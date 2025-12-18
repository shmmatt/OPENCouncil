export interface ModelPricing {
  provider: string;
  model: string;
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gemini-2.5-flash": {
    provider: "google",
    model: "gemini-2.5-flash",
    inputPer1M: 0.075,
    outputPer1M: 0.30,
  },
  "gemini-2.5-pro": {
    provider: "google",
    model: "gemini-2.5-pro",
    inputPer1M: 1.25,
    outputPer1M: 10.00,
  },
  "gemini-2.0-flash": {
    provider: "google",
    model: "gemini-2.0-flash",
    inputPer1M: 0.10,
    outputPer1M: 0.40,
  },
  "gemini-1.5-pro": {
    provider: "google",
    model: "gemini-1.5-pro",
    inputPer1M: 1.25,
    outputPer1M: 5.00,
  },
  "gpt-4o": {
    provider: "openai",
    model: "gpt-4o",
    inputPer1M: 2.50,
    outputPer1M: 10.00,
  },
  "gpt-4o-mini": {
    provider: "openai",
    model: "gpt-4o-mini",
    inputPer1M: 0.15,
    outputPer1M: 0.60,
  },
};

export function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    console.warn(`Unknown model pricing: ${model}, using default estimate`);
    return (tokensIn * 0.001 + tokensOut * 0.002) / 1000;
  }
  
  const inputCost = (tokensIn / 1_000_000) * pricing.inputPer1M;
  const outputCost = (tokensOut / 1_000_000) * pricing.outputPer1M;
  
  return inputCost + outputCost;
}

export function getProvider(model: string): string {
  const pricing = MODEL_PRICING[model];
  return pricing?.provider || "unknown";
}
