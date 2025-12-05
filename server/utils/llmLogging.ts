/**
 * LLM Call Logging Utilities
 * 
 * Provides structured logging for all LLM (Gemini) calls in the chat pipeline.
 * Logs both requests (prompts, model, settings) and responses (truncated output).
 * 
 * SAFETY CONSTRAINTS:
 * - System prompts and user prompts are truncated to prevent log bloat
 * - Response content is truncated
 * - No API keys or auth tokens are logged
 */

import { logDebug, truncate, sanitizeUserContent, type LogContext } from "./logger";

export interface LlmLogParams {
  requestId?: string;
  sessionId?: string;
  stage: string;
  model: string;
  systemPrompt?: string;
  userPrompt?: string;
  temperature?: number;
  extra?: Record<string, any>;
}

/**
 * Log an LLM request before making the API call
 * Captures the stage, model, prompts (truncated), and any extra context
 */
export function logLlmRequest(params: LlmLogParams): void {
  const { 
    requestId, 
    sessionId, 
    stage, 
    model, 
    systemPrompt, 
    userPrompt, 
    temperature,
    extra 
  } = params;
  
  const context: LogContext = {
    requestId,
    sessionId,
    stage,
    model,
    temperature,
    ...extra,
  };

  if (systemPrompt) {
    context.systemPrompt = truncate(systemPrompt, 800);
  }
  if (userPrompt) {
    context.userPrompt = sanitizeUserContent(userPrompt, 400);
  }

  logDebug("llm_request", context);
}

export interface LlmResponseLogParams {
  requestId?: string;
  sessionId?: string;
  stage: string;
  model: string;
  responseText?: string;
  durationMs?: number;
  tokenCount?: number;
  extra?: Record<string, any>;
}

/**
 * Log an LLM response after receiving it
 * Captures the stage, model, truncated response, and timing info
 */
export function logLlmResponse(params: LlmResponseLogParams): void {
  const { 
    requestId, 
    sessionId, 
    stage, 
    model, 
    responseText,
    durationMs,
    tokenCount,
    extra 
  } = params;
  
  const context: LogContext = {
    requestId,
    sessionId,
    stage,
    model,
    durationMs,
    tokenCount,
    ...extra,
  };

  if (responseText) {
    context.responseSnippet = truncate(responseText, 1500);
    context.responseLength = responseText.length;
  }

  logDebug("llm_response", context);
}

/**
 * Log an LLM error
 */
export function logLlmError(params: {
  requestId?: string;
  sessionId?: string;
  stage: string;
  model: string;
  error: Error | string;
}): void {
  const { requestId, sessionId, stage, model, error } = params;
  
  logDebug("llm_error", {
    requestId,
    sessionId,
    stage,
    model,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
  });
}
