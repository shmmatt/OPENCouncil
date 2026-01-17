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

  // =====================================================
  // DEEP ANSWER / CHARACTER CAP SETTINGS
  // =====================================================

  /**
   * Enable the Deep Answer toggle feature.
   * When false, the toggle is hidden in UI and answerMode is forced to "standard".
   * Set to false to disable as a premium feature.
   */
  DEEP_ANSWER_ENABLED: true,

  /**
   * Character caps for different paths and modes.
   * These are now defined in answerPolicy.ts - kept here for backward compat.
   * @deprecated Use getAnswerPolicy() from answerPolicy.ts instead
   */
  CHAR_CAPS: {
    simple: {
      standard: 950,
      deep: 1700,
    },
    complex: {
      standard: 1900,
      deep: 5400,
    },
  },

  /**
   * Coverage score thresholds for "What we couldn't confirm" section.
   */
  COVERAGE_THRESHOLD_STANDARD: 0.7,
  COVERAGE_THRESHOLD_DEEP: 0.85,

  // =====================================================
  // SITUATION ANCHORING / TOPIC CONTINUITY SETTINGS
  // =====================================================

  /**
   * Enable situation anchoring to maintain topic continuity.
   * When true, the assistant will track the current situation and
   * prefer on-topic chunks during retrieval.
   */
  ENABLE_SITUATION_ANCHORING: true,

  /**
   * Use LLM for situation extraction (more accurate but slower).
   * When false, uses fast heuristic-based extraction only.
   */
  ENABLE_LLM_SITUATION_EXTRACTION: false,

  /**
   * Weight multiplier for situation-matching chunks during re-ranking.
   * Higher values make on-topic chunks more likely to appear in context.
   * Range: 0.0 (disabled) to 1.0 (strong preference)
   */
  SITUATION_MATCH_WEIGHT: 0.3,

  /**
   * Minimum percentage of on-topic chunks to include in context.
   * If situation context exists and matching chunks are available,
   * at least this percentage will be from on-topic sources.
   * Range: 0.0 to 1.0
   */
  MIN_ON_TOPIC_CHUNK_RATIO: 0.4,

  /**
   * Enable post-generation drift detection.
   * When true, checks if the answer drifted to unrelated topics
   * and attempts to regenerate with stricter anchoring.
   */
  ENABLE_DRIFT_DETECTION: true,

  /**
   * Maximum regeneration attempts when drift is detected.
   */
  MAX_DRIFT_REGENERATION_ATTEMPTS: 1,
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

/**
 * Get the character cap for a given complexity and answer mode.
 */
export function getCharacterCap(
  complexity: "simple" | "complex",
  answerMode: "standard" | "deep"
): number {
  return chatConfig.CHAR_CAPS[complexity][answerMode];
}

/**
 * Get length targets for prompts (soft targets).
 */
export function getLengthTargets(
  complexity: "simple" | "complex",
  answerMode: "standard" | "deep"
): { description: string; charMax: number } {
  if (complexity === "simple") {
    if (answerMode === "standard") {
      return { description: "target 2-4 sentences, max 900 chars", charMax: 900 };
    } else {
      return { description: "target 5-8 sentences, max 1600 chars", charMax: 1600 };
    }
  } else {
    if (answerMode === "standard") {
      return { description: "target ~250-400 words, max 1800 chars", charMax: 1800 };
    } else {
      return { description: "target ~600-900 words, max 5200 chars", charMax: 5200 };
    }
  }
}

/**
 * Validate and normalize answerMode from request.
 * Returns "standard" if deep answer is disabled or invalid input.
 */
export function validateAnswerMode(
  inputMode: string | undefined
): "standard" | "deep" {
  if (!chatConfig.DEEP_ANSWER_ENABLED) {
    return "standard";
  }
  if (inputMode === "deep") {
    return "deep";
  }
  return "standard";
}
