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
