import { storage } from "../storage";
import { calculateCost, getProvider } from "./pricing";
import type { ActorContext } from "../auth/types";
import type { LlmStage } from "@shared/schema";

export interface LLMCallResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface LLMCallOptions {
  actor: ActorContext;
  sessionId?: string;
  requestId?: string;
  stage: LlmStage;
  model: string;
  metadata?: Record<string, unknown>;
}

export async function logLLMCall(
  options: LLMCallOptions,
  result: LLMCallResult
): Promise<void> {
  try {
    const { actor, sessionId, requestId, stage, model, metadata } = options;
    const { tokensIn, tokensOut } = result;
    
    const costUsd = calculateCost(model, tokensIn, tokensOut);
    const provider = getProvider(model);
    
    await storage.createLlmCostLog({
      actorType: actor.actorType,
      userId: actor.userId || null,
      anonId: actor.anonId || null,
      sessionId: sessionId || null,
      requestId: requestId || null,
      stage,
      provider,
      model,
      tokensIn,
      tokensOut,
      costUsd: costUsd.toFixed(6),
      metadata: metadata || null,
    });
  } catch (error) {
    console.error("Failed to log LLM call:", error);
  }
}

export function extractTokenCounts(response: {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}): { tokensIn: number; tokensOut: number } {
  const usage = response.usageMetadata;
  return {
    tokensIn: usage?.promptTokenCount || 0,
    tokensOut: usage?.candidatesTokenCount || 0,
  };
}

export async function getDailyCost(actor: ActorContext): Promise<number> {
  if (actor.actorType === "user" && actor.userId) {
    return storage.getDailyCostByUser(actor.userId);
  } else if (actor.anonId) {
    return storage.getDailyCostByAnon(actor.anonId);
  }
  return 0;
}
