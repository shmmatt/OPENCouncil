/**
 * Global Logging Utility for Chat Pipeline Observability
 * 
 * This module provides structured logging using pino for the chat v2 pipeline
 * and related services. Logs are JSON-formatted for easy parsing.
 * 
 * Environment Variables:
 * - LOG_LEVEL: Controls minimum log level (debug, info, warn, error). Default: "info"
 * - CHAT_DEBUG_LOGGING: Set to "1" or "true" to enable verbose debug logs. Default: disabled
 * - CHAT_LOG_USER_CONTENT: Set to "1" or "true" to log user question text (privacy concern).
 *   Default: disabled (only logs question length)
 * - NODE_ENV: When "development", enables pretty-printing of logs
 * 
 * SAFETY CONSTRAINTS:
 * - Never log API keys or secrets
 * - Never log full document bodies (snippets only, truncated)
 * - Never log auth tokens or user passwords
 * - Truncate LLM prompts/responses to reasonable lengths
 * - User question content is redacted by default (only logs length)
 */

import pino from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  sessionId?: string;
  stage?: string;
  [key: string]: any;
}

const CHAT_DEBUG_ENABLED = 
  process.env.CHAT_DEBUG_LOGGING === "1" || 
  process.env.CHAT_DEBUG_LOGGING === "true";

const LOG_USER_CONTENT_ENABLED =
  process.env.CHAT_LOG_USER_CONTENT === "1" ||
  process.env.CHAT_LOG_USER_CONTENT === "true";

// Determine log level
const configuredLevel = process.env.LOG_LEVEL || "info";
const effectiveLevel = CHAT_DEBUG_ENABLED ? "debug" : configuredLevel;

// Create the pino logger
const pinoLogger = pino({
  level: effectiveLevel,
  // Use pretty printing in development
  transport: process.env.NODE_ENV === "development" 
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined,
  // Redact sensitive fields automatically
  redact: {
    paths: [
      "password",
      "passwordHash", 
      "apiKey",
      "token",
      "authorization",
      "cookie",
      "*.password",
      "*.apiKey",
      "*.token",
    ],
    censor: "[REDACTED]",
  },
  // Standard timestamp
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Core logging function. Outputs structured JSON logs.
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
  // Skip debug logs unless explicitly enabled
  if (level === "debug" && !CHAT_DEBUG_ENABLED) return;

  pinoLogger[level](context, message);
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
 * Get the underlying pino logger for advanced use cases
 * (e.g., creating child loggers with bound context)
 */
export function getLogger(): pino.Logger {
  return pinoLogger;
}

/**
 * Create a child logger with bound context
 * Useful for request-scoped logging where requestId should be on every log
 */
export function createChildLogger(context: LogContext): pino.Logger {
  return pinoLogger.child(context);
}

/**
 * Helper to truncate long strings for logging
 * Prevents excessively large log entries while preserving key information
 */
export function truncate(text: string | undefined | null, maxLen = 1000): string | undefined {
  if (!text) return undefined;
  return text.length > maxLen ? text.slice(0, maxLen) + "…[truncated]" : text;
}

/**
 * Sanitize user-provided content for logging.
 * By default, redacts the full content and only returns length info.
 * Enable CHAT_LOG_USER_CONTENT=1 to log actual content (truncated).
 * 
 * @param content - User-provided content (questions, messages)
 * @param maxLen - Maximum length if content logging is enabled
 */
export function sanitizeUserContent(content: string | undefined | null, maxLen = 100): string | undefined {
  if (!content) return undefined;
  
  if (LOG_USER_CONTENT_ENABLED) {
    return truncate(content, maxLen);
  }
  
  return `[redacted, length=${content.length}]`;
}

/**
 * Check if debug logging is currently enabled
 */
export function isDebugEnabled(): boolean {
  return CHAT_DEBUG_ENABLED;
}

/**
 * Check if user content logging is enabled
 */
export function isUserContentLoggingEnabled(): boolean {
  return LOG_USER_CONTENT_ENABLED;
}

// Export the logger for direct use when needed
export { pinoLogger as logger };
