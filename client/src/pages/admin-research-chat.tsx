import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { parseSSEStream } from "@/lib/sseParser";
import { ChatMessageBubble } from "@/components/ChatMessageBubble";
import { TypingIndicator } from "@/components/TypingIndicator";
import {
  Send,
  Loader2,
  Sparkles,
  Paperclip,
  X,
  FileText,
  Microscope,
  RotateCcw,
  ExternalLink,
  User,
  LogOut,
  FlaskConical,
} from "lucide-react";
import { NH_TOWNS } from "@shared/schema";
import type { ChatSession, ChatMessage } from "@shared/schema";

function adminFetch(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem("adminToken");
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

export default function AdminResearchChat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedTown, setSelectedTown] = useState<string>("");
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);
  const [isDeepDiveMode, setIsDeepDiveMode] = useState(false);
  const [deepDiveIteration, setDeepDiveIteration] = useState(0);
  const [deepDiveMaxIterations, setDeepDiveMaxIterations] = useState(3);
  const [isStreaming, setIsStreaming] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const towns = NH_TOWNS.filter(t => t !== "statewide");

  const { data: messages, isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: ["/api/chat/sessions", sessionId],
    enabled: !!sessionId,
  });

  const assistantMessages = messages?.filter(m => m.role === "assistant") || [];
  const canGenerate = !!selectedTown && assistantMessages.length > 0 && !!sessionId;

  const sendStreamingMessage = useCallback(async (content: string, useDeepDive: boolean = false) => {
    if (!sessionId) return;
    setIsStreaming(true);
    setPipelineStage(null);
    setDeepDiveIteration(0);

    const endpoint = useDeepDive
      ? `/api/chat/v2/sessions/${sessionId}/messages/deep-dive`
      : `/api/chat/v2/sessions/${sessionId}/messages/stream`;

    const abortController = new AbortController();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, metadata: { town: selectedTown || undefined } }),
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
          queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", sessionId] });
        },
        onFollowups: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", sessionId] });
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
  }, [sessionId, selectedTown, toast]);

  const sendMessageMutation = useMutation({
    mutationFn: async ({ content, file }: { content: string; file: File | null }) => {
      if (!sessionId) {
        throw new Error("No active session");
      }

      if (file) {
        const formData = new FormData();
        formData.append("content", content);
        formData.append("file", file);

        const response = await fetch(`/api/chat/v2/sessions/${sessionId}/messages/upload`, {
          method: "POST",
          body: formData,
          credentials: "include",
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ message: "Upload failed" }));
          throw new Error(error.message || "Upload failed");
        }
        return response;
      } else {
        sendStreamingMessage(content, isDeepDiveMode);
        return null;
      }
    },
    onSuccess: (result) => {
      if (result !== null) {
        setPendingMessage(null);
        setSelectedFile(null);
        queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", sessionId] });
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

  const generateFeedItemMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/content/generate-from-chat", {
        method: "POST",
        body: JSON.stringify({ sessionId, town: selectedTown }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ message: "Generation failed" }));
        throw new Error(errData.message || "Generation failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({
        title: `Draft created: ${data.title || "Untitled"}`,
        description: "View and edit in the Content panel",
        action: (
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/content">
              <ExternalLink className="w-3 h-3 mr-1" />
              View in Content
            </Link>
          </Button>
        ),
      });
    },
    onError: (error) => {
      toast({
        title: "Failed to generate feed item",
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
      const form = document.querySelector("[data-testid='form-research-chat']") as HTMLFormElement;
      if (form) form.requestSubmit();
    }, 50);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sendMessageMutation.isPending, isStreaming]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputValue.trim() && !selectedFile)) return;

    const messageContent = inputValue.trim();

    if (!sessionId) {
      const res = await apiRequest("POST", "/api/chat/sessions", {
        title: "Research Chat",
      });
      const newSession: ChatSession = await res.json();
      setSessionId(newSession.id);

      if (selectedTown) {
        apiRequest("POST", "/api/preferences/town", {
          town: selectedTown,
          sessionId: newSession.id,
        }).catch(() => {});
      }

      const displayMessage = selectedFile
        ? `${messageContent}\n\n[Attached: ${selectedFile.name}]`
        : messageContent;
      setPendingMessage(displayMessage);
      setInputValue("");

      setTimeout(() => {
        if (selectedFile) {
          const formData = new FormData();
          formData.append("content", messageContent);
          formData.append("file", selectedFile);
          fetch(`/api/chat/v2/sessions/${newSession.id}/messages/upload`, {
            method: "POST",
            body: formData,
            credentials: "include",
          }).then((response) => {
            if (!response.ok) throw new Error("Upload failed");
            setPendingMessage(null);
            setSelectedFile(null);
            queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", newSession.id] });
          }).catch((err) => {
            setPendingMessage(null);
            toast({ title: "Failed", description: err.message, variant: "destructive" });
          });
        } else {
          setIsStreaming(true);
          setPipelineStage(null);
          setDeepDiveIteration(0);

          const endpoint = isDeepDiveMode
            ? `/api/chat/v2/sessions/${newSession.id}/messages/deep-dive`
            : `/api/chat/v2/sessions/${newSession.id}/messages/stream`;

          const abortController = new AbortController();

          fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: messageContent }),
            credentials: "include",
            signal: abortController.signal,
          }).then(async (response) => {
            if (!response.ok || !response.body) throw new Error("Stream failed");
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
                queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", newSession.id] });
              },
              onFollowups: () => {
                queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", newSession.id] });
              },
              onError: (data) => {
                sseError = new Error(data?.message || "An error occurred");
              },
            }, abortController.signal);

            reader.cancel().catch(() => {});
            if (sseError) throw sseError;
          }).catch((error) => {
            setPendingMessage(null);
            toast({
              title: "Failed to send message",
              description: error instanceof Error ? error.message : "An error occurred",
              variant: "destructive",
            });
          }).finally(() => {
            setIsStreaming(false);
            setPipelineStage(null);
            setDeepDiveIteration(0);
          });
        }
      }, 100);
      return;
    }

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

  const handleNewResearch = () => {
    setSessionId(null);
    setSelectedTown("");
    setInputValue("");
    setPendingMessage(null);
    setSelectedFile(null);
    setPipelineStage(null);
    setIsStreaming(false);
    setIsDeepDiveMode(false);
    setDeepDiveIteration(0);
  };

  const handleLogout = () => {
    localStorage.removeItem("adminToken");
    window.location.href = "/admin/login";
  };

  const isBusy = sendMessageMutation.isPending || isStreaming;

  return (
    <div className="flex flex-col h-screen bg-background">
      <header className="border-b bg-card shrink-0">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10">
              <Microscope className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold" data-testid="text-page-title">Research Chat</h1>
              <p className="text-sm text-muted-foreground">Research topics and generate feed items</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" asChild data-testid="link-content">
              <Link href="/admin/content">
                <Sparkles className="w-4 h-4 mr-2" />
                Content
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-research">
              <Link href="/admin/research">
                <FlaskConical className="w-4 h-4 mr-2" />
                OC Research
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-documents">
              <Link href="/admin/documents">
                <FileText className="w-4 h-4 mr-2" />
                Documents
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout} data-testid="button-logout">
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <div className="border-b bg-card px-6 py-3 shrink-0">
        <div className="max-w-4xl mx-auto flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <label className="text-sm font-medium text-muted-foreground shrink-0">Town:</label>
            <Select value={selectedTown} onValueChange={setSelectedTown} disabled={!!sessionId}>
              <SelectTrigger className="w-full max-w-[240px]" data-testid="select-research-town">
                <SelectValue placeholder="Select a town..." />
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

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={isDeepDiveMode ? "default" : "outline"}
                size="sm"
                className={`toggle-elevate ${isDeepDiveMode ? "toggle-elevated" : ""}`}
                onClick={() => setIsDeepDiveMode(!isDeepDiveMode)}
                disabled={isBusy}
                data-testid="button-deep-dive-toggle"
              >
                <Sparkles className="w-4 h-4 mr-1" />
                Deep Dive
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{isDeepDiveMode ? "Switch to quick answer" : "Enable multi-pass deep analysis"}</p>
            </TooltipContent>
          </Tooltip>

          <Button
            onClick={() => generateFeedItemMutation.mutate()}
            disabled={!canGenerate || generateFeedItemMutation.isPending || isBusy}
            data-testid="button-generate-feed-item"
          >
            {generateFeedItemMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating draft...
              </>
            ) : (
              <>
                <FileText className="w-4 h-4 mr-2" />
                Generate Feed Item
              </>
            )}
          </Button>

          {sessionId && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleNewResearch}
              disabled={isBusy || generateFeedItemMutation.isPending}
              data-testid="button-new-research"
            >
              <RotateCcw className="w-4 h-4 mr-1" />
              New Research
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 p-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {!sessionId && !pendingMessage ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Microscope className="w-8 h-8 text-primary" />
              </div>
              <h2 className="text-xl font-semibold mb-2" data-testid="text-empty-state">Start Your Research</h2>
              <p className="text-muted-foreground mb-2 max-w-md">
                Select a town, ask questions about municipal documents, then generate a feed item from your findings.
              </p>
              {!selectedTown && (
                <Badge variant="secondary" className="mt-2 no-default-hover-elevate no-default-active-elevate" data-testid="badge-select-town-hint">
                  Select a town above to get started
                </Badge>
              )}
            </div>
          ) : messagesLoading && sessionId ? (
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
                <ChatMessageBubble
                  key={message.id}
                  message={message}
                  onFollowUpClick={handleFollowUpClick}
                />
              ))}
              {pendingMessage && (
                <div className="flex gap-4 justify-end">
                  <div className="flex flex-col gap-2 max-w-3xl items-end">
                    <div className="rounded-lg px-4 py-3 bg-primary text-primary-foreground">
                      <p className="text-sm whitespace-pre-wrap">{pendingMessage}</p>
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

      <div className="border-t bg-card p-4 shrink-0">
        <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto" data-testid="form-research-chat">
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
              disabled={isBusy}
              data-testid="button-attach-file"
            >
              <Paperclip className="w-5 h-5" />
            </Button>
            <Textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isDeepDiveMode ? "Ask a question for deep analysis..." : "Ask about municipal documents..."}
              className="min-h-[60px] resize-none"
              disabled={isBusy}
              data-testid="input-message"
            />
            <Button
              type="submit"
              size="icon"
              disabled={(!inputValue.trim() && !selectedFile) || isBusy}
              className="h-[60px] w-[60px]"
              data-testid="button-send"
            >
              {isBusy ? (
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
  );
}
