import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Search,
  FolderUp,
  ScanLine,
  FileText,
  SkipForward,
  Cog,
  ArrowRight,
  Database,
  Globe,
  Download,
  Layers,
  Play,
  Square,
  Zap,
} from "lucide-react";

function adminFetch(url: string, options?: RequestInit) {
  const token = localStorage.getItem("adminToken");
  return fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

function getJobStatusBadge(status: string) {
  switch (status) {
    case "queued":
      return <Badge variant="outline" className="text-orange-600 border-orange-600"><Clock className="w-3 h-3 mr-1" />Queued</Badge>;
    case "textract_running":
      return <Badge variant="outline" className="text-blue-600 border-blue-600"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Running</Badge>;
    case "materialized":
      return <Badge variant="outline" className="text-green-600 border-green-600"><CheckCircle2 className="w-3 h-3 mr-1" />Materialized</Badge>;
    case "skipped_native":
      return <Badge variant="outline" className="text-teal-600 border-teal-600"><SkipForward className="w-3 h-3 mr-1" />Native Text</Badge>;
    case "failed":
    case "textract_failed":
      return <Badge variant="outline" className="text-red-600 border-red-600"><XCircle className="w-3 h-3 mr-1" />{status === "textract_failed" ? "Textract Failed" : "Failed"}</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleString();
}

interface OcrJobStats {
  queued: number;
  skipped_native: number;
  textract_running: number;
  textract_failed: number;
  materialized: number;
  failed: number;
}

interface OcrJob {
  id: number;
  documentId: string;
  status: string;
  s3Key: string | null;
  s3Bucket: string | null;
  attempts: number;
  lastError: string | null;
  pageCount: number | null;
  nativeTextChars: number | null;
  textractJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DiscoveryResult {
  bucket: string;
  totalFileBlobs: number;
  withS3Key: number;
  alreadyProcessed: number;
  newDocuments: number;
  townBreakdown: Record<string, number>;
  documents: Array<{
    fileBlobId: string;
    key: string;
    filename: string;
    size: number;
    ocrStatus: string;
    town: string | null;
  }>;
}

interface ReconciliationReport {
  fileBlobs: {
    totalFileBlobs: number;
    withS3Key: number;
    ocrNone: number;
    ocrCompleted: number;
    ocrFailed: number;
    ocrProcessing: number;
    ocrQueued: number;
    withExtractedText: number;
    withOcrText: number;
    withTextArtifact: number;
  };
  ocrJobs: {
    queued: number;
    skipped_native: number;
    textract_running: number;
    textract_failed: number;
    materialized: number;
    failed: number;
    total: number;
    linkedToFileBlob: number;
    orphaned: number;
  };
}

function StatsCards({ stats }: { stats: OcrJobStats | undefined }) {
  const cards = [
    { label: "Queued", value: stats?.queued ?? 0, icon: Clock, color: "text-orange-600" },
    { label: "Running", value: stats?.textract_running ?? 0, icon: Cog, color: "text-blue-600" },
    { label: "Materialized", value: stats?.materialized ?? 0, icon: CheckCircle2, color: "text-green-600" },
    { label: "Native Text", value: stats?.skipped_native ?? 0, icon: SkipForward, color: "text-teal-600" },
    { label: "Failed", value: (stats?.failed ?? 0) + (stats?.textract_failed ?? 0), icon: XCircle, color: "text-red-600" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <c.icon className={`w-4 h-4 ${c.color}`} />
              <span className="text-sm text-muted-foreground">{c.label}</span>
            </div>
            <div className="text-2xl font-bold" data-testid={`text-stat-${c.label.toLowerCase().replace(" ", "-")}`}>{c.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function JobsTable({ statusFilter }: { statusFilter?: string }) {
  const [, setLocation] = useLocation();
  const [page, setPage] = useState(0);
  const limit = 50;

  const { data, isLoading } = useQuery<{ jobs: OcrJob[]; total: number }>({
    queryKey: ["/api/admin/ocr/textract/all-jobs", statusFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
      if (statusFilter) params.set("status", statusFilter);
      const res = await adminFetch(`/api/admin/ocr/textract/all-jobs?${params}`);
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem("adminToken");
          setLocation("/admin/login");
          throw new Error("Session expired");
        }
        throw new Error("Failed to fetch jobs");
      }
      return res.json();
    },
    refetchInterval: 15000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const jobs = data?.jobs || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);

  if (jobs.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8" data-testid="text-no-jobs">
        No jobs found
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ScrollArea className="w-full">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>S3 Key</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Pages</TableHead>
              <TableHead>Native Chars</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id} data-testid={`row-job-${job.id}`}>
                <TableCell className="font-mono text-xs">{job.id}</TableCell>
                <TableCell className="max-w-[250px] truncate font-mono text-xs" title={job.s3Key || ""}>
                  {job.s3Key || "-"}
                </TableCell>
                <TableCell>{getJobStatusBadge(job.status)}</TableCell>
                <TableCell>{job.pageCount ?? "-"}</TableCell>
                <TableCell>{job.nativeTextChars != null ? job.nativeTextChars.toLocaleString() : "-"}</TableCell>
                <TableCell>{job.attempts}</TableCell>
                <TableCell className="max-w-[200px] truncate text-xs text-red-600" title={job.lastError || ""}>
                  {job.lastError || "-"}
                </TableCell>
                <TableCell className="text-xs">{formatDate(job.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollArea>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">
            {total} total jobs
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              data-testid="button-prev-page"
            >
              Previous
            </Button>
            <span className="text-sm px-2">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              data-testid="button-next-page"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReconciliationPanel() {
  const { data, isLoading } = useQuery<ReconciliationReport>({
    queryKey: ["/api/admin/ocr/textract/reconciliation"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/ocr/textract/reconciliation");
      if (!res.ok) throw new Error("Failed to fetch reconciliation");
      return res.json();
    },
    refetchInterval: 30000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const fb = data.fileBlobs;
  const oj = data.ocrJobs;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">File Blobs (Source of Truth)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {[
              { label: "Total Blobs", value: fb.totalFileBlobs },
              { label: "With S3 Key", value: fb.withS3Key },
              { label: "OCR: None", value: fb.ocrNone, color: "text-muted-foreground" },
              { label: "OCR: Completed", value: fb.ocrCompleted, color: "text-green-600" },
              { label: "OCR: Failed", value: fb.ocrFailed, color: "text-red-600" },
              { label: "OCR: Processing", value: fb.ocrProcessing, color: "text-blue-600" },
              { label: "OCR: Queued", value: fb.ocrQueued, color: "text-orange-600" },
              { label: "Has Extracted Text", value: fb.withExtractedText, color: "text-green-600" },
              { label: "Has OCR Text", value: fb.withOcrText, color: "text-green-600" },
              { label: "Has Text Artifact", value: fb.withTextArtifact, color: "text-teal-600" },
            ].map((item) => (
              <div key={item.label} className="p-2">
                <div className="text-xs text-muted-foreground">{item.label}</div>
                <div className={`text-lg font-bold ${item.color || ""}`} data-testid={`text-recon-${item.label.toLowerCase().replace(/[: ]+/g, "-")}`}>
                  {item.value.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">OCR Jobs (Work Queue)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {[
              { label: "Total Jobs", value: oj.total },
              { label: "Linked to Blob", value: oj.linkedToFileBlob, color: "text-green-600" },
              { label: "Orphaned (no blob)", value: oj.orphaned, color: oj.orphaned > 0 ? "text-orange-600" : "" },
              { label: "Queued", value: oj.queued, color: "text-orange-600" },
              { label: "Running", value: oj.textract_running, color: "text-blue-600" },
              { label: "Materialized", value: oj.materialized, color: "text-green-600" },
              { label: "Skipped (Native)", value: oj.skipped_native, color: "text-teal-600" },
              { label: "Failed", value: oj.failed + oj.textract_failed, color: "text-red-600" },
            ].map((item) => (
              <div key={item.label} className="p-2">
                <div className="text-xs text-muted-foreground">{item.label}</div>
                <div className={`text-lg font-bold ${item.color || ""}`} data-testid={`text-recon-oj-${item.label.toLowerCase().replace(/[: ()]+/g, "-")}`}>
                  {item.value.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface PipelineData {
  pipeline: {
    discovered: number;
    downloaded: number;
    linkedToBlobs: number;
    totalBlobs: number;
    textReady: number;
    ocrCompleted: number;
    ocrPending: number;
    ocrFailed: number;
    readyToExport: number;
    exported: number;
    indexed: number;
    totalIndexedChunks: number;
    totalChunksInPgvector: number;
    chunksWithLineage: number;
    uniqueBlobsInChunks: number;
    totalLogicalDocs: number;
    totalVersions: number;
    currentVersions: number;
  };
  breakdowns: {
    embeddingStatus: Array<{ embedding_status: string; count: number }>;
    ocrStatus: Array<{ ocr_status: string; count: number }>;
  };
  recentJobs: Array<{
    id: number;
    batch_id: string;
    status: string;
    chunks_count: number;
    file_blobs_processed: number;
    started_at: string;
    completed_at: string;
  }>;
}

function PipelineStage({ label, count, total, icon: Icon, color }: { label: string; count: number; total: number; icon: any; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex flex-col items-center gap-1 min-w-[100px]" data-testid={`pipeline-stage-${label.toLowerCase().replace(/\s/g, '-')}`}>
      <Icon className={`w-5 h-5 ${color}`} />
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-bold">{count.toLocaleString()}</span>
      {total > 0 && total !== count && (
        <span className="text-xs text-muted-foreground">{pct}%</span>
      )}
    </div>
  );
}

interface EmbeddingProgress {
  status: "idle" | "running" | "stopping" | "completed" | "failed";
  totalDocuments: number;
  processedDocuments: number;
  totalChunks: number;
  insertedChunks: number;
  errorCount: number;
  errors: string[];
  startedAt: string | null;
  completedAt: string | null;
  batchId: string | null;
  currentDocument: string | null;
  estimatedTimeRemaining: number | null;
}

function EmbeddingPipelineControls() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [limitInput, setLimitInput] = useState("");

  const { data: progress, isLoading } = useQuery<EmbeddingProgress>({
    queryKey: ["/api/admin/embedding/status"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/embedding/status");
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem("adminToken");
          setLocation("/admin/login");
          throw new Error("Session expired");
        }
        throw new Error("Failed to fetch embedding status");
      }
      return res.json();
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "running" || status === "stopping") return 2000;
      return 15000;
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = {};
      if (limitInput && parseInt(limitInput, 10) > 0) {
        body.limit = parseInt(limitInput, 10);
      }
      const res = await adminFetch("/api/admin/embedding/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to start pipeline");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Pipeline Started", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/embedding/status"] });
    },
    onError: (error: Error) => {
      toast({ title: "Start Failed", description: error.message, variant: "destructive" });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/embedding/stop", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Failed to stop pipeline");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Stop Requested", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/embedding/status"] });
    },
    onError: (error: Error) => {
      toast({ title: "Stop Failed", description: error.message, variant: "destructive" });
    },
  });

  const isActive = progress?.status === "running" || progress?.status === "stopping";
  const docPct = progress && progress.totalDocuments > 0
    ? Math.round((progress.processedDocuments / progress.totalDocuments) * 100)
    : 0;

  function formatEta(seconds: number | null): string {
    if (!seconds || seconds <= 0) return "-";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case "idle":
        return <Badge variant="outline">Idle</Badge>;
      case "running":
        return <Badge variant="default" className="bg-blue-600"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Running</Badge>;
      case "stopping":
        return <Badge variant="outline" className="text-orange-600 border-orange-600"><Clock className="w-3 h-3 mr-1" />Stopping</Badge>;
      case "completed":
        return <Badge variant="default" className="bg-green-600"><CheckCircle2 className="w-3 h-3 mr-1" />Completed</Badge>;
      case "failed":
        return <Badge variant="destructive"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="embedding-pipeline-controls">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            <CardTitle className="text-sm">Embedding Pipeline</CardTitle>
            {progress && getStatusBadge(progress.status)}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {!isActive && (
              <>
                <Input
                  type="number"
                  placeholder="Limit (optional)"
                  className="w-32"
                  value={limitInput}
                  onChange={(e) => setLimitInput(e.target.value)}
                  data-testid="input-embedding-limit"
                />
                <Button
                  size="sm"
                  onClick={() => startMutation.mutate()}
                  disabled={startMutation.isPending}
                  data-testid="button-start-embedding"
                >
                  {startMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-1" />
                  )}
                  Start Embedding
                </Button>
              </>
            )}
            {isActive && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => stopMutation.mutate()}
                disabled={stopMutation.isPending || progress?.status === "stopping"}
                data-testid="button-stop-embedding"
              >
                {stopMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Square className="w-4 h-4 mr-1" />
                )}
                Stop Pipeline
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {progress && (isActive || progress.status === "completed" || progress.status === "failed") && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Documents</span>
                <span className="text-sm font-medium">
                  {progress.processedDocuments.toLocaleString()} / {progress.totalDocuments.toLocaleString()} ({docPct}%)
                </span>
              </div>
              <Progress value={docPct} data-testid="progress-embedding" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Chunks Created</span>
                <div className="text-lg font-bold" data-testid="text-chunks-created">{progress.insertedChunks.toLocaleString()}</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Total Chunks</span>
                <div className="text-lg font-bold">{progress.totalChunks.toLocaleString()}</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Errors</span>
                <div className={`text-lg font-bold ${progress.errorCount > 0 ? "text-red-600" : ""}`} data-testid="text-embedding-errors">{progress.errorCount}</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">ETA</span>
                <div className="text-lg font-bold" data-testid="text-embedding-eta">{formatEta(progress.estimatedTimeRemaining)}</div>
              </div>
            </div>

            {progress.currentDocument && isActive && (
              <div className="text-xs text-muted-foreground truncate" data-testid="text-current-document">
                Processing: {progress.currentDocument}
              </div>
            )}

            {progress.batchId && (
              <div className="text-xs text-muted-foreground">
                Batch: <span className="font-mono">{progress.batchId}</span>
              </div>
            )}

            {progress.startedAt && (
              <div className="text-xs text-muted-foreground">
                Started: {new Date(progress.startedAt).toLocaleString()}
                {progress.completedAt && ` | Finished: ${new Date(progress.completedAt).toLocaleString()}`}
              </div>
            )}

            {progress.errors.length > 0 && (
              <div className="space-y-1">
                <span className="text-xs font-medium text-red-600">Recent Errors:</span>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {progress.errors.slice(-5).map((err, i) => (
                    <div key={i} className="text-xs text-red-500 font-mono bg-red-50 dark:bg-red-950/20 p-1 rounded">
                      {err}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {progress?.status === "idle" && (
          <div className="text-sm text-muted-foreground text-center py-2" data-testid="text-embedding-idle">
            Ready to embed documents. Click "Start Embedding" to begin generating embeddings for all documents with text ready.
            Use the limit field to process a specific number of documents.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PipelineStatusPanel() {
  const { data, isLoading, refetch } = useQuery<PipelineData>({
    queryKey: ['/api/admin/pipeline-status'],
    queryFn: async () => {
      const res = await adminFetch('/api/admin/pipeline-status');
      if (!res.ok) throw new Error('Failed to fetch pipeline status');
      return res.json();
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin mr-2" />
        <span>Loading pipeline status...</span>
      </div>
    );
  }

  if (!data) return null;

  const p = data.pipeline;

  const stages = [
    { label: "URLs Discovered", count: p.discovered, total: p.discovered, icon: Globe, color: "text-blue-500" },
    { label: "Downloaded", count: p.downloaded, total: p.discovered, icon: Download, color: "text-blue-600" },
    { label: "File Blobs", count: p.totalBlobs, total: p.downloaded, icon: FileText, color: "text-indigo-500" },
    { label: "Text Ready", count: p.textReady, total: p.totalBlobs, icon: ScanLine, color: "text-purple-500" },
    { label: "Ready to Export", count: p.readyToExport, total: p.textReady, icon: FolderUp, color: "text-amber-500" },
    { label: "Exported", count: p.exported, total: p.textReady, icon: Layers, color: "text-orange-500" },
    { label: "Indexed", count: p.indexed, total: p.textReady, icon: Database, color: "text-green-600" },
  ];

  const overallPct = p.totalBlobs > 0 ? Math.round((p.indexed / p.totalBlobs) * 100) : 0;

  return (
    <div className="space-y-4" data-testid="pipeline-status-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Document Lifecycle Pipeline</h3>
        <Button variant="ghost" size="icon" onClick={() => refetch()} data-testid="button-refresh-pipeline">
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-sm text-muted-foreground">Overall Progress:</span>
            <Progress value={overallPct} className="flex-1" />
            <span className="text-sm font-medium">{overallPct}%</span>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2">
            {stages.map((stage, i) => (
              <div key={stage.label} className="flex items-center gap-1">
                <PipelineStage {...stage} />
                {i < stages.length - 1 && (
                  <ArrowRight className="w-4 h-4 text-muted-foreground mt-4" />
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">OCR Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.breakdowns.ocrStatus.map((row) => (
                <div key={row.ocr_status} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">{row.ocr_status}</span>
                  <span className="text-sm font-medium">{Number(row.count).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Embedding Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.breakdowns.embeddingStatus.map((row) => (
                <div key={row.embedding_status} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">{row.embedding_status}</span>
                  <span className="text-sm font-medium">{Number(row.count).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Chunk Stats</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Total in pgvector</span>
                <span className="text-sm font-medium">{p.totalChunksInPgvector.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">With lineage</span>
                <span className="text-sm font-medium">{p.chunksWithLineage.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Unique blobs</span>
                <span className="text-sm font-medium">{p.uniqueBlobsInChunks.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Logical docs</span>
                <span className="text-sm font-medium">{p.totalLogicalDocs.toLocaleString()}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <EmbeddingPipelineControls />

      {data.recentJobs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent Embedding Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Blobs</TableHead>
                  <TableHead>Chunks</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentJobs.map((job) => (
                  <TableRow key={job.id} data-testid={`row-embedding-job-${job.id}`}>
                    <TableCell className="font-mono text-xs">{job.batch_id || '-'}</TableCell>
                    <TableCell>
                      <Badge variant={job.status === 'completed' ? 'default' : 'outline'}>
                        {job.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{job.file_blobs_processed ?? '-'}</TableCell>
                    <TableCell>{job.chunks_count ?? '-'}</TableCell>
                    <TableCell>{job.completed_at ? new Date(job.completed_at).toLocaleDateString() : '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DiscoveryPanel() {
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [discoveryData, setDiscoveryData] = useState<DiscoveryResult | null>(null);
  const [docPage, setDocPage] = useState(0);
  const hasAutoScanned = useRef(false);
  const DOCS_PER_PAGE = 100;

  const discoverMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/ocr/textract/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Discovery failed (HTTP ${res.status})`);
      }
      return res.json();
    },
    onSuccess: (data: DiscoveryResult) => {
      setDiscoveryData(data);
      setSelectedIds(new Set());
      setDocPage(0);
      toast({
        title: "Discovery Complete",
        description: `Found ${data.newDocuments} file blobs needing Textract (${data.totalFileBlobs} total blobs, ${data.withS3Key} with S3 keys).`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Discovery Failed", description: error.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (!hasAutoScanned.current) {
      hasAutoScanned.current = true;
      discoverMutation.mutate();
    }
  }, []);

  const enqueueMutation = useMutation({
    mutationFn: async (fileBlobIds: string[]) => {
      const res = await adminFetch("/api/admin/ocr/textract/enqueue-discovered", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileBlobIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Enqueue failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Enqueued", description: data.message });
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/all-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/reconciliation"] });
      discoverMutation.mutate();
    },
    onError: (error: Error) => {
      toast({ title: "Enqueue Failed", description: error.message, variant: "destructive" });
    },
  });

  const enqueueAllMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/ocr/textract/enqueue-all-new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Enqueue all failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Enqueued All", description: data.message });
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/all-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/reconciliation"] });
      discoverMutation.mutate();
    },
    onError: (error: Error) => {
      toast({ title: "Enqueue All Failed", description: error.message, variant: "destructive" });
    },
  });

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!discoveryData) return;
    if (selectedIds.size === discoveryData.documents.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(discoveryData.documents.map((d) => d.fileBlobId)));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Search className="w-4 h-4" />
            File Blobs Needing OCR
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Source of truth: <span className="font-mono">file_blobs</span> with valid S3 keys that haven't been processed yet
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {discoverMutation.isPending && !discoveryData && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Scanning file_blobs for unprocessed documents...
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              onClick={() => discoverMutation.mutate()}
              disabled={discoverMutation.isPending}
              data-testid="button-scan-blobs"
            >
              {discoverMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ScanLine className="w-4 h-4 mr-2" />
              )}
              {discoveryData ? "Re-scan" : "Scan File Blobs"}
            </Button>
          </div>

          {discoveryData && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <Card>
                  <CardContent className="p-3">
                    <div className="text-sm text-muted-foreground">Total File Blobs</div>
                    <div className="text-xl font-bold" data-testid="text-total-blobs">{discoveryData.totalFileBlobs.toLocaleString()}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3">
                    <div className="text-sm text-muted-foreground">With S3 Key</div>
                    <div className="text-xl font-bold" data-testid="text-with-s3">{discoveryData.withS3Key.toLocaleString()}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3">
                    <div className="text-sm text-muted-foreground">Already Processed</div>
                    <div className="text-xl font-bold" data-testid="text-already-processed">{discoveryData.alreadyProcessed.toLocaleString()}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3">
                    <div className="text-sm text-muted-foreground">Need Processing</div>
                    <div className="text-xl font-bold text-orange-600" data-testid="text-need-processing">{discoveryData.newDocuments.toLocaleString()}</div>
                  </CardContent>
                </Card>
              </div>

              {Object.keys(discoveryData.townBreakdown).length > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">Unprocessed by Town</div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(discoveryData.townBreakdown)
                      .sort((a, b) => b[1] - a[1])
                      .map(([town, count]) => (
                        <Badge key={town} variant="secondary">
                          {town}: {count}
                        </Badge>
                      ))}
                  </div>
                </div>
              )}

              {discoveryData.newDocuments > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={() => enqueueAllMutation.mutate()}
                        disabled={enqueueAllMutation.isPending}
                        data-testid="button-enqueue-all"
                      >
                        {enqueueAllMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <FolderUp className="w-4 h-4 mr-2" />
                        )}
                        Enqueue All ({discoveryData.newDocuments})
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedIds.size === discoveryData.documents.length && discoveryData.documents.length > 0}
                        onCheckedChange={toggleAll}
                        data-testid="checkbox-select-all"
                      />
                      <span className="text-sm text-muted-foreground">
                        {selectedIds.size} of {discoveryData.documents.length} selected
                      </span>
                      <Button
                        variant="outline"
                        onClick={() => enqueueMutation.mutate(Array.from(selectedIds))}
                        disabled={selectedIds.size === 0 || enqueueMutation.isPending}
                        data-testid="button-enqueue-selected"
                      >
                        {enqueueMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <FolderUp className="w-4 h-4 mr-2" />
                        )}
                        Enqueue Selected ({selectedIds.size})
                      </Button>
                    </div>
                  </div>

                  {(() => {
                    const totalDocs = discoveryData.documents.length;
                    const totalPages = Math.ceil(totalDocs / DOCS_PER_PAGE);
                    const pagedDocs = discoveryData.documents.slice(docPage * DOCS_PER_PAGE, (docPage + 1) * DOCS_PER_PAGE);
                    return (
                      <>
                        <ScrollArea className="h-[400px] w-full rounded border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-8" />
                                <TableHead>Filename</TableHead>
                                <TableHead>S3 Key</TableHead>
                                <TableHead>Town</TableHead>
                                <TableHead>Size</TableHead>
                                <TableHead>Status</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {pagedDocs.map((doc) => (
                                <TableRow key={doc.fileBlobId} data-testid={`row-blob-${doc.fileBlobId}`}>
                                  <TableCell>
                                    <Checkbox
                                      checked={selectedIds.has(doc.fileBlobId)}
                                      onCheckedChange={() => toggleId(doc.fileBlobId)}
                                    />
                                  </TableCell>
                                  <TableCell className="text-xs max-w-[200px] truncate" title={doc.filename}>
                                    {doc.filename}
                                  </TableCell>
                                  <TableCell className="font-mono text-xs max-w-[250px] truncate" title={doc.key}>
                                    {doc.key}
                                  </TableCell>
                                  <TableCell>
                                    {doc.town ? <Badge variant="secondary">{doc.town}</Badge> : "-"}
                                  </TableCell>
                                  <TableCell className="text-xs">{formatBytes(doc.size)}</TableCell>
                                  <TableCell>
                                    <Badge variant="outline" className="text-xs">{doc.ocrStatus}</Badge>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                        {totalPages > 1 && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm text-muted-foreground">
                              Page {docPage + 1} of {totalPages} ({totalDocs} documents)
                            </span>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setDocPage((p) => Math.max(0, p - 1))}
                                disabled={docPage === 0}
                                data-testid="button-doc-prev"
                              >
                                Previous
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setDocPage((p) => Math.min(totalPages - 1, p + 1))}
                                disabled={docPage >= totalPages - 1}
                                data-testid="button-doc-next"
                              >
                                Next
                              </Button>
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {discoveryData.newDocuments === 0 && (
                <div className="text-center text-muted-foreground py-4" data-testid="text-all-processed">
                  All file blobs with S3 keys have been processed or are in the pipeline.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminOcrPipeline() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("pipeline");

  const { data: stats, isLoading: statsLoading } = useQuery<OcrJobStats>({
    queryKey: ["/api/admin/ocr/textract/stats"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/ocr/textract/stats");
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem("adminToken");
          setLocation("/admin/login");
          throw new Error("Session expired");
        }
        throw new Error("Failed to fetch stats");
      }
      return res.json();
    },
    refetchInterval: 10000,
  });

  const resetStuckMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/ocr/textract/reset-stuck", { method: "POST" });
      if (!res.ok) throw new Error("Reset failed");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Reset Complete", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/all-jobs"] });
    },
    onError: (error: Error) => {
      toast({ title: "Reset Failed", description: error.message, variant: "destructive" });
    },
  });

  const retryFailedMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/ocr/textract/retry-failed", { method: "POST" });
      if (!res.ok) throw new Error("Retry failed");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Retry Queued", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/all-jobs"] });
    },
    onError: (error: Error) => {
      toast({ title: "Retry Failed", description: error.message, variant: "destructive" });
    },
  });

  const reindexMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/ocr/reindex-completed", { method: "POST" });
      if (!res.ok) throw new Error("Re-index failed");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Re-indexing Complete", description: data.message });
    },
    onError: (error: Error) => {
      toast({ title: "Re-indexing Failed", description: error.message, variant: "destructive" });
    },
  });

  const failedCount = (stats?.failed ?? 0) + (stats?.textract_failed ?? 0);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-4 space-y-6">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3">
            <Link href="/admin/ingestion">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-xl font-bold" data-testid="text-page-title">OCR Pipeline</h1>
              <p className="text-sm text-muted-foreground">Textract document processing and S3 discovery</p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => retryFailedMutation.mutate()}
              disabled={retryFailedMutation.isPending || failedCount === 0}
              data-testid="button-retry-failed"
            >
              {retryFailedMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Retry Failed ({failedCount})
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => resetStuckMutation.mutate()}
              disabled={resetStuckMutation.isPending}
              data-testid="button-reset-stuck"
            >
              {resetStuckMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <AlertTriangle className="w-4 h-4 mr-1" />}
              Reset Stuck
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => reindexMutation.mutate()}
              disabled={reindexMutation.isPending}
              data-testid="button-reindex"
            >
              {reindexMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <FileText className="w-4 h-4 mr-1" />}
              Re-index Completed
            </Button>
          </div>
        </div>

        {statsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <StatsCards stats={stats} />
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="pipeline" data-testid="tab-pipeline">Pipeline Status</TabsTrigger>
            <TabsTrigger value="overview" data-testid="tab-overview">All Jobs</TabsTrigger>
            <TabsTrigger value="reconciliation" data-testid="tab-reconciliation">Reconciliation</TabsTrigger>
            <TabsTrigger value="queued" data-testid="tab-queued">Queued</TabsTrigger>
            <TabsTrigger value="textract_running" data-testid="tab-running">Running</TabsTrigger>
            <TabsTrigger value="materialized" data-testid="tab-materialized">Materialized</TabsTrigger>
            <TabsTrigger value="failed" data-testid="tab-failed">Failed</TabsTrigger>
            <TabsTrigger value="discover" data-testid="tab-discover">Enqueue</TabsTrigger>
          </TabsList>

          <TabsContent value="pipeline">
            <PipelineStatusPanel />
          </TabsContent>
          <TabsContent value="overview">
            <JobsTable />
          </TabsContent>
          <TabsContent value="reconciliation">
            <ReconciliationPanel />
          </TabsContent>
          <TabsContent value="queued">
            <JobsTable statusFilter="queued" />
          </TabsContent>
          <TabsContent value="textract_running">
            <JobsTable statusFilter="textract_running" />
          </TabsContent>
          <TabsContent value="materialized">
            <JobsTable statusFilter="materialized" />
          </TabsContent>
          <TabsContent value="failed">
            <JobsTable statusFilter="failed" />
          </TabsContent>
          <TabsContent value="discover">
            <DiscoveryPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
