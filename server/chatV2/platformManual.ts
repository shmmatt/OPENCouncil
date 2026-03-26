/**
 * OPENCouncil Platform Manual — Chat Context Injection
 *
 * This module provides:
 *  1. The authoritative platform manual text (OPENCOUNCIL_PLATFORM_MANUAL)
 *  2. A fast, zero-cost keyword detector (detectPlatformQuery) that identifies
 *     when a user is asking about the OPENCouncil platform itself rather than
 *     researching a specific municipal topic.
 *
 * DESIGN NOTES
 * - No LLM call is made; a tight regex battery is sufficient because platform
 *   meta-questions are highly predictable and platform-specific vocabulary
 *   (e.g., "opencouncil", "message quota") rarely appears in research queries.
 * - A town-name guard prevents false positives when the user mentions a
 *   Carroll County town alongside a platform-flavored word.
 */

// ---------------------------------------------------------------------------
// Carroll County town names — used to suppress false-positive detection when
// the user mentions a town alongside a platform keyword.
// ---------------------------------------------------------------------------
const CARROLL_COUNTY_TOWNS = [
  "conway", "north conway", "ossipee", "tamworth", "madison", "moultonborough",
  "sandwich", "freedom", "effingham", "chatham", "albany", "bartlett",
  "jackson", "hart's location", "harts location",
];

function containsTownName(question: string): boolean {
  const q = question.toLowerCase();
  return CARROLL_COUNTY_TOWNS.some((town) => q.includes(town));
}

// ---------------------------------------------------------------------------
// Platform-signal patterns.  Every pattern here is unambiguous on its own;
// none requires a town-name exclusion because they are already specific enough.
// Patterns that COULD appear in a research question (e.g. "what towns …") are
// excluded — the town-name guard handles the few remaining edge cases.
// ---------------------------------------------------------------------------
const PLATFORM_PATTERNS: RegExp[] = [
  // The product name — always safe
  /\bopencouncil\b/i,

  // Message quota / limits
  /\bhow many (?:messages?|queries|chats?)\b/i,
  /\bmessage(?:s)? (?:quota|limit|allowance|left|remaining|count)\b/i,
  /\bquery (?:quota|limit|allowance|left|remaining|count)\b/i,
  /\b(?:messages?|queries) (?:do i get|did i get|have i got|have i used|are left|remain(?:ing)?)\b/i,

  // Subscription / pricing
  /\bsubscri(?:ption|be)\b/i,
  /\bhow much does (?:this|it) cost\b/i,
  /\bhow much is (?:this|it|the (?:pro|premium|paid) (?:plan|tier))\b/i,
  /\bdo you charge\b/i,
  /\bpaid (?:plan|tier|subscription|account)\b/i,
  /\bfree (?:tier|plan|trial|account)\b/i,
  /\bpro (?:plan|tier|account|upgrade)\b/i,

  // Authorship / operators
  /\bwho (?:made|built|created|runs|manages|operates|is behind) (?:this|it|opencouncil)\b/i,

  // How the system works (closed question — no entity follows)
  /\bhow does (?:this(?: system| platform| tool| app)?|it|the system|the (?:chat|search|ai)) work\b/i,
  /\bhow (?:does|do) (?:the )?(?:search|retrieval|rag|ai|pipeline) work\b/i,

  // Crawling / update frequency
  /\bhow (?:often|frequently) (?:do you|does (?:opencouncil|it|the system)) (?:crawl|update|refresh|check)\b/i,

  // "About" the platform
  /\babout (?:opencouncil|yourself|this (?:system|platform|tool|website|app|service))\b/i,

  // Contact
  /\bcontact (?:you|support|opencouncil|the team|someone)\b/i,
  /\binfo@/i,

  // "What is this" — safe because it refers to "this" (the current tool)
  /\bwhat (?:is|are) (?:this|opencouncil)\b/i,
];

/**
 * Returns true when the question appears to be asking about the OPENCouncil
 * platform itself rather than a specific municipal topic.
 *
 * The check runs before the RAG pipeline — no LLM call needed.
 *
 * False-positive prevention:
 *  - Patterns are tight and platform-specific.
 *  - If the question also mentions a Carroll County town name AND the matched
 *    pattern is one of the weaker "topic-agnostic" patterns, the town guard
 *    suppresses the result so the RAG pipeline handles it alone.
 */
export function detectPlatformQuery(question: string): boolean {
  for (const pattern of PLATFORM_PATTERNS) {
    if (pattern.test(question)) {
      // "opencouncil" and contact patterns are unambiguous — always inject.
      const alwaysTrigger = /\bopencouncil\b|info@|subscri(?:ption|be)|\bwho (?:made|built|created|runs|manages|operates|is behind)/i;
      if (alwaysTrigger.test(question)) return true;

      // For other patterns: suppress if the question also names a local town,
      // because the user is probably asking about that town's process,
      // not the platform architecture.
      if (containsTownName(question)) return false;

      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The OPENCouncil System Manual
// This text is injected verbatim into the synthesizer system prompt when
// detectPlatformQuery returns true.  Keep it factual and concise.
// ---------------------------------------------------------------------------
export const OPENCOUNCIL_PLATFORM_MANUAL = `
# OPENCouncil — Platform Reference

## 1. What Is OPENCouncil?
OPENCouncil is an AI-powered civic intelligence platform for New Hampshire municipalities. It continuously crawls, OCR-processes, and indexes public government documents — meeting minutes, agendas, budgets, warrant articles, zoning ordinances, and more — then makes them searchable and explainable through a conversational AI interface.

The platform's mission is radical municipal transparency: every resident, reporter, or business owner should be able to ask a plain-English question and get an evidence-grounded answer drawn directly from official town records.

## 2. Geographic Coverage
OPENCouncil currently focuses on **Carroll County, NH**, indexing documents from the following communities:
- Conway (including North Conway)
- Ossipee
- Tamworth
- Madison
- Moultonborough
- Sandwich
- Freedom
- Effingham
- Chatham
- Albany
- Bartlett
- Jackson
- Hart's Location

Coverage of additional NH counties is planned for future releases.

## 3. What Documents Are Indexed?
The system ingests documents published by town boards and committees, including but not limited to:
- **Select Board** minutes and agendas
- **Planning Board** minutes, agendas, and site plan applications
- **Zoning Board of Adjustment** decisions and meeting records
- **Conservation Commission** minutes
- **Budget Committee** reports and proposed operating budgets
- **Town Meeting** warrant articles, ballots, and results
- **School Board** minutes (where published)
- **Annual Reports** and audited financial statements
- **Ordinances, bylaws, and zoning regulations**

Documents are fetched from official town websites, scanned for text via OCR when necessary, chunked, and embedded into a vector database. New documents are typically picked up within a few days of being posted publicly.

## 4. How the AI Works (RAG Pipeline)
OPENCouncil uses a **Retrieval-Augmented Generation (RAG)** architecture:
1. **Planning** — The AI analyzes your question and builds a retrieval plan (topics, entities, time filters).
2. **Retrieval** — Relevant document chunks are fetched from a pgvector database of town records plus a New Hampshire state law corpus (RSA, OPLR handbooks, etc.).
3. **Synthesis** — A large language model (Google Gemini) reads the retrieved chunks and writes a direct, cited answer.
4. **Audit** — A second pass checks for hallucination risk and citation accuracy.

The AI cites the specific documents it draws from. If the records don't contain the answer, it will say so rather than guess.

## 5. Message Quotas
OPENCouncil uses a tiered access model:
- **Guest users** (no account): Limited to a small number of free queries per session (typically 3–5) before being prompted to sign up.
- **Free tier** (email registration): A fixed number of queries per month (displayed in the usage meter in the top navigation bar).
- **Pro subscribers**: Unlimited queries.

The usage meter in the header shows remaining messages and resets on a monthly cycle. If you have hit your limit, upgrading to Pro or waiting for the monthly reset will restore access.

## 6. Subscriptions and Pricing
OPENCouncil offers a Free tier (email registration required) and a Pro subscription. Exact pricing is displayed on the upgrade page inside the app. For billing questions, contact the team directly (see Section 9).

## 7. Limitations and Power-User Tips
- **Broad questions get broad answers.** If you ask "What has the Planning Board done?" you may get a summary overview. For richer detail, narrow the scope: "What did the Conway Planning Board decide about the Settlers' Green expansion in 2024?" yields a much more precise answer.
- **Very recent documents** (published within the last few days) may not yet be indexed.
- **Handwritten or low-quality scanned documents** are processed via OCR; accuracy depends on scan quality. Heavily degraded pages may produce incomplete text.
- **The AI does not have access to real-time data**, live town websites, or any information outside the indexed document corpus plus its general training knowledge. It will not retrieve information from links.
- **New Hampshire RSA references** — The system has a dedicated NH state law corpus for RSA lookups (e.g., RSA 91-A, the Right-to-Know Law). Ask directly and it will cite chapter and section.
- **Executive session / non-public records** are never published by towns and therefore not indexed.

## 8. Data Freshness
The crawler runs on a regular schedule (approximately daily for active towns). Each document version is timestamped. You can ask "What is the most recent document available for [town] [board]?" to check the freshness of indexed content.

## 9. Contact and Support
For questions, bug reports, feature requests, or billing help, contact the OPENCouncil team at **info@opencouncil.co**. Response times are typically within one business day.

---
*IMPORTANT INSTRUCTION FOR AI: Surface the contact email (info@opencouncil.co) ONLY when the user explicitly asks how to get in touch with the OPENCouncil team or asks for contact information. Do NOT include it in research answers or general platform descriptions unless directly asked.*
`;
