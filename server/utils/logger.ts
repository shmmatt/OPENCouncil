/**
 * Global Logging Utility for Chat Pipeline Observability
 * 
 * This module provides structured logging for the chat v2 pipeline and related services.
 * All logs are formatted as JSON for easy parsing and can be filtered by level.
 * 
 * Environment Variables:
 * - LOG_LEVEL: Controls minimum log level (debug, info, warn, error). Default: "info"
 * - CHAT_DEBUG_LOGGING: Set to "1" or "true" to enable verbose debug logs. Default: disabled
 * 
 * SAFETY CONSTRAINTS:
 * - Never log API keys or secrets
 * - Never log full document bodies (snippets only, truncated)
 * - Never log auth tokens or user passwords
 * - Truncate LLM prompts/responses to reasonable lengths
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  sessionId?: string;
  stage?: string;
  [key: string]: any;
}

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const CURRENT_LOG_LEVEL: LogLevel = 
  (process.env.LOG_LEVEL as LogLevel) || "info";

const CHAT_DEBUG_ENABLED = 
  process.env.CHAT_DEBUG_LOGGING === "1" || 
  process.env.CHAT_DEBUG_LOGGING === "true";

function shouldLog(level: LogLevel): boolean {
  const currentIndex = LOG_LEVELS.indexOf(CURRENT_LOG_LEVEL);
  const levelIndex = LOG_LEVELS.indexOf(level);
  return levelIndex >= currentIndex;
}

/**
 * Core logging function. Outputs structured JSON logs to console.
 * 
 * @param level - Log level (debug, info, warn, error)
 * @param message - Short message identifier (e.g., "chat_v2_request_received")
 * @param context - Additional context including requestId, sessionId, stage, etc.
 */
export function log(
  level: LogLevel,
  message: string,
  context: LogContext = {}
): void {
  if (!shouldLog(level)) return;
  if (!CHAT_DEBUG_ENABLED && level === "debug") return;

  const timestamp = new Date().toISOString();
  
  const payload = {
    ts: timestamp,
    level,
    message,
    ...context,
  };

  const output = JSON.stringify(payload);
  
  switch (level) {
    case "error":
      console.error(output);
      break;
    case "warn":
      console.warn(output);
      break;
    default:
      console.log(output);
  }
}

export const logDebug = (msg: string, ctx?: LogContext) => 
  log("debug", msg, ctx);

export const logInfo = (msg: string, ctx?: LogContext) => 
  log("info", msg, ctx);

export const logWarn = (msg: string, ctx?: LogContext) => 
  log("warn", msg, ctx);

export const logError = (msg: string, ctx?: LogContext) => 
  log("error", msg, ctx);

/**
 * Helper to truncate long strings for logging
 * Prevents excessively large log entries while preserving key information
 */
export function truncate(text: string | undefined | null, maxLen = 1000): string | undefined {
  if (!text) return undefined;
  return text.length > maxLen ? text.slice(0, maxLen) + "…[truncated]" : text;
}

/**
 * Check if debug logging is currently enabled
 */
export function isDebugEnabled(): boolean {
  return CHAT_DEBUG_ENABLED && shouldLog("debug");
}
