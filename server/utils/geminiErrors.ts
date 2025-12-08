import { logError } from "./logger";

export class GeminiQuotaExceededError extends Error {
  constructor(message: string = "Gemini quota exceeded") {
    super(message);
    this.name = "GeminiQuotaExceededError";
  }
}

export function isQuotaError(error: any): boolean {
  if (!error) return false;
  
  const errorStr = String(error);
  const message = error?.message ?? errorStr;
  const status = error?.status;
  const nestedError = error?.error;
  
  const hasQuotaInMessage = message.includes("quota") || message.includes("RESOURCE_EXHAUSTED");
  const hasQuotaStatus = status === "RESOURCE_EXHAUSTED";
  const hasQuotaCode = error?.code === 429;
  
  const hasNestedQuotaCode = nestedError?.code === 429;
  const hasNestedQuotaStatus = nestedError?.status === "RESOURCE_EXHAUSTED";
  const hasNestedQuotaMessage = nestedError?.message?.includes("quota") || 
    nestedError?.message?.includes("RESOURCE_EXHAUSTED");
  
  return (
    hasQuotaInMessage ||
    hasQuotaStatus ||
    hasQuotaCode ||
    hasNestedQuotaCode ||
    hasNestedQuotaStatus ||
    hasNestedQuotaMessage
  );
}

export function handleGeminiError(
  error: any,
  context: { requestId?: string; sessionId?: string; stage: string }
): never {
  const message = error?.message ?? String(error);
  
  if (isQuotaError(error)) {
    logError("gemini_quota_exceeded", {
      requestId: context.requestId,
      sessionId: context.sessionId,
      stage: context.stage,
      error: message,
    });
    throw new GeminiQuotaExceededError(message);
  }
  
  throw error;
}

export function getQuotaExceededMessage(): string {
  return "The OpenCouncil assistant has temporarily reached its usage limit and cannot generate new answers right now. This is just a usage limit. Please try again in a few minutes or contact your administrator if the issue persists.";
}
