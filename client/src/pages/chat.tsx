import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageCircle, Plus, Send, Loader2, Menu, Sparkles, Paperclip, X, Rss, User, FileText, Link2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { UserStatusBar } from "@/components/user-status-bar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { ChatSession, ChatMessage, TemplatePayload } from "@shared/schema";
import { TemplateBanner } from "@/components/TemplateBanner";
import { TemplateFirstMessage } from "@/components/TemplateFirstMessage";
import { useToast } from "@/hooks/use-toast";
import { parseSSEStream } from "@/lib/sseParser";
import { ChatMessageBubble } from "@/components/ChatMessageBubble";
import { TypingIndicator } from "@/components/TypingIndicator";

function ChatSidebar({ 
  sessions, 
  activeSessionId, 
  onSessionSelect, 
  onNewChat,
  selectedTown,
  onTownChange,
  towns,
}: { 
  sessions?: ChatSession[]; 
  activeSessionId: string | null;
  onSessionSelect: (id: string) => void;
  onNewChat: () => void;
  selectedTown: string;
  onTownChange: (town: string) => void;
  towns: string[];
}) {
  const [location] = useLocation();
  const isFeedActive = location.startsWith("/feed");
  const isChatActive = location.startsWith("/chat");

  return (
    <div className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      <div className="p-4 space-y-2 border-b border-sidebar-border">
        <Button 
          onClick={onNewChat} 
          className="w-full"
          variant={isChatActive ? "default" : "outline"}
          data-testid="button-new-chat"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Chat
        </Button>
        <Button
          asChild
          className="w-full"
          variant={isFeedActive ? "default" : "outline"}
          data-testid="link-town-feed"
        >
          <Link href="/feed">
            <Rss className="w-4 h-4 mr-2" />
            Town Feed
          </Link>
        </Button>
      </div>

      {/* Town selector */}
      <div className="p-3 border-b border-sidebar-border">
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
          Town
        </label>
        <Select value={selectedTown} onValueChange={onTownChange}>
          <SelectTrigger 
            className="w-full" 
            data-testid="select-town"
          >
            <SelectValue placeholder="Select a town" />
          </SelectTrigger>
          <SelectContent>
            {towns.map((town) => (
              <SelectItem key={town} value={town} data-testid={`town-option-${town}`}>
                {town}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Sessions list */}
      <div className="p-3 pb-1">
        <h3 className="text-xs font-medium text-muted-foreground mb-2">
          Conversations
        </h3>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-2 pb-2 space-y-1">
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

export default function Chat() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [sharedLinkQuestion, setSharedLinkQuestion] = useState<string | null>(null);
  const [isProcessingSharedLink, setIsProcessingSharedLink] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedTown, setSelectedTown] = useState<string>("Ossipee");
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);
  const [isDeepDiveMode, setIsDeepDiveMode] = useState(false);
  const [deepDiveIteration, setDeepDiveIteration] = useState(0);
  const [deepDiveMaxIterations, setDeepDiveMaxIterations] = useState(3);
  const [isStreaming, setIsStreaming] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sharedLinkProcessedRef = useRef(false);
  const { toast } = useToast();

  // Detect ?session= URL parameter for template-launched sessions
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const sessionParam = urlParams.get("session");
    if (sessionParam) {
      setActiveSessionId(sessionParam);
      urlParams.delete("session");
      const remainingParams = urlParams.toString();
      const newUrl = window.location.pathname + (remainingParams ? `?${remainingParams}` : "");
      window.history.replaceState({}, document.title, newUrl);
    }
  }, []);

  // Detect ?q= URL parameter for shareable links
  useEffect(() => {
    if (sharedLinkProcessedRef.current) return;
    
    const urlParams = new URLSearchParams(window.location.search);
    const questionParam = urlParams.get("q");
    
    if (questionParam) {
      const decodedQuestion = questionParam;
      setSharedLinkQuestion(decodedQuestion);
      setIsProcessingSharedLink(true);
      sharedLinkProcessedRef.current = true;
      
      // Remove only the 'q' parameter, preserve other params (like utm_source, etc.)
      urlParams.delete("q");
      const remainingParams = urlParams.toString();
      const newUrl = window.location.pathname + (remainingParams ? `?${remainingParams}` : "");
      window.history.replaceState({}, document.title, newUrl);
    }
  }, []);

  const { data: townsData } = useQuery<{ towns: string[] }>({
    queryKey: ["/api/meta/towns"],
  });

  const { data: prefData } = useQuery<{ town: string }>({
    queryKey: ["/api/preferences/town"],
  });

  useEffect(() => {
    if (prefData?.town) {
      setSelectedTown(prefData.town);
    }
  }, [prefData?.town]);

  const { data: sessions } = useQuery<ChatSession[]>({
    queryKey: ["/api/chat/sessions"],
  });

  const setTownMutation = useMutation({
    mutationFn: async (town: string) => {
      await apiRequest("POST", "/api/preferences/town", { 
        town,
        sessionId: activeSessionId 
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/preferences/town"] });
      queryClient.invalidateQueries({ queryKey: ["/api/updates/minutes"] });
    },
  });

  const handleTownChange = (town: string) => {
    setSelectedTown(town);
    setTownMutation.mutate(town);
  };

  const towns = townsData?.towns || ["Ossipee"];

  const { data: messages, isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: ["/api/chat/sessions", activeSessionId],
    enabled: !!activeSessionId,
  });

  const createSessionMutation = useMutation({
    mutationFn: async (params?: { templateId?: string; feedItemId?: string; title?: string }): Promise<ChatSession> => {
      const res = await apiRequest("POST", "/api/chat/sessions", {
        title: params?.title || "New conversation",
        templateId: params?.templateId,
        feedItemId: params?.feedItemId,
      });
      return res.json();
    },
    onSuccess: (newSession: ChatSession) => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
      setActiveSessionId(newSession.id);
    },
  });

  // Send message to a specific session (used for shared links)
  const sendToSession = useCallback(async (sessionId: string, content: string) => {
    setPendingMessage(content);
    try {
      await apiRequest("POST", `/api/chat/v2/sessions/${sessionId}/messages`, { content });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/usage"] });
    } finally {
      setPendingMessage(null);
      setIsProcessingSharedLink(false);
    }
  }, []);

  const deepLinkProcessedRef = useRef(false);
  useEffect(() => {
    if (deepLinkProcessedRef.current) return;

    const urlParams = new URLSearchParams(window.location.search);
    const feedId = urlParams.get("feedId");
    const templateSlug = urlParams.get("templateSlug");
    const qIdStr = urlParams.get("qId");

    if ((!feedId && !templateSlug) || qIdStr === null) return;

    deepLinkProcessedRef.current = true;
    window.history.replaceState({}, document.title, window.location.pathname);

    const qId = parseInt(qIdStr, 10);

    const processDeepLink = async () => {
      try {
        let payload: any = null;
        let sessionPayload: Record<string, string> = {};

        if (feedId) {
          const feedRes = await fetch(`/api/feed/items/${feedId}`, { credentials: "include" });
          if (!feedRes.ok) throw new Error("Feed item not found");
          const feedItem = await feedRes.json();
          payload = feedItem.generatedPayload;
          sessionPayload = { feedItemId: feedId };
        } else if (templateSlug) {
          const templateRes = await fetch(`/api/templates/by-slug/${templateSlug}`, { credentials: "include" });
          if (!templateRes.ok) throw new Error("Template not found");
          const template = await templateRes.json();
          payload = template.generatedPayload;
          sessionPayload = { templateId: template.id };
        }

        if (!payload) throw new Error("No payload found");

        const allQuestions: string[] = [];
        if (payload.sections) {
          for (const section of payload.sections) {
            if (section.suggestedQuestions) {
              allQuestions.push(...section.suggestedQuestions);
            }
          }
        }
        if (payload.highLevelQuestions) {
          allQuestions.push(...payload.highLevelQuestions);
        }

        const question = allQuestions[qId];
        if (!question) throw new Error(`Question index ${qId} out of range`);

        setSharedLinkQuestion(question);
        setIsProcessingSharedLink(true);
        sharedLinkProcessedRef.current = true;

        const sessionRes = await apiRequest("POST", "/api/chat/sessions", {
          title: question.slice(0, 50) + (question.length > 50 ? "..." : ""),
          ...sessionPayload,
        });
        const newSession = await sessionRes.json();
        queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
        setActiveSessionId(newSession.id);

        await sendToSession(newSession.id, question);
        setSharedLinkQuestion(null);
        setIsProcessingSharedLink(false);
      } catch (error) {
        console.error("Failed to process deep link:", error);
        setIsProcessingSharedLink(false);
        setSharedLinkQuestion(null);
        toast({
          title: "Could not process deep link",
          description: "The linked question could not be loaded. Please try again.",
          variant: "destructive",
        });
      }
    };

    processDeepLink();
  }, [sendToSession, toast]);

  // Auto-create session and send message when shared link question is detected
  useEffect(() => {
    if (!sharedLinkQuestion || !isProcessingSharedLink) return;
    
    const processSharedLink = async () => {
      const questionToSend = sharedLinkQuestion;
      try {
        // Create a new session for the shared link
        const res = await apiRequest("POST", "/api/chat/sessions", { 
          title: questionToSend.slice(0, 50) + (questionToSend.length > 50 ? "..." : "")
        });
        const newSession: ChatSession = await res.json();
        queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
        setActiveSessionId(newSession.id);
        
        // Send the question
        await sendToSession(newSession.id, questionToSend);
        setSharedLinkQuestion(null);
      } catch (error) {
        console.error("Failed to process shared link:", error);
        setIsProcessingSharedLink(false);
        setSharedLinkQuestion(null);
        // Put the question in the input field so user can retry
        setInputValue(questionToSend);
        toast({
          title: "Could not process shared link",
          description: "Your question has been added to the input field. Please try sending it manually.",
          variant: "destructive",
        });
      }
    };
    
    processSharedLink();
  }, [sharedLinkQuestion, isProcessingSharedLink, sendToSession, toast]);

  const sendStreamingMessage = useCallback(async (content: string, useDeepDive: boolean = false) => {
    if (!activeSessionId) return;
    setIsStreaming(true);
    setPipelineStage(null);
    setDeepDiveIteration(0);

    const endpoint = useDeepDive
      ? `/api/chat/v2/sessions/${activeSessionId}/messages/deep-dive`
      : `/api/chat/v2/sessions/${activeSessionId}/messages/stream`;

    const abortController = new AbortController();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        credentials: "include",
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => "Stream failed");
        throw new Error(errText);
      }

      const reader = response.body.getReader();
      let sseError: Error | null = null;

      await parseSSEStream(reader, {
        onStatus: (stage) => setPipelineStage(stage || null),
        onProgress: ({ iteration, maxIterations }) => {
          setDeepDiveIteration(iteration);
          setDeepDiveMaxIterations(maxIterations);
        },
        onAnswer: () => {
          setPendingMessage(null);
          setPipelineStage(null);
          queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", activeSessionId] });
          queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
          queryClient.invalidateQueries({ queryKey: ["/api/auth/usage"] });
        },
        onFollowups: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", activeSessionId] });
        },
        onError: (data) => {
          sseError = new Error(data?.message || "An error occurred");
        },
      }, abortController.signal);

      reader.cancel().catch(() => {});
      if (sseError) throw sseError;
    } catch (error) {
      setPendingMessage(null);
      toast({
        title: "Failed to send message",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsStreaming(false);
      setPipelineStage(null);
      setDeepDiveIteration(0);
    }
  }, [activeSessionId, toast]);

  const sendMessageMutation = useMutation({
    mutationFn: async ({ content, file }: { content: string; file: File | null }) => {
      if (!activeSessionId) {
        throw new Error("No active chat session. Please start a new chat first.");
      }
      
      if (file) {
        const formData = new FormData();
        formData.append("content", content);
        formData.append("file", file);
        
        try {
          const response = await fetch(`/api/chat/v2/sessions/${activeSessionId}/messages/upload`, {
            method: "POST",
            body: formData,
            credentials: "include",
          });
          
          if (!response.ok) {
            const error = await response.json().catch(() => ({ message: "Upload failed" }));
            throw new Error(error.message || "Upload failed");
          }
          
          return response;
        } catch (error) {
          if (error instanceof TypeError && error.message === "Failed to fetch") {
            throw new Error("Network error - the request may have timed out. Please try again with a smaller file.");
          }
          throw error;
        }
      } else {
        sendStreamingMessage(content, isDeepDiveMode);
        return null;
      }
    },
    onSuccess: (result) => {
      if (result !== null) {
        setPendingMessage(null);
        setSelectedFile(null);
        queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", activeSessionId] });
        queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
        queryClient.invalidateQueries({ queryKey: ["/api/auth/usage"] });
      } else {
        setSelectedFile(null);
      }
    },
    onError: (error) => {
      setPendingMessage(null);
      toast({
        title: "Failed to send message",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const allowedTypes = [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
      ];
      const allowedExtensions = [".pdf", ".docx", ".txt"];
      const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
      
      if (!allowedTypes.includes(file.type) && !allowedExtensions.includes(ext)) {
        toast({
          title: "Invalid file type",
          description: "Only PDF, DOCX, and TXT files are supported.",
          variant: "destructive",
        });
        return;
      }
      
      if (file.size > 25 * 1024 * 1024) {
        toast({
          title: "File too large",
          description: "Maximum file size is 25MB.",
          variant: "destructive",
        });
        return;
      }
      
      setSelectedFile(file);
    }
  };

  const handleRemoveFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFollowUpClick = (question: string) => {
    setInputValue(question);
    setTimeout(() => {
      const form = document.querySelector("form");
      if (form) {
        form.requestSubmit();
      }
    }, 50);
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
    createSessionMutation.mutate(undefined);
  };

  const handleTemplateLaunch = (templateId: string, title: string) => {
    createSessionMutation.mutate({ templateId, title });
  };

  const activeSession = sessions?.find((s) => s.id === activeSessionId);
  const activeTemplateId = (activeSession as any)?.templateId as string | null;
  const activeFeedItemId = (activeSession as any)?.feedItemId as string | null;

  const { data: templateData } = useQuery<{
    id: string;
    title: string;
    bannerText: string;
    town: string;
    generatedPayload: TemplatePayload | null;
  } | null>({
    queryKey: ["/api/templates", activeTemplateId],
    queryFn: async () => {
      if (!activeTemplateId) return null;
      const res = await fetch(`/api/templates/${activeTemplateId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!activeTemplateId,
  });

  const { data: feedItemData } = useQuery<{
    id: string;
    title: string;
    town: string;
    summary: string;
    generatedPayload: TemplatePayload | null;
  } | null>({
    queryKey: ["/api/feed/items", activeFeedItemId],
    queryFn: async () => {
      if (!activeFeedItemId) return null;
      const res = await fetch(`/api/feed/items/${activeFeedItemId}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!activeFeedItemId,
  });

  const handleTemplateQuestionClick = (question: string) => {
    setInputValue(question);
    setTimeout(() => {
      const form = document.querySelector("form");
      if (form) {
        form.requestSubmit();
      }
    }, 50);
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputValue.trim() && !selectedFile) || !activeSessionId) return;

    const messageContent = inputValue.trim();
    const displayMessage = selectedFile 
      ? `${messageContent}\n\n[Attached: ${selectedFile.name}]`
      : messageContent;
    setPendingMessage(displayMessage);
    sendMessageMutation.mutate({ content: messageContent, file: selectedFile });
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
      selectedTown={selectedTown}
      onTownChange={handleTownChange}
      towns={towns}
    />
  );

  return (
    <div className="flex h-screen bg-background">
      <div className="hidden md:block w-72 h-full">
        {sidebarContent}
      </div>

      <div className="flex-1 flex flex-col h-full">
        <TemplateBanner onLaunch={handleTemplateLaunch} isLoading={createSessionMutation.isPending} selectedTown={selectedTown} />
        <header className="border-b bg-card px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
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
          </div>
          <UserStatusBar />
        </header>

        <ScrollArea className="flex-1 p-4">
          <div className="max-w-4xl mx-auto space-y-6">
            {isProcessingSharedLink && sharedLinkQuestion ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                  <Link2 className="w-8 h-8 text-primary animate-pulse" />
                </div>
                <h2 className="text-xl font-semibold mb-2" data-testid="text-shared-link-loading">Processing Your Question</h2>
                <p className="text-muted-foreground mb-4 max-w-md">
                  Starting a new conversation from your shared link...
                </p>
                <div className="bg-card border border-card-border rounded-lg p-4 max-w-md">
                  <p className="text-sm italic text-muted-foreground">"{sharedLinkQuestion}"</p>
                </div>
              </div>
            ) : !activeSessionId ? (
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
                {templateData?.generatedPayload && (
                  <TemplateFirstMessage
                    payload={templateData.generatedPayload}
                    title={templateData.title}
                    onQuestionClick={handleTemplateQuestionClick}
                  />
                )}
                {feedItemData?.generatedPayload && (
                  <TemplateFirstMessage
                    payload={feedItemData.generatedPayload}
                    title={feedItemData.title}
                    onQuestionClick={handleTemplateQuestionClick}
                  />
                )}
                {messages?.map((message) => (
                  <ChatMessageBubble 
                    key={message.id} 
                    message={message} 
                    onFollowUpClick={handleFollowUpClick}
                    onFeedbackSubmit={(type) => {
                      const current = message.feedback;
                      const newFeedback = current === type ? null : type;
                      apiRequest("POST", `/api/chat/messages/${message.id}/feedback`, { feedback: newFeedback })
                        .then(() => {
                          queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", activeSessionId] });
                        });
                    }}
                  />
                ))}
                {pendingMessage && (
                  <div className="flex gap-4 justify-end">
                    <div className="flex flex-col gap-2 max-w-3xl items-end">
                      <div className="rounded-lg px-4 py-3 bg-primary text-primary-foreground">
                        <p className="text-base whitespace-pre-wrap">{pendingMessage}</p>
                      </div>
                      <p className="text-xs text-muted-foreground px-1">
                        {new Date().toLocaleTimeString()}
                      </p>
                    </div>
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                )}
                {(sendMessageMutation.isPending || isStreaming) && (
                  <TypingIndicator 
                    pipelineStage={pipelineStage}
                    isDeepDive={isDeepDiveMode}
                    deepDiveIteration={deepDiveIteration}
                    deepDiveMaxIterations={deepDiveMaxIterations}
                  />
                )}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        </ScrollArea>

        <div className="border-t bg-card p-4">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto">
            {selectedFile && (
              <div className="mb-2 flex items-center gap-2 bg-muted/50 rounded-md px-3 py-2">
                <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm truncate flex-1" data-testid="text-attached-file">
                  {selectedFile.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  ({(selectedFile.size / 1024).toFixed(1)} KB)
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={handleRemoveFile}
                  data-testid="button-remove-file"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            )}
            {isDeepDiveMode && (
              <div className="mb-2 flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-md px-3 py-2">
                <Sparkles className="w-4 h-4 text-primary flex-shrink-0" />
                <span className="text-sm text-primary">Deep Dive mode — comprehensive multi-pass analysis</span>
              </div>
            )}
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt"
                onChange={handleFileSelect}
                className="hidden"
                data-testid="input-file"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-[60px] w-[60px] flex-shrink-0"
                onClick={() => fileInputRef.current?.click()}
                disabled={!activeSessionId || sendMessageMutation.isPending || isStreaming}
                data-testid="button-attach-file"
              >
                <Paperclip className="w-5 h-5" />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={isDeepDiveMode ? "default" : "outline"}
                    className={`h-[60px] px-4 flex-shrink-0 toggle-elevate ${isDeepDiveMode ? "toggle-elevated" : ""}`}
                    onClick={() => setIsDeepDiveMode(!isDeepDiveMode)}
                    disabled={!activeSessionId || sendMessageMutation.isPending || isStreaming}
                    data-testid="button-deep-dive-toggle"
                  >
                    <Sparkles className="w-5 h-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{isDeepDiveMode ? "Switch to quick answer" : "Deep Dive: comprehensive analysis"}</p>
                </TooltipContent>
              </Tooltip>
              <Textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isDeepDiveMode ? "Ask a question for deep analysis..." : selectedFile ? "Ask a question about this document..." : "Ask about your municipal documents..."}
                className="min-h-[60px] resize-none"
                disabled={!activeSessionId || sendMessageMutation.isPending || isStreaming}
                data-testid="input-message"
              />
              <Button
                type="submit"
                size="icon"
                disabled={!activeSessionId || (!inputValue.trim() && !selectedFile) || sendMessageMutation.isPending || isStreaming}
                className="h-[60px] w-[60px]"
                data-testid="button-send"
              >
                {(sendMessageMutation.isPending || isStreaming) ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Press Enter to send, Shift+Enter for new line{isDeepDiveMode ? " | Deep Dive active" : ""}
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
