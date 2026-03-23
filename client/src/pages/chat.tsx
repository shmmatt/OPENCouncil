import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Send, Loader2, Menu, Sparkles, Paperclip, X, User, FileText, Link2, Landmark, BookOpen } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { UserStatusBar } from "@/components/user-status-bar";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { ChatSession, ChatMessage, TemplatePayload } from "@shared/schema";
import { TemplateBanner } from "@/components/TemplateBanner";
import { TemplateFirstMessage } from "@/components/TemplateFirstMessage";
import { useToast } from "@/hooks/use-toast";
import { parseSSEStream } from "@/lib/sseParser";
import { ChatMessageBubble } from "@/components/ChatMessageBubble";
import { TypingIndicator } from "@/components/TypingIndicator";
import { ChatSidebarPanel } from "@/components/ChatSidebarPanel";

export default function Chat() {
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const [inputValue, setInputValue] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [sharedLinkQuestion, setSharedLinkQuestion] = useState<string | null>(null);
  const [isProcessingSharedLink, setIsProcessingSharedLink] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);
  const [isDeepDiveMode, setIsDeepDiveMode] = useState(false);
  const [deepDiveIteration, setDeepDiveIteration] = useState(0);
  const [deepDiveMaxIterations, setDeepDiveMaxIterations] = useState(3);
  const [isStreaming, setIsStreaming] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sharedLinkProcessedRef = useRef(false);
  const { toast } = useToast();

  const activeSessionId = new URLSearchParams(searchString).get("session");

  const setActiveSessionId = useCallback((id: string | null) => {
    if (id) {
      navigate(`/chat?session=${id}`);
    } else {
      navigate("/chat");
    }
  }, [navigate]);

  useEffect(() => {
    if (sharedLinkProcessedRef.current) return;

    const urlParams = new URLSearchParams(window.location.search);
    const questionParam = urlParams.get("q");

    if (questionParam) {
      const decodedQuestion = questionParam;
      setSharedLinkQuestion(decodedQuestion);
      setIsProcessingSharedLink(true);
      sharedLinkProcessedRef.current = true;

      urlParams.delete("q");
      const remainingParams = urlParams.toString();
      const newUrl = window.location.pathname + (remainingParams ? `?${remainingParams}` : "");
      window.history.replaceState({}, document.title, newUrl);
    }
  }, []);

  const { data: prefData } = useQuery<{ town: string }>({
    queryKey: ["/api/preferences/town"],
  });
  const selectedTown = prefData?.town || "Ossipee";

  const { data: sessions } = useQuery<ChatSession[]>({
    queryKey: ["/api/chat/sessions"],
  });

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

  useEffect(() => {
    if (!sharedLinkQuestion || !isProcessingSharedLink) return;

    const processSharedLink = async () => {
      const questionToSend = sharedLinkQuestion;
      try {
        const res = await apiRequest("POST", "/api/chat/sessions", {
          title: questionToSend.slice(0, 50) + (questionToSend.length > 50 ? "..." : ""),
        });
        const newSession: ChatSession = await res.json();
        queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
        setActiveSessionId(newSession.id);

        await sendToSession(newSession.id, questionToSend);
        setSharedLinkQuestion(null);
      } catch (error) {
        console.error("Failed to process shared link:", error);
        setIsProcessingSharedLink(false);
        setSharedLinkQuestion(null);
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
      navigate(`/chat?session=${sessions[0].id}`);
    }
  }, [sessions, activeSessionId, navigate]);

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

  const mobileSidebarContent = <ChatSidebarPanel />;

  const sessionLabel = activeSession
    ? `ACTIVE SESSION: ${activeSession.title?.slice(0, 36).toUpperCase()}${(activeSession.title?.length ?? 0) > 36 ? "..." : ""}`
    : "CIVIC LEDGER ASSISTANT";

  return (
    <div className="flex h-full bg-background">
      <div className="flex-1 flex flex-col min-w-0 relative">
        <TemplateBanner onLaunch={handleTemplateLaunch} isLoading={createSessionMutation.isPending} selectedTown={selectedTown} />

        <div className="border-b bg-card px-5 md:px-8 py-5 flex-shrink-0">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <Sheet>
                <SheetTrigger asChild className="md:hidden">
                  <Button variant="ghost" size="icon" data-testid="button-menu">
                    <Menu className="w-5 h-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="p-0 w-72">
                  {mobileSidebarContent}
                </SheetContent>
              </Sheet>
              <div>
                <span
                  className="inline-block text-[10px] font-black uppercase tracking-widest text-muted-foreground bg-muted border border-border rounded-md px-2 py-0.5 mb-2"
                  data-testid="badge-active-session"
                >
                  {sessionLabel}
                </span>
                <h1 className="text-2xl md:text-3xl font-black font-headline text-foreground leading-tight">
                  Civic Ledger Assistant
                </h1>
                <p className="text-muted-foreground text-sm mt-1 max-w-xl leading-relaxed">
                  Access real-time information from official town records, meeting minutes, and municipal bylaws. Every response is cited directly from the archive.
                </p>
              </div>
            </div>
            <div className="hidden sm:block">
              <UserStatusBar />
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1 px-4 md:px-6 lg:px-8" style={{ paddingBottom: "8rem" }}>
          <div className="max-w-3xl mx-auto py-6 space-y-6">
            {isProcessingSharedLink && sharedLinkQuestion ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                  <Link2 className="w-8 h-8 text-primary animate-pulse" />
                </div>
                <h2 className="text-xl font-semibold font-headline mb-2" data-testid="text-shared-link-loading">Processing Your Question</h2>
                <p className="text-muted-foreground mb-4 max-w-md">
                  Starting a new conversation from your shared link...
                </p>
                <div className="bg-card border border-card-border rounded-lg p-4 max-w-md">
                  <p className="text-sm italic text-muted-foreground">"{sharedLinkQuestion}"</p>
                </div>
              </div>
            ) : !activeSessionId ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                  <Landmark className="w-8 h-8 text-primary" />
                </div>
                <h2 className="text-xl font-semibold font-headline mb-2">Start a New Conversation</h2>
                <p className="text-muted-foreground mb-6 max-w-sm">Ask questions about town bylaws, meeting minutes, or local updates.</p>
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
                      <div className="rounded-lg px-4 py-3 bg-sky-50 dark:bg-sky-950 border border-sky-200 dark:border-sky-800">
                        <p className="text-sm whitespace-pre-wrap text-foreground">{pendingMessage}</p>
                      </div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-1">
                        RESIDENT &bull; {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center border border-border">
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

        <div className="absolute bottom-0 left-0 right-0 px-4 md:px-8 pb-6 pt-3 bg-gradient-to-t from-background via-background to-transparent pointer-events-none">
          <form onSubmit={handleSendMessage} className="max-w-3xl mx-auto pointer-events-auto">
            <div className="bg-card border border-border rounded-2xl shadow-md overflow-hidden">
              {selectedFile && (
                <div className="flex items-center gap-2 bg-muted/50 px-4 pt-3 pb-1">
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
                    className="h-6 w-6 flex-shrink-0"
                    onClick={handleRemoveFile}
                    data-testid="button-remove-file"
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              )}
              {isDeepDiveMode && (
                <div className="flex items-center gap-2 bg-primary/5 border-b border-primary/10 px-4 pt-3 pb-2">
                  <Sparkles className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                  <span className="text-sm text-primary font-medium">Deep Dive — comprehensive multi-pass analysis</span>
                </div>
              )}
              <div className="flex items-end gap-2 px-3 py-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.txt"
                  onChange={handleFileSelect}
                  className="hidden"
                  data-testid="input-file"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={isDeepDiveMode ? "default" : "ghost"}
                      size="icon"
                      className={`flex-shrink-0 toggle-elevate ${isDeepDiveMode ? "toggle-elevated" : ""}`}
                      onClick={() => setIsDeepDiveMode(!isDeepDiveMode)}
                      disabled={!activeSessionId || sendMessageMutation.isPending || isStreaming}
                      data-testid="button-deep-dive-toggle"
                    >
                      <Sparkles className="w-4 h-4" />
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
                  placeholder={
                    isDeepDiveMode
                      ? "Ask a question for deep analysis..."
                      : selectedFile
                      ? "Ask a question about this document..."
                      : "Ask about town bylaws, meeting minutes, or local updates..."
                  }
                  className="min-h-[44px] max-h-32 resize-none border-0 shadow-none focus-visible:ring-0 bg-transparent p-1 flex-1"
                  disabled={!activeSessionId || sendMessageMutation.isPending || isStreaming}
                  data-testid="input-message"
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={!activeSessionId || (!inputValue.trim() && !selectedFile) || sendMessageMutation.isPending || isStreaming}
                  className="flex-shrink-0"
                  data-testid="button-send"
                >
                  {sendMessageMutation.isPending || isStreaming ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <div className="flex items-center gap-4 px-4 pb-3">
                <button
                  type="button"
                  className="text-xs text-muted-foreground flex items-center gap-1.5 hover:text-foreground transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!activeSessionId || sendMessageMutation.isPending || isStreaming}
                  data-testid="button-attach-file"
                >
                  <Paperclip className="w-3 h-3" />
                  Add Document
                </button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground flex items-center gap-1.5 hover:text-foreground transition-colors"
                  data-testid="button-view-archive"
                >
                  <BookOpen className="w-3 h-3" />
                  View Archive
                </button>
                <span className="text-xs text-muted-foreground/60 ml-auto hidden sm:block">
                  Enter to send &bull; Shift+Enter for new line
                </span>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
