import { generateQueryEmbedding } from "../services/embeddingService";
import { semanticSearch, type SearchResult } from "../services/embeddingStorage";
import { getDocumentVersionById, getLogicalDocumentById } from "../storage/documents";
import { logDebug, logInfo } from "../utils/logger";
import { computeSituationMatchScore } from "./situationExtractor";
import { chatConfigV3 } from "./chatConfigV3";
import type { RetrievalPlanV3, IssueMap } from "./types";
import type { LabeledChunk, ChunkAuthority, PipelineLogContext } from "./types";
import type { SituationContext } from "@shared/schema";
import type { V3RetrievalResult } from "./twoLaneRetrieve";

interface PgvectorLaneChunk {
  docId: string;
  title: string;
  content: string;
  lane: "local" | "state";
  score: number;
  documentNames: string[];
}

async function enrichResult(result: SearchResult): Promise<{ title: string; content: string }> {
  try {
    const docVersion = await getDocumentVersionById(result.chunk.documentVersionId);
    if (docVersion) {
      const logicalDoc = await getLogicalDocumentById(docVersion.documentId);
      if (logicalDoc) {
        return { title: logicalDoc.canonicalTitle, content: result.chunk.content };
      }
    }
  } catch {}
  return { title: `chunk-${result.chunk.chunkIndex}`, content: result.chunk.content };
}

async function executeQueryOnLane(
  query: string,
  lane: "local" | "state",
  town: string | null,
  maxResults: number,
): Promise<PgvectorLaneChunk[]> {
  const queryEmbedding = await generateQueryEmbedding(query);

  const townFilter = lane === "local" && town ? town : lane === "state" ? "statewide" : undefined;

  const results = await semanticSearch(queryEmbedding, {
    town: townFilter,
    limit: maxResults,
    similarityThreshold: 0.4,
  });

  const enriched = await Promise.all(results.map(async (r, idx) => {
    const { title, content } = await enrichResult(r);
    return {
      docId: `${lane}_pgv_${idx}_${r.chunk.documentVersionId}`,
      title,
      content,
      lane,
      score: r.similarity,
      documentNames: [title],
    } as PgvectorLaneChunk;
  }));

  return enriched;
}

function dedupeChunksByContent(chunks: PgvectorLaneChunk[]): PgvectorLaneChunk[] {
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

  const allQueries = [
    ...localQueries.map(q => ({ query: q, lane: "local" as const })),
    ...stateQueries.map(q => ({ query: q, lane: "state" as const })),
  ];

  const results = await Promise.all(
    allQueries.map(({ query, lane }) =>
      executeQueryOnLane(query, lane, townPreference || null, lane === "local" ? plan.local.k : plan.state.k)
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
  }));

  const labeledStateChunks: LabeledChunk[] = selectedState.map((chunk, idx) => ({
    label: `[S${idx + 1}]`,
    title: chunk.title,
    content: chunk.content,
    lane: "state" as const,
    authority: classifyAuthority(chunk.title, chunk.content, "state"),
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
