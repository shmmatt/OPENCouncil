import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { MessageCircle, Plus, Send, Loader2, User, Bot, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import type { ChatSession, ChatMessage } from "@shared/schema";

// V2 response types
interface SourceCitation {
  id: string;
  title: string;
  town?: string;
  year?: string;
  category?: string;
  url?: string;
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
}

function ChatSidebar({ 
  sessions, 
  activeSessionId, 
  onSessionSelect, 
  onNewChat 
}: { 
  sessions?: ChatSession[]; 
  activeSessionId: string | null;
  onSessionSelect: (id: string) => void;
  onNewChat: () => void;
}) {
  return (
    <div className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      <div className="p-4 border-b border-sidebar-border">
        <Button 
          onClick={onNewChat} 
          className="w-full" 
          variant="default"
          data-testid="button-new-chat"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Chat
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {sessions?.map((session) => (
            <button
              key={session.id}
              onClick={() => onSessionSelect(session.id)}
              className={`w-full text-left p-3 rounded-md hover-elevate active-elevate-2 transition-colors ${
                activeSessionId === session.id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground"
              }`}
              data-testid={`button-session-${session.id}`}
            >
              <div className="flex items-start gap-2">
                <MessageCircle className="w-4 h-4 mt-1 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{session.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(session.updatedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function MessageBubble({ 
  message, 
  onFollowUpClick 
}: { 
  message: ChatMessage;
  onFollowUpClick?: (question: string) => void;
}) {
  const isUser = message.role === "user";
  
  // Parse v2 metadata from citations field
  let v2Data: V2Metadata | null = null;
  let legacyCitations: string[] | null = null;
  
  if (message.citations) {
    try {
      const parsed = JSON.parse(message.citations);
      if (parsed.v2 === true) {
        v2Data = parsed as V2Metadata;
      } else if (Array.isArray(parsed)) {
        legacyCitations = parsed;
      }
    } catch (e) {
      console.error("Failed to parse citations:", e);
    }
  }

  const sources = v2Data?.sources || [];
  const suggestedFollowUps = v2Data?.suggestedFollowUps || [];

  return (
    <div className={`flex gap-4 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <Bot className="w-4 h-4 text-primary" />
        </div>
      )}
      <div className={`flex flex-col gap-2 max-w-3xl ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-lg px-4 py-3 ${
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-card border border-card-border"
          }`}
          data-testid={`message-${message.id}`}
        >
          <p className="text-base whitespace-pre-wrap">{message.content}</p>
        </div>
        
        {/* V2 Sources */}
        {sources.length > 0 && (
          <div className="text-xs text-muted-foreground space-y-1 bg-muted/50 rounded-md p-2">
            <p className="font-medium">Sources:</p>
            {sources.map((source, idx) => (
              <div key={source.id || idx} className="pl-2 flex items-start gap-1">
                <span>•</span>
                <span>
                  {source.url ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                      data-testid={`link-source-${source.id || idx}`}
                    >
                      {source.title}
                    </a>
                  ) : (
                    source.title
                  )}
                  {source.town && <span className="text-muted-foreground/70"> ({source.town})</span>}
                  {source.year && <span className="text-muted-foreground/70"> - {source.year}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        
        {/* Legacy citations fallback */}
        {legacyCitations && legacyCitations.length > 0 && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p className="font-medium">Sources:</p>
            {legacyCitations.map((citation: string, idx: number) => (
              <p key={idx} className="pl-2">• {citation}</p>
            ))}
          </div>
        )}
        
        {/* Suggested follow-up questions */}
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
        
        <p className="text-xs text-muted-foreground px-1">
          {new Date(message.createdAt).toLocaleTimeString()}
        </p>
      </div>
      {isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
          <User className="w-4 h-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-4 justify-start">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
        <Bot className="w-4 h-4 text-primary" />
      </div>
      <div className="flex flex-col gap-2 max-w-3xl">
        <div className="rounded-lg px-4 py-3 bg-card border border-card-border">
          <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
            <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
            <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Chat() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: sessions } = useQuery<ChatSession[]>({
    queryKey: ["/api/chat/sessions"],
  });

  const { data: messages, isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: ["/api/chat/sessions", activeSessionId],
    enabled: !!activeSessionId,
  });

  const createSessionMutation = useMutation({
    mutationFn: async (): Promise<ChatSession> => {
      const res = await apiRequest("POST", "/api/chat/sessions", { title: "New conversation" });
      return res.json();
    },
    onSuccess: (newSession: ChatSession) => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
      setActiveSessionId(newSession.id);
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async (content: string) => {
      // Use v2 chat endpoint for enhanced pipeline with logging
      return await apiRequest("POST", `/api/chat/v2/sessions/${activeSessionId}/messages`, { content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
    },
  });

  const handleFollowUpClick = (question: string) => {
    setInputValue(question);
  };

  useEffect(() => {
    if (sessions && sessions.length > 0 && !activeSessionId) {
      setActiveSessionId(sessions[0].id);
    }
  }, [sessions, activeSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sendMessageMutation.isPending]);

  const handleNewChat = () => {
    createSessionMutation.mutate();
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || !activeSessionId) return;

    sendMessageMutation.mutate(inputValue);
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(e);
    }
  };

  const sidebarContent = (
    <ChatSidebar
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSessionSelect={setActiveSessionId}
      onNewChat={handleNewChat}
    />
  );

  return (
    <div className="flex h-screen bg-background">
      <div className="hidden md:block w-72 h-full">
        {sidebarContent}
      </div>

      <div className="flex-1 flex flex-col h-full">
        <header className="border-b bg-card px-4 py-3 flex items-center gap-3">
          <Sheet>
            <SheetTrigger asChild className="md:hidden">
              <Button variant="ghost" size="icon" data-testid="button-menu">
                <Menu className="w-5 h-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-72">
              {sidebarContent}
            </SheetContent>
          </Sheet>
          <div>
            <h1 className="text-lg font-semibold">OPENCouncil Assistant</h1>
            <p className="text-xs text-muted-foreground">Ask questions about your municipal documents</p>
          </div>
        </header>

        <ScrollArea className="flex-1 p-4">
          <div className="max-w-4xl mx-auto space-y-6">
            {!activeSessionId ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <MessageCircle className="w-16 h-16 text-muted-foreground mb-4" />
                <h2 className="text-xl font-semibold mb-2">Start a New Conversation</h2>
                <p className="text-muted-foreground mb-6">Ask questions about your municipal documents</p>
                <Button onClick={handleNewChat} data-testid="button-start-chat">
                  <Plus className="w-4 h-4 mr-2" />
                  New Chat
                </Button>
              </div>
            ) : messagesLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-4">
                    <Skeleton className="w-8 h-8 rounded-full" />
                    <Skeleton className="h-20 flex-1" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {messages?.map((message) => (
                  <MessageBubble 
                    key={message.id} 
                    message={message} 
                    onFollowUpClick={handleFollowUpClick}
                  />
                ))}
                {sendMessageMutation.isPending && <TypingIndicator />}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        </ScrollArea>

        <div className="border-t bg-card p-4">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto">
            <div className="flex gap-2">
              <Textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your municipal documents..."
                className="min-h-[60px] resize-none"
                disabled={!activeSessionId || sendMessageMutation.isPending}
                data-testid="input-message"
              />
              <Button
                type="submit"
                size="icon"
                disabled={!activeSessionId || !inputValue.trim() || sendMessageMutation.isPending}
                className="h-[60px] w-[60px]"
                data-testid="button-send"
              >
                {sendMessageMutation.isPending ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2 text-center">
              Press Enter to send, Shift+Enter for new line
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
