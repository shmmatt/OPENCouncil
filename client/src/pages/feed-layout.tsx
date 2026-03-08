import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import TownFeedComponent from "@/components/TownFeed";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { UserStatusBar } from "@/components/user-status-bar";
import { X, Loader2, MessageSquare, Sparkles, ArrowRight, Menu, MessageCircle, Rss } from "lucide-react";
import type { ChatSession, ChatMessage, TownFeedPayload } from "@shared/schema";

interface DrawerState {
  isOpen: boolean;
  feedItemId?: string;
  templateId?: string;
  question?: string;
  sessionId?: string;
}

function ChatMessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
      data-testid={`chat-message-${message.id}`}
    >
      <div
        className={`max-w-[85%] rounded-md px-4 py-3 text-sm whitespace-pre-wrap ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
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
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
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
      setStreamStatus("Thinking...");
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
        const decoder = new TextDecoder();
        let buffer = "";
        let streamDone = false;

        while (!streamDone) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          let eventType = "";
          let dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
              dataLines = [];
            } else if (line.startsWith("data: ")) {
              dataLines.push(line.slice(6));
            } else if (line === "" && eventType && dataLines.length > 0) {
              try {
                const data = JSON.parse(dataLines.join("\n"));
                if (eventType === "status") {
                  setStreamStatus(data.stage || "Processing...");
                } else if (eventType === "answer") {
                  setStreamStatus(null);
                  queryClient.invalidateQueries({
                    queryKey: ["/api/chat/sessions", sid],
                  });
                } else if (eventType === "followups") {
                  queryClient.invalidateQueries({
                    queryKey: ["/api/chat/sessions", sid],
                  });
                } else if (eventType === "error") {
                  streamDone = true;
                } else if (eventType === "done") {
                  streamDone = true;
                }
              } catch {}
              eventType = "";
              dataLines = [];
            }
          }
        }

        reader.cancel().catch(() => {});
      } catch (error) {
        console.error("Chat stream error:", error);
      } finally {
        setIsStreaming(false);
        setStreamStatus(null);
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
        <div className="flex items-center justify-between gap-2 p-4 border-b flex-wrap">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-primary" />
            <span className="font-medium text-sm" data-testid="text-drawer-title">
              Chat
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

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
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
              <ChatMessageBubble key={msg.id} message={msg} />
            ))}

          {(isSending || isStreaming) && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-stream-status">
              <Loader2 className="w-4 h-4 animate-spin" />
              {streamStatus || "Thinking..."}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {sessionId && (
          <div className="border-t p-4">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a follow-up question..."
                className="flex-1 bg-muted rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
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

function FeedNav() {
  return (
    <div className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      <div className="p-4 space-y-2 border-b border-sidebar-border">
        <Button
          asChild
          className="w-full"
          variant="outline"
          data-testid="link-nav-chat"
        >
          <Link href="/chat">
            <MessageCircle className="w-4 h-4 mr-2" />
            Go to Chat
          </Link>
        </Button>
        <Button
          className="w-full"
          variant="default"
          disabled
          data-testid="link-nav-feed-active"
        >
          <Rss className="w-4 h-4 mr-2" />
          Town Feed
        </Button>
      </div>
      <div className="p-4 flex-1">
        <p className="text-xs text-muted-foreground">
          Browse the latest updates from your selected towns. Click a suggested question to start a chat.
        </p>
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

  return (
    <div className="flex h-screen bg-background" data-testid="feed-layout">
      <div className="hidden md:block w-72 h-full">
        <FeedNav />
      </div>

      <div className="flex-1 flex flex-col h-full min-w-0">
        <header className="border-b bg-card px-4 py-3 flex items-center justify-between gap-3 sticky top-0 z-[999]">
          <div className="flex items-center gap-3">
            <Sheet>
              <SheetTrigger asChild className="md:hidden">
                <Button variant="ghost" size="icon" data-testid="button-feed-menu">
                  <Menu className="w-5 h-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="p-0 w-72">
                <FeedNav />
              </SheetContent>
            </Sheet>
            <div>
              <h1 className="text-lg font-semibold">Town Feed</h1>
              <p className="text-xs text-muted-foreground">Latest updates from your communities</p>
            </div>
          </div>
          <UserStatusBar />
        </header>

        <div className="flex-1 overflow-y-auto">
          <TownFeedComponent onQuestionClick={handleQuestionClick} />
        </div>
      </div>

      {drawer.isOpen && (
        <ChatDrawer state={drawer} onClose={handleCloseDrawer} />
      )}
    </div>
  );
}
