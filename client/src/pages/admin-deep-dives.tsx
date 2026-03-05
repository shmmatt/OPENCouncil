import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, ChevronDown, ChevronRight, Clock, DollarSign, Hash, Target, Zap, Sparkles, AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { useLocation } from "wouter";

interface DeepDiveStats {
  totalDives: number;
  avgQualityScore: number | null;
  avgCompletenessScore: number | null;
  avgCostUsd: number | null;
  avgIterations: number | null;
  avgDurationMs: number | null;
  completedCount: number;
  failedCount: number;
  runningCount: number;
}

interface DeepDiveSession {
  id: string;
  chatSessionId: string;
  messageId: string;
  question: string;
  town: string | null;
  status: string;
  finalAnswer: string | null;
  qualityScore: number | null;
  completenessScore: number | null;
  iterationCount: number;
  totalCostUsd: string | null;
  totalDurationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

interface DeepDiveStep {
  id: string;
  deepDiveId: string;
  stepNumber: number;
  stepType: string;
  input: string;
  output: string;
  reasoning: string | null;
  toolUsed: string | null;
  modelUsed: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string | null;
  durationMs: number | null;
  createdAt: string;
}

function getStatusBadge(status: string) {
  switch (status) {
    case "completed":
      return <Badge variant="default" data-testid={`badge-status-${status}`}><CheckCircle className="w-3 h-3 mr-1" /> Completed</Badge>;
    case "running":
      return <Badge variant="secondary" data-testid={`badge-status-${status}`}><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Running</Badge>;
    case "failed":
      return <Badge variant="destructive" data-testid={`badge-status-${status}`}><AlertCircle className="w-3 h-3 mr-1" /> Failed</Badge>;
    default:
      return <Badge variant="outline" data-testid={`badge-status-${status}`}>{status}</Badge>;
  }
}

function getStepTypeBadge(stepType: string) {
  const colors: Record<string, string> = {
    intent_analysis: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    research_plan: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
    rag_retrieval: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    news_search: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    web_search: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
    synthesis: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
    quality_check: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    supplemental_plan: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  };
  const label = stepType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[stepType] || "bg-muted text-muted-foreground"}`}>{label}</span>;
}

function formatDuration(ms: number | null): string {
  if (!ms) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: string | null): string {
  if (!cost) return "-";
  const val = parseFloat(cost);
  if (val < 0.001) return `$${val.toFixed(6)}`;
  return `$${val.toFixed(4)}`;
}

function StepRow({ step }: { step: DeepDiveStep }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger asChild>
        <button
          className="w-full flex items-center gap-3 px-3 py-2 hover-elevate rounded-md text-left"
          data-testid={`button-step-${step.stepNumber}`}
        >
          <span className="text-xs text-muted-foreground w-6 text-right">#{step.stepNumber}</span>
          {getStepTypeBadge(step.stepType)}
          {step.modelUsed && (
            <span className="text-xs text-muted-foreground font-mono">{step.modelUsed}</span>
          )}
          {step.toolUsed && (
            <span className="text-xs text-muted-foreground">[{step.toolUsed}]</span>
          )}
          <span className="ml-auto flex items-center gap-3 flex-wrap">
            {step.tokensIn != null && (
              <span className="text-xs text-muted-foreground">{step.tokensIn + (step.tokensOut || 0)} tok</span>
            )}
            <span className="text-xs text-muted-foreground">{formatCost(step.costUsd)}</span>
            <span className="text-xs text-muted-foreground">{formatDuration(step.durationMs)}</span>
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-9 mr-3 mb-3 space-y-2 text-sm">
          {step.reasoning && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Reasoning:</span>
              <pre className="mt-1 p-2 bg-muted rounded text-xs whitespace-pre-wrap max-h-40 overflow-y-auto">{step.reasoning}</pre>
            </div>
          )}
          <div>
            <span className="text-xs font-medium text-muted-foreground">Input:</span>
            <pre className="mt-1 p-2 bg-muted rounded text-xs whitespace-pre-wrap max-h-40 overflow-y-auto">{step.input.slice(0, 2000)}</pre>
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">Output:</span>
            <pre className="mt-1 p-2 bg-muted rounded text-xs whitespace-pre-wrap max-h-60 overflow-y-auto">{step.output.slice(0, 3000)}</pre>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SessionDetail({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { data, isLoading } = useQuery<{ session: DeepDiveSession; steps: DeepDiveStep[] }>({
    queryKey: ["/api/admin/deep-dives", sessionId],
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const { session, steps } = data;

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack} data-testid="button-back-to-list">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back to list
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-lg" data-testid="text-session-question">{session.question}</CardTitle>
            {getStatusBadge(session.status)}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Town</span>
              <p className="font-medium" data-testid="text-session-town">{session.town || "N/A"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Iterations</span>
              <p className="font-medium" data-testid="text-session-iterations">{session.iterationCount}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Quality / Completeness</span>
              <p className="font-medium" data-testid="text-session-scores">
                {session.qualityScore ?? "-"} / {session.completenessScore ?? "-"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Cost</span>
              <p className="font-medium" data-testid="text-session-cost">{formatCost(session.totalCostUsd)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Duration</span>
              <p className="font-medium" data-testid="text-session-duration">{formatDuration(session.totalDurationMs)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Created</span>
              <p className="font-medium" data-testid="text-session-created">{new Date(session.createdAt).toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Chain of Thought ({steps.length} steps)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </div>
        </CardContent>
      </Card>

      {session.finalAnswer && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Final Answer</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm" data-testid="text-final-answer">{session.finalAnswer}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function AdminDeepDives() {
  const [, setLocation] = useLocation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const pageSize = 20;

  const { data: stats, isLoading: statsLoading } = useQuery<DeepDiveStats>({
    queryKey: ["/api/admin/deep-dives/stats"],
  });

  const listQueryKey = `/api/admin/deep-dives?limit=${pageSize}&offset=${page * pageSize}${statusFilter !== "all" ? `&status=${statusFilter}` : ""}`;
  const { data: listData, isLoading: listLoading } = useQuery<{ sessions: DeepDiveSession[]; total: number }>({
    queryKey: [listQueryKey],
  });

  if (selectedId) {
    return (
      <div className="container max-w-5xl mx-auto p-6">
        <SessionDetail sessionId={selectedId} onBack={() => setSelectedId(null)} />
      </div>
    );
  }

  return (
    <div className="container max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/admin/documents")} data-testid="button-back-admin">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Sparkles className="w-6 h-6" /> Deep Dive Analytics
          </h1>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Hash className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Total Dives</span>
            </div>
            <p className="text-2xl font-bold mt-1" data-testid="text-stat-total">
              {statsLoading ? <Skeleton className="h-8 w-12" /> : stats?.totalDives || 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Avg Quality</span>
            </div>
            <p className="text-2xl font-bold mt-1" data-testid="text-stat-quality">
              {statsLoading ? <Skeleton className="h-8 w-12" /> : stats?.avgQualityScore?.toFixed(1) || "-"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Avg Cost</span>
            </div>
            <p className="text-2xl font-bold mt-1" data-testid="text-stat-cost">
              {statsLoading ? <Skeleton className="h-8 w-12" /> : stats?.avgCostUsd ? `$${stats.avgCostUsd.toFixed(4)}` : "-"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Avg Iterations</span>
            </div>
            <p className="text-2xl font-bold mt-1" data-testid="text-stat-iterations">
              {statsLoading ? <Skeleton className="h-8 w-12" /> : stats?.avgIterations?.toFixed(1) || "-"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
          <SelectTrigger className="w-40" data-testid="select-status-filter">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground" data-testid="text-total-count">
          {listData?.total || 0} sessions
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          {listLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <div className="divide-y">
              {listData?.sessions.map((session) => (
                <button
                  key={session.id}
                  className="w-full flex items-center gap-3 px-4 py-3 hover-elevate text-left"
                  onClick={() => setSelectedId(session.id)}
                  data-testid={`button-session-${session.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{session.question}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-xs text-muted-foreground">
                        {new Date(session.createdAt).toLocaleDateString()}
                      </span>
                      {session.town && (
                        <span className="text-xs text-muted-foreground">{session.town}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 flex-wrap">
                    {session.qualityScore != null && (
                      <span className="text-xs text-muted-foreground">
                        Q:{session.qualityScore} C:{session.completenessScore}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {session.iterationCount}x
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatCost(session.totalCostUsd)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDuration(session.totalDurationMs)}
                    </span>
                    {getStatusBadge(session.status)}
                  </div>
                </button>
              ))}
              {(!listData?.sessions || listData.sessions.length === 0) && (
                <p className="text-center text-muted-foreground py-8" data-testid="text-no-sessions">No deep dive sessions yet</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {listData && listData.total > pageSize && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage(p => p - 1)}
            data-testid="button-prev-page"
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground" data-testid="text-page-info">
            Page {page + 1} of {Math.ceil(listData.total / pageSize)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * pageSize >= listData.total}
            onClick={() => setPage(p => p + 1)}
            data-testid="button-next-page"
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
