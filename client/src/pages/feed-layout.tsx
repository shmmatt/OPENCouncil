import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { parseSSEStream } from "@/lib/sseParser";
import TownFeedComponent from "@/components/TownFeed";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { X, Loader2, MessageSquare, ArrowRight, Calendar } from "lucide-react";
import type { ChatSession, ChatMessage } from "@shared/schema";
import { ChatMessageBubble } from "@/components/ChatMessageBubble";
import { TypingIndicator } from "@/components/TypingIndicator";

interface DrawerState {
  isOpen: boolean;
  feedItemId?: string;
  templateId?: string;
  question?: string;
  sessionId?: string;
}

function ChatDrawer({
  state,
  onClose,
}: {
  state: DrawerState;
  onClose: () => void;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(state.sessionId || null);
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState("");
  const hasInitialized = useRef(false);

  const { data: messages, isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: ["/api/chat/sessions", sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/chat/sessions/${sessionId}`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data || [];
    },
    enabled: !!sessionId,
    refetchInterval: isStreaming ? 2000 : false,
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendStreamingMessage = useCallback(
    async (sid: string, content: string) => {
      setIsStreaming(true);
      setPipelineStage(null);
      try {
        const response = await fetch(
          `/api/chat/v2/sessions/${sid}/messages/stream`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
            credentials: "include",
          }
        );

        if (!response.ok || !response.body) {
          throw new Error("Stream failed");
        }

        const reader = response.body.getReader();

        await parseSSEStream(reader, {
          onStatus: (stage) => setPipelineStage(stage || null),
          onAnswer: () => {
            setPipelineStage(null);
            queryClient.invalidateQueries({
              queryKey: ["/api/chat/sessions", sid],
            });
          },
          onFollowups: () => {
            queryClient.invalidateQueries({
              queryKey: ["/api/chat/sessions", sid],
            });
          },
        });

        reader.cancel().catch(() => {});
      } catch (error) {
        console.error("Chat stream error:", error);
      } finally {
        setIsStreaming(false);
        setPipelineStage(null);
        queryClient.invalidateQueries({
          queryKey: ["/api/chat/sessions", sid],
        });
      }
    },
    []
  );

  useEffect(() => {
    if (hasInitialized.current) return;
    if (!state.question || !state.isOpen) return;
    hasInitialized.current = true;

    const initChat = async () => {
      setIsCreating(true);
      try {
        const res = await apiRequest("POST", "/api/chat/sessions", {
          title: state.question!.slice(0, 50) + (state.question!.length > 50 ? "..." : ""),
          feedItemId: state.feedItemId,
          templateId: state.templateId,
        });
        const newSession: ChatSession = await res.json();
        setSessionId(newSession.id);
        queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
        setIsCreating(false);

        setIsSending(true);
        await sendStreamingMessage(newSession.id, state.question!);
        setIsSending(false);
      } catch (error) {
        console.error("Failed to create chat session:", error);
        setIsCreating(false);
        setIsSending(false);
      }
    };

    initChat();
  }, [state.question, state.isOpen, state.feedItemId, state.templateId, sendStreamingMessage]);

  const handleSendFollowUp = useCallback(async () => {
    if (!inputValue.trim() || !sessionId || isStreaming) return;
    const msg = inputValue.trim();
    setInputValue("");
    await sendStreamingMessage(sessionId, msg);
  }, [inputValue, sessionId, isStreaming, sendStreamingMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendFollowUp();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      data-testid="chat-drawer-overlay"
    >
      <div
        className="absolute inset-0 bg-black/30 dark:bg-black/50"
        onClick={onClose}
        data-testid="chat-drawer-backdrop"
      />

      <div
        className="relative w-full max-w-xl bg-background border-l shadow-lg flex flex-col animate-in slide-in-from-right duration-300"
        data-testid="chat-drawer"
      >
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-b flex-wrap bg-card">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-primary" />
            <span className="font-semibold font-headline text-sm" data-testid="text-drawer-title">
              Civic Ledger Assistant
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            data-testid="button-close-drawer"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {isCreating && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-creating-session">
              <Loader2 className="w-4 h-4 animate-spin" />
              Starting conversation...
            </div>
          )}

          {messagesLoading && sessionId && (
            <div className="space-y-3">
              <Skeleton className="h-12 w-3/4 ml-auto" />
              <Skeleton className="h-24 w-4/5" />
            </div>
          )}

          {messages &&
            messages.map((msg) => (
              <ChatMessageBubble
                key={msg.id}
                message={msg}
                compact
                onFollowUpClick={(question) => {
                  if (sessionId) {
                    sendStreamingMessage(sessionId, question);
                  }
                }}
                onFeedbackSubmit={(type) => {
                  const current = msg.feedback;
                  const newFeedback = current === type ? null : type;
                  apiRequest("POST", `/api/chat/messages/${msg.id}/feedback`, { feedback: newFeedback })
                    .then(() => {
                      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", sessionId] });
                    });
                }}
              />
            ))}

          {(isSending || isStreaming) && (
            <TypingIndicator pipelineStage={pipelineStage} />
          )}

          <div ref={messagesEndRef} />
        </div>

        {sessionId && (
          <div className="border-t p-4 bg-card">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a follow-up question..."
                className="flex-1 bg-muted rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary border border-border"
                disabled={isStreaming}
                data-testid="input-followup"
              />
              <Button
                size="icon"
                onClick={handleSendFollowUp}
                disabled={!inputValue.trim() || isStreaming}
                data-testid="button-send-followup"
              >
                <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function FeedLayout() {
  const [drawer, setDrawer] = useState<DrawerState>({ isOpen: false });

  const handleQuestionClick = useCallback(
    (question: string, feedItemId?: string, templateId?: string) => {
      const params = new URLSearchParams();
      params.set("chat", "open");
      if (feedItemId) params.set("feedId", feedItemId);
      if (templateId) params.set("templateId", templateId);

      window.history.pushState(null, "", `/feed?${params.toString()}`);

      setDrawer({
        isOpen: true,
        feedItemId,
        templateId,
        question,
        sessionId: undefined,
      });
    },
    []
  );

  const handleCloseDrawer = useCallback(() => {
    setDrawer({ isOpen: false });
    window.history.replaceState(null, "", "/feed");
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("chat")) {
        setDrawer({ isOpen: false });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (drawer.isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawer.isOpen]);

  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).toUpperCase();

  return (
    <div className="flex flex-col h-full" data-testid="feed-layout">
      <div className="border-b bg-card px-6 md:px-8 py-6 flex-shrink-0">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-black tracking-widest text-primary uppercase font-headline mb-1">
              Official Publication
            </p>
            <h1 className="text-3xl md:text-4xl font-black font-headline text-foreground leading-tight" data-testid="text-feed-title">
              The Civic Ledger
            </h1>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed max-w-xl">
              Verified municipal activities and legislative updates for the community of OPENCouncil.
            </p>
          </div>
          <div className="flex items-center gap-2 bg-muted border border-border rounded-full px-4 py-2 flex-shrink-0 self-start sm:self-auto">
            <Calendar className="w-3.5 h-3.5 text-primary flex-shrink-0" />
            <span className="text-[10px] font-black font-headline tracking-widest whitespace-nowrap" data-testid="text-feed-date">
              {today}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-8 py-6">
          <TownFeedComponent onQuestionClick={handleQuestionClick} />
        </div>
      </div>

      {drawer.isOpen && (
        <ChatDrawer state={drawer} onClose={handleCloseDrawer} />
      )}
    </div>
  );
}
