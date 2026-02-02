import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";

/**
 * Rate limiting middleware to prevent abuse and control costs.
 * 
 * Limits are per IP address by default. In production behind a proxy,
 * ensure trust proxy is set: app.set('trust proxy', 1)
 */

// Key generator that uses anonymous ID if available, falls back to IP
const keyGenerator = (req: Request): string => {
  // Use anon ID if available (more accurate than IP for shared networks)
  const anonId = (req as any).anonId;
  if (anonId) {
    return `anon:${anonId}`;
  }
  // Fall back to IP
  return req.ip || req.socket.remoteAddress || 'unknown';
};

// Standard error response
const rateLimitHandler = (req: Request, res: Response) => {
  res.status(429).json({
    message: "Too many requests. Please wait a moment before trying again.",
    retryAfter: res.getHeader('Retry-After'),
  });
};

/**
 * Chat message rate limiter - strictest limits (LLM API costs)
 * 20 messages per minute per user/IP
 */
export const chatMessageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: { message: "Too many messages. Please wait a moment before sending another." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: rateLimitHandler,
});

/**
 * Chat session creation limiter
 * 10 new sessions per minute per user/IP
 */
export const sessionCreationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { message: "Too many sessions created. Please wait before starting a new conversation." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: rateLimitHandler,
});

/**
 * General API limiter for other endpoints
 * 100 requests per minute per user/IP
 */
export const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { message: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: rateLimitHandler,
});

/**
 * File upload limiter (ingestion)
 * 30 uploads per 5 minutes per user/IP
 */
export const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  message: { message: "Too many file uploads. Please wait before uploading more." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: rateLimitHandler,
});

/**
 * Strict limiter for expensive operations
 * 5 requests per minute (for things like bulk operations)
 */
export const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { message: "This operation is rate limited. Please wait before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: rateLimitHandler,
});
