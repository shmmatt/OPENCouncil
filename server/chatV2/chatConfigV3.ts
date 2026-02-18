/**
 * Chat Pipeline V3 Configuration
 * Settings specific to the v3 orchestrated pipeline (Plan → Retrieve → Synthesize → Audit)
 */

export const chatConfigV3 = {
  // =====================================================
  // V3 PIPELINE TOGGLE
  // =====================================================

  /**
   * Enable the v3 pipeline (Plan → Retrieve → Synthesize → Audit)
   * When false, falls back to the unified v2 pipeline
   */
  ENABLE_V3_PIPELINE: true,

  // =====================================================
  // PLANNER V3 SETTINGS
  // =====================================================

  /**
   * Maximum queries per lane to prevent query explosion
   */
  MAX_QUERIES_PER_LANE: 6,

  /**
   * Default K (documents to retrieve) for local lane
   */
  DEFAULT_LOCAL_K: 12,

  /**
   * Default K (documents to retrieve) for state lane  
   */
  DEFAULT_STATE_K: 8,

  /**
   * Default cap (documents to keep after ranking) for local lane
   */
  DEFAULT_LOCAL_CAP: 10,

  /**
   * Default cap (documents to keep after ranking) for state lane
   */
  DEFAULT_STATE_CAP: 5,

  /**
   * Planner confidence threshold below which to use conservative plan
   */
  LOW_CONFIDENCE_THRESHOLD: 0.4,

  // =====================================================
  // RETRIEVAL V3 SETTINGS
  // =====================================================

  /**
   * Enable early exit when sufficient good chunks found
   * After first 2 queries, if we have enough high-quality chunks, skip remaining
   */
  ENABLE_EARLY_EXIT: true,

  /**
   * Minimum merged chunk count to trigger early exit
   */
  EARLY_EXIT_MIN_CHUNKS: 8,

  /**
   * Minimum alignment score for a chunk to be considered "good"
   */
  GOOD_CHUNK_ALIGNMENT_THRESHOLD: 0.5,

  /**
   * Minimum legal topic match for state chunk to satisfy minState
   * Chunks must match at least one legal topic or general terms
   */
  STATE_RELEVANCE_BAR_KEYWORDS: [
    'municipal liability',
    'ADA',
    'building code',
    'RSA',
    'compliance',
    'ordinance',
    'zoning',
    'variance',
    'permit',
    'governmental immunity',
    'negligence',
  ],

  // =====================================================
  // SYNTHESIS V3 SETTINGS
  // =====================================================

  /**
   * Character target range for standard answers
   */
  SYNTHESIS_CHAR_TARGET_MIN: 800,
  SYNTHESIS_CHAR_TARGET_MAX: 1500,

  /**
   * Maximum characters for session source text in synthesis prompt
   */
  MAX_SESSION_SOURCE_CHARS: 12000,

  /**
   * Maximum characters per chunk in synthesis prompt
   */
  MAX_CHUNK_CHARS: 2000,

  // =====================================================
  // AUDIT V3 SETTINGS
  // =====================================================

  /**
   * Enable post-generation audit pass
   */
  ENABLE_AUDIT: true,

  /**
   * Maximum repair attempts (1 means one retry if audit fails)
   */
  MAX_REPAIR_ATTEMPTS: 1,

  /**
   * Enable observability debug output in responses (dev/admin only)
   */
  ENABLE_DEBUG_OUTPUT: process.env.NODE_ENV !== 'production',

  // =====================================================
  // RECORD STRENGTH TIER THRESHOLDS
  // =====================================================

  /**
   * Tier A requirements
   */
  TIER_A_MIN_LOCAL: 5,
  TIER_A_MIN_STATE: 3,
  TIER_A_MIN_ALIGNMENT: 0.6,

  /**
   * Tier B requirements (below A, above C)
   */
  TIER_B_MIN_LOCAL: 3,
  TIER_B_MIN_STATE: 2,
  TIER_B_MIN_ALIGNMENT: 0.4,

  // =====================================================
  // COVERAGE SETTINGS
  // =====================================================

  /**
   * Minimum state chunks to guarantee when legal salience >= 0.5
   * Only applies if state candidates actually exist
   */
  MIN_STATE_FOR_LEGAL_QUESTIONS: 3,

  /**
   * Minimum local fact chunks to always try to include
   */
  MIN_LOCAL_FACTS: 2,
};
