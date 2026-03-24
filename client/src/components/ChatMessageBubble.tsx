import { useState } from "react";
import { Bot, User, FileText, ChevronDown, Link2, ExternalLink, AlertCircle, Sparkles, ThumbsUp, ThumbsDown, Globe, Lock, Mail, Loader2, CheckCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@shared/schema";
import type { ChatNotice } from "@shared/chatNotices";
import { MessageNotices } from "@/components/MessageNotices";
import { apiRequest } from "@/lib/queryClient";

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
  isBlurred?: boolean;
  isAuthenticated?: boolean;
  onBlurLifted?: () => void;
}

const PREVIEW_CHARS = 100;

function EmailUnlockOverlay({ onUnlocked }: { onUnlocked: () => void }) {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await apiRequest("POST", "/api/auth/email-unlock", {
        email,
        returnTo: window.location.pathname + window.location.search,
      });
      setIsSuccess(true);
      onUnlocked();
    } catch (err) {
      setError("Failed to send link. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
          <CheckCircle className="w-5 h-5 text-primary" />
        </div>
        <p className="text-sm font-medium">Check your inbox for a sign-in link</p>
        <p className="text-xs text-muted-foreground">Your answer is now visible in this session</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
        <Lock className="w-5 h-5 text-primary" />
      </div>
      <div>
        <p className="text-sm font-semibold">Enter your email to unlock this answer and get 10 more free queries.</p>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 w-full max-w-xs">
        <Input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isSubmitting}
          className="text-sm"
          data-testid="input-unlock-email"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          type="submit"
          size="sm"
          disabled={!email.trim() || isSubmitting}
          data-testid="button-unlock-submit"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              Sending...
            </>
          ) : (
            <>
              <Mail className="w-3 h-3 mr-1.5" />
              Unlock answer
            </>
          )}
        </Button>
      </form>
    </div>
  );
}

function ProUpgradeOverlay() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/stripe/checkout", {});
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError("Could not start checkout. Please try again.");
      }
    } catch (err) {
      setError("Could not start checkout. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
        <Sparkles className="w-5 h-5 text-primary" />
      </div>
      <div>
        <p className="text-sm font-semibold">Upgrade to OPENCouncil Pro</p>
        <p className="text-xs text-muted-foreground mt-1">Unlimited civic intelligence, no daily caps</p>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button
        size="sm"
        onClick={handleUpgrade}
        disabled={isLoading}
        data-testid="button-upgrade-pro"
      >
        {isLoading ? (
          <>
            <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
            Loading...
          </>
        ) : (
          <>
            <Sparkles className="w-3 h-3 mr-1.5" />
            Upgrade to Pro
          </>
        )}
      </Button>
    </div>
  );
}

export function ChatMessageBubble({ message, onFollowUpClick, onFeedbackSubmit, compact, isBlurred = false, isAuthenticated = false, onBlurLifted }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const [blurLifted, setBlurLifted] = useState(false);

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

  const shouldBlur = isBlurred && !blurLifted && !isUser;
  const previewText = shouldBlur ? message.content.slice(0, PREVIEW_CHARS) : message.content;
  const hasMore = shouldBlur && message.content.length > PREVIEW_CHARS;

  const handleUnlocked = () => {
    setBlurLifted(true);
    onBlurLifted?.();
  };

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
          } relative`}
          data-testid={`message-${message.id}`}
        >
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          ) : shouldBlur ? (
            <div className="relative">
              <div className={`prose dark:prose-invert max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 prose-headings:my-3 prose-headings:font-semibold prose-table:w-full prose-table:border-collapse prose-th:border prose-th:border-border prose-th:bg-muted prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-semibold prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 ${compact ? "prose-sm" : "prose-sm"}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewText}</ReactMarkdown>
              </div>
              <div className="relative mt-2" data-testid="blur-overlay-container">
                {hasMore && (
                  <div
                    className="select-none pointer-events-none overflow-hidden"
                    style={{ maxHeight: "12rem" }}
                  >
                    <div
                      className="prose dark:prose-invert max-w-none prose-sm text-sm"
                      style={{
                        filter: "blur(5px)",
                        maskImage: "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0) 100%)",
                        WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0) 100%)",
                      }}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content.slice(PREVIEW_CHARS)}</ReactMarkdown>
                    </div>
                  </div>
                )}
                <div className="mt-4 flex justify-center">
                  <div className="bg-card border border-card-border rounded-lg p-5 shadow-sm w-full max-w-sm" data-testid="plg-overlay">
                    {isAuthenticated ? (
                      <ProUpgradeOverlay />
                    ) : (
                      <EmailUnlockOverlay onUnlocked={handleUnlocked} />
                    )}
                  </div>
                </div>
              </div>
            </div>
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

        {suggestedFollowUps.length > 0 && onFollowUpClick && !shouldBlur && (
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
          {!isUser && onFeedbackSubmit && !shouldBlur && (
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
