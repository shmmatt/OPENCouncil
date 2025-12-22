import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiRequest } from "@/lib/queryClient";
import { MessageCircle, Plus, Send, Loader2, User, Bot, Menu, FileText, ExternalLink, Sparkles, ChevronDown, Link2, Paperclip, X, Info, AlertCircle } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { UserStatusBar } from "@/components/user-status-bar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatSession, ChatMessage, MinutesUpdateItem } from "@shared/schema";
import type { ChatNotice } from "@shared/chatNotices";
import { MessageNotices } from "@/components/MessageNotices";
import { useToast } from "@/hooks/use-toast";

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
  notices?: ChatNotice[];
  // Coverage data
  coverageScore?: number;
  missingFacets?: string[];
  showCoverageDisclaimer?: boolean;
  // Answer mode data
  answerMode?: "standard" | "deep";
  wasTruncated?: boolean;
}

function RecentMinutesUpdates({ 
  selectedTown,
  onAskAboutMeeting 
}: { 
  selectedTown: string;
  onAskAboutMeeting: (prompt: string) => void;
}) {
  const { data: minutesData, isLoading } = useQuery<{ items: MinutesUpdateItem[] }>({
    queryKey: ["/api/updates/minutes", selectedTown],
    queryFn: async () => {
      const res = await fetch(`/api/updates/minutes?town=${encodeURIComponent(selectedTown)}&limit=5`);
      if (!res.ok) throw new Error("Failed to fetch minutes updates");
      return res.json();
    },
  });

  const items = minutesData?.items || [];

  if (isLoading) {
    return (
      <div className="p-3 space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="p-3 text-center text-muted-foreground text-sm">
        No recent minutes have been added yet.
      </div>
    );
  }

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return null;
    try {
      return new Date(dateStr).toLocaleDateString("en-US", { 
        month: "short", 
        day: "numeric", 
        year: "numeric" 
      });
    } catch {
      return null;
    }
  };

  const handleAskClick = (item: MinutesUpdateItem) => {
    const meetingDateStr = item.meetingDate 
      ? formatDate(item.meetingDate) 
      : "recent meeting";
    const boardStr = item.board || "board";
    const prompt = `Summarize key decisions, votes, and any budget impacts from the ${item.town} ${boardStr} minutes for ${meetingDateStr}. Cite the minutes.`;
    onAskAboutMeeting(prompt);
  };

  return (
    <div className="space-y-1">
      {items.map((item) => (
        <div 
          key={item.documentVersionId}
          className="p-2 rounded-md bg-sidebar-accent/30 space-y-1"
          data-testid={`minutes-item-${item.documentVersionId}`}
        >
          <div className="flex items-start gap-2">
            <FileText className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {item.town}{item.board ? ` — ${item.board}` : ""}
              </p>
              {item.meetingDate && (
                <p className="text-xs text-muted-foreground">
                  Meeting: {formatDate(item.meetingDate)}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Added: {formatDate(item.ingestedAt)}
              </p>
            </div>
          </div>
          <div className="flex gap-1 ml-6">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => handleAskClick(item)}
              data-testid={`button-ask-about-${item.documentVersionId}`}
            >
              <Sparkles className="w-3 h-3 mr-1" />
              Ask
            </Button>
            {item.fileSearchDocumentName && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs px-2"
                asChild
                data-testid={`button-view-${item.documentVersionId}`}
              >
                <a 
                  href={`/admin/documents?doc=${item.logicalDocumentId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="w-3 h-3 mr-1" />
                  View
                </a>
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatSidebar({ 
  sessions, 
  activeSessionId, 
  onSessionSelect, 
  onNewChat,
  onInsertPrompt
}: { 
  sessions?: ChatSession[]; 
  activeSessionId: string | null;
  onSessionSelect: (id: string) => void;
  onNewChat: () => void;
  onInsertPrompt: (prompt: string) => void;
}) {
  // Fetch available towns
  const { data: townsData } = useQuery<{ towns: string[] }>({
    queryKey: ["/api/meta/towns"],
  });

  // Fetch current town preference
  const { data: prefData } = useQuery<{ town: string }>({
    queryKey: ["/api/preferences/town"],
  });

  const [selectedTown, setSelectedTown] = useState<string>("Ossipee");

  // Update selected town when preference loads
  useEffect(() => {
    if (prefData?.town) {
      setSelectedTown(prefData.town);
    }
  }, [prefData?.town]);

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

      {/* Town selector */}
      <div className="p-3 border-b border-sidebar-border">
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
          Town
        </label>
        <Select value={selectedTown} onValueChange={handleTownChange}>
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

      {/* Recent minutes updates - collapsible */}
      <Collapsible defaultOpen={false} className="border-b border-sidebar-border">
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover-elevate" data-testid="button-toggle-minutes">
          <h3 className="text-xs font-medium text-muted-foreground">
            Recent Minutes Updates
          </h3>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3">
          <RecentMinutesUpdates 
            selectedTown={selectedTown}
            onAskAboutMeeting={onInsertPrompt}
          />
        </CollapsibleContent>
      </Collapsible>

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
  const notices = v2Data?.notices || [];
  const showCoverageDisclaimer = v2Data?.showCoverageDisclaimer || false;
  const missingFacets = v2Data?.missingFacets || [];

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
          {isUser ? (
            <p className="text-base whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 prose-headings:my-3 prose-headings:font-semibold prose-table:w-full prose-table:border-collapse prose-th:border prose-th:border-border prose-th:bg-muted prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-semibold prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>
        
        
        {/* V2 Notices (scope, disclaimers, system messages) */}
        {!isUser && notices.length > 0 && (
          <MessageNotices notices={notices} />
        )}
        
        {/* Coverage disclaimer - "What we couldn't confirm" */}
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

interface TypingIndicatorProps {
  hasFile?: boolean;
  messageContent?: string;
}

const STATUS_PHRASES = {
  initial: ["Thinking..."],
  document: [
    "Analyzing your document...",
    "Extracting key information...",
    "Cross-referencing sources...",
    "Finding relevant sections...",
  ],
  search: [
    "Searching through documents...",
    "Finding relevant information...",
    "Reviewing municipal records...",
    "Gathering insights...",
  ],
  general: [
    "Formulating response...",
    "Analyzing your question...",
    "Preparing your answer...",
    "Putting it all together...",
  ],
};

function getContextType(hasFile?: boolean, messageContent?: string): keyof typeof STATUS_PHRASES {
  if (hasFile) return "document";
  
  const content = (messageContent || "").toLowerCase();
  const searchTerms = ["find", "search", "look for", "where", "what", "when", "who", "meeting", "minutes", "document", "report"];
  
  if (searchTerms.some(term => content.includes(term))) {
    return "search";
  }
  
  return "general";
}

function TypingIndicator({ hasFile, messageContent }: TypingIndicatorProps) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [showPhrase, setShowPhrase] = useState(false);
  const contextType = getContextType(hasFile, messageContent);
  const phrases = STATUS_PHRASES[contextType];

  useEffect(() => {
    // Show dots first, then show phrase after brief delay
    const initialTimer = setTimeout(() => {
      setShowPhrase(true);
    }, 800);

    return () => clearTimeout(initialTimer);
  }, []);

  useEffect(() => {
    if (!showPhrase) return;

    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % phrases.length);
    }, 2500);

    return () => clearInterval(interval);
  }, [showPhrase, phrases.length]);

  return (
    <div className="flex gap-4 justify-start">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
        <Bot className="w-4 h-4 text-primary" />
      </div>
      <div className="flex flex-col gap-2 max-w-3xl">
        <div className="rounded-lg px-4 py-3 bg-card border border-card-border">
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
              <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
              <div className="w-2 h-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            {showPhrase && (
              <span 
                className="text-sm text-muted-foreground animate-in fade-in duration-300"
                data-testid="text-typing-status"
              >
                {phrases[phraseIndex]}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Type for answer mode
type AnswerMode = "standard" | "deep";

// LocalStorage key for deep answer mode preference
const DEEP_ANSWER_MODE_KEY = "opencouncil-deep-answer-mode";

export default function Chat() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [sharedLinkQuestion, setSharedLinkQuestion] = useState<string | null>(null);
  const [isProcessingSharedLink, setIsProcessingSharedLink] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  
  // Deep Answer mode state - persisted in localStorage (default OFF)
  const [deepAnswerMode, setDeepAnswerMode] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(DEEP_ANSWER_MODE_KEY);
      return stored === "true";
    } catch {
      return false;
    }
  });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sharedLinkProcessedRef = useRef(false);
  const { toast } = useToast();
  
  // Persist deep answer mode to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(DEEP_ANSWER_MODE_KEY, String(deepAnswerMode));
    } catch {
      // localStorage unavailable - silent fail
    }
  }, [deepAnswerMode]);
  
  // Fetch chat config to check if deep answer feature is enabled
  const { data: chatConfigData } = useQuery<{ deepAnswerEnabled: boolean }>({
    queryKey: ["/api/chat/config"],
  });
  
  // Check if deep answer feature is enabled (server-controlled)
  const deepAnswerFeatureEnabled = chatConfigData?.deepAnswerEnabled ?? false;
  
  // Derive answerMode from toggle state (only apply if feature enabled)
  const answerMode: AnswerMode = (deepAnswerFeatureEnabled && deepAnswerMode) ? "deep" : "standard";

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
        return await apiRequest("POST", `/api/chat/v2/sessions/${activeSessionId}/messages`, { 
          content, 
          answerMode 
        });
      }
    },
    onSuccess: () => {
      setPendingMessage(null);
      setSelectedFile(null);
      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions", activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/usage"] });
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

  const handleInsertPrompt = (prompt: string) => {
    setInputValue(prompt);
  };

  const sidebarContent = (
    <ChatSidebar
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSessionSelect={setActiveSessionId}
      onNewChat={handleNewChat}
      onInsertPrompt={handleInsertPrompt}
    />
  );

  return (
    <div className="flex h-screen bg-background">
      <div className="hidden md:block w-72 h-full">
        {sidebarContent}
      </div>

      <div className="flex-1 flex flex-col h-full">
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
                {messages?.map((message) => (
                  <MessageBubble 
                    key={message.id} 
                    message={message} 
                    onFollowUpClick={handleFollowUpClick}
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
                {sendMessageMutation.isPending && (
                  <TypingIndicator 
                    hasFile={!!selectedFile} 
                    messageContent={pendingMessage || inputValue} 
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
                disabled={!activeSessionId || sendMessageMutation.isPending}
                data-testid="button-attach-file"
              >
                <Paperclip className="w-5 h-5" />
              </Button>
              <Textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={selectedFile ? "Ask a question about this document..." : "Ask about your municipal documents..."}
                className="min-h-[60px] resize-none"
                disabled={!activeSessionId || sendMessageMutation.isPending}
                data-testid="input-message"
              />
              <Button
                type="submit"
                size="icon"
                disabled={!activeSessionId || (!inputValue.trim() && !selectedFile) || sendMessageMutation.isPending}
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
            <div className="flex items-center justify-between mt-2">
              <p className="text-xs text-muted-foreground">
                Press Enter to send, Shift+Enter for new line
              </p>
              {/* Only show Deep Answer toggle if feature is enabled */}
              {deepAnswerFeatureEnabled && (
                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1.5">
                        <Switch
                          id="deep-answer-mode"
                          checked={deepAnswerMode}
                          onCheckedChange={setDeepAnswerMode}
                          disabled={sendMessageMutation.isPending}
                          data-testid="switch-deep-answer"
                        />
                        <Label 
                          htmlFor="deep-answer-mode" 
                          className="text-xs text-muted-foreground cursor-pointer select-none"
                        >
                          Detailed answers
                        </Label>
                        <Info className="w-3 h-3 text-muted-foreground" />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <p className="text-sm">
                        Get longer, more comprehensive answers with additional context. 
                        Best for complex policy questions or research.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
