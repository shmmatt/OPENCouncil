import { GoogleGenAI } from "@google/genai";
import { db, schema, eq, and, desc, sql, gte } from "../storage/db";
import { generateQueryEmbedding } from "./embeddingService";
import { semanticSearch } from "./embeddingStorage";
import { logInfo, logError, logDebug } from "../utils/logger";
import type { ScoredTopic, RoutineTopic, TownFeedNewsArticle, TownFeedItem } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });
const MODEL = "gemini-3.1-flash-lite";
const SUMMARY_MODEL = "gemini-3.1-pro-preview";

interface RawTopic {
  topic: string;
  board: string | null;
  meetingDate: string | null;
  keyPoints: string[];
}

export async function extractTopicsFromMinutes(town: string): Promise<{ topics: RawTopic[]; sourceMinutesIds: string[] }> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recentMinutes = await db
    .select({
      versionId: schema.documentVersions.id,
      documentId: schema.documentVersions.documentId,
      board: schema.logicalDocuments.board,
      meetingDate: schema.documentVersions.meetingDate,
      fileBlobId: schema.documentVersions.fileBlobId,
    })
    .from(schema.documentVersions)
    .innerJoin(schema.logicalDocuments, eq(schema.documentVersions.documentId, schema.logicalDocuments.id))
    .where(and(
      eq(schema.logicalDocuments.town, town),
      eq(schema.documentVersions.isMinutes, true),
      eq(schema.documentVersions.isCurrent, true),
      gte(schema.documentVersions.createdAt, thirtyDaysAgo),
    ))
    .orderBy(desc(schema.documentVersions.createdAt))
    .limit(20);

  if (recentMinutes.length === 0) {
    logInfo(`[contentGeneration] No recent minutes found for ${town}`);
    return { topics: [], sourceMinutesIds: [] };
  }

  const sourceMinutesIds = recentMinutes.map(m => m.documentId);

  const chunks = await db
    .select({
      content: schema.documentChunks.content,
      metadata: schema.documentChunks.metadata,
    })
    .from(schema.documentChunks)
    .where(and(
      sql`lower(metadata->>'town') = ${town.toLowerCase()}`,
      sql`metadata->>'documentType' = 'meeting_minutes'`,
    ))
    .orderBy(desc(schema.documentChunks.createdAt))
    .limit(50);

  if (chunks.length === 0) {
    logInfo(`[contentGeneration] No minute chunks found for ${town}`);
    return { topics: [], sourceMinutesIds };
  }

  const concatenatedText = chunks
    .map(c => {
      const meta = c.metadata || {};
      const header = [meta.board, meta.date].filter(Boolean).join(" - ");
      return header ? `[${header}]\n${c.content}` : c.content;
    })
    .join("\n\n---\n\n")
    .slice(0, 60000);

  const prompt = `You are analyzing municipal meeting minutes from ${town}, New Hampshire.
Extract distinct topics discussed across these minutes. For each topic, identify:
- topic: A clear, concise name for the topic (e.g., "Water District Budget Increase", "Short-Term Rental Ordinance")
- board: Which board discussed it (e.g., "Select Board", "Planning Board", "ZBA") or null if unclear
- meetingDate: The date of the meeting where this was discussed (ISO format YYYY-MM-DD) or null if unclear
- keyPoints: 2-4 bullet points summarizing the key discussion points

Focus on substantive topics — skip procedural items like roll call, approval of prior minutes, adjournment.
Return 5-15 topics depending on how much substantive content exists.

Meeting minutes text:
${concatenatedText}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            topics: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  topic: { type: "string" as const },
                  board: { type: "string" as const, nullable: true },
                  meetingDate: { type: "string" as const, nullable: true },
                  keyPoints: { type: "array" as const, items: { type: "string" as const } },
                },
                required: ["topic", "keyPoints"],
              },
            },
          },
          required: ["topics"],
        },
      },
    });

    const rawText = response.text || "{}";
    const parsed = JSON.parse(rawText);
    const topics: RawTopic[] = (parsed.topics || []).map((t: any) => ({
      topic: t.topic || "Unknown Topic",
      board: t.board || null,
      meetingDate: t.meetingDate || null,
      keyPoints: Array.isArray(t.keyPoints) ? t.keyPoints : [],
    }));

    logInfo(`[contentGeneration] Extracted ${topics.length} topics from ${town} minutes`);
    return { topics, sourceMinutesIds };
  } catch (error) {
    logError(`[contentGeneration] Topic extraction failed for ${town}`, { error: String(error) });
    throw error;
  }
}

export async function judgeStoryWorthiness(topics: RawTopic[]): Promise<ScoredTopic[]> {
  if (topics.length === 0) return [];

  const topicSummaries = topics.map((t, i) =>
    `${i + 1}. "${t.topic}" (Board: ${t.board || "unknown"}, Date: ${t.meetingDate || "unknown"})\n   Key points: ${t.keyPoints.join("; ")}`
  ).join("\n\n");

  const prompt = `You are a local news editor evaluating municipal meeting topics for story-worthiness.

Score each topic on three axes (each 1-10):
- financialImpact: How significant is the financial impact on residents? (tax changes, large expenditures, budget cuts = high)
- publicFriction: How much public controversy or debate does this generate? (contested votes, citizen complaints, legal disputes = high)
- qualityOfLife: How directly does this affect residents' daily quality of life? (zoning changes, infrastructure, public safety = high)

Also provide an overall "relevance" score (1-10) that reflects how newsworthy this topic is for local residents. The overall score should be a weighted combination that emphasizes financial impact and public friction slightly more.

Topics to evaluate:
${topicSummaries}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            scored_topics: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  index: { type: "number" as const },
                  financialImpact: { type: "number" as const },
                  publicFriction: { type: "number" as const },
                  qualityOfLife: { type: "number" as const },
                  relevance: { type: "number" as const },
                },
                required: ["index", "financialImpact", "publicFriction", "qualityOfLife", "relevance"],
              },
            },
          },
          required: ["scored_topics"],
        },
      },
    });

    const rawText = response.text || "{}";
    const parsed = JSON.parse(rawText);
    const scoredResults = parsed.scored_topics || [];

    const scoredTopics: ScoredTopic[] = topics.map((t, i) => {
      const scoreData = scoredResults.find((s: any) => s.index === i + 1) || {};
      const financialImpact = scoreData.financialImpact || 1;
      const publicFriction = scoreData.publicFriction || 1;
      const qualityOfLife = scoreData.qualityOfLife || 1;
      const relevance = scoreData.relevance || Math.round((financialImpact + publicFriction + qualityOfLife) / 3);

      return {
        topic: t.topic,
        score: relevance,
        financialImpact,
        publicFriction,
        qualityOfLife,
        relevance,
        board: t.board,
        meetingDate: t.meetingDate,
        keyPoints: t.keyPoints,
      };
    });

    logInfo(`[contentGeneration] Scored ${scoredTopics.length} topics, ${scoredTopics.filter(t => t.score >= 8).length} high-scoring`);
    return scoredTopics;
  } catch (error) {
    logError(`[contentGeneration] Story worthiness judging failed`, { error: String(error) });
    throw error;
  }
}

export async function enrichWithHistoricalContext(
  scoredTopics: ScoredTopic[],
  town: string
): Promise<ScoredTopic[]> {
  const enriched: ScoredTopic[] = [];

  for (const topic of scoredTopics) {
    try {
      const queryText = `${topic.topic} ${topic.keyPoints.slice(0, 2).join(" ")} ${town}`;
      const queryEmbedding = await generateQueryEmbedding(queryText);

      const results = await semanticSearch(queryEmbedding, {
        town,
        limit: 5,
        similarityThreshold: 0.4,
      });

      if (results.length === 0) {
        enriched.push({ ...topic, historicalContext: undefined });
        continue;
      }

      const contextChunks = results.map((r, i) => {
        const meta = r.chunk.metadata || {};
        const header = [meta.board, meta.year, meta.documentType].filter(Boolean).join(" | ");
        return `[Source ${i + 1}: ${header}]\n${r.chunk.content.slice(0, 1500)}`;
      }).join("\n\n");

      const contextPrompt = `Based on these historical municipal documents from ${town}, NH, write a brief historical context paragraph (2-4 sentences) for this topic:

Topic: "${topic.topic}"
Key points from recent minutes: ${topic.keyPoints.join("; ")}

Historical documents:
${contextChunks}

Write a concise narrative connecting historical context to the current discussion. Focus on precedents, prior decisions, and evolution of the issue. If no meaningful historical context exists, say so briefly.`;

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: contextPrompt }] }],
        config: { temperature: 0.2, maxOutputTokens: 500 },
      });

      const contextText = response.text || "";
      enriched.push({ ...topic, historicalContext: contextText.trim() || undefined });

      logDebug(`[contentGeneration] Enriched topic "${topic.topic}" with ${results.length} historical sources`);
    } catch (error) {
      logError(`[contentGeneration] Failed to enrich topic "${topic.topic}"`, { error: String(error) });
      enriched.push({ ...topic, historicalContext: undefined });
    }
  }

  return enriched;
}

export function formatRoutineRollup(scoredTopics: ScoredTopic[]): RoutineTopic[] {
  return scoredTopics.map(t => ({
    topic: t.topic,
    score: t.score,
    board: t.board,
    rollupSentence: `${t.board || "The board"} discussed ${t.topic.toLowerCase()}${t.keyPoints.length > 0 ? ` — ${t.keyPoints[0].toLowerCase()}` : ""}.`,
  }));
}

export async function generateSummary(
  highScoringTopics: ScoredTopic[],
  routineRollup: RoutineTopic[],
  town: string
): Promise<string> {
  const highTopicText = highScoringTopics.map((t, i) => {
    const ctx = t.historicalContext ? `\n   Historical context: ${t.historicalContext}` : "";
    return `${i + 1}. "${t.topic}" (Score: ${t.score}/10, Board: ${t.board || "unknown"})
   Key points: ${t.keyPoints.join("; ")}${ctx}`;
  }).join("\n\n");

  const routineText = routineRollup.map(r => `- ${r.rollupSentence}`).join("\n");

  const prompt = `You are a municipal affairs reporter covering ${town}, New Hampshire. Write a factual summary of recent board and committee actions. Your writing must be dry, neutral, and precise — like a wire service report, not a newsletter.

STRICT TONE RULES:
- Never use exclamation marks
- Never use rhetorical questions
- Never use conversational phrases like "Let's dive in," "Here's what you need to know," "Big news," or "Stay tuned"
- Never use subjective adjectives: "exciting," "impressive," "concerning," "remarkable," "important," "significant"
- Never use PR language or evaluative adjectives: "pleased," "successfully," "fortunately," "unfortunately," "proud," "committed to"
- Never title the piece with the town name followed by an exclamation mark or informal phrasing
- Do NOT write: "Big changes are coming to ${town}!" or "${town} Update!"
- DO write: "The ${town} Select Board approved a $2.1M bond for road repairs at its Feb. 12 meeting."

JOURNALISTIC LEDE RULES:
- The very first sentence MUST be a newspaper-style lede containing Who, What, When, and Where
- The first paragraph must be strictly under 40 words — punchy and direct
- Do NOT repeat the town name in the first sentence if it is already clear from context (e.g., if the reader already knows the town, do not start with "The ${town} Select Board...")
- Do NOT echo or rephrase the headline/title in the opening sentence — the lede must add new information
- Example of a good lede: "A **$363,500** purchase of the former bank building on Main Street was approved unanimously at the **Feb. 12** meeting."

HIGH-PRIORITY TOPICS:
${highTopicText || "(None — all topics were routine this period)"}

ROUTINE ITEMS:
${routineText || "(None)"}

Structure:
- Open with the most consequential action taken, stated as a single declarative sentence (the journalistic lede)
- One topic per paragraph, 2-4 sentences each
- For each topic: what was decided, by whom, and what changes for residents
- Use "Why it matters:" as a label before a single factual sentence where relevant — never as editorial commentary
- Bold names, dollar figures, vote counts, and dates
- End with "Also on the agenda:" followed by routine items, each in one sentence
- 400-800 words
- Always finish the full summary — do not stop mid-sentence or mid-section`;

  try {
    const response = await ai.models.generateContent({
      model: SUMMARY_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.2, maxOutputTokens: 8192 },
    });

    const summary = response.text || "Unable to generate summary.";
    logInfo(`[contentGeneration] Generated summary for ${town} (${summary.length} chars)`);
    return summary.trim();
  } catch (error) {
    logError(`[contentGeneration] Summary generation failed for ${town}`, { error: String(error) });
    throw error;
  }
}

export async function generateCuriosityQuestions(
  summary: string,
  highScoringTopics: ScoredTopic[],
  town: string
): Promise<{ sections: { topic: string; questions: string[] }[]; highLevelQuestions: string[] }> {
  let topicDetails: string;
  try {
    topicDetails = highScoringTopics.map((t, i) => {
      const points = Array.isArray(t.keyPoints) ? t.keyPoints.join("; ") : "";
      return `${i + 1}. "${t.topic}" (Board: ${t.board || "unknown"})
   Key points: ${points}
   ${t.historicalContext ? `Context: ${t.historicalContext}` : ""}`;
    }).join("\n\n");
  } catch {
    topicDetails = highScoringTopics.map((t, i) => `${i + 1}. "${t.topic}"`).join("\n");
  }

  const truncatedSummary = summary.length > 3000 ? summary.slice(0, 3000) + "..." : summary;

  const prompt = `You are generating follow-up questions for a municipal news summary about ${town}, New Hampshire. Read the summary and topic details carefully, then generate specific, curiosity-driven questions.

SUMMARY:
${truncatedSummary}

TOPICS:
${topicDetails}

STRICT RULES FOR QUESTION GENERATION:
0. ANSWERABLE ONLY — You are strictly forbidden from generating questions that ask for specific numbers, costs, names, vote counts, or historical data UNLESS the exact answer is explicitly stated in the summary text above. If the summary says "the town avoided a bond" but does NOT state the estimated cost, do NOT ask "What was the estimated cost of the bond?" If the answer isn't in the text, do not ask the question. Every question you generate must be answerable using only the summary and topic details provided.
1. NO TEMPLATES — Never use generic formats like "What is the history of [Topic]?" or "How does [Topic] affect residents?" or "What decisions were made about [Topic]?"
2. BE SPECIFIC — Anchor every question in a specific number, person, dollar figure, vote count, date, or conflict actually mentioned in the summary text.
3. SEEK THE UNANSWERED — Ask the natural next question the summary implies but does not fully resolve. What would a reader wonder after reading this?
4. CONVERSATIONAL TONE — Write as if a curious local resident were asking at a coffee shop. Short, punchy, natural.

BAD EXAMPLES (never generate questions like these):
- "What decisions were made about the police station in ${town}?"
- "What is the history of zoning variances in ${town}?"
- "How does the budget affect ${town} residents?"
- "Summarize recent municipal activity in ${town}."
- "What was the total estimated cost of the construction bond?" (if the summary only says a bond was avoided, without stating a cost)

GOOD EXAMPLES (generate questions like these):
- "Which paving projects lost $300,000 to fund the new police station?"
- "Who purchased the old police station for $363,500?"
- "Why aren't commercial mulch yards classified in the zoning ordinance?"
- "Are there other town facilities being upgraded with ARPA funds right now?"

Respond with JSON only:
{
  "sections": [
    {
      "topic": "exact topic title from the list above",
      "questions": ["question 1", "question 2", "question 3"]
    }
  ],
  "highLevelQuestions": ["cross-cutting question 1", "cross-cutting question 2", "cross-cutting question 3"]
}

Generate 2-3 questions per topic and 2-3 high-level questions that cut across multiple topics.`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.4,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            sections: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  topic: { type: "string" as const },
                  questions: { type: "array" as const, items: { type: "string" as const } },
                },
                required: ["topic", "questions"],
              },
            },
            highLevelQuestions: {
              type: "array" as const,
              items: { type: "string" as const },
            },
          },
          required: ["sections", "highLevelQuestions"],
        },
      },
    });

    const rawText = response.text || "{}";
    logDebug(`[contentGeneration] Curiosity questions raw (${rawText.length} chars): ${rawText.slice(0, 300)}`);
    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`JSON parse failed: ${String(parseErr)}`);
      }
    }

    const sections = (parsed.sections || []).map((s: any) => ({
      topic: String(s.topic || ""),
      questions: Array.isArray(s.questions) ? s.questions.map(String).slice(0, 3) : [],
    }));

    const highLevelQuestions = Array.isArray(parsed.highLevelQuestions)
      ? parsed.highLevelQuestions.map(String).slice(0, 3)
      : [];

    if (sections.every((s: any) => s.questions.length === 0) && highLevelQuestions.length === 0) {
      throw new Error("LLM returned empty questions");
    }

    logInfo(`[contentGeneration] Generated curiosity questions: ${sections.length} sections, ${highLevelQuestions.length} high-level`);
    return { sections, highLevelQuestions };
  } catch (error) {
    logError(`[contentGeneration] Curiosity question generation failed`, { error: String(error) });
    return {
      sections: highScoringTopics.map(t => ({
        topic: t.topic,
        questions: [`What led to the decision on ${t.topic}?`, `What happens next with ${t.topic}?`],
      })),
      highLevelQuestions: [`What should ${town} residents watch for in the coming months?`],
    };
  }
}

export async function runContentGenerationPipeline(town: string): Promise<{
  title: string;
  summary: string;
  topics: ScoredTopic[];
  routineTopics: RoutineTopic[];
  sourceMinutesIds: string[];
}> {
  logInfo(`[contentGeneration] Starting pipeline for ${town}`);

  const { topics: rawTopics, sourceMinutesIds } = await extractTopicsFromMinutes(town);

  if (rawTopics.length === 0) {
    return {
      title: `${town} Municipal Update`,
      summary: `No recent meeting minutes were found for ${town} in the last 30 days.`,
      topics: [],
      routineTopics: [],
      sourceMinutesIds,
    };
  }

  const scoredTopics = await judgeStoryWorthiness(rawTopics);

  const highScoring = scoredTopics.filter(t => t.score >= 8);
  const lowScoring = scoredTopics.filter(t => t.score < 8);

  const enrichedHighScoring = highScoring.length > 0
    ? await enrichWithHistoricalContext(highScoring, town)
    : [];

  const routineTopics = formatRoutineRollup(lowScoring);

  const summary = await generateSummary(enrichedHighScoring, routineTopics, town);

  const title = enrichedHighScoring.length > 0
    ? `${town}: ${enrichedHighScoring[0].topic}`
    : `${town} Municipal Update`;

  logInfo(`[contentGeneration] Pipeline complete for ${town}: ${enrichedHighScoring.length} high-scoring, ${routineTopics.length} routine`);

  return {
    title,
    summary,
    topics: enrichedHighScoring,
    routineTopics,
    sourceMinutesIds,
  };
}

export async function scoreArticleRelevancy(
  articles: TownFeedNewsArticle[],
  topics: ScoredTopic[],
  town: string
): Promise<TownFeedNewsArticle[]> {
  if (articles.length === 0) return [];

  const topicSummaries = topics.map((t, i) =>
    `${i + 1}. "${t.topic}" — ${t.keyPoints.slice(0, 3).join("; ")}`
  ).join("\n");

  const articleSummaries = articles.map((a, i) =>
    `${i + 1}. [${a.source}] "${a.title}" — ${a.snippet.slice(0, 200)}`
  ).join("\n");

  const prompt = `You are evaluating the relevancy of news articles to municipal meeting topics from ${town}, New Hampshire.

CRITICAL: Geographic relevance is essential. These topics are specifically about ${town}, NH.

For each article, score how relevant it is to the topics on a scale of 1-10:
- 10: Directly covers the same issue in ${town}, references the same entities/decisions
- 7-9: Strongly related to the same issue in ${town}, provides meaningful additional context
- 4-6: Related topic in the same geographic region (Carroll County, Lakes Region) but not specifically about ${town}
- 1-3: Same general theme (e.g., "police station") but about a DIFFERENT town or unrelated location — these must score low regardless of topic similarity

An article about a police station in Wolfeboro is NOT relevant to a police station topic in ${town}. An article about zoning in Conway is NOT relevant to a zoning topic in ${town}. The town must match for a score of 7 or above.

TOPICS FROM ${town.toUpperCase()} MUNICIPAL MEETINGS:
${topicSummaries}

NEWS ARTICLES TO SCORE:
${articleSummaries}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            scores: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  index: { type: "number" as const },
                  relevancyScore: { type: "number" as const },
                },
                required: ["index", "relevancyScore"],
              },
            },
          },
          required: ["scores"],
        },
      },
    });

    const rawText = response.text || "{}";
    const parsed = JSON.parse(rawText);
    const scores = parsed.scores || [];

    const scored = articles.map((a, i) => {
      const scoreData = scores.find((s: any) => s.index === i + 1);
      return {
        ...a,
        relevancyScore: Math.max(1, Math.min(10, Math.round(scoreData?.relevancyScore ?? 1))),
      };
    });

    scored.sort((a, b) => (b.relevancyScore ?? 0) - (a.relevancyScore ?? 0));

    const top5 = scored.slice(0, 5);
    logInfo(`[contentGeneration] Scored ${scored.length} articles, keeping top 5, ${top5.filter(a => (a.relevancyScore ?? 0) >= 7).length} high-relevancy`);
    return top5;
  } catch (error) {
    logError(`[contentGeneration] Article relevancy scoring failed`, { error: String(error) });
    return articles.map(a => ({ ...a, relevancyScore: 1 }));
  }
}

export async function regenerateSummaryWithNews(item: TownFeedItem): Promise<string> {
  const topics = (item.topics || []) as ScoredTopic[];
  const routineTopics = (item.routineTopics || []) as RoutineTopic[];
  const newsArticles = (item.newsArticles || []) as TownFeedNewsArticle[];

  const highScoringTopics = topics.filter(t => t.score >= 8);
  const topArticles = newsArticles
    .filter(a => (a.relevancyScore ?? 0) >= 7)
    .sort((a, b) => (b.relevancyScore ?? 0) - (a.relevancyScore ?? 0))
    .slice(0, 5);

  const highTopicText = highScoringTopics.map((t, i) => {
    const ctx = t.historicalContext ? `\n   Historical context: ${t.historicalContext}` : "";
    return `${i + 1}. "${t.topic}" (Score: ${t.score}/10, Board: ${t.board || "unknown"})
   Key points: ${t.keyPoints.join("; ")}${ctx}`;
  }).join("\n\n");

  const routineText = routineTopics.map(r => `- ${r.rollupSentence}`).join("\n");

  const newsText = topArticles.map((a, i) =>
    `${i + 1}. [${a.source}] "${a.title}" (Relevancy: ${a.relevancyScore}/10)\n   ${a.snippet}`
  ).join("\n\n");

  const prompt = `You are a municipal affairs reporter covering ${item.town}, New Hampshire. Write a factual summary of recent board and committee actions, incorporating relevant local news reporting. Your writing must be dry, neutral, and precise — like a wire service report, not a newsletter.

STRICT TONE RULES:
- Never use exclamation marks
- Never use rhetorical questions
- Never use conversational phrases like "Let's dive in," "Here's what you need to know," "Big news," or "Stay tuned"
- Never use subjective adjectives: "exciting," "impressive," "concerning," "remarkable," "important," "significant"
- Never title the piece with the town name followed by an exclamation mark or informal phrasing
- Do NOT write: "Big changes are coming to ${item.town}!" or "${item.town} Update!"
- DO write: "The ${item.town} Select Board approved a $2.1M bond for road repairs at its Feb. 12 meeting."

HIGH-PRIORITY TOPICS:
${highTopicText || "(None — all topics were routine this period)"}

RELEVANT LOCAL NEWS ARTICLES (incorporate key facts from these):
${newsText || "(No relevant news articles found)"}

ROUTINE ITEMS:
${routineText || "(None)"}

Structure:
- Open with the most consequential action taken, stated as a single declarative sentence
- One topic per paragraph, 2-4 sentences each
- For each topic: what was decided, by whom, and what changes for residents
- Use "Why it matters:" as a label before a single factual sentence where relevant — never as editorial commentary
- When citing a fact from a news article, attribute it inline: "as reported by the Conway Daily Sun" or "according to the Carroll County Independent"
- Only attribute facts from news articles, not from meeting minutes
- Bold names, dollar figures, vote counts, and dates
- End with "Also on the agenda:" followed by routine items, each in one sentence
- 400-800 words
- Always finish the full summary — do not stop mid-sentence or mid-section`;

  try {
    const response = await ai.models.generateContent({
      model: SUMMARY_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.2, maxOutputTokens: 8192 },
    });

    const summary = response.text || "Unable to generate summary.";
    logInfo(`[contentGeneration] Regenerated summary with news for ${item.town} (${summary.length} chars, ${topArticles.length} articles incorporated)`);
    return summary.trim();
  } catch (error) {
    logError(`[contentGeneration] Summary regeneration with news failed for ${item.town}`, { error: String(error) });
    throw error;
  }
}
