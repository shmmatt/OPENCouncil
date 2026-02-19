import { useState } from "react";
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
  totalInS3: number;
  alreadyTracked: number;
  newDocuments: number;
  townBreakdown: Record<string, number>;
  documents: Array<{
    key: string;
    size: number;
    lastModified: string | null;
    town: string | null;
  }>;
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

function DiscoveryPanel() {
  const { toast } = useToast();
  const [prefix, setPrefix] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [discoveryData, setDiscoveryData] = useState<DiscoveryResult | null>(null);

  const discoverMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/ocr/textract/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: prefix || undefined }),
      });
      if (!res.ok) throw new Error("Discovery failed");
      return res.json();
    },
    onSuccess: (data: DiscoveryResult) => {
      setDiscoveryData(data);
      setSelectedKeys(new Set());
      toast({
        title: "Discovery Complete",
        description: `Found ${data.newDocuments} new documents out of ${data.totalInS3} total PDFs.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Discovery Failed", description: error.message, variant: "destructive" });
    },
  });

  const enqueueMutation = useMutation({
    mutationFn: async (keys: string[]) => {
      const res = await adminFetch("/api/admin/ocr/textract/enqueue-discovered", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
      });
      if (!res.ok) throw new Error("Enqueue failed");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Enqueued", description: data.message });
      setSelectedKeys(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ocr/textract/all-jobs"] });
      discoverMutation.mutate();
    },
    onError: (error: Error) => {
      toast({ title: "Enqueue Failed", description: error.message, variant: "destructive" });
    },
  });

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (!discoveryData) return;
    if (selectedKeys.size === discoveryData.documents.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(discoveryData.documents.map((d) => d.key)));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Search className="w-4 h-4" />
            S3 Bucket Scanner
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              placeholder="Filter by prefix (e.g. town name)..."
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              className="max-w-xs"
              data-testid="input-discovery-prefix"
            />
            <Button
              onClick={() => discoverMutation.mutate()}
              disabled={discoverMutation.isPending}
              data-testid="button-scan-bucket"
            >
              {discoverMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ScanLine className="w-4 h-4 mr-2" />
              )}
              Scan Bucket
            </Button>
          </div>

          {discoveryData && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Card>
                  <CardContent className="p-3">
                    <div className="text-sm text-muted-foreground">Total PDFs in S3</div>
                    <div className="text-xl font-bold" data-testid="text-total-s3">{discoveryData.totalInS3}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3">
                    <div className="text-sm text-muted-foreground">Already Tracked</div>
                    <div className="text-xl font-bold" data-testid="text-already-tracked">{discoveryData.alreadyTracked}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3">
                    <div className="text-sm text-muted-foreground">New (Unprocessed)</div>
                    <div className="text-xl font-bold text-orange-600" data-testid="text-new-docs">{discoveryData.newDocuments}</div>
                  </CardContent>
                </Card>
              </div>

              {Object.keys(discoveryData.townBreakdown).length > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">New Documents by Town</div>
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

              {discoveryData.documents.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedKeys.size === discoveryData.documents.length && discoveryData.documents.length > 0}
                        onCheckedChange={toggleAll}
                        data-testid="checkbox-select-all"
                      />
                      <span className="text-sm text-muted-foreground">
                        {selectedKeys.size} of {discoveryData.documents.length} selected
                      </span>
                    </div>
                    <Button
                      onClick={() => enqueueMutation.mutate(Array.from(selectedKeys))}
                      disabled={selectedKeys.size === 0 || enqueueMutation.isPending}
                      data-testid="button-enqueue-selected"
                    >
                      {enqueueMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <FolderUp className="w-4 h-4 mr-2" />
                      )}
                      Enqueue Selected ({selectedKeys.size})
                    </Button>
                  </div>

                  <ScrollArea className="h-[300px] w-full rounded border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8" />
                          <TableHead>S3 Key</TableHead>
                          <TableHead>Town</TableHead>
                          <TableHead>Size</TableHead>
                          <TableHead>Last Modified</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {discoveryData.documents.map((doc) => (
                          <TableRow key={doc.key} data-testid={`row-discovered-${doc.key}`}>
                            <TableCell>
                              <Checkbox
                                checked={selectedKeys.has(doc.key)}
                                onCheckedChange={() => toggleKey(doc.key)}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-xs max-w-[300px] truncate" title={doc.key}>
                              {doc.key}
                            </TableCell>
                            <TableCell>
                              {doc.town ? <Badge variant="secondary">{doc.town}</Badge> : "-"}
                            </TableCell>
                            <TableCell className="text-xs">{formatBytes(doc.size)}</TableCell>
                            <TableCell className="text-xs">{formatDate(doc.lastModified)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>

                  {discoveryData.newDocuments > discoveryData.documents.length && (
                    <div className="text-sm text-muted-foreground">
                      Showing {discoveryData.documents.length} of {discoveryData.newDocuments} new documents
                    </div>
                  )}
                </div>
              )}

              {discoveryData.newDocuments === 0 && (
                <div className="text-center text-muted-foreground py-4" data-testid="text-all-tracked">
                  All S3 documents are already tracked in the pipeline.
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
  const [activeTab, setActiveTab] = useState("overview");

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
            <TabsTrigger value="overview" data-testid="tab-overview">All Jobs</TabsTrigger>
            <TabsTrigger value="queued" data-testid="tab-queued">Queued</TabsTrigger>
            <TabsTrigger value="textract_running" data-testid="tab-running">Running</TabsTrigger>
            <TabsTrigger value="materialized" data-testid="tab-materialized">Materialized</TabsTrigger>
            <TabsTrigger value="failed" data-testid="tab-failed">Failed</TabsTrigger>
            <TabsTrigger value="discover" data-testid="tab-discover">Discover</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <JobsTable />
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
