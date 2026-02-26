import { generateQueryEmbedding } from "../services/embeddingService";
import { semanticSearch, hybridSearch, type SearchResult, type HybridSearchResult } from "../services/embeddingStorage";
import { getDocumentVersionById, getLogicalDocumentById } from "../storage/documents";
import { db, sql } from "../storage/db";
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
  lane: "local" | "state";
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

async function enrichResult(result: SearchResult): Promise<EnrichedResult> {
  const meta = result.chunk.metadata;
  const fileBlobId = meta?.fileBlobId || undefined;
  const filename = meta?.filename || undefined;
  const town = meta?.town || undefined;
  const board = meta?.board || undefined;
  const year = meta?.year != null ? String(meta.year) : undefined;
  const category = meta?.documentType || undefined;

  try {
    if (result.chunk.documentId) {
      const logicalDoc = await getLogicalDocumentById(result.chunk.documentId);
      if (logicalDoc) {
        return {
          title: logicalDoc.canonicalTitle,
          content: result.chunk.content,
          fileBlobId,
          filename: filename || logicalDoc.canonicalTitle,
          town: logicalDoc.town || town,
          board: logicalDoc.board || board,
          year: year,
          category: logicalDoc.category || category,
        };
      }
    }
  } catch {}

  if (fileBlobId && !filename) {
    try {
      const blobResult = await db.execute(sql`
        SELECT original_filename FROM file_blobs WHERE id = ${fileBlobId} LIMIT 1
      `);
      const rows = (blobResult.rows || blobResult) as any[];
      if (rows.length > 0 && rows[0].original_filename) {
        const resolvedFilename = rows[0].original_filename;
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
    } catch {}
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
}

export interface LaneQueryOptions {
  keywordTerms?: string[];
  temporalFilter?: TemporalTarget;
  queryFocus?: QueryFocus;
}

export async function executeQueryOnLane(
  query: string,
  lane: "local" | "state",
  town: string | null,
  maxResults: number,
  laneOptions?: LaneQueryOptions,
): Promise<PgvectorLaneChunk[]> {
  const queryEmbedding = await generateQueryEmbedding(query);

  const townFilter = lane === "local" && town ? town : lane === "state" ? "statewide" : undefined;
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
      limit: maxResults,
      similarityThreshold: 0.4,
    });
  }

  const enriched = await Promise.all(results.map(async (r, idx) => {
    const enrichedResult = await enrichResult({ chunk: r.chunk, similarity: r.similarity, documentId: r.documentId });
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
  }));

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

function classifyAuthority(title: string, content: string, lane: "local" | "state"): ChunkAuthority {
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

  const allLocalChunks: PgvectorLaneChunk[] = [];
  const allStateChunks: PgvectorLaneChunk[] = [];
  const localQueriesUsed: string[] = [];
  const stateQueriesUsed: string[] = [];

  const laneOpts: LaneQueryOptions = {
    keywordTerms: plan.keywordTerms && plan.keywordTerms.length > 0 ? plan.keywordTerms : undefined,
    temporalFilter: plan.temporalFilter,
    queryFocus: plan.queryFocus,
  };

  const allQueries = [
    ...localQueries.map(q => ({ query: q, lane: "local" as const })),
    ...stateQueries.map(q => ({ query: q, lane: "state" as const })),
  ];

  const results = await Promise.all(
    allQueries.map(({ query, lane }) =>
      executeQueryOnLane(query, lane, townPreference || null, lane === "local" ? plan.local.k : plan.state.k, laneOpts)
        .then(chunks => ({ query, lane, chunks }))
        .catch(err => {
          logInfo(`pgvector query failed for ${lane}: ${err}`, { stage: "pgvectorRetrieve" });
          return { query, lane, chunks: [] as PgvectorLaneChunk[] };
        })
    )
  );

  for (const r of results) {
    if (r.lane === "local") {
      allLocalChunks.push(...r.chunks);
      if (r.chunks.length > 0) localQueriesUsed.push(r.query);
    } else {
      allStateChunks.push(...r.chunks);
      if (r.chunks.length > 0) stateQueriesUsed.push(r.query);
    }
  }

  const dedupedLocal = dedupeChunksByContent(allLocalChunks);
  const dedupedState = dedupeChunksByContent(allStateChunks);

  const rankedLocal = rankWithSituation(dedupedLocal, situationContext);
  const rankedState = rankWithSituation(dedupedState, situationContext);

  const selectedLocal = rankedLocal.slice(0, plan.local.cap);
  const selectedState = rankedState.slice(0, plan.state.cap);

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

  const situationAlignment = situationContext && [...selectedLocal, ...selectedState].length > 0
    ? [...selectedLocal, ...selectedState].reduce(
        (sum, c) => sum + computeSituationMatchScore(c.title + " " + c.content, situationContext), 0
      ) / [...selectedLocal, ...selectedState].length
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

  const allDocumentNames = Array.from(new Set([
    ...selectedLocal.flatMap(c => c.documentNames),
    ...selectedState.flatMap(c => c.documentNames),
  ]));

  const durationMs = Date.now() - startTime;

  logInfo(
    `pgvector retrieval: ${labeledLocalChunks.length} local + ${labeledStateChunks.length} state chunks (${durationMs}ms)`,
    {
      stage: "pgvectorRetrieve",
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
    }
  );

  return {
    localChunks: labeledLocalChunks,
    stateChunks: labeledStateChunks,
    allDocumentNames,
    localCount: labeledLocalChunks.length,
    stateCount: labeledStateChunks.length,
    situationAlignment,
    legalTopicCoverage,
    authoritativeStatePresent: detectAuthoritativeState(selectedState),
    distinctStateDocs,
    distinctLocalDocs,
    debug: {
      localQueriesUsed,
      stateQueriesUsed,
      localRetrievedTotal: allLocalChunks.length,
      stateRetrievedTotal: allStateChunks.length,
      earlyExitTriggered: false,
      durationMs,
      legalSalience: issueMap.legalSalience,
    },
  };
}
