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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  Globe,
  FileText,
  Play,
  RotateCcw,
  MapPin,
  Link2,
  FolderDown,
  Activity,
  Settings,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  BarChart3,
  Target,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { FAILURE_LABELS, STATE_DOC_CATEGORY_LABELS, UPDATE_CADENCES } from "@shared/crawler-schema";
import type { StateDocCategory, UpdateCadence } from "@shared/crawler-schema";

function adminFetch(url: string, options?: RequestInit) {
  const token = localStorage.getItem("adminToken");
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleString();
}

function formatDateShort(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "0";
  return n.toLocaleString();
}

function getTownStatusBadge(status: string) {
  switch (status) {
    case "active":
      return <Badge variant="outline" className="text-green-600 border-green-600">Active</Badge>;
    case "failed":
      return <Badge variant="outline" className="text-red-600 border-red-600">Failed</Badge>;
    case "paused":
      return <Badge variant="outline" className="text-yellow-600 border-yellow-600">Paused</Badge>;
    case "disabled":
      return <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function getRunStatusBadge(status: string) {
  switch (status) {
    case "running":
      return <Badge variant="outline" className="text-blue-600 border-blue-600"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Running</Badge>;
    case "completed":
      return <Badge variant="outline" className="text-green-600 border-green-600"><CheckCircle2 className="w-3 h-3 mr-1" />Completed</Badge>;
    case "completed_with_errors":
      return <Badge variant="outline" className="text-amber-600 border-amber-600"><AlertTriangle className="w-3 h-3 mr-1" />Partial</Badge>;
    case "failed":
      return <Badge variant="outline" className="text-red-600 border-red-600"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
    case "timeout":
      return <Badge variant="outline" className="text-orange-600 border-orange-600"><Clock className="w-3 h-3 mr-1" />Timeout</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function getDocStatusBadge(status: string) {
  switch (status) {
    case "uploaded":
      return <Badge variant="outline" className="text-green-600 border-green-600">Uploaded</Badge>;
    case "downloaded":
      return <Badge variant="outline" className="text-blue-600 border-blue-600">Downloaded</Badge>;
    case "discovered":
      return <Badge variant="outline" className="text-yellow-600 border-yellow-600">Discovered</Badge>;
    case "failed":
      return <Badge variant="outline" className="text-red-600 border-red-600">Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

interface CrawlerStats {
  totalTowns: number;
  totalDocuments: number;
  totalUploaded: number;
  totalFailed: number;
  totalUrls: number;
  activeRuns: number;
  recentRuns: any[];
}

interface TownOverview {
  id: string;
  name: string;
  slug: string;
  url: string;
  cms: string | null;
  status: string;
  totalDocuments: number;
  totalUploaded: number;
  lastFullCrawl: string | null;
  lastIncrementalCrawl: string | null;
  consecutiveFailures: number;
  maxPages: number | null;
  customPaths: string[] | null;
  urlCount: number;
  documentsByStatus: Record<string, number>;
  lastRunStatus: string | null;
  lastRunDate: string | null;
  activeRunId: string | null;
}

interface CrawlerRun {
  id: string;
  townId: string;
  mode: string;
  triggerType: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  pagesVisited: number;
  documentsDiscovered: number;
  documentsDownloaded: number;
  documentsUploaded: number;
  documentsFailed: number;
  maxPagesLimit: number | null;
  errorMessage: string | null;
  summary: any;
}

interface CrawlerDocument {
  id: string;
  townId: string;
  url: string;
  filename: string;
  category: string | null;
  board: string | null;
  year: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  s3Key: string | null;
  discoveredAt: string;
  status: string;
  errorMessage: string | null;
  fileBlobId: string | null;
}

interface CrawlerUrl {
  id: string;
  townId: string;
  url: string;
  source: string;
  priority: string;
  firstDiscovered: string;
  lastVisited: string | null;
  visitCount: number;
  documentCount: number;
  status: string;
  errorMessage: string | null;
}

function FailureBreakdown({ summary, allRuns, runId }: { summary: any; allRuns: CrawlerRun[]; runId: string }) {
  if (!summary?.failuresByType || Object.keys(summary.failuresByType).length === 0) return null;

  const sortedRuns = [...allRuns].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const currentIdx = sortedRuns.findIndex(r => r.id === runId);
  const prevRun = currentIdx >= 0 && currentIdx < sortedRuns.length - 1 ? sortedRuns[currentIdx + 1] : null;
  const prevTypes = prevRun?.summary?.failuresByType ? Object.keys(prevRun.summary.failuresByType) : [];

  return (
    <div className="mt-1 space-y-0.5">
      {Object.entries(summary.failuresByType as Record<string, number>)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .map(([type, count]) => {
          const isRepeat = prevTypes.includes(type);
          const label = (FAILURE_LABELS as Record<string, string>)[type] || type;
          return (
            <div key={type} className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap">
              <span>{label}: {count as number}</span>
              {isRepeat && (
                <Badge variant="destructive" className="text-[8px] px-1 py-0 h-3 leading-none no-default-hover-elevate no-default-active-elevate">
                  repeat
                </Badge>
              )}
            </div>
          );
        })}
    </div>
  );
}

function StatsOverview({ stats }: { stats: CrawlerStats | undefined }) {
  const cards = [
    { label: "Towns", value: stats?.totalTowns ?? 0, icon: MapPin, color: "text-blue-600" },
    { label: "URLs Tracked", value: stats?.totalUrls ?? 0, icon: Link2, color: "text-purple-600" },
    { label: "Documents", value: stats?.totalDocuments ?? 0, icon: FileText, color: "text-indigo-600" },
    { label: "Uploaded", value: stats?.totalUploaded ?? 0, icon: FolderDown, color: "text-green-600" },
    { label: "Failed", value: stats?.totalFailed ?? 0, icon: XCircle, color: "text-red-600" },
    { label: "Active Runs", value: stats?.activeRuns ?? 0, icon: Activity, color: "text-orange-600" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <c.icon className={`w-4 h-4 ${c.color}`} />
              <span className="text-sm text-muted-foreground">{c.label}</span>
            </div>
            <div className="text-2xl font-bold" data-testid={`text-stat-${c.label.toLowerCase().replace(/\s+/g, "-")}`}>
              {formatNumber(c.value)}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TownsDashboard({
  onSelectTown,
}: {
  onSelectTown: (town: TownOverview) => void;
}) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: towns, isLoading } = useQuery<TownOverview[]>({
    queryKey: ["/api/admin/crawler/towns"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/crawler/towns");
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem("adminToken");
          setLocation("/admin/login");
          throw new Error("Session expired");
        }
        throw new Error("Failed to fetch towns");
      }
      return res.json();
    },
    refetchInterval: 15000,
  });

  const triggerCrawl = useMutation({
    mutationFn: async ({ townId, mode }: { townId: string; mode: string }) => {
      const res = await adminFetch("/api/admin/crawler/trigger", {
        method: "POST",
        body: JSON.stringify({ townId, mode }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Crawl Started", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler/towns"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler/stats"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const forceClearRun = async (runId: string) => {
    try {
      const res = await adminFetch(`/api/admin/crawler/runs/${runId}/abort`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).message);
      toast({ title: "Run Cleared", description: "Stale crawl run has been cleared" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler/towns"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler/stats"] });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea className="w-full">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Town</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>CMS</TableHead>
            <TableHead>URLs</TableHead>
            <TableHead>Docs (Uploaded/Total)</TableHead>
            <TableHead>Last Crawl</TableHead>
            <TableHead>Last Run</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(towns || []).map((town) => {
            const totalDocs = Object.values(town.documentsByStatus).reduce((a, b) => a + b, 0);
            const uploaded = town.documentsByStatus["uploaded"] || 0;
            return (
              <TableRow
                key={town.id}
                className="hover-elevate cursor-pointer"
                onClick={() => onSelectTown(town)}
                data-testid={`row-town-${town.slug}`}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium">{town.name}</div>
                      <div className="text-xs text-muted-foreground truncate max-w-[200px]">{town.url}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>{getTownStatusBadge(town.status)}</TableCell>
                <TableCell className="text-sm">{town.cms || "-"}</TableCell>
                <TableCell>{formatNumber(town.urlCount)}</TableCell>
                <TableCell>
                  <span className="text-green-600 font-medium">{uploaded}</span>
                  <span className="text-muted-foreground"> / {totalDocs}</span>
                </TableCell>
                <TableCell className="text-xs">{formatDateShort(town.lastFullCrawl)}</TableCell>
                <TableCell>
                  {town.lastRunStatus ? getRunStatusBadge(town.lastRunStatus) : <span className="text-muted-foreground text-xs">Never</span>}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {town.activeRunId ? (
                      <>
                        <Badge variant="outline" className="text-blue-600 border-blue-600">
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />Running
                        </Badge>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => forceClearRun(town.activeRunId!)}
                          data-testid={`button-force-clear-${town.slug}`}
                        >
                          <XCircle className="w-3 h-3 mr-1" />Clear
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => triggerCrawl.mutate({ townId: town.id, mode: "full" })}
                        disabled={triggerCrawl.isPending}
                        data-testid={`button-crawl-${town.slug}`}
                      >
                        <Play className="w-3 h-3 mr-1" />Crawl
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

interface CrawlProgress {
  runId: string;
  townId: string;
  townName: string;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
  pagesVisited: number;
  pagesQueued: number;
  documentsDiscovered: number;
  documentsDownloaded: number;
  documentsFailed: number;
  duplicatesSkipped: number;
  currentUrl: string;
  log: string[];
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
  detectedCms?: string;
  protectionDetected?: string;
  strategyStats?: {
    sitemap: number;
    knownPaths: number;
    breadthFirst: number;
    external: number;
    iframe: number;
  };
}

function CrawlProgressPanel({ runId, onComplete }: { runId: string; onComplete: () => void }) {
  const [showLog, setShowLog] = useState(false);
  const completedRef = useState(false);

  const { data: progress } = useQuery<CrawlProgress>({
    queryKey: ["/api/admin/crawler/runs", runId, "progress"],
    queryFn: async () => {
      const res = await adminFetch(`/api/admin/crawler/runs/${runId}/progress`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && data.status !== 'running') return false;
      return 2000;
    },
  });

  const { toast } = useToast();

  const isComplete = progress && progress.status !== 'running';
  const effectRef = completedRef;
  if (isComplete && !effectRef[0]) {
    effectRef[1](true);
    setTimeout(onComplete, 2000);
  }

  const abortMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch(`/api/admin/crawler/runs/${runId}/abort`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Crawl Aborted" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler"] });
    },
  });

  if (!progress) return null;

  const isRunning = progress.status === 'running';
  const elapsed = Math.round((Date.now() - new Date(progress.startedAt).getTime()) / 1000);
  const elapsedStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

  return (
    <Card className={isRunning ? "border-blue-500/50" : progress.status === 'completed' ? "border-green-500/50" : progress.status === 'completed_with_errors' ? "border-amber-500/50" : "border-red-500/50"}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            ) : progress.status === 'completed' ? (
              <CheckCircle2 className="w-4 h-4 text-green-600" />
            ) : progress.status === 'completed_with_errors' ? (
              <AlertTriangle className="w-4 h-4 text-amber-600" />
            ) : (
              <XCircle className="w-4 h-4 text-red-600" />
            )}
            <span className="font-semibold" data-testid="text-crawl-status">
              {isRunning ? 'Crawling...' : progress.status === 'completed' ? 'Crawl Complete' : progress.status === 'completed_with_errors' ? 'Completed with Errors' : 'Crawl Failed'}
            </span>
            <span className="text-sm text-muted-foreground">{elapsedStr}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowLog(!showLog)}
              data-testid="button-toggle-log"
            >
              {showLog ? 'Hide Log' : 'Show Log'}
            </Button>
            {isRunning && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => abortMutation.mutate()}
                disabled={abortMutation.isPending}
                data-testid="button-abort-crawl"
              >
                Abort
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div>
            <div className="text-xs text-muted-foreground">Pages Visited</div>
            <div className="text-lg font-bold" data-testid="text-progress-pages">{progress.pagesVisited}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Docs Found</div>
            <div className="text-lg font-bold" data-testid="text-progress-found">{progress.documentsDiscovered}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Downloaded</div>
            <div className="text-lg font-bold text-green-600" data-testid="text-progress-downloaded">{progress.documentsDownloaded}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Failed</div>
            <div className="text-lg font-bold text-red-600" data-testid="text-progress-failed">{progress.documentsFailed}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Duplicates</div>
            <div className="text-lg font-bold text-muted-foreground" data-testid="text-progress-duplicates">{progress.duplicatesSkipped}</div>
          </div>
        </div>

        {(progress.detectedCms || progress.protectionDetected || progress.strategyStats) && (
          <div className="flex items-center gap-2 flex-wrap">
            {progress.detectedCms && (
              <Badge variant="secondary" data-testid="text-detected-cms">
                CMS: {progress.detectedCms}
              </Badge>
            )}
            {progress.protectionDetected && (
              <Badge variant="destructive" data-testid="text-protection">
                {progress.protectionDetected}
              </Badge>
            )}
            {progress.strategyStats && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>Sitemap: {progress.strategyStats.sitemap}</span>
                <span>Paths: {progress.strategyStats.knownPaths}</span>
                <span>BFS: {progress.strategyStats.breadthFirst}</span>
                {progress.strategyStats.external > 0 && <span>External: {progress.strategyStats.external}</span>}
                {progress.strategyStats.iframe > 0 && <span>Embed: {progress.strategyStats.iframe}</span>}
              </div>
            )}
          </div>
        )}

        {isRunning && progress.currentUrl && (
          <div className="text-xs text-muted-foreground truncate" data-testid="text-current-url">
            Crawling: {progress.currentUrl}
          </div>
        )}

        {progress.errorMessage && (
          <div className={`text-sm p-2 rounded ${
            progress.status === 'failed' ? "text-red-600 bg-red-50 dark:bg-red-950/20" :
            progress.status === 'completed_with_errors' ? "text-amber-600 bg-amber-50 dark:bg-amber-950/20" :
            "text-muted-foreground bg-muted/50"
          }`} data-testid="text-crawl-error">
            {progress.errorMessage}
          </div>
        )}

        {showLog && progress.log.length > 0 && (
          <ScrollArea className="h-48 rounded border bg-muted/30 p-2">
            <pre className="text-xs font-mono whitespace-pre-wrap" data-testid="text-crawl-log">
              {progress.log.slice(-100).join('\n')}
            </pre>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function TownDetail({
  town,
  onBack,
}: {
  town: TownOverview;
  onBack: () => void;
}) {
  const [tab, setTab] = useState("documents");
  const [docStatus, setDocStatus] = useState<string>("all");
  const [docSearch, setDocSearch] = useState("");
  const [docPage, setDocPage] = useState(0);
  const [urlStatus, setUrlStatus] = useState<string>("all");
  const [urlPage, setUrlPage] = useState(0);
  const [runPage, setRunPage] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(town.activeRunId);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const limit = 50;

  const { data: townData } = useQuery<TownOverview>({
    queryKey: ["/api/admin/crawler/towns", town.id],
    queryFn: async () => {
      const res = await adminFetch(`/api/admin/crawler/towns/${town.id}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    initialData: town,
  });

  const { data: docsData, isLoading: docsLoading } = useQuery<{ documents: CrawlerDocument[]; total: number }>({
    queryKey: ["/api/admin/crawler/documents", town.id, docStatus, docSearch, docPage],
    queryFn: async () => {
      const params = new URLSearchParams({
        townId: town.id,
        limit: String(limit),
        offset: String(docPage * limit),
      });
      if (docStatus !== "all") params.set("status", docStatus);
      if (docSearch) params.set("search", docSearch);
      const res = await adminFetch(`/api/admin/crawler/documents?${params}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const { data: urlsData, isLoading: urlsLoading } = useQuery<{ urls: CrawlerUrl[]; total: number }>({
    queryKey: ["/api/admin/crawler/urls", town.id, urlStatus, urlPage],
    queryFn: async () => {
      const params = new URLSearchParams({
        townId: town.id,
        limit: String(limit),
        offset: String(urlPage * limit),
      });
      if (urlStatus !== "all") params.set("status", urlStatus);
      const res = await adminFetch(`/api/admin/crawler/urls?${params}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: tab === "urls",
  });

  const { data: runsData, isLoading: runsLoading } = useQuery<{ runs: CrawlerRun[]; total: number }>({
    queryKey: ["/api/admin/crawler/runs", town.id, runPage],
    queryFn: async () => {
      const params = new URLSearchParams({
        townId: town.id,
        limit: String(limit),
        offset: String(runPage * limit),
      });
      const res = await adminFetch(`/api/admin/crawler/runs?${params}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: tab === "runs",
    refetchInterval: 15000,
  });

  const triggerCrawl = useMutation({
    mutationFn: async (mode: string) => {
      const res = await adminFetch("/api/admin/crawler/trigger", {
        method: "POST",
        body: JSON.stringify({ townId: town.id, mode }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Crawl Started", description: data.message });
      setActiveRunId(data.runId);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateTown = useMutation({
    mutationFn: async (updates: any) => {
      const res = await adminFetch(`/api/admin/crawler/towns/${town.id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Updated", description: "Town profile saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler/towns"] });
      setEditOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const totalDocs = docsData?.total || 0;
  const totalDocPages = Math.ceil(totalDocs / limit);
  const totalUrls = urlsData?.total || 0;
  const totalUrlPages = Math.ceil(totalUrls / limit);
  const totalRuns = runsData?.total || 0;
  const totalRunPages = Math.ceil(totalRuns / limit);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-towns">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Globe className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-xl font-bold">{townData?.name || town.name}</h2>
          {getTownStatusBadge(townData?.status || town.status)}
          {townData?.cms && <Badge variant="secondary">{townData.cms}</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <a href={town.url} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground flex items-center gap-1">
            {town.url} <ExternalLink className="w-3 h-3" />
          </a>
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-edit-profile">
                <Settings className="w-3 h-3 mr-1" />Profile
              </Button>
            </DialogTrigger>
            <DialogContent>
              <TownProfileEditor town={townData || town} onSave={(updates) => updateTown.mutate(updates)} saving={updateTown.isPending} />
            </DialogContent>
          </Dialog>
          <Button
            size="sm"
            onClick={() => triggerCrawl.mutate("full")}
            disabled={triggerCrawl.isPending || !!activeRunId}
            data-testid="button-trigger-crawl"
          >
            <Play className="w-3 h-3 mr-1" />
            {activeRunId ? "Running..." : "Run Crawl"}
          </Button>
          {activeRunId && (
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                try {
                  const res = await adminFetch(`/api/admin/crawler/runs/${activeRunId}/abort`, { method: "POST" });
                  if (!res.ok) throw new Error((await res.json()).message);
                  toast({ title: "Run Cleared", description: "Stale crawl run has been cleared" });
                  setActiveRunId(null);
                  queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler"] });
                } catch (error: any) {
                  toast({ title: "Error", description: error.message, variant: "destructive" });
                }
              }}
              data-testid="button-force-clear-detail"
            >
              <XCircle className="w-3 h-3 mr-1" />Force Clear
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">URLs Found</div>
            <div className="text-lg font-bold" data-testid="text-town-urls">{formatNumber(town.urlCount)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">Docs Uploaded</div>
            <div className="text-lg font-bold text-green-600" data-testid="text-town-uploaded">
              {formatNumber(town.documentsByStatus["uploaded"] || 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">Docs Failed</div>
            <div className="text-lg font-bold text-red-600" data-testid="text-town-failed">
              {formatNumber(town.documentsByStatus["failed"] || 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">Last Crawl</div>
            <div className="text-sm font-medium">{formatDateShort(town.lastFullCrawl)}</div>
          </CardContent>
        </Card>
      </div>

      {activeRunId && (
        <CrawlProgressPanel
          runId={activeRunId}
          onComplete={() => {
            setActiveRunId(null);
            queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler"] });
          }}
        />
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="documents" data-testid="tab-documents">
            <FileText className="w-3 h-3 mr-1" />Documents ({totalDocs})
          </TabsTrigger>
          <TabsTrigger value="urls" data-testid="tab-urls">
            <Link2 className="w-3 h-3 mr-1" />URLs ({town.urlCount})
          </TabsTrigger>
          <TabsTrigger value="runs" data-testid="tab-runs">
            <Activity className="w-3 h-3 mr-1" />Run History
          </TabsTrigger>
          <TabsTrigger value="coverage" data-testid="tab-coverage">
            <Target className="w-3 h-3 mr-1" />Coverage
          </TabsTrigger>
          <TabsTrigger value="gaps" data-testid="tab-gaps">
            <AlertTriangle className="w-3 h-3 mr-1" />Gaps
          </TabsTrigger>
        </TabsList>

        <TabsContent value="documents" className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search documents..."
                value={docSearch}
                onChange={(e) => { setDocSearch(e.target.value); setDocPage(0); }}
                className="pl-8"
                data-testid="input-doc-search"
              />
            </div>
            <Select value={docStatus} onValueChange={(v) => { setDocStatus(v); setDocPage(0); }}>
              <SelectTrigger className="w-[150px]" data-testid="select-doc-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="uploaded">Uploaded</SelectItem>
                <SelectItem value="downloaded">Downloaded</SelectItem>
                <SelectItem value="discovered">Discovered</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {docsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <ScrollArea className="w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Filename</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Board</TableHead>
                      <TableHead>Year</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Discovered</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(docsData?.documents || []).map((doc) => (
                      <TableRow key={doc.id} data-testid={`row-doc-${doc.id}`}>
                        <TableCell>
                          <div className="max-w-[250px]">
                            <div className="truncate font-mono text-xs" title={doc.filename}>{doc.filename}</div>
                            <div className="truncate text-xs text-muted-foreground" title={doc.url}>{doc.url}</div>
                          </div>
                        </TableCell>
                        <TableCell>{getDocStatusBadge(doc.status)}</TableCell>
                        <TableCell className="text-xs">{doc.category || "-"}</TableCell>
                        <TableCell className="text-xs">{doc.board || "-"}</TableCell>
                        <TableCell className="text-xs">{doc.year || "-"}</TableCell>
                        <TableCell className="text-xs">
                          {doc.sizeBytes ? formatBytes(doc.sizeBytes) : "-"}
                        </TableCell>
                        <TableCell className="text-xs">{formatDateShort(doc.discoveredAt)}</TableCell>
                        <TableCell className="max-w-[150px] truncate text-xs text-red-600" title={doc.errorMessage || ""}>
                          {doc.errorMessage || "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                    {(!docsData?.documents || docsData.documents.length === 0) && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                          No documents found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
              <Pagination page={docPage} totalPages={totalDocPages} onPageChange={setDocPage} total={totalDocs} />
            </>
          )}
        </TabsContent>

        <TabsContent value="urls" className="space-y-3">
          <div className="flex items-center gap-2">
            <Select value={urlStatus} onValueChange={(v) => { setUrlStatus(v); setUrlPage(0); }}>
              <SelectTrigger className="w-[150px]" data-testid="select-url-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="visited">Visited</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {urlsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <ScrollArea className="w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>URL</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Visits</TableHead>
                      <TableHead>Docs Found</TableHead>
                      <TableHead>First Seen</TableHead>
                      <TableHead>Last Visited</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(urlsData?.urls || []).map((url) => (
                      <TableRow key={url.id} data-testid={`row-url-${url.id}`}>
                        <TableCell>
                          <a
                            href={url.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="max-w-[350px] truncate block text-xs font-mono text-blue-600 dark:text-blue-400"
                            title={url.url}
                          >
                            {url.url}
                          </a>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{url.source}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={
                            url.status === "visited" ? "text-green-600 border-green-600" :
                            url.status === "failed" ? "text-red-600 border-red-600" :
                            "text-yellow-600 border-yellow-600"
                          }>
                            {url.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{url.visitCount}</TableCell>
                        <TableCell>{url.documentCount}</TableCell>
                        <TableCell className="text-xs">{formatDateShort(url.firstDiscovered)}</TableCell>
                        <TableCell className="text-xs">{formatDateShort(url.lastVisited)}</TableCell>
                      </TableRow>
                    ))}
                    {(!urlsData?.urls || urlsData.urls.length === 0) && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                          No URLs tracked yet
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
              <Pagination page={urlPage} totalPages={totalUrlPages} onPageChange={setUrlPage} total={totalUrls} />
            </>
          )}
        </TabsContent>

        <TabsContent value="runs" className="space-y-3">
          {runsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <ScrollArea className="w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Started</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Pages</TableHead>
                      <TableHead>Discovered</TableHead>
                      <TableHead>Downloaded</TableHead>
                      <TableHead>Uploaded</TableHead>
                      <TableHead>Failed</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(runsData?.runs || []).map((run) => {
                      const duration = run.completedAt
                        ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
                        : null;
                      return (
                        <TableRow key={run.id} data-testid={`row-run-${run.id}`}>
                          <TableCell className="text-xs">{formatDateShort(run.startedAt)}</TableCell>
                          <TableCell>
                            <Badge variant="secondary">{run.mode}</Badge>
                          </TableCell>
                          <TableCell>{getRunStatusBadge(run.status)}</TableCell>
                          <TableCell>{run.pagesVisited}</TableCell>
                          <TableCell>{run.documentsDiscovered}</TableCell>
                          <TableCell>{run.documentsDownloaded}</TableCell>
                          <TableCell className="text-green-600 font-medium">{run.documentsUploaded}</TableCell>
                          <TableCell className={run.documentsFailed > 0 ? "text-red-600" : ""}>
                            {run.documentsFailed}
                            <FailureBreakdown summary={run.summary} allRuns={runsData?.runs || []} runId={run.id} />
                          </TableCell>
                          <TableCell className="text-xs">
                            {duration != null ? `${Math.floor(duration / 60)}m ${duration % 60}s` : "-"}
                          </TableCell>
                          <TableCell className="max-w-[200px] text-xs" title={run.errorMessage || run.summary?.statusReason || ""}>
                            <span className={
                              run.status === 'failed' ? "text-red-600" :
                              run.status === 'completed_with_errors' ? "text-amber-600" :
                              "text-muted-foreground"
                            }>
                              {run.errorMessage || run.summary?.statusReason || "-"}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {(!runsData?.runs || runsData.runs.length === 0) && (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                          No crawl runs yet
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
              <Pagination page={runPage} totalPages={totalRunPages} onPageChange={setRunPage} total={totalRuns} />
            </>
          )}
        </TabsContent>

        <TabsContent value="coverage">
          <CoverageTab townId={town.id} townName={town.name} />
        </TabsContent>

        <TabsContent value="gaps">
          <GapAnalysisTab townId={town.id} townName={town.name} townUrl={town.url} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface AssessmentData {
  id: string;
  townId: string;
  assessedAt: string;
  population: number;
  predicted: Record<string, number>;
  estimated: Record<string, number>;
  categoryScores: Record<string, {
    predicted: number;
    estimated: number;
    score: number;
    rating: string;
  }>;
  overallScore: number;
  totalFilesAnalyzed: number;
  llmModel: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  meeting_minutes: "Meeting Minutes",
  agendas: "Agendas",
  ordinances: "Ordinances & Regulations",
  budgets: "Budgets & Financial",
  annual_reports: "Annual/Town Reports",
  forms_applications: "Forms & Applications",
  newsletters: "Newsletters & Notices",
  zoning: "Zoning Documents",
  plans_studies: "Plans & Studies",
  policies_procedures: "Policies & Procedures",
  elections: "Elections & Voting",
  other: "Other Documents",
};

const CATEGORY_ORDER = [
  "meeting_minutes",
  "agendas",
  "ordinances",
  "budgets",
  "annual_reports",
  "forms_applications",
  "newsletters",
  "zoning",
  "plans_studies",
  "policies_procedures",
  "elections",
  "other",
];

function getRatingBadge(rating: string) {
  switch (rating) {
    case "excellent":
      return <Badge variant="outline" className="text-green-600 border-green-600">Excellent</Badge>;
    case "good":
      return <Badge variant="outline" className="text-blue-600 border-blue-600">Good</Badge>;
    case "fair":
      return <Badge variant="outline" className="text-yellow-600 border-yellow-600">Fair</Badge>;
    case "poor":
      return <Badge variant="outline" className="text-orange-600 border-orange-600">Poor</Badge>;
    case "missing":
      return <Badge variant="outline" className="text-red-600 border-red-600">Missing</Badge>;
    default:
      return <Badge variant="outline">{rating}</Badge>;
  }
}

function getOverallRating(score: number): { label: string; color: string } {
  if (score >= 80) return { label: "Excellent", color: "text-green-600" };
  if (score >= 60) return { label: "Good", color: "text-blue-600" };
  if (score >= 40) return { label: "Fair", color: "text-yellow-600" };
  if (score >= 20) return { label: "Poor", color: "text-orange-600" };
  return { label: "Minimal", color: "text-red-600" };
}

interface GapTarget {
  category: string;
  label: string;
  priority: "critical" | "high" | "medium" | "low";
  predicted: number;
  found: number;
  deficit: number;
  score: number;
  rating: string;
  searchHints: Array<{
    strategy: string;
    patterns: string[];
    description: string;
  }>;
}

interface GapAnalysisData {
  townId: string;
  townName: string;
  cms: string | null;
  overallScore: number;
  assessedAt: string;
  gaps: GapTarget[];
  topPriority: string | null;
  targetPaths?: string[];
  linkPatterns?: string[];
}

function getPriorityColor(priority: string) {
  switch (priority) {
    case "critical": return "text-red-600 dark:text-red-400";
    case "high": return "text-orange-600 dark:text-orange-400";
    case "medium": return "text-yellow-600 dark:text-yellow-400";
    case "low": return "text-muted-foreground";
    default: return "";
  }
}

function getPriorityBadgeVariant(priority: string): "destructive" | "secondary" | "outline" | "default" {
  switch (priority) {
    case "critical": return "destructive";
    case "high": return "default";
    case "medium": return "secondary";
    default: return "outline";
  }
}

function GapAnalysisTab({ townId, townName, townUrl }: { townId: string; townName: string; townUrl: string }) {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const { data: gapData, isLoading, error } = useQuery<GapAnalysisData>({
    queryKey: ["/api/admin/crawler/gaps", townId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/crawler/gaps/${townId}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("adminToken")}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to load gap analysis");
      }
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        <span className="text-sm text-muted-foreground">Analyzing coverage gaps...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <AlertTriangle className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground mb-2">
            {(error as Error).message}
          </p>
          <p className="text-xs text-muted-foreground">
            Run a coverage assessment first from the Coverage tab.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!gapData || gapData.gaps.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <CheckCircle2 className="w-8 h-8 text-green-600 mx-auto mb-2" />
          <p className="text-sm font-medium">No significant coverage gaps detected</p>
          <p className="text-xs text-muted-foreground mt-1">
            All document categories have adequate coverage (score &gt; 80).
          </p>
        </CardContent>
      </Card>
    );
  }

  const criticalCount = gapData.gaps.filter(g => g.priority === "critical").length;
  const highCount = gapData.gaps.filter(g => g.priority === "high").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-medium">Gap Analysis for {townName}</h3>
          <p className="text-xs text-muted-foreground">
            Based on assessment from {new Date(gapData.assessedAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {criticalCount > 0 && (
            <Badge variant="destructive" data-testid="badge-critical-gaps">
              {criticalCount} critical
            </Badge>
          )}
          {highCount > 0 && (
            <Badge variant="default" data-testid="badge-high-gaps">
              {highCount} high priority
            </Badge>
          )}
          <Badge variant="secondary" data-testid="badge-overall-score">
            Overall: {gapData.overallScore}/100
          </Badge>
        </div>
      </div>

      <div className="space-y-2">
        {gapData.gaps.map((gap) => (
          <Card key={gap.category} data-testid={`card-gap-${gap.category}`}>
            <CardContent className="p-3">
              <div
                className="flex items-center justify-between gap-2 flex-wrap cursor-pointer"
                onClick={() => setExpandedCategory(
                  expandedCategory === gap.category ? null : gap.category
                )}
                data-testid={`button-expand-gap-${gap.category}`}
              >
                <div className="flex items-center gap-2">
                  <Badge variant={getPriorityBadgeVariant(gap.priority)}>
                    {gap.priority}
                  </Badge>
                  <span className="text-sm font-medium">{gap.label}</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-xs text-muted-foreground">
                    Found {gap.found} of ~{gap.predicted} expected
                  </div>
                  <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        gap.score <= 10 ? "bg-red-500" :
                        gap.score <= 25 ? "bg-orange-500" :
                        gap.score <= 50 ? "bg-yellow-500" :
                        "bg-green-500"
                      }`}
                      style={{ width: `${Math.min(100, gap.score)}%` }}
                    />
                  </div>
                  <span className={`text-xs font-mono ${getPriorityColor(gap.priority)}`}>
                    {gap.score}%
                  </span>
                  <ChevronRight
                    className={`w-4 h-4 text-muted-foreground transition-transform ${
                      expandedCategory === gap.category ? "rotate-90" : ""
                    }`}
                  />
                </div>
              </div>

              {expandedCategory === gap.category && (
                <div className="mt-3 pt-3 border-t space-y-3">
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <span className="text-muted-foreground">Expected:</span>{" "}
                      <span className="font-medium">~{gap.predicted} docs</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Found:</span>{" "}
                      <span className="font-medium">{gap.found} docs</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Deficit:</span>{" "}
                      <span className="font-medium text-red-600 dark:text-red-400">{gap.deficit} docs</span>
                    </div>
                  </div>

                  {gap.searchHints.length > 0 && (
                    <div>
                      <div className="text-xs font-medium mb-1 text-muted-foreground">
                        Suggested search strategies:
                      </div>
                      {gap.searchHints.map((hint, i) => (
                        <div key={i} className="mb-2">
                          <div className="text-xs text-muted-foreground italic mb-0.5">
                            {hint.description}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {hint.patterns.slice(0, 8).map((p, j) => (
                              <Badge
                                key={j}
                                variant="outline"
                                className="text-xs font-mono"
                              >
                                {hint.strategy === "path_patterns" ? (
                                  <a
                                    href={`${townUrl.replace(/\/$/, "")}${p}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {p}
                                    <ExternalLink className="w-2.5 h-2.5" />
                                  </a>
                                ) : (
                                  p
                                )}
                              </Badge>
                            ))}
                            {hint.patterns.length > 8 && (
                              <span className="text-xs text-muted-foreground">
                                +{hint.patterns.length - 8} more
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {gapData.targetPaths && gapData.targetPaths.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="text-xs font-medium mb-1 text-muted-foreground">
              Priority target URLs ({gapData.targetPaths.length})
            </div>
            <ScrollArea className="h-32">
              <div className="space-y-0.5">
                {gapData.targetPaths.map((url, i) => (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-mono text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                    data-testid={`link-target-url-${i}`}
                  >
                    {url.replace(townUrl, "")}
                    <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
                  </a>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CoverageTab({ townId, townName }: { townId: string; townName: string }) {
  const { toast } = useToast();

  const { data: assessment, isLoading } = useQuery<AssessmentData | null>({
    queryKey: ["/api/admin/crawler/assessments", townId],
    queryFn: async () => {
      const res = await adminFetch(`/api/admin/crawler/assessments/${townId}`);
      if (!res.ok) throw new Error("Failed to fetch assessment");
      return res.json();
    },
    enabled: true,
  });

  const runAssessment = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300_000);
      try {
        const res = await adminFetch(`/api/admin/crawler/assessments/${townId}/run`, {
          method: "POST",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error((await res.json()).message);
        return res.json();
      } finally {
        clearTimeout(timeoutId);
      }
    },
    onSuccess: () => {
      toast({ title: "Assessment Complete", description: `Coverage analysis for ${townName} is ready` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler/assessments", townId] });
    },
    onError: (error: Error) => {
      toast({ title: "Assessment Failed", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!assessment) {
    return (
      <Card>
        <CardContent className="py-12 text-center space-y-4">
          <BarChart3 className="w-12 h-12 mx-auto text-muted-foreground" />
          <div>
            <h3 className="text-lg font-medium">No Coverage Assessment Yet</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Run an analysis to compare expected documents against what we've actually found for {townName}.
            </p>
          </div>
          <Button
            onClick={() => runAssessment.mutate()}
            disabled={runAssessment.isPending}
            data-testid="button-run-assessment"
          >
            {runAssessment.isPending ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyzing...</>
            ) : (
              <><BarChart3 className="w-4 h-4 mr-2" />Run Coverage Analysis</>
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const overallScore = Number(assessment.overallScore);
  const { label: overallLabel, color: overallColor } = getOverallRating(overallScore);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-sm text-muted-foreground">Overall Completeness</div>
            <div className="flex items-baseline gap-2">
              <span className={`text-3xl font-bold ${overallColor}`} data-testid="text-overall-score">
                {Math.round(overallScore)}%
              </span>
              <span className={`text-sm font-medium ${overallColor}`}>{overallLabel}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-right text-sm text-muted-foreground">
            <div>{assessment.totalFilesAnalyzed} files analyzed</div>
            <div>Pop. {formatNumber(assessment.population)}</div>
            <div>Assessed {formatDateShort(assessment.assessedAt)}</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runAssessment.mutate()}
            disabled={runAssessment.isPending}
            data-testid="button-refresh-assessment"
          >
            {runAssessment.isPending ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Analyzing...</>
            ) : (
              <><RefreshCw className="w-3 h-3 mr-1" />Re-Analyze</>
            )}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead className="text-right">Found</TableHead>
                <TableHead className="w-[200px]">Completeness</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead>Rating</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CATEGORY_ORDER.map((cat) => {
                const scores = assessment.categoryScores[cat];
                if (!scores) return null;
                const progressColor = scores.score >= 80
                  ? "[&>div]:bg-green-500"
                  : scores.score >= 50
                  ? "[&>div]:bg-blue-500"
                  : scores.score >= 25
                  ? "[&>div]:bg-yellow-500"
                  : scores.score > 0
                  ? "[&>div]:bg-orange-500"
                  : "[&>div]:bg-red-500";
                return (
                  <TableRow key={cat} data-testid={`row-category-${cat}`}>
                    <TableCell>
                      <span className="font-medium">{CATEGORY_LABELS[cat] || cat}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{scores.predicted}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{scores.estimated}</TableCell>
                    <TableCell>
                      <Progress value={Math.min(scores.score, 100)} className={`h-2 ${progressColor}`} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{scores.score}%</TableCell>
                    <TableCell>{getRatingBadge(scores.rating)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <h4 className="text-sm font-medium mb-2">How This Works</h4>
          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              <strong>Expected (Predicted):</strong> Based on {townName}'s population of {formatNumber(assessment.population)},
              we estimate how many documents of each type a well-documented town website would have.
              This includes years of meeting minutes, budgets, annual reports, and more.
            </p>
            <p>
              <strong>Found (Estimated):</strong> An AI analysis of the {assessment.totalFilesAnalyzed} successfully
              downloaded filenames, classifying each into document categories.
            </p>
            <p>
              <strong>Score:</strong> The percentage of expected documents we've found. Categories are weighted
              by importance (minutes and budgets count more than newsletters). Overall score is a weighted average.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TownProfileEditor({
  town,
  onSave,
  saving,
}: {
  town: TownOverview;
  onSave: (updates: any) => void;
  saving: boolean;
}) {
  const [cms, setCms] = useState(town.cms || "");
  const [maxPages, setMaxPages] = useState(town.maxPages?.toString() || "");
  const [customPaths, setCustomPaths] = useState((town.customPaths || []).join("\n"));
  const [status, setStatus] = useState(town.status);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit {town.name} Crawler Profile</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger data-testid="select-town-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>CMS Type</Label>
          <Select value={cms || "unknown"} onValueChange={setCms}>
            <SelectTrigger data-testid="select-cms-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unknown">Unknown</SelectItem>
              <SelectItem value="CivicPlus">CivicPlus</SelectItem>
              <SelectItem value="WordPress">WordPress</SelectItem>
              <SelectItem value="Revize">Revize</SelectItem>
              <SelectItem value="Custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Max Pages per Crawl</Label>
          <div className="flex items-center gap-2 flex-wrap">
            {[500, 1000, 1500, 2000].map(preset => (
              <Button
                key={preset}
                size="sm"
                variant={maxPages === String(preset) ? "default" : "outline"}
                onClick={() => setMaxPages(String(preset))}
                data-testid={`button-maxpages-${preset}`}
              >
                {preset}
              </Button>
            ))}
            <Button
              size="sm"
              variant={!maxPages ? "default" : "outline"}
              onClick={() => setMaxPages("")}
              data-testid="button-maxpages-default"
            >
              Default (1000)
            </Button>
          </div>
          <Input
            type="number"
            value={maxPages}
            onChange={(e) => setMaxPages(e.target.value)}
            placeholder="Default (1000)"
            data-testid="input-max-pages"
          />
        </div>
        <div className="space-y-2">
          <Label>Custom Paths (one per line)</Label>
          <Textarea
            value={customPaths}
            onChange={(e) => setCustomPaths(e.target.value)}
            placeholder="/documents&#10;/minutes&#10;/agendas"
            rows={4}
            data-testid="input-custom-paths"
          />
          <p className="text-xs text-muted-foreground">
            Additional URL paths the crawler should check beyond what it discovers automatically.
          </p>
        </div>
      </div>
      <DialogFooter>
        <Button
          onClick={() => onSave({
            status,
            cms: cms === "unknown" ? null : cms,
            maxPages: maxPages ? parseInt(maxPages) : null,
            customPaths: customPaths.trim() ? customPaths.trim().split("\n").filter(Boolean) : null,
          })}
          disabled={saving}
          data-testid="button-save-profile"
        >
          {saving && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
          Save Changes
        </Button>
      </DialogFooter>
    </>
  );
}

function Pagination({
  page,
  totalPages,
  onPageChange,
  total,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  total: number;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">{total} total</span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          data-testid="button-prev-page"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <span className="text-sm px-2">
          {page + 1} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
          data-testid="button-next-page"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function RunLogViewer({ runId }: { runId: string }) {
  const { data, isLoading } = useQuery<{ logs: string[]; summary: any }>({
    queryKey: ["/api/admin/crawler/runs", runId, "logs"],
    queryFn: async () => {
      const res = await adminFetch(`/api/admin/crawler/runs/${runId}/logs`);
      if (!res.ok) throw new Error("Failed to fetch logs");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm text-muted-foreground">Loading logs...</span>
      </div>
    );
  }

  const logs = data?.logs || [];
  const summary = data?.summary as any;

  return (
    <div className="space-y-3">
      {summary?.statusReason && (
        <div className="text-sm px-3 py-2 rounded bg-muted/50 border border-muted" data-testid="text-status-reason">
          <span className="font-medium text-muted-foreground">Result: </span>
          {summary.statusReason}
        </div>
      )}
      {summary?.strategyStats && (
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">Sitemap: {summary.strategyStats?.sitemap ?? 0}</Badge>
          <Badge variant="secondary">Known Paths: {summary.strategyStats?.knownPaths ?? 0}</Badge>
          <Badge variant="secondary">BFS: {summary.strategyStats?.breadthFirst ?? 0}</Badge>
          <Badge variant="secondary">External: {summary.strategyStats?.external ?? 0}</Badge>
          <Badge variant="secondary">Iframe: {summary.strategyStats?.iframe ?? 0}</Badge>
          {summary?.detectedCms && <Badge variant="outline">CMS: {summary.detectedCms}</Badge>}
          {(summary?.fastLaneRequests != null || summary?.heavyLaneRequests != null) && (
            <>
              <Badge variant="secondary" data-testid="badge-fast-lane">Fast Lane: {summary.fastLaneRequests ?? 0}</Badge>
              <Badge variant="secondary" data-testid="badge-heavy-lane">Heavy Lane: {summary.heavyLaneRequests ?? 0}</Badge>
            </>
          )}
          {summary?.interstitialsBypassed != null && summary.interstitialsBypassed > 0 && (
            <Badge variant="outline" className="text-green-600 border-green-600 dark:text-green-400 dark:border-green-400" data-testid="badge-interstitials">Interstitials Bypassed: {summary.interstitialsBypassed}</Badge>
          )}
          {summary?.protectionDetected && <Badge variant="outline" className="text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400">Protection: {summary.protectionDetected}</Badge>}
          {summary?.protectionStats?.detected && (
            <>
              <Badge variant="outline" className="text-orange-600 border-orange-600 dark:text-orange-400 dark:border-orange-400">
                Blocked Pages: {summary.protectionStats.blockedPages}
              </Badge>
              {summary.protectionStats.blockedDocuments > 0 && (
                <Badge variant="outline" className="text-orange-600 border-orange-600 dark:text-orange-400 dark:border-orange-400">
                  Blocked Docs: {summary.protectionStats.blockedDocuments}
                </Badge>
              )}
              {summary.protectionStats.types.map((t: string) => (
                <Badge key={t} variant="outline" className="text-yellow-600 border-yellow-600 dark:text-yellow-400 dark:border-yellow-400">
                  {t}
                </Badge>
              ))}
            </>
          )}
        </div>
      )}
      {summary?.errors && Array.isArray(summary.errors) && summary.errors.length > 0 && (
        <div className="text-sm text-red-600">
          {summary.errors.length} error(s): {summary.errors.slice(0, 3).map((e: any) => e?.error || 'unknown').join(", ")}
          {summary.errors.length > 3 && ` (+${summary.errors.length - 3} more)`}
        </div>
      )}
      <ScrollArea className="h-64 border rounded-md">
        <div className="p-2 font-mono text-xs space-y-0.5">
          {logs.length === 0 ? (
            <div className="text-muted-foreground italic">No logs available (run may predate log persistence)</div>
          ) : (
            logs.map((line, i) => (
              <div 
                key={i} 
                className={`${
                  line.includes("FAIL") || line.includes("ERROR") 
                    ? "text-red-600 dark:text-red-400" 
                    : line.includes("PROTECTION")
                    ? "text-orange-600 dark:text-orange-400 font-medium"
                    : line.includes("WARNING")
                    ? "text-yellow-600 dark:text-yellow-400"
                    : line.includes("---") 
                    ? "font-semibold text-foreground" 
                    : line.includes("OK") 
                    ? "text-green-600 dark:text-green-400"
                    : "text-muted-foreground"
                }`}
              >
                {line}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function RunHistoryGlobal() {
  const [page, setPage] = useState(0);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  const limit = 50;

  const { data: towns } = useQuery<TownOverview[]>({
    queryKey: ["/api/admin/crawler/towns"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/crawler/towns");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const townMap = new Map((towns || []).map((t) => [t.id, t.name]));

  const { data, isLoading } = useQuery<{ runs: CrawlerRun[]; total: number }>({
    queryKey: ["/api/admin/crawler/runs", null, page],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
      const res = await adminFetch(`/api/admin/crawler/runs?${params}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const totalPages = Math.ceil((data?.total || 0) / limit);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ScrollArea className="w-full">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Town</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Pages</TableHead>
              <TableHead>Discovered</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead>Failed</TableHead>
              <TableHead>Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.runs || []).map((run) => {
              const duration = run.completedAt
                ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
                : null;
              return (
                <>
                  <TableRow 
                    key={run.id} 
                    data-testid={`row-run-${run.id}`} 
                    className="cursor-pointer hover-elevate"
                    onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                  >
                    <TableCell className="font-medium">{townMap.get(run.townId) || run.townId}</TableCell>
                    <TableCell className="text-xs">{formatDateShort(run.startedAt)}</TableCell>
                    <TableCell><Badge variant="secondary">{run.mode}</Badge></TableCell>
                    <TableCell className="text-xs">{run.triggerType}</TableCell>
                    <TableCell>{getRunStatusBadge(run.status)}</TableCell>
                    <TableCell>{run.pagesVisited}</TableCell>
                    <TableCell>{run.documentsDiscovered}</TableCell>
                    <TableCell className="text-green-600 font-medium">{run.documentsUploaded}</TableCell>
                    <TableCell className={run.documentsFailed > 0 ? "text-red-600" : ""}>
                      {run.documentsFailed}
                    </TableCell>
                    <TableCell className="text-xs">
                      {duration != null ? `${Math.floor(duration / 60)}m ${duration % 60}s` : "-"}
                    </TableCell>
                  </TableRow>
                  {expandedRun === run.id && (
                    <TableRow>
                      <TableCell colSpan={10} className="p-4 bg-muted/30">
                        <RunLogViewer runId={run.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
          </TableBody>
        </Table>
      </ScrollArea>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} total={data?.total || 0} />
    </div>
  );
}

interface StateSource {
  id: string;
  name: string;
  slug: string;
  agency: string;
  agencyAbbrev: string | null;
  baseUrl: string;
  description: string | null;
  docCategories: StateDocCategory[];
  targetPaths: string[];
  linkPatterns: string[];
  excludePatterns: string[];
  updateCadence: string;
  maxPages: number | null;
  status: string;
  lastCrawlDate: string | null;
  totalDocuments: number;
  totalUploaded: number;
  consecutiveFailures: number;
  notes: string | null;
}

function getSourceStatusBadge(status: string) {
  switch (status) {
    case "active":
      return <Badge variant="outline" className="text-green-600 border-green-600">Active</Badge>;
    case "failed":
      return <Badge variant="outline" className="text-red-600 border-red-600">Failed</Badge>;
    case "paused":
      return <Badge variant="outline" className="text-yellow-600 border-yellow-600">Paused</Badge>;
    case "disabled":
      return <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function StateSourceProfileEditor({
  source,
  onSave,
  saving,
}: {
  source: StateSource;
  onSave: (updates: any) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(source.name);
  const [agency, setAgency] = useState(source.agency);
  const [baseUrl, setBaseUrl] = useState(source.baseUrl);
  const [description, setDescription] = useState(source.description || "");
  const [docCategories, setDocCategories] = useState((source.docCategories || []).join(", "));
  const [targetPaths, setTargetPaths] = useState((source.targetPaths || []).join("\n"));
  const [linkPatterns, setLinkPatterns] = useState((source.linkPatterns || []).join("\n"));
  const [excludePatterns, setExcludePatterns] = useState((source.excludePatterns || []).join("\n"));
  const [updateCadence, setUpdateCadence] = useState(source.updateCadence || "quarterly");
  const [maxPages, setMaxPages] = useState(source.maxPages?.toString() || "");
  const [notes, setNotes] = useState(source.notes || "");
  const [status, setStatus] = useState(source.status);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit {source.name}</DialogTitle>
      </DialogHeader>
      <ScrollArea className="max-h-[60vh]">
        <div className="space-y-4 py-2 pr-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-source-name" />
            </div>
            <div className="space-y-2">
              <Label>Agency</Label>
              <Input value={agency} onChange={(e) => setAgency(e.target.value)} data-testid="input-source-agency" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Base URL</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} data-testid="input-source-url" />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} data-testid="input-source-description" />
          </div>
          <div className="space-y-2">
            <Label>Doc Categories (comma-separated)</Label>
            <Input value={docCategories} onChange={(e) => setDocCategories(e.target.value)} placeholder="rsas, regulations, guidance" data-testid="input-source-categories" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger data-testid="select-source-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Update Cadence</Label>
              <Select value={updateCadence} onValueChange={setUpdateCadence}>
                <SelectTrigger data-testid="select-source-cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UPDATE_CADENCES.map((c) => (
                    <SelectItem key={c} value={c}>{c.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Max Pages</Label>
            <Input type="number" value={maxPages} onChange={(e) => setMaxPages(e.target.value)} placeholder="No limit" data-testid="input-source-maxpages" />
          </div>
          <div className="space-y-2">
            <Label>Target Paths (one per line)</Label>
            <Textarea value={targetPaths} onChange={(e) => setTargetPaths(e.target.value)} rows={3} data-testid="input-source-target-paths" />
          </div>
          <div className="space-y-2">
            <Label>Link Patterns (one per line)</Label>
            <Textarea value={linkPatterns} onChange={(e) => setLinkPatterns(e.target.value)} rows={2} data-testid="input-source-link-patterns" />
          </div>
          <div className="space-y-2">
            <Label>Exclude Patterns (one per line)</Label>
            <Textarea value={excludePatterns} onChange={(e) => setExcludePatterns(e.target.value)} rows={2} data-testid="input-source-exclude-patterns" />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} data-testid="input-source-notes" />
          </div>
        </div>
      </ScrollArea>
      <DialogFooter>
        <Button
          onClick={() => onSave({
            name, agency, baseUrl, description: description || null,
            docCategories: docCategories.split(",").map(s => s.trim()).filter(Boolean),
            targetPaths: targetPaths.trim() ? targetPaths.trim().split("\n").filter(Boolean) : [],
            linkPatterns: linkPatterns.trim() ? linkPatterns.trim().split("\n").filter(Boolean) : [],
            excludePatterns: excludePatterns.trim() ? excludePatterns.trim().split("\n").filter(Boolean) : [],
            updateCadence, status,
            maxPages: maxPages ? parseInt(maxPages) : null,
            notes: notes || null,
          })}
          disabled={saving}
          data-testid="button-save-source"
        >
          {saving && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
          Save Changes
        </Button>
      </DialogFooter>
    </>
  );
}

function StateSourceDetail({
  source,
  onBack,
}: {
  source: StateSource;
  onBack: () => void;
}) {
  const [tab, setTab] = useState("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [docPage, setDocPage] = useState(0);
  const [runPage, setRunPage] = useState(0);
  const { toast } = useToast();
  const limit = 50;

  const { data: detailData } = useQuery<{ source: StateSource; documentStats: any; recentRuns: any[] }>({
    queryKey: ["/api/crawler-intel/state-sources", source.slug],
    queryFn: async () => {
      const res = await fetch(`/api/crawler-intel/state-sources/${source.slug}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: docsData } = useQuery<{ documents: any[]; total: number }>({
    queryKey: ["/api/crawler-intel/state-sources", source.slug, "documents", docPage],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(docPage * limit) });
      const res = await fetch(`/api/crawler-intel/state-sources/${source.slug}/documents?${params}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: tab === "documents",
  });

  const { data: runsData } = useQuery<{ runs: any[]; total: number }>({
    queryKey: ["/api/crawler-intel/state-sources", source.slug, "runs", runPage],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(runPage * limit) });
      const res = await fetch(`/api/crawler-intel/state-sources/${source.slug}/runs?${params}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: tab === "runs",
  });

  const triggerCrawl = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/crawler-intel/state-sources/${source.slug}/crawl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Crawl Started", description: data.message || "Crawl triggered" });
      queryClient.invalidateQueries({ queryKey: ["/api/crawler-intel/state-sources"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateSource = useMutation({
    mutationFn: async (updates: any) => {
      const res = await fetch(`/api/crawler-intel/state-sources/${source.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Updated", description: "Source profile saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/crawler-intel/state-sources"] });
      setEditOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const src = detailData?.source || source;
  const stats = detailData?.documentStats;
  const totalDocPages = Math.ceil((docsData?.total || 0) / limit);
  const totalRunPages = Math.ceil((runsData?.total || 0) / limit);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-sources">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Globe className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-xl font-bold">{src.name}</h2>
          {getSourceStatusBadge(src.status)}
          {src.agencyAbbrev && <Badge variant="secondary">{src.agencyAbbrev}</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <a href={src.baseUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground flex items-center gap-1">
            {src.baseUrl} <ExternalLink className="w-3 h-3" />
          </a>
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-edit-source">
                <Settings className="w-3 h-3 mr-1" />Edit
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <StateSourceProfileEditor source={src} onSave={(updates) => updateSource.mutate(updates)} saving={updateSource.isPending} />
            </DialogContent>
          </Dialog>
          <Button
            size="sm"
            onClick={() => triggerCrawl.mutate()}
            disabled={triggerCrawl.isPending}
            data-testid="button-trigger-source-crawl"
          >
            <Play className="w-3 h-3 mr-1" />
            {triggerCrawl.isPending ? "Starting..." : "Trigger Crawl"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">Total Docs</div>
            <div className="text-lg font-bold" data-testid="text-source-total-docs">{formatNumber(src.totalDocuments)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">Uploaded</div>
            <div className="text-lg font-bold text-green-600" data-testid="text-source-uploaded">{formatNumber(src.totalUploaded)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">Cadence</div>
            <div className="text-sm font-medium">{(src.updateCadence || "").replace(/_/g, " ")}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-sm text-muted-foreground">Last Crawl</div>
            <div className="text-sm font-medium">{formatDateShort(src.lastCrawlDate)}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-source-overview">
            <Globe className="w-3 h-3 mr-1" />Overview
          </TabsTrigger>
          <TabsTrigger value="documents" data-testid="tab-source-documents">
            <FileText className="w-3 h-3 mr-1" />Documents
          </TabsTrigger>
          <TabsTrigger value="runs" data-testid="tab-source-runs">
            <Activity className="w-3 h-3 mr-1" />Run History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          {src.description && (
            <Card>
              <CardContent className="p-4">
                <div className="text-sm text-muted-foreground mb-1">Description</div>
                <p className="text-sm">{src.description}</p>
              </CardContent>
            </Card>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Card>
              <CardContent className="p-4">
                <div className="text-sm text-muted-foreground mb-2">Doc Categories</div>
                <div className="flex flex-wrap gap-1">
                  {(src.docCategories || []).map((cat) => (
                    <Badge key={cat} variant="secondary">
                      {(STATE_DOC_CATEGORY_LABELS as Record<string, string>)[cat] || cat}
                    </Badge>
                  ))}
                  {(!src.docCategories || src.docCategories.length === 0) && <span className="text-xs text-muted-foreground">None configured</span>}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-sm text-muted-foreground mb-2">Target Paths</div>
                <div className="space-y-0.5 max-h-32 overflow-y-auto">
                  {(src.targetPaths || []).map((p, i) => (
                    <div key={i} className="text-xs font-mono text-muted-foreground">{p}</div>
                  ))}
                  {(!src.targetPaths || src.targetPaths.length === 0) && <span className="text-xs text-muted-foreground">None</span>}
                </div>
              </CardContent>
            </Card>
          </div>
          {stats?.byCategory && Object.keys(stats.byCategory).length > 0 && (
            <Card>
              <CardContent className="p-4">
                <div className="text-sm text-muted-foreground mb-2">Document Stats by Category</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {Object.entries(stats.byCategory as Record<string, number>).map(([cat, count]) => (
                    <div key={cat} className="flex items-center justify-between gap-2">
                      <span className="text-xs truncate">{(STATE_DOC_CATEGORY_LABELS as Record<string, string>)[cat] || cat}</span>
                      <span className="text-xs font-bold">{count as number}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="documents" className="space-y-3">
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Discovered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(docsData?.documents || []).map((doc: any) => (
                  <TableRow key={doc.id} data-testid={`row-state-doc-${doc.id}`}>
                    <TableCell>
                      <div className="max-w-[300px] truncate text-sm" title={doc.url}>{doc.filename}</div>
                    </TableCell>
                    <TableCell>
                      {doc.category ? (
                        <Badge variant="secondary">
                          {(STATE_DOC_CATEGORY_LABELS as Record<string, string>)[doc.category] || doc.category}
                        </Badge>
                      ) : "-"}
                    </TableCell>
                    <TableCell>{getDocStatusBadge(doc.status)}</TableCell>
                    <TableCell className="text-xs">{formatDateShort(doc.discoveredAt)}</TableCell>
                  </TableRow>
                ))}
                {(docsData?.documents || []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">No documents found</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
          <Pagination page={docPage} totalPages={totalDocPages} onPageChange={setDocPage} total={docsData?.total || 0} />
        </TabsContent>

        <TabsContent value="runs" className="space-y-3">
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Pages</TableHead>
                  <TableHead>Discovered</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runsData?.runs || detailData?.recentRuns || []).map((run: any) => {
                  const duration = run.completedAt
                    ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
                    : null;
                  return (
                    <TableRow key={run.id} data-testid={`row-state-run-${run.id}`}>
                      <TableCell className="text-xs">{formatDateShort(run.startedAt)}</TableCell>
                      <TableCell><Badge variant="secondary">{run.mode}</Badge></TableCell>
                      <TableCell>{getRunStatusBadge(run.status)}</TableCell>
                      <TableCell>{run.pagesVisited}</TableCell>
                      <TableCell>{run.documentsDiscovered}</TableCell>
                      <TableCell className="text-green-600 font-medium">{run.documentsUploaded}</TableCell>
                      <TableCell className={run.documentsFailed > 0 ? "text-red-600" : ""}>{run.documentsFailed}</TableCell>
                      <TableCell className="text-xs">
                        {duration != null ? `${Math.floor(duration / 60)}m ${duration % 60}s` : "-"}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(runsData?.runs || detailData?.recentRuns || []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">No runs yet</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
          <Pagination page={runPage} totalPages={totalRunPages} onPageChange={setRunPage} total={runsData?.total || 0} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StateSourcesDashboard({
  onSelectSource,
}: {
  onSelectSource: (source: StateSource) => void;
}) {
  const { data, isLoading } = useQuery<{ sources: StateSource[] }>({
    queryKey: ["/api/crawler-intel/state-sources"],
    queryFn: async () => {
      const res = await fetch("/api/crawler-intel/state-sources");
      if (!res.ok) throw new Error("Failed to fetch state sources");
      return res.json();
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const sources = data?.sources || [];

  return (
    <ScrollArea className="w-full">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>Agency</TableHead>
            <TableHead>Categories</TableHead>
            <TableHead>Cadence</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Documents</TableHead>
            <TableHead>Last Crawl</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sources.map((src) => (
            <TableRow
              key={src.id}
              className="hover-elevate cursor-pointer"
              onClick={() => onSelectSource(src)}
              data-testid={`row-state-source-${src.slug}`}
            >
              <TableCell>
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <div className="font-medium">{src.name}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">{src.baseUrl}</div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-sm">{src.agencyAbbrev || src.agency}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {(src.docCategories || []).slice(0, 3).map((cat) => (
                    <Badge key={cat} variant="secondary" className="text-xs">
                      {(STATE_DOC_CATEGORY_LABELS as Record<string, string>)[cat] || cat}
                    </Badge>
                  ))}
                  {(src.docCategories || []).length > 3 && (
                    <span className="text-xs text-muted-foreground">+{src.docCategories.length - 3}</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-sm">{(src.updateCadence || "").replace(/_/g, " ")}</TableCell>
              <TableCell>{getSourceStatusBadge(src.status)}</TableCell>
              <TableCell>
                <span className="text-green-600 font-medium">{src.totalUploaded}</span>
                <span className="text-muted-foreground"> / {src.totalDocuments}</span>
              </TableCell>
              <TableCell className="text-xs">{formatDateShort(src.lastCrawlDate)}</TableCell>
            </TableRow>
          ))}
          {sources.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">No state sources configured</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

function CrawlAnalyticsDashboard() {
  const { data: towns, isLoading: townsLoading } = useQuery<TownOverview[]>({
    queryKey: ["/api/admin/crawler/towns"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/crawler/towns");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: runsData, isLoading: runsLoading } = useQuery<{ runs: CrawlerRun[]; total: number }>({
    queryKey: ["/api/admin/crawler/runs", null, 0],
    queryFn: async () => {
      const res = await adminFetch(`/api/admin/crawler/runs?limit=100&offset=0`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  if (townsLoading || runsLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const allTowns = towns || [];
  const allRuns = runsData?.runs || [];
  const completedRuns = allRuns.filter(r => r.status === 'completed' || r.status === 'completed_with_errors');

  const totalDocs = allTowns.reduce((sum, t) => {
    const total = Object.values(t.documentsByStatus).reduce((a, b) => a + b, 0);
    return sum + total;
  }, 0);
  const totalUploaded = allTowns.reduce((sum, t) => sum + (t.documentsByStatus["uploaded"] || 0), 0);
  const totalFailed = allTowns.reduce((sum, t) => sum + (t.documentsByStatus["failed"] || 0), 0);

  const townsByDocs = [...allTowns].sort((a, b) => {
    const aTotal = Object.values(a.documentsByStatus).reduce((s, v) => s + v, 0);
    const bTotal = Object.values(b.documentsByStatus).reduce((s, v) => s + v, 0);
    return bTotal - aTotal;
  });

  const cmsCounts: Record<string, number> = {};
  allTowns.forEach(t => {
    const cms = t.cms || "Unknown";
    cmsCounts[cms] = (cmsCounts[cms] || 0) + 1;
  });

  const strategyTotals = { sitemap: 0, knownPaths: 0, breadthFirst: 0, external: 0, iframe: 0 };
  completedRuns.forEach(r => {
    const s = (r.summary as any)?.strategyStats;
    if (s) {
      strategyTotals.sitemap += s.sitemap || 0;
      strategyTotals.knownPaths += s.knownPaths || 0;
      strategyTotals.breadthFirst += s.breadthFirst || 0;
      strategyTotals.external += s.external || 0;
      strategyTotals.iframe += s.iframe || 0;
    }
  });
  const totalByStrategy = Object.values(strategyTotals).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Document Coverage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold" data-testid="text-total-docs">{formatNumber(totalDocs)}</div>
            <div className="text-sm text-muted-foreground mt-1">
              {formatNumber(totalUploaded)} uploaded, {formatNumber(totalFailed)} failed
            </div>
            <Progress value={totalDocs > 0 ? (totalUploaded / totalDocs) * 100 : 0} className="mt-2" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">CMS Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {Object.entries(cmsCounts).sort((a, b) => b[1] - a[1]).map(([cms, count]) => (
                <div key={cms} className="flex items-center justify-between gap-2">
                  <span className="text-sm">{cms}</span>
                  <Badge variant="secondary">{count}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Discovery Strategy</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {Object.entries(strategyTotals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([strategy, count]) => (
                <div key={strategy} className="flex items-center justify-between gap-2">
                  <span className="text-sm capitalize">{strategy.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{formatNumber(count)}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {totalByStrategy > 0 ? `${Math.round((count / totalByStrategy) * 100)}%` : '0%'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Per-Town Coverage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {townsByDocs.map(town => {
              const total = Object.values(town.documentsByStatus).reduce((s, v) => s + v, 0);
              const uploaded = town.documentsByStatus["uploaded"] || 0;
              const failed = town.documentsByStatus["failed"] || 0;
              const maxDocs = Object.values(townsByDocs[0]?.documentsByStatus || {}).reduce((s, v) => s + v, 0);
              const uploadRate = total > 0 ? Math.round((uploaded / total) * 100) : 0;
              const lastRunInfo = completedRuns.find(r => r.townId === town.id);
              const protectionStats = (lastRunInfo?.summary as any)?.protectionStats;
              const isBlocked = total === 0 || (protectionStats?.blockedPages > 50 && uploaded < 10);
              const hasProtection = protectionStats?.detected;
              return (
                <div key={town.id} className="flex items-center gap-2 flex-wrap" data-testid={`analytics-town-${town.slug}`}>
                  <span className="text-sm w-28 truncate font-medium">{town.name}</span>
                  <div className="flex-1 min-w-[100px] relative">
                    <div className="h-5 bg-muted rounded-md overflow-hidden">
                      <div 
                        className={`h-full rounded-md ${isBlocked ? 'bg-red-500/50' : uploadRate > 90 ? 'bg-green-500/70' : uploadRate > 50 ? 'bg-yellow-500/70' : 'bg-orange-500/70'}`}
                        style={{ width: `${maxDocs > 0 ? (uploaded / maxDocs) * 100 : 0}%` }} 
                      />
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground w-24 text-right">
                    {formatNumber(uploaded)}/{formatNumber(total)} ({uploadRate}%)
                  </span>
                  <Badge variant="secondary" className="text-xs">
                    {town.cms || "?"}
                  </Badge>
                  {hasProtection && protectionStats.types?.length > 0 && (
                    <Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30" data-testid={`badge-protection-${town.slug}`}>
                      {protectionStats.types.join(', ')}
                    </Badge>
                  )}
                  {isBlocked && (
                    <Badge variant="outline" className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30" data-testid={`badge-blocked-${town.slug}`}>
                      blocked
                    </Badge>
                  )}
                  {town.consecutiveFailures > 0 && (
                    <Badge variant="outline" className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30" data-testid={`badge-failures-${town.slug}`}>
                      {town.consecutiveFailures} failures
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminCrawler() {
  const [, setLocation] = useLocation();
  const [selectedTown, setSelectedTown] = useState<TownOverview | null>(null);
  const [selectedSource, setSelectedSource] = useState<StateSource | null>(null);
  const [activeTab, setActiveTab] = useState("towns");
  const { toast } = useToast();

  const { data: stats, isLoading: statsLoading } = useQuery<CrawlerStats>({
    queryKey: ["/api/admin/crawler/stats"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/crawler/stats");
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
    refetchInterval: 30000,
  });

  const resetOrphaned = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/crawler/reset-orphaned", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Done", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const triggerAllCrawls = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/crawler/trigger-all", {
        method: "POST",
        body: JSON.stringify({ mode: "full" }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Batch Crawl", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-3">
              <Link href="/admin/documents" data-testid="link-back-admin">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="w-4 h-4 mr-1" />Admin
                </Button>
              </Link>
              <h1 className="text-xl font-bold">Crawler Management</h1>
            </div>
            <div className="flex items-center gap-2">
              {(stats?.activeRuns || 0) > 0 && (
                <Badge variant="outline" className="text-blue-600 border-blue-600">
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  {stats?.activeRuns} active
                </Badge>
              )}
              <Button
                variant="default"
                size="sm"
                onClick={() => triggerAllCrawls.mutate()}
                disabled={triggerAllCrawls.isPending || (stats?.activeRuns || 0) > 3}
                data-testid="button-crawl-all-towns"
              >
                {triggerAllCrawls.isPending ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <Play className="w-3 h-3 mr-1" />
                )}
                Crawl All Towns
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => resetOrphaned.mutate()}
                disabled={resetOrphaned.isPending}
                data-testid="button-reset-orphaned"
              >
                <RotateCcw className="w-3 h-3 mr-1" />
                Reset Orphaned
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  queryClient.invalidateQueries({ queryKey: ["/api/admin/crawler"] });
                }}
                data-testid="button-refresh"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6 space-y-6">
        <StatsOverview stats={stats} />

        {selectedTown ? (
          <TownDetail town={selectedTown} onBack={() => setSelectedTown(null)} />
        ) : selectedSource ? (
          <StateSourceDetail source={selectedSource} onBack={() => setSelectedSource(null)} />
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="towns" data-testid="tab-towns">
                <MapPin className="w-3 h-3 mr-1" />Towns
              </TabsTrigger>
              <TabsTrigger value="runs" data-testid="tab-all-runs">
                <Activity className="w-3 h-3 mr-1" />All Runs
              </TabsTrigger>
              <TabsTrigger value="analytics" data-testid="tab-analytics">
                <BarChart3 className="w-3 h-3 mr-1" />Analytics
              </TabsTrigger>
              <TabsTrigger value="state-sources" data-testid="tab-state-sources">
                <Globe className="w-3 h-3 mr-1" />State Sources
              </TabsTrigger>
            </TabsList>

            <TabsContent value="towns">
              <TownsDashboard onSelectTown={setSelectedTown} />
            </TabsContent>

            <TabsContent value="runs">
              <RunHistoryGlobal />
            </TabsContent>

            <TabsContent value="analytics">
              <CrawlAnalyticsDashboard />
            </TabsContent>

            <TabsContent value="state-sources">
              <StateSourcesDashboard onSelectSource={setSelectedSource} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
