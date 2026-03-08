import { generateQueryEmbedding, generateBatchQueryEmbeddings } from "../services/embeddingService";
import { semanticSearch, hybridSearch, type SearchResult, type HybridSearchResult } from "../services/embeddingStorage";
import { getDocumentVersionById, getLogicalDocumentById } from "../storage/documents";
import { db, sql } from "../storage/db";
import * as schema from "@shared/schema";
import { logDebug, logInfo } from "../utils/logger";
import { computeSituationMatchScore } from "./situationExtractor";
import { chatConfigV3 } from "./chatConfigV3";
import type { RetrievalPlanV3, IssueMap, TemporalTarget, QueryFocus } from "./types";
import { QUERY_FOCUS_DOC_TYPE_WEIGHTS } from "./types";
import type { LabeledChunk, ChunkAuthority, PipelineLogContext } from "./types";
import type { SituationContext } from "@shared/schema";
import type { V3RetrievalResult } from "./twoLaneRetrieve";

export interface PgvectorLaneChunk {
  docId: string;
  title: string;
  content: string;
  lane: "local" | "state" | "sau";
  score: number;
  documentNames: string[];
  year?: string;
  category?: string;
}

interface EnrichedResult {
  title: string;
  content: string;
  fileBlobId?: string;
  filename?: string;
  town?: string;
  board?: string;
  year?: string;
  category?: string;
}

async function batchEnrichResults(results: SearchResult[]): Promise<EnrichedResult[]> {
  const docIds = new Set<string>();
  const blobIds = new Set<string>();

  for (const r of results) {
    if (r.chunk.documentId) docIds.add(r.chunk.documentId);
    const meta = r.chunk.metadata;
    if (meta?.fileBlobId && !meta?.filename) blobIds.add(meta.fileBlobId);
  }

  const logicalDocMap = new Map<string, typeof schema.logicalDocuments.$inferSelect>();
  const blobFilenameMap = new Map<string, string>();

  let logicalDocs: (typeof schema.logicalDocuments.$inferSelect)[] = [];
  let blobRows: any = { rows: [] };
  try {
    [logicalDocs, blobRows] = await Promise.all([
      docIds.size > 0
        ? db.select().from(schema.logicalDocuments)
            .where(sql`${schema.logicalDocuments.id} IN (${sql.join(Array.from(docIds).map(id => sql`${id}`), sql`, `)})`)
        : Promise.resolve([]),
      blobIds.size > 0
        ? db.execute(sql`SELECT id, original_filename FROM file_blobs WHERE id IN (${sql.join(Array.from(blobIds).map(id => sql`${id}`), sql`, `)})`)
        : Promise.resolve({ rows: [] } as any),
    ]);
  } catch {
    logInfo("batchEnrichResults: DB lookup failed, falling back to metadata-only enrichment", { stage: "pgvectorRetrieve" });
  }

  for (const doc of logicalDocs) {
    logicalDocMap.set(doc.id, doc);
  }
  const rows = (blobRows.rows || blobRows) as any[];
  for (const row of rows) {
    if (row.original_filename) blobFilenameMap.set(row.id, row.original_filename);
  }

  return results.map(result => {
    const meta = result.chunk.metadata;
    const fileBlobId = meta?.fileBlobId || undefined;
    const filename = meta?.filename || undefined;
    const town = meta?.town || undefined;
    const board = meta?.board || undefined;
    const year = meta?.year != null ? String(meta.year) : undefined;
    const category = meta?.documentType || undefined;

    if (result.chunk.documentId) {
      const logicalDoc = logicalDocMap.get(result.chunk.documentId);
      if (logicalDoc) {
        return {
          title: logicalDoc.canonicalTitle,
          content: result.chunk.content,
          fileBlobId,
          filename: filename || logicalDoc.canonicalTitle,
          town: logicalDoc.town || town,
          board: logicalDoc.board || board,
          year,
          category: logicalDoc.category || category,
        };
      }
    }

    if (fileBlobId && !filename) {
      const resolvedFilename = blobFilenameMap.get(fileBlobId);
      if (resolvedFilename) {
        return {
          title: resolvedFilename,
          content: result.chunk.content,
          fileBlobId,
          filename: resolvedFilename,
          town,
          board,
          year,
          category,
        };
      }
    }

    const metaTitle = filename || meta?.documentType;
    return {
      title: metaTitle || `chunk-${result.chunk.chunkIndex}`,
      content: result.chunk.content,
      fileBlobId,
      filename,
      town,
      board,
      year,
      category,
    };
  });
}

export interface LaneQueryOptions {
  keywordTerms?: string[];
  temporalFilter?: TemporalTarget;
  queryFocus?: QueryFocus;
  sauTowns?: string[];
  sauId?: string;
}

export async function executeQueryOnLane(
  query: string,
  lane: "local" | "state" | "sau",
  town: string | null,
  maxResults: number,
  laneOptions?: LaneQueryOptions,
  precomputedEmbedding?: number[],
): Promise<PgvectorLaneChunk[]> {
  const queryEmbedding = precomputedEmbedding || await generateQueryEmbedding(query);

  const townFilter = lane === "local" && town ? town : lane === "state" ? "statewide" : undefined;
  const townsFilter = lane === "sau" && laneOptions?.sauTowns ? laneOptions.sauTowns : undefined;
  const sauFilter = lane === "sau" && laneOptions?.sauId ? laneOptions.sauId : undefined;
  const useHybrid = laneOptions && (
    (laneOptions.keywordTerms && laneOptions.keywordTerms.length > 0) ||
    (laneOptions.temporalFilter && laneOptions.temporalFilter.strategy !== "none") ||
    (laneOptions.queryFocus && laneOptions.queryFocus !== "general")
  );

  let results: Array<{ chunk: any; similarity: number; documentId: string | null }>;

  if (useHybrid) {
    const docTypeWeights = laneOptions.queryFocus
      ? QUERY_FOCUS_DOC_TYPE_WEIGHTS[laneOptions.queryFocus]
      : undefined;

    const hybridResults = await hybridSearch(queryEmbedding, {
      town: townFilter,
      towns: townsFilter,
      sau: sauFilter,
      limit: maxResults,
      similarityThreshold: 0.4,
      keywordTerms: laneOptions.keywordTerms,
      temporalFilter: laneOptions.temporalFilter,
      docTypeWeights,
    });

    results = hybridResults.map(r => ({
      chunk: r.chunk,
      similarity: r.score,
      documentId: r.documentId,
    }));
  } else {
    results = await semanticSearch(queryEmbedding, {
      town: townFilter,
      towns: townsFilter,
      sau: sauFilter,
      limit: maxResults,
      similarityThreshold: 0.4,
    });
  }

  const enrichedResults = await batchEnrichResults(results);
  const enriched: PgvectorLaneChunk[] = enrichedResults.map((enrichedResult, idx) => {
    const r = results[idx];
    let docName: string;
    if (enrichedResult.fileBlobId) {
      docName = `[blob:${enrichedResult.fileBlobId}] ${enrichedResult.title}`;
    } else if (enrichedResult.filename && enrichedResult.town) {
      docName = `[file:${enrichedResult.town}:${enrichedResult.filename}] ${enrichedResult.title}`;
    } else {
      docName = enrichedResult.title;
    }
    return {
      docId: `${lane}_pgv_${idx}_${r.chunk.documentId || r.chunk.id}`,
      title: enrichedResult.title,
      content: enrichedResult.content,
      lane,
      score: r.similarity,
      documentNames: [docName],
      year: enrichedResult.year,
      category: enrichedResult.category,
    } as PgvectorLaneChunk;
  });

  return enriched;
}

export function dedupeChunksByContent(chunks: PgvectorLaneChunk[]): PgvectorLaneChunk[] {
  const seen = new Set<string>();
  const deduped: PgvectorLaneChunk[] = [];
  for (const chunk of chunks) {
    const key = chunk.content.slice(0, 200).toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(chunk);
    }
  }
  return deduped;
}

function classifyAuthority(title: string, content: string, lane: "local" | "state" | "sau"): ChunkAuthority {
  const combinedText = (title + ' ' + content).toLowerCase();

  if (lane === "state") {
    if (/\brsa\s+\d+/i.test(combinedText)) return "rsa";
    if (/\bnhma\b/i.test(combinedText) || combinedText.includes("municipal association")) return "nhma";
    return "official";
  }

  if (combinedText.includes("minutes") || combinedText.includes("meeting")) return "minutes";
  if (combinedText.includes("news") || combinedText.includes("article")) return "news";
  return "official";
}

function rankWithSituation(
  chunks: PgvectorLaneChunk[],
  situationContext: SituationContext | null | undefined
): PgvectorLaneChunk[] {
  if (!situationContext) {
    return chunks.sort((a, b) => b.score - a.score);
  }

  return chunks
    .map(chunk => ({
      ...chunk,
      score: chunk.score + computeSituationMatchScore(chunk.title + " " + chunk.content, situationContext) * 0.3,
    }))
    .sort((a, b) => b.score - a.score);
}

function detectAuthoritativeState(chunks: PgvectorLaneChunk[]): boolean {
  return chunks.some(c => {
    const text = (c.title + ' ' + c.content).toLowerCase();
    return /\brsa\s+\d+/.test(text) || /\bnhma\b/.test(text);
  });
}

export async function pgvectorTwoLaneRetrieveWithPlan(
  plan: RetrievalPlanV3,
  issueMap: IssueMap,
  options: {
    townPreference?: string | null;
    situationContext?: SituationContext | null;
    logContext?: PipelineLogContext;
  }
): Promise<V3RetrievalResult> {
  const { townPreference, situationContext, logContext } = options;
  const startTime = Date.now();

  const localQueries = plan.local.queries.slice(0, chatConfigV3.MAX_QUERIES_PER_LANE);
  const stateQueries = plan.state.queries.slice(0, chatConfigV3.MAX_QUERIES_PER_LANE);
  const sauQueries = plan.sau ? plan.sau.queries.slice(0, chatConfigV3.MAX_QUERIES_PER_LANE) : [];

  const allQueryStrings = [...localQueries, ...stateQueries, ...sauQueries];
  const embeddingStartTime = Date.now();
  const embeddingMap = await generateBatchQueryEmbeddings(allQueryStrings);
  logInfo(`pgvector embeddings: ${embeddingMap.size} vectors for ${allQueryStrings.length} queries (${Date.now() - embeddingStartTime}ms)`, {
    stage: "pgvectorRetrieve",
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
  });

  const laneOpts: LaneQueryOptions = {
    keywordTerms: plan.keywordTerms && plan.keywordTerms.length > 0 ? plan.keywordTerms : undefined,
    temporalFilter: plan.temporalFilter,
    queryFocus: plan.queryFocus,
  };

  const sauLaneOpts: LaneQueryOptions = {
    ...laneOpts,
    sauTowns: plan.sauTowns,
    sauId: plan.sauId,
  };

  const allQueryPromises = [
    ...localQueries.map(query => ({ query, lane: "local" as const, k: plan.local.k, opts: laneOpts })),
    ...stateQueries.map(query => ({ query, lane: "state" as const, k: plan.state.k, opts: laneOpts })),
    ...sauQueries.map(query => ({ query, lane: "sau" as const, k: plan.sau!.k, opts: sauLaneOpts })),
  ].map(async ({ query, lane, k, opts }) => {
    try {
      const result = await executeQueryOnLane(query, lane, townPreference || null, k, opts, embeddingMap.get(query));
      return { chunks: result, query, lane, success: true };
    } catch (err) {
      logInfo(`pgvector query failed for ${lane}: ${err}`, { stage: "pgvectorRetrieve" });
      return { chunks: [] as PgvectorLaneChunk[], query, lane, success: false };
    }
  });

  const queryResults = await Promise.all(allQueryPromises);

  const allLocalChunks: PgvectorLaneChunk[] = [];
  const allStateChunks: PgvectorLaneChunk[] = [];
  const allSauChunks: PgvectorLaneChunk[] = [];
  const localQueriesUsed: string[] = [];
  const stateQueriesUsed: string[] = [];
  const sauQueriesUsed: string[] = [];

  for (const result of queryResults) {
    if (result.lane === "local") {
      allLocalChunks.push(...result.chunks);
      if (result.success && result.chunks.length > 0) localQueriesUsed.push(result.query);
    } else if (result.lane === "state") {
      allStateChunks.push(...result.chunks);
      if (result.success && result.chunks.length > 0) stateQueriesUsed.push(result.query);
    } else if (result.lane === "sau") {
      allSauChunks.push(...result.chunks);
      if (result.success && result.chunks.length > 0) sauQueriesUsed.push(result.query);
    }
  }

  const dedupedLocal = dedupeChunksByContent(allLocalChunks);
  const dedupedState = dedupeChunksByContent(allStateChunks);
  const dedupedSau = dedupeChunksByContent(allSauChunks);

  const rankedLocal = rankWithSituation(dedupedLocal, situationContext);
  const rankedState = rankWithSituation(dedupedState, situationContext);
  const rankedSau = rankWithSituation(dedupedSau, situationContext);

  const selectedLocal = rankedLocal.slice(0, plan.local.cap);
  const selectedState = rankedState.slice(0, plan.state.cap);
  const selectedSau = plan.sau ? rankedSau.slice(0, plan.sau.cap) : [];

  const labeledLocalChunks: LabeledChunk[] = selectedLocal.map((chunk, idx) => ({
    label: `[L${idx + 1}]`,
    title: chunk.title,
    content: chunk.content,
    lane: "local" as const,
    authority: classifyAuthority(chunk.title, chunk.content, "local"),
    year: chunk.year,
    category: chunk.category,
  }));

  const labeledStateChunks: LabeledChunk[] = selectedState.map((chunk, idx) => ({
    label: `[S${idx + 1}]`,
    title: chunk.title,
    content: chunk.content,
    lane: "state" as const,
    authority: classifyAuthority(chunk.title, chunk.content, "state"),
    year: chunk.year,
    category: chunk.category,
  }));

  const labeledSauChunks: LabeledChunk[] = selectedSau.map((chunk, idx) => ({
    label: `[A${idx + 1}]`,
    title: chunk.title,
    content: chunk.content,
    lane: "sau" as const,
    authority: classifyAuthority(chunk.title, chunk.content, "sau"),
    year: chunk.year,
    category: chunk.category,
  }));

  const allSelectedChunks = [...selectedLocal, ...selectedState, ...selectedSau];
  const situationAlignment = situationContext && allSelectedChunks.length > 0
    ? allSelectedChunks.reduce(
        (sum, c) => sum + computeSituationMatchScore(c.title + " " + c.content, situationContext), 0
      ) / allSelectedChunks.length
    : 0;

  const legalTopicCoverage = issueMap.legalTopics.length > 0
    ? (() => {
        const text = labeledStateChunks.map(c => c.content.toLowerCase()).join(' ');
        let covered = 0;
        for (const topic of issueMap.legalTopics) {
          if (text.includes(topic.toLowerCase())) covered++;
        }
        return covered / issueMap.legalTopics.length;
      })()
    : 1.0;

  const distinctStateDocs = new Set(labeledStateChunks.map(c => c.title.toLowerCase().trim())).size;
  const distinctLocalDocs = new Set(labeledLocalChunks.map(c => c.title.toLowerCase().trim())).size;
  const distinctSauDocs = new Set(labeledSauChunks.map(c => c.title.toLowerCase().trim())).size;

  const allDocumentNames = Array.from(new Set([
    ...selectedLocal.flatMap(c => c.documentNames),
    ...selectedState.flatMap(c => c.documentNames),
    ...selectedSau.flatMap(c => c.documentNames),
  ]));

  const durationMs = Date.now() - startTime;

  logInfo(
    `pgvector retrieval: ${labeledLocalChunks.length} local + ${labeledStateChunks.length} state + ${labeledSauChunks.length} SAU chunks (${durationMs}ms)`,
    {
      stage: "pgvectorRetrieve",
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
    }
  );

  return {
    localChunks: labeledLocalChunks,
    stateChunks: labeledStateChunks,
    sauChunks: labeledSauChunks,
    allDocumentNames,
    localCount: labeledLocalChunks.length,
    stateCount: labeledStateChunks.length,
    sauCount: labeledSauChunks.length,
    situationAlignment,
    legalTopicCoverage,
    authoritativeStatePresent: detectAuthoritativeState(selectedState),
    distinctStateDocs,
    distinctLocalDocs,
    distinctSauDocs,
    debug: {
      localQueriesUsed,
      stateQueriesUsed,
      sauQueriesUsed,
      localRetrievedTotal: allLocalChunks.length,
      stateRetrievedTotal: allStateChunks.length,
      sauRetrievedTotal: allSauChunks.length,
      earlyExitTriggered: false,
      durationMs,
      legalSalience: issueMap.legalSalience,
    },
  };
}
