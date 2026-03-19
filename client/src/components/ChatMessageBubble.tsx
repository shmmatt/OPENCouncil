import { Bot, User, FileText, ChevronDown, Link2, ExternalLink, AlertCircle, Sparkles, ThumbsUp, ThumbsDown, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@shared/schema";
import type { ChatNotice } from "@shared/chatNotices";
import { MessageNotices } from "@/components/MessageNotices";

interface SourceCitation {
  id: string;
  title: string;
  town?: string;
  year?: string;
  category?: string;
  url?: string;
  meetingDate?: string;
  board?: string;
  isInternal?: boolean;
}

interface V2Metadata {
  v2: true;
  answerMeta: {
    complexity: "simple" | "complex";
    requiresClarification: boolean;
    criticScore: {
      relevance: number;
      completeness: number;
      clarity: number;
      riskOfMisleading: number;
    };
    limitationsNote?: string;
  };
  sources: SourceCitation[];
  suggestedFollowUps: string[];
  notices?: ChatNotice[];
  coverageScore?: number;
  missingFacets?: string[];
  showCoverageDisclaimer?: boolean;
  wasTruncated?: boolean;
  isDeepDive?: boolean;
  deepDiveId?: string;
}

interface ChatMessageBubbleProps {
  message: ChatMessage;
  onFollowUpClick?: (question: string) => void;
  onFeedbackSubmit?: (type: "up" | "down") => void;
  compact?: boolean;
}

export function ChatMessageBubble({ message, onFollowUpClick, onFeedbackSubmit, compact }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";

  let v2Data: V2Metadata | null = null;

  if (message.citations) {
    try {
      const parsed = JSON.parse(message.citations);
      if (parsed.v2 === true) {
        v2Data = parsed as V2Metadata;
      }
    } catch (e) {
      // ignore malformed citations
    }
  }

  const sources = v2Data?.sources || [];
  const suggestedFollowUps = v2Data?.suggestedFollowUps || [];
  const notices = v2Data?.notices || [];
  const showCoverageDisclaimer = v2Data?.showCoverageDisclaimer || false;
  const missingFacets = v2Data?.missingFacets || [];
  const isDeepDiveMessage = v2Data?.isDeepDive === true;

  const currentFeedback = message.feedback;

  return (
    <div className={`flex gap-4 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          {isDeepDiveMessage ? <Sparkles className="w-4 h-4 text-primary" /> : <Bot className="w-4 h-4 text-primary" />}
        </div>
      )}
      <div className={`flex flex-col gap-2 ${compact ? "max-w-full" : "max-w-3xl"} ${isUser ? "items-end" : "items-start"}`}>
        {isDeepDiveMessage && !isUser && (
          <Badge variant="secondary" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid="badge-deep-dive">
            <Sparkles className="w-3 h-3 mr-1" /> Deep Dive
          </Badge>
        )}
        <div
          className={`rounded-lg px-4 py-3 ${
            isUser
              ? "bg-sky-50 dark:bg-sky-950 border border-sky-200 dark:border-sky-800"
              : "bg-card border border-card-border"
          }`}
          data-testid={`message-${message.id}`}
        >
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className={`prose dark:prose-invert max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 prose-headings:my-3 prose-headings:font-semibold prose-table:w-full prose-table:border-collapse prose-th:border prose-th:border-border prose-th:bg-muted prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-semibold prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 ${compact ? "prose-sm" : "prose-sm"}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>

        {!isUser && notices.length > 0 && (
          <MessageNotices notices={notices} />
        )}

        {!isUser && showCoverageDisclaimer && missingFacets.length > 0 && (
          <div className="mt-2 p-3 rounded-md bg-muted/50 border border-border" data-testid="coverage-disclaimer">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  What we couldn't fully confirm
                </p>
                <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                  {missingFacets.map((facet, idx) => (
                    <li key={idx} className="leading-relaxed">{facet}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {!isUser && sources.length > 0 && (
          <Collapsible data-testid={`sources-collapsible-${message.id}`}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover-elevate active-elevate-2 rounded-md px-2 py-1" data-testid={`button-sources-toggle-${message.id}`}>
              <FileText className="w-3 h-3" />
              <span>Sources ({sources.length})</span>
              <ChevronDown className="w-3 h-3 transition-transform [[data-state=open]_&]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 space-y-1 pl-1">
                {sources.map((source, idx) => (
                  <div key={source.id || idx} className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid={`source-item-${idx}`}>
                    {source.isInternal ? (
                      <FileText className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    ) : (
                      <Globe className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    )}
                    {(() => {
                      const title = source.title || "";
                      const titleLower = title.toLowerCase();
                      const yearFromDate = source.meetingDate ? source.meetingDate.split("-")[0] : null;
                      const dateAlreadyInTitle = source.meetingDate
                        ? (titleLower.includes(source.meetingDate) || (yearFromDate && title.includes(yearFromDate)))
                        : false;
                      const yearAlreadyInTitle = source.year ? title.includes(source.year) : false;
                      const dateSuffix = source.meetingDate && !dateAlreadyInTitle
                        ? ` (${source.meetingDate})`
                        : source.year && !yearAlreadyInTitle
                          ? ` (${source.year})`
                          : "";
                      const boardAbbrevs: Record<string, string[]> = {
                        "planning board": ["pb"],
                        "zoning board of adjustment": ["zba"],
                        "board of selectmen": ["bos"],
                        "select board": ["bos"],
                        "conservation commission": ["cc"],
                        "budget committee": ["budget comm."],
                      };
                      const boardInTitle = source.board
                        ? titleLower.includes(source.board.toLowerCase()) ||
                          (boardAbbrevs[source.board.toLowerCase()] || []).some(abbr => titleLower.includes(abbr.toLowerCase()))
                        : true;
                      const boardSuffix = source.board && !boardInTitle
                        ? ` - ${source.board}`
                        : "";
                      const suffix = `${dateSuffix}${boardSuffix}`;
                      return source.url ? (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2 hover:text-foreground"
                          data-testid={`link-source-${idx}`}
                        >
                          {source.title}{suffix}
                        </a>
                      ) : (
                        <span data-testid={`text-source-${idx}`}>
                          {source.title}{suffix}
                        </span>
                      );
                    })()}
                    {source.url && !source.isInternal && <ExternalLink className="w-3 h-3 mt-0.5 flex-shrink-0 opacity-50" />}
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {suggestedFollowUps.length > 0 && onFollowUpClick && (
          <div className="flex flex-wrap gap-2 mt-1">
            {suggestedFollowUps.map((question, idx) => (
              <button
                key={idx}
                onClick={() => onFollowUpClick(question)}
                className="text-xs bg-primary/10 text-primary hover-elevate active-elevate-2 rounded-full px-3 py-1 transition-colors"
                data-testid={`button-followup-${idx}`}
              >
                {question}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap px-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground font-headline">
            {isUser ? "RESIDENT" : isDeepDiveMessage ? "DEEP DIVE" : "CIVIC LEDGER"}
            {" \u2022 "}
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
          {!isUser && onFeedbackSubmit && (
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onFeedbackSubmit("up")}
                    className={`p-1 rounded transition-colors ${
                      currentFeedback === "up"
                        ? "text-primary bg-primary/10"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid={`button-thumbs-up-${message.id}`}
                  >
                    <ThumbsUp className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Helpful</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onFeedbackSubmit("down")}
                    className={`p-1 rounded transition-colors ${
                      currentFeedback === "down"
                        ? "text-destructive bg-destructive/10"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid={`button-thumbs-down-${message.id}`}
                  >
                    <ThumbsDown className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Not helpful</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
        {!isUser && (
          <p className="text-[10px] text-muted-foreground/60 px-1" data-testid="text-ai-disclaimer">
            AI can make mistakes — verify with official records
          </p>
        )}
      </div>
      {isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
          <User className="w-4 h-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
