import { getStageLabel } from "@/lib/sseParser";
import { Bot, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface TypingIndicatorProps {
  pipelineStage?: string | null;
  isDeepDive?: boolean;
  deepDiveIteration?: number;
  deepDiveMaxIterations?: number;
}

export function TypingIndicator({ pipelineStage, isDeepDive, deepDiveIteration, deepDiveMaxIterations }: TypingIndicatorProps) {
  let displayText = pipelineStage
    ? getStageLabel(pipelineStage)
    : "Thinking...";

  if (isDeepDive && deepDiveIteration && deepDiveMaxIterations) {
    const iterLabel = ` (Pass ${deepDiveIteration} of ${deepDiveMaxIterations})`;
    if (pipelineStage && pipelineStage.startsWith("deep_dive_")) {
      displayText = displayText.replace("...", iterLabel + "...");
    }
  }

  return (
    <div className="flex gap-4 justify-start">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
        {isDeepDive ? <Sparkles className="w-4 h-4 text-primary" /> : <Bot className="w-4 h-4 text-primary" />}
      </div>
      <div className="flex flex-col gap-2 max-w-3xl">
        <div className="rounded-lg px-4 py-3 bg-card border border-card-border">
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
              <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
              <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            <span 
              className="text-sm text-muted-foreground animate-in fade-in duration-300"
              data-testid="text-typing-status"
            >
              {displayText}
            </span>
            {isDeepDive && (
              <Badge variant="secondary" className="text-xs no-default-hover-elevate no-default-active-elevate">
                <Sparkles className="w-3 h-3 mr-1" /> Deep Dive
              </Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
