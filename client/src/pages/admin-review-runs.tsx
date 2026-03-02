import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Calendar,
  FileText,
  BarChart3,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";

interface ReviewRun {
  id: string;
  sessionIds: string[];
  totalSessions: number;
  successfulAnalyses: number;
  avgDocScore: string | null;
  avgAnswerScore: string | null;
  thumbsUpCount: number;
  thumbsDownCount: number;
  topMissingDocs: string | null;
  executiveSummary: string | null;
  createdAt: string;
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

function ScoreBadge({ score }: { score: string | null }) {
  if (!score) return <Badge variant="outline">-</Badge>;
  const num = parseFloat(score);
  let variant: "default" | "secondary" | "destructive" | "outline" = "secondary";
  if (num >= 7) variant = "default";
  else if (num <= 4) variant = "destructive";
  return (
    <Badge variant={variant} className="min-w-[3rem] justify-center">
      {num.toFixed(1)}/10
    </Badge>
  );
}

function MarkdownContent({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="space-y-2">
      {lines.map((line, i) => {
        if (line.startsWith("# ")) {
          return <h1 key={i} className="text-xl font-bold mt-4 mb-2">{line.slice(2)}</h1>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={i} className="text-lg font-semibold mt-4 mb-1">{line.slice(3)}</h2>;
        }
        if (line.startsWith("### ")) {
          return <h3 key={i} className="text-base font-medium mt-3 mb-1">{line.slice(4)}</h3>;
        }
        if (line.startsWith("---")) {
          return <hr key={i} className="my-3 border-border" />;
        }
        if (line.startsWith("LOCATION:") || line.startsWith("OLD:") || line.startsWith("NEW:") || line.startsWith("REASON:")) {
          const [label, ...rest] = line.split(":");
          return (
            <div key={i} className="font-mono text-sm">
              <span className="font-bold text-primary">{label}:</span>
              <span className="text-muted-foreground">{rest.join(":")}</span>
            </div>
          );
        }
        if (line.trim() === "") {
          return <div key={i} className="h-2" />;
        }
        if (line.startsWith("- ")) {
          return <li key={i} className="text-sm text-muted-foreground ml-4 list-disc">{line.slice(2)}</li>;
        }
        if (/^\d+\.\s/.test(line)) {
          return <li key={i} className="text-sm text-muted-foreground ml-4 list-decimal">{line.replace(/^\d+\.\s/, "")}</li>;
        }
        return <p key={i} className="text-sm text-muted-foreground">{line}</p>;
      })}
    </div>
  );
}

export default function AdminReviewRuns() {
  const [, setLocation] = useLocation();
  const token = localStorage.getItem("adminToken");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const fetchWithAuth = useCallback(async (url: string) => {
    const currentToken = localStorage.getItem("adminToken");
    if (!currentToken) {
      setLocation("/admin/login");
      throw new Error("No auth token");
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    if (res.status === 401) {
      localStorage.removeItem("adminToken");
      setLocation("/admin/login");
      throw new Error("Session expired");
    }
    if (!res.ok) throw new Error("Request failed");
    return res.json();
  }, [setLocation]);

  const { data: runs, isLoading } = useQuery<ReviewRun[]>({
    queryKey: ["/api/admin/chat-analytics/review-runs"],
    queryFn: () => fetchWithAuth("/api/admin/chat-analytics/review-runs"),
    enabled: !!token,
  });

  const { data: selectedRun, isLoading: runLoading } = useQuery<ReviewRun>({
    queryKey: ["/api/admin/chat-analytics/review-runs", selectedRunId],
    queryFn: () => fetchWithAuth(`/api/admin/chat-analytics/review-runs/${selectedRunId}`),
    enabled: !!selectedRunId && !!token,
  });

  const openDetail = (id: string) => {
    setSelectedRunId(id);
    setDetailOpen(true);
  };

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
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
          <div className="flex items-center gap-4">
            <Link href="/admin/chat-analytics">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-semibold" data-testid="text-page-title">Batch Review Runs</h1>
              <p className="text-sm text-muted-foreground">
                Aggregated analysis summaries with improvement roadmaps
              </p>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : !runs || runs.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No review runs yet.</p>
              <p className="text-sm mt-2">Select sessions in Chat Analytics and click "Batch Review" to create one.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {runs.map((run) => (
              <Card key={run.id} className="hover-elevate cursor-pointer" onClick={() => openDetail(run.id)} data-testid={`card-run-${run.id}`}>
                <CardContent className="py-4">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-4 flex-wrap">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Calendar className="h-4 w-4" />
                        {formatDate(run.createdAt)}
                      </div>
                      <Badge variant="secondary" data-testid={`badge-sessions-${run.id}`}>
                        {run.totalSessions} sessions
                      </Badge>
                      <Badge variant={run.successfulAnalyses === run.totalSessions ? "default" : "outline"}>
                        {run.successfulAnalyses}/{run.totalSessions} analyzed
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Doc:</span>
                        <ScoreBadge score={run.avgDocScore} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Answer:</span>
                        <ScoreBadge score={run.avgAnswerScore} />
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-green-600 dark:text-green-400">{run.thumbsUpCount} up</span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-red-600 dark:text-red-400">{run.thumbsDownCount} down</span>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Review Run Details</DialogTitle>
            <DialogDescription>
              {selectedRun && `${selectedRun.totalSessions} sessions analyzed on ${formatDate(selectedRun.createdAt)}`}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[70vh]">
            {runLoading ? (
              <div className="space-y-4 p-4">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : selectedRun ? (
              <div className="space-y-6 p-4">
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Doc Score:</span>
                    <ScoreBadge score={selectedRun.avgDocScore} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Answer Score:</span>
                    <ScoreBadge score={selectedRun.avgAnswerScore} />
                  </div>
                  <Badge variant="secondary">
                    {selectedRun.successfulAnalyses}/{selectedRun.totalSessions} analyzed
                  </Badge>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-green-600 dark:text-green-400">{selectedRun.thumbsUpCount} up</span>
                    <span className="text-muted-foreground">/</span>
                    <span className="text-red-600 dark:text-red-400">{selectedRun.thumbsDownCount} down</span>
                  </div>
                </div>

                {selectedRun.executiveSummary && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        Executive Summary & Improvement Roadmap
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <MarkdownContent content={selectedRun.executiveSummary} />
                    </CardContent>
                  </Card>
                )}

                {selectedRun.topMissingDocs && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4" />
                        Raw Missing Documents (All Sessions)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid="text-missing-docs-raw">
                        {selectedRun.topMissingDocs}
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
            ) : null}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
