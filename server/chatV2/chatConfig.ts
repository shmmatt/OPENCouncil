/**
 * Chat Pipeline V2 Configuration
 * Centralized settings for the chat pipeline behavior and optimizations.
 */

export const chatConfig = {
  /**
   * When false, skips the critic LLM call entirely for complex answers.
   * The draft answer from synthesis is used directly as the final answer.
   * This significantly reduces latency (saves ~10-15s per complex question).
   */
  ENABLE_COMPLEX_CRITIC: false,

  /**
   * Only run critic if draft answer exceeds this character length.
   * Only applies when ENABLE_COMPLEX_CRITIC is true.
   */
  CRITIC_MIN_ANSWER_LENGTH: 4000,

  /**
   * High-risk terms that should trigger critic even for shorter answers.
   * Only applies when ENABLE_COMPLEX_CRITIC is true.
   */
  CRITIC_HIGH_RISK_TERMS: [
    "lawsuit",
    "liability",
    "damages",
    "sue",
    "legal action",
    "court",
    "attorney",
    "negligence",
  ],

  /**
   * Maximum question length for considering router bypass.
   * Questions shorter than this may skip the router for follow-ups.
   */
  ROUTER_BYPASS_MAX_QUESTION_LENGTH: 120,

  /**
   * Patterns that indicate a trivial follow-up question.
   * Case-insensitive matching at the start of the question.
   */
  ROUTER_BYPASS_PATTERNS: [
    "so ",
    "so then",
    "otherwise",
    "does that mean",
    "then ",
    "if so",
    "and if",
    "what about",
    "how about",
    "but what if",
    "is that",
    "would that",
    "could that",
    "should that",
    "can i",
    "can we",
    "can they",
  ],

  /**
   * Maximum number of retrieval passes for complex questions.
   * Set to 1 for single-pass retrieval (faster), 2-3 for multi-pass (more thorough).
   */
  MAX_RETRIEVAL_PASSES: 1,

  /**
   * Number of history turns to include in router/answer prompts.
   * Lower = faster/cheaper, higher = more context.
   */
  MAX_HISTORY_TURNS_FOR_ROUTER: 2,
  MAX_HISTORY_TURNS_FOR_ANSWER: 4,

  // =====================================================
  // EVIDENCE COVERAGE GATE SETTINGS
  // =====================================================

  /**
   * Enable Evidence Coverage Gate to evaluate retrieval quality
   * and trigger additional retrieval passes when needed.
   */
  ENABLE_EVIDENCE_GATE: true,

  /**
   * Maximum additional retrieval passes the gate can trigger.
   * Keeps costs bounded while allowing for evidence expansion.
   */
  MAX_COVERAGE_RETRIEVAL_PASSES: 2,

  /**
   * Maximum combined chunks from all retrieval passes.
   * Prevents token bloat in synthesis prompts.
   */
  MAX_COMBINED_CHUNKS: 40,

  /**
   * Minimum coverage score to skip expansion.
   * Below this threshold, the gate will recommend additional passes.
   */
  MIN_COVERAGE_SCORE_FOR_SKIP: 0.7,

  /**
   * Question intents that typically require broader coverage.
   * These will be more likely to trigger retrieval expansion.
   */
  BROAD_COVERAGE_INTENTS: [
    "mechanism",
    "breakdown", 
    "why",
    "compare",
    "process",
    "mixed",
  ],

  // =====================================================
  // TWO-LANE RETRIEVAL SETTINGS
  // =====================================================

  /**
   * Enable parallel local + statewide retrieval.
   * When true, both lanes run in parallel for most queries.
   * This ensures RSA/statewide context is retrieved alongside local docs.
   */
  ENABLE_PARALLEL_STATE_LANE: true,

  /**
   * Maximum chunks to retrieve from the local lane before capping.
   * Local lane focuses on town-specific documents.
   */
  LOCAL_LANE_K: 12,

  /**
   * Maximum chunks to retrieve from the state lane before capping.
   * State lane focuses on RSA, NHMA, and statewide guidance.
   */
  STATE_LANE_K: 8,

  /**
   * Maximum local chunks to pass to synthesis after retrieval.
   * Caps prevent prompt bloat.
   */
  LOCAL_CONTEXT_CAP: 10,

  /**
   * Maximum state chunks to pass to synthesis after retrieval.
   * State context is typically more concise.
   */
  STATE_CONTEXT_CAP: 5,

  /**
   * Maximum merged chunks from both lanes after deduplication.
   * Target is 15, but can go higher for complex questions.
   */
  MERGED_CONTEXT_CAP: 15,

  /**
   * When true, skip state lane for purely local questions
   * (e.g., "what time was the meeting called to order").
   * Default false - state lane is cheap and often useful.
   */
  SKIP_STATE_LANE_FOR_TRIVIAL_LOCAL: false,
};

/**
 * Check if the critic should run for a given draft answer and question.
 */
export function shouldRunCritic(
  draftAnswerLength: number,
  question: string
): boolean {
  if (!chatConfig.ENABLE_COMPLEX_CRITIC) {
    return false;
  }

  if (draftAnswerLength > chatConfig.CRITIC_MIN_ANSWER_LENGTH) {
    return true;
  }

  const lowerQuestion = question.toLowerCase();
  return chatConfig.CRITIC_HIGH_RISK_TERMS.some((term) =>
    lowerQuestion.includes(term.toLowerCase())
  );
}
