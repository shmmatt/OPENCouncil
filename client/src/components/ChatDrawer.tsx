import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { parseSSEStream } from "@/lib/sseParser";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { X, Loader2, MessageSquare, ArrowRight } from "lucide-react";
import type { ChatSession, ChatMessage } from "@shared/schema";
import { ChatMessageBubble } from "@/components/ChatMessageBubble";
import { TypingIndicator } from "@/components/TypingIndicator";

export interface ChatDrawerState {
  isOpen: boolean;
  feedItemId?: string;
  templateId?: string;
  documentVersionId?: string;
  question?: string;
  sessionId?: string;
}

interface ChatDrawerProps {
  state: ChatDrawerState;
  onClose: () => void;
}

export function ChatDrawer({ state, onClose }: ChatDrawerProps) {
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
    async (sid: string, content: string, documentVersionId?: string) => {
      setIsStreaming(true);
      setPipelineStage(null);
      try {
        const body: Record<string, unknown> = { content };
        if (documentVersionId) {
          body.metadata = { documentVersionId };
        }
        const response = await fetch(
          `/api/chat/v2/sessions/${sid}/messages/stream`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
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
          documentVersionId: state.documentVersionId,
        });
        const newSession: ChatSession = await res.json();
        setSessionId(newSession.id);
        queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
        setIsCreating(false);

        setIsSending(true);
        await sendStreamingMessage(newSession.id, state.question!, state.documentVersionId);
        setIsSending(false);
      } catch (error) {
        console.error("Failed to create chat session:", error);
        setIsCreating(false);
        setIsSending(false);
      }
    };

    initChat();
  }, [state.question, state.isOpen, state.feedItemId, state.templateId, state.documentVersionId, sendStreamingMessage]);

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
              OPENCouncil
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
