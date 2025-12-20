import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Search,
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
  MessageSquare,
  DollarSign,
  FileWarning,
  Sparkles,
  RefreshCw,
  BarChart3,
  FileText,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";

interface ChatAnalyticsListItem {
  sessionId: string;
  title: string;
  userId: string | null;
  anonId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalCost: number;
  costPerMessage: number;
  isAnalyzed: boolean;
  summary: string | null;
  critique: string | null;
  missingDocsSuggestions: string | null;
  documentQualityScore: number | null;
  answerQualityScore: number | null;
  analyzedAt: string | null;
}

interface ChatAnalyticsListResult {
  items: ChatAnalyticsListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface ChatMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  citations: string | null;
  createdAt: string;
}

interface SessionDetails {
  session: {
    id: string;
    title: string;
    userId: string | null;
    anonId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  messages: ChatMessage[];
  analytics: {
    id: string;
    sessionId: string;
    summary: string;
    critique: string;
    missingDocsSuggestions: string | null;
    documentQualityScore: number | null;
    answerQualityScore: number | null;
    analyzedAt: string;
  } | null;
}

function ScoreBadge({ score, label }: { score: number | null; label: string }) {
  if (score === null) return <Badge variant="outline">-</Badge>;
  
  let variant: "default" | "secondary" | "destructive" | "outline" = "secondary";
  if (score >= 7) variant = "default";
  else if (score <= 4) variant = "destructive";
  
  return (
    <Badge variant={variant} className="min-w-[3rem] justify-center">
      {score}/10
    </Badge>
  );
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function formatCost(cost: number): string {
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

export default function AdminChatAnalytics() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const token = localStorage.getItem("adminToken");
  
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortField, setSortField] = useState("date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [filterAnalyzed, setFilterAnalyzed] = useState<string>("all");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const fetchWithAuth = useCallback(async (url: string, options: RequestInit = {}) => {
    const currentToken = localStorage.getItem("adminToken");
    if (!currentToken) {
      setLocation("/admin/login");
      throw new Error("No auth token");
    }
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${currentToken}`,
      },
    });
    if (res.status === 401) {
      localStorage.removeItem("adminToken");
      setLocation("/admin/login");
      throw new Error("Session expired");
    }
    if (!res.ok) throw new Error("Request failed");
    return res.json();
  }, [setLocation]);

  const queryParams = new URLSearchParams({
    page: page.toString(),
    pageSize: pageSize.toString(),
    sortField,
    sortOrder,
    search,
  });
  if (filterAnalyzed !== "all") {
    queryParams.set("filterAnalyzed", filterAnalyzed);
  }

  const { data, isLoading, refetch } = useQuery<ChatAnalyticsListResult>({
    queryKey: ["/api/admin/chat-analytics", page, pageSize, sortField, sortOrder, search, filterAnalyzed],
    queryFn: () => fetchWithAuth(`/api/admin/chat-analytics?${queryParams.toString()}`),
    enabled: !!token,
  });

  const { data: sessionDetails, isLoading: detailsLoading } = useQuery<SessionDetails>({
    queryKey: ["/api/admin/chat-analytics", selectedSessionId],
    queryFn: () => fetchWithAuth(`/api/admin/chat-analytics/${selectedSessionId}`),
    enabled: !!selectedSessionId && !!token,
  });

  const analyzeMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      return fetchWithAuth(`/api/admin/chat-analytics/${sessionId}/analyze`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      toast({ title: "Analysis complete", description: "Chat session has been analyzed." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/chat-analytics"] });
    },
    onError: () => {
      toast({ title: "Analysis failed", description: "Could not analyze chat session.", variant: "destructive" });
    },
  });

  const batchAnalyzeMutation = useMutation({
    mutationFn: async (sessionIds: string[]) => {
      return fetchWithAuth("/api/admin/chat-analytics/batch-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds }),
      });
    },
    onSuccess: (results: { sessionId: string; success: boolean; error?: string }[]) => {
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      toast({
        title: "Batch analysis complete",
        description: `${successful} succeeded, ${failed} failed`,
      });
      setSelectedSessions(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/admin/chat-analytics"] });
    },
    onError: () => {
      toast({ title: "Batch analysis failed", variant: "destructive" });
    },
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
    setPage(1);
  };

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const toggleSelect = (sessionId: string) => {
    const newSelected = new Set(selectedSessions);
    if (newSelected.has(sessionId)) {
      newSelected.delete(sessionId);
    } else {
      newSelected.add(sessionId);
    }
    setSelectedSessions(newSelected);
  };

  const selectAll = () => {
    if (!data) return;
    const allIds = new Set(data.items.map(item => item.sessionId));
    setSelectedSessions(allIds);
  };

  const deselectAll = () => {
    setSelectedSessions(new Set());
  };

  const openDetails = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setDetailsDialogOpen(true);
  };

  const items = data?.items || [];
  const total = data?.total || 0;
  const totalPages = data?.totalPages || 1;

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-96">
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground mb-4">Admin authentication required</p>
            <Link href="/admin/login">
              <Button data-testid="button-login">Go to Login</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link href="/admin/documents">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-semibold">Chat Analytics</h1>
              <p className="text-sm text-muted-foreground">
                Review and analyze all user chat sessions
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/admin/usage">
              <Button variant="outline" size="sm" data-testid="button-usage">
                <BarChart3 className="h-4 w-4 mr-2" />
                Usage Dashboard
              </Button>
            </Link>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader className="pb-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search chats..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    className="pl-9 w-64"
                    data-testid="input-search"
                  />
                </div>
                <Button variant="outline" size="sm" onClick={handleSearch} data-testid="button-search">
                  Search
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Select value={filterAnalyzed} onValueChange={(v) => { setFilterAnalyzed(v); setPage(1); }}>
                  <SelectTrigger className="w-40" data-testid="select-filter-analyzed">
                    <SelectValue placeholder="Filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sessions</SelectItem>
                    <SelectItem value="true">Analyzed Only</SelectItem>
                    <SelectItem value="false">Not Analyzed</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetch()}
                  data-testid="button-refresh"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {selectedSessions.size > 0 && (
              <div className="flex items-center gap-2 mb-4 p-3 bg-muted/50 rounded-md">
                <span className="text-sm font-medium">
                  {selectedSessions.size} selected
                </span>
                <Button
                  size="sm"
                  onClick={() => batchAnalyzeMutation.mutate(Array.from(selectedSessions))}
                  disabled={batchAnalyzeMutation.isPending}
                  data-testid="button-batch-analyze"
                >
                  {batchAnalyzeMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4 mr-2" />
                  )}
                  Analyze Selected
                </Button>
                <Button variant="ghost" size="sm" onClick={deselectAll} data-testid="button-deselect-all">
                  Clear Selection
                </Button>
              </div>
            )}

            {isLoading ? (
              <div className="space-y-4">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <MessageSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No chat sessions found</p>
              </div>
            ) : (
              <div className="border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox
                          checked={selectedSessions.size === items.length && items.length > 0}
                          onCheckedChange={(checked) => checked ? selectAll() : deselectAll()}
                          data-testid="checkbox-select-all"
                        />
                      </TableHead>
                      <TableHead className="w-12"></TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 p-0 font-medium"
                          onClick={() => handleSort("date")}
                          data-testid="button-sort-date"
                        >
                          Date
                          <ArrowUpDown className="ml-2 h-4 w-4" />
                        </Button>
                      </TableHead>
                      <TableHead>Chat Title</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 p-0 font-medium"
                          onClick={() => handleSort("messages")}
                          data-testid="button-sort-messages"
                        >
                          Messages
                          <ArrowUpDown className="ml-2 h-4 w-4" />
                        </Button>
                      </TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 p-0 font-medium"
                          onClick={() => handleSort("cost")}
                          data-testid="button-sort-cost"
                        >
                          Cost
                          <ArrowUpDown className="ml-2 h-4 w-4" />
                        </Button>
                      </TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 p-0 font-medium"
                          onClick={() => handleSort("docScore")}
                          data-testid="button-sort-doc-score"
                        >
                          Doc Score
                          <ArrowUpDown className="ml-2 h-4 w-4" />
                        </Button>
                      </TableHead>
                      <TableHead>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 p-0 font-medium"
                          onClick={() => handleSort("answerScore")}
                          data-testid="button-sort-answer-score"
                        >
                          Answer Score
                          <ArrowUpDown className="ml-2 h-4 w-4" />
                        </Button>
                      </TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <Collapsible key={item.sessionId} asChild>
                        <>
                          <TableRow className="hover-elevate">
                            <TableCell>
                              <Checkbox
                                checked={selectedSessions.has(item.sessionId)}
                                onCheckedChange={() => toggleSelect(item.sessionId)}
                                data-testid={`checkbox-session-${item.sessionId}`}
                              />
                            </TableCell>
                            <TableCell>
                              <CollapsibleTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setExpandedRow(expandedRow === item.sessionId ? null : item.sessionId)}
                                  data-testid={`button-expand-${item.sessionId}`}
                                >
                                  {expandedRow === item.sessionId ? (
                                    <ChevronUp className="h-4 w-4" />
                                  ) : (
                                    <ChevronDown className="h-4 w-4" />
                                  )}
                                </Button>
                              </CollapsibleTrigger>
                            </TableCell>
                            <TableCell className="text-sm">
                              {formatDate(item.updatedAt)}
                            </TableCell>
                            <TableCell className="max-w-xs truncate font-medium">
                              {item.title}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {item.userId ? (
                                <Badge variant="secondary">User</Badge>
                              ) : (
                                <Badge variant="outline">Anon</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-sm">
                              {item.messageCount}
                            </TableCell>
                            <TableCell className="text-sm">
                              {formatCost(item.totalCost)}
                            </TableCell>
                            <TableCell>
                              <ScoreBadge score={item.documentQualityScore} label="Doc" />
                            </TableCell>
                            <TableCell>
                              <ScoreBadge score={item.answerQualityScore} label="Answer" />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openDetails(item.sessionId)}
                                  data-testid={`button-view-${item.sessionId}`}
                                >
                                  <FileText className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => analyzeMutation.mutate(item.sessionId)}
                                  disabled={analyzeMutation.isPending}
                                  data-testid={`button-analyze-${item.sessionId}`}
                                >
                                  {analyzeMutation.isPending ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Sparkles className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                          <CollapsibleContent asChild>
                            <TableRow className="bg-muted/30">
                              <TableCell colSpan={10} className="p-4">
                                {item.isAnalyzed ? (
                                  <div className="grid gap-4 md:grid-cols-3">
                                    <div>
                                      <h4 className="font-medium text-sm mb-1">Summary</h4>
                                      <p className="text-sm text-muted-foreground">{item.summary}</p>
                                    </div>
                                    <div>
                                      <h4 className="font-medium text-sm mb-1">Critique</h4>
                                      <p className="text-sm text-muted-foreground">{item.critique}</p>
                                    </div>
                                    <div>
                                      <h4 className="font-medium text-sm mb-1">Missing Docs</h4>
                                      <p className="text-sm text-muted-foreground">
                                        {item.missingDocsSuggestions || "None identified"}
                                      </p>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="text-center py-4 text-muted-foreground">
                                    <FileWarning className="h-8 w-8 mx-auto mb-2 opacity-50" />
                                    <p className="text-sm">Not analyzed yet</p>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="mt-2"
                                      onClick={() => analyzeMutation.mutate(item.sessionId)}
                                      disabled={analyzeMutation.isPending}
                                      data-testid={`button-analyze-expanded-${item.sessionId}`}
                                    >
                                      <Sparkles className="h-4 w-4 mr-2" />
                                      Analyze Now
                                    </Button>
                                  </div>
                                )}
                              </TableCell>
                            </TableRow>
                          </CollapsibleContent>
                        </>
                      </Collapsible>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-muted-foreground">
                Showing {items.length} of {total} sessions
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages, page + 1))}
                  disabled={page >= totalPages}
                  data-testid="button-next-page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle>Chat Session Details</DialogTitle>
            <DialogDescription>
              {sessionDetails?.session.title}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            {detailsLoading ? (
              <div className="space-y-4 p-4">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : sessionDetails ? (
              <div className="space-y-6 p-4">
                {sessionDetails.analytics && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Analysis Results</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 md:grid-cols-2">
                      <div>
                        <h4 className="font-medium text-sm mb-1">Summary</h4>
                        <p className="text-sm text-muted-foreground">{sessionDetails.analytics.summary}</p>
                      </div>
                      <div>
                        <h4 className="font-medium text-sm mb-1">Critique</h4>
                        <p className="text-sm text-muted-foreground">{sessionDetails.analytics.critique}</p>
                      </div>
                      <div>
                        <h4 className="font-medium text-sm mb-1">Missing Documents</h4>
                        <p className="text-sm text-muted-foreground">
                          {sessionDetails.analytics.missingDocsSuggestions || "None identified"}
                        </p>
                      </div>
                      <div className="flex gap-4">
                        <div>
                          <h4 className="font-medium text-sm mb-1">Document Score</h4>
                          <ScoreBadge score={sessionDetails.analytics.documentQualityScore} label="Doc" />
                        </div>
                        <div>
                          <h4 className="font-medium text-sm mb-1">Answer Score</h4>
                          <ScoreBadge score={sessionDetails.analytics.answerQualityScore} label="Answer" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Transcript</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {sessionDetails.messages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`p-3 rounded-lg ${
                            msg.role === "user"
                              ? "bg-primary/10 ml-8"
                              : "bg-muted mr-8"
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant={msg.role === "user" ? "default" : "secondary"}>
                              {msg.role === "user" ? "User" : "Assistant"}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatDate(msg.createdAt)}
                            </span>
                          </div>
                          <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                          {msg.citations && (
                            <p className="text-xs text-muted-foreground mt-2">
                              Citations: {msg.citations}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            ) : null}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
