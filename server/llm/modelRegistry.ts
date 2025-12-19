/**
 * Model Registry - Centralized model selection for OpenCouncil LLM pipeline
 * 
 * Implements a model regime that balances quality and speed:
 * - Fast models (gemini-2.5-flash) for control steps
 * - High-quality models (gemini-3-flash-preview) for final synthesis
 * - Escalation rules for complex/high-impact questions
 * - Safe fallbacks on errors
 */

export type ModelStage = 
  | 'router'
  | 'retrievalPlanner'
  | 'simpleAnswer'
  | 'complexSummary'
  | 'complexSynthesis'
  | 'critic'
  | 'evidenceGate'
  | 'followups'
  | 'degraded';

export interface ModelContext {
  complexity?: 'simple' | 'complex';
  requiresComposedAnswer?: boolean;
  hasUserArtifact?: boolean;
  scopeHint?: 'local' | 'statewide' | 'mixed' | null;
}

export interface ModelSelection {
  model: string;
  wasEscalated: boolean;
  escalationReason?: string;
}

const MODELS = {
  FAST: 'gemini-2.5-flash',
  HIGH_QUALITY: 'gemini-3-flash-preview',
} as const;

const ENV_OVERRIDES: Record<ModelStage, string> = {
  router: 'MODEL_ROUTER',
  retrievalPlanner: 'MODEL_PLANNER',
  simpleAnswer: 'MODEL_SIMPLE',
  complexSummary: 'MODEL_COMPLEX_SUMMARY',
  complexSynthesis: 'MODEL_COMPLEX_SYNTHESIS',
  critic: 'MODEL_CRITIC',
  evidenceGate: 'MODEL_EVIDENCE_GATE',
  followups: 'MODEL_FOLLOWUPS',
  degraded: 'MODEL_DEGRADED',
};

const SIMPLE_ESCALATE_ENV = 'MODEL_SIMPLE_ESCALATE';

const DEFAULT_MODELS: Record<ModelStage, string> = {
  router: MODELS.FAST,
  retrievalPlanner: MODELS.FAST,
  simpleAnswer: MODELS.FAST,
  complexSummary: MODELS.FAST,
  complexSynthesis: MODELS.HIGH_QUALITY,
  critic: MODELS.FAST,
  evidenceGate: MODELS.FAST,
  followups: MODELS.FAST,
  degraded: MODELS.FAST,
};

function getEnvOverride(stage: ModelStage): string | undefined {
  const envKey = ENV_OVERRIDES[stage];
  return process.env[envKey];
}

function getSimpleEscalationModel(): string {
  return process.env[SIMPLE_ESCALATE_ENV] || MODELS.HIGH_QUALITY;
}

/**
 * Determines if simple answer should escalate to high-quality model
 */
function shouldEscalateSimpleAnswer(ctx: ModelContext): { escalate: boolean; reason?: string } {
  if (ctx.requiresComposedAnswer === true) {
    return { escalate: true, reason: 'requiresComposedAnswer' };
  }
  
  if (ctx.hasUserArtifact === true) {
    return { escalate: true, reason: 'hasUserArtifact' };
  }
  
  return { escalate: false };
}

/**
 * Get the appropriate model for a pipeline stage
 * 
 * @param stage - The pipeline stage
 * @param ctx - Context about the current request
 * @returns Model selection with escalation info
 */
export function getModelForStage(stage: ModelStage, ctx: ModelContext = {}): ModelSelection {
  const envOverride = getEnvOverride(stage);
  if (envOverride) {
    return {
      model: envOverride,
      wasEscalated: false,
    };
  }

  if (stage === 'simpleAnswer') {
    const { escalate, reason } = shouldEscalateSimpleAnswer(ctx);
    if (escalate) {
      return {
        model: getSimpleEscalationModel(),
        wasEscalated: true,
        escalationReason: reason,
      };
    }
  }

  return {
    model: DEFAULT_MODELS[stage],
    wasEscalated: false,
  };
}

/**
 * Get the fallback model for retry scenarios
 */
export function getFallbackModel(): string {
  return process.env['MODEL_DEGRADED'] || MODELS.FAST;
}

/**
 * Model names for reference
 */
export const ModelNames = MODELS;
