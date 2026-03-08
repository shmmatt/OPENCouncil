export const STAGE_LABELS: Record<string, string> = {
  planning: "Analyzing your question...",
  retrieving: "Searching through documents...",
  synthesizing: "Writing your answer...",
  auditing: "Verifying accuracy...",
  deep_dive_starting: "Starting deep dive analysis...",
  deep_dive_intent: "Analyzing your question...",
  deep_dive_planning: "Creating research plan...",
  deep_dive_researching: "Researching...",
  deep_dive_synthesizing: "Writing analysis...",
  deep_dive_quality: "Evaluating quality...",
  deep_dive_replanning: "Refining research plan...",
};

export function getStageLabel(stage: string): string {
  return STAGE_LABELS[stage] || "Processing...";
}

export interface SSEHandlers {
  onStatus?: (stage: string) => void;
  onProgress?: (data: { iteration: number; maxIterations: number }) => void;
  onAnswer?: (data: any) => void;
  onFollowups?: (data: any) => void;
  onError?: (data: any) => void;
  onDone?: () => void;
}

export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: SSEHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const segments = buffer.split("\n\n");
      buffer = segments.pop() || "";

      for (const segment of segments) {
        if (!segment.trim()) continue;

        let eventType = "";
        const dataLines: string[] = [];

        for (const line of segment.split("\n")) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          }
        }

        if (!eventType || dataLines.length === 0) continue;

        let data: any;
        try {
          data = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }

        switch (eventType) {
          case "status":
            handlers.onStatus?.(data.stage || "");
            break;
          case "progress":
            handlers.onProgress?.({
              iteration: data.iteration || 0,
              maxIterations: data.maxIterations || 3,
            });
            break;
          case "answer":
            handlers.onAnswer?.(data);
            break;
          case "followups":
            handlers.onFollowups?.(data);
            break;
          case "error":
            handlers.onError?.(data);
            return;
          case "done":
            handlers.onDone?.();
            return;
        }
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError" || signal?.aborted) {
      return;
    }
    throw err;
  }
}
