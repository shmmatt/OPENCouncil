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
} from "lucide-react";

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
                      <Badge variant="outline" className="text-blue-600 border-blue-600">
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />Running
                      </Badge>
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
            disabled={triggerCrawl.isPending || !!town.activeRunId}
            data-testid="button-trigger-crawl"
          >
            <Play className="w-3 h-3 mr-1" />
            {town.activeRunId ? "Running..." : "Run Crawl"}
          </Button>
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
                          </TableCell>
                          <TableCell className="text-xs">
                            {duration != null ? `${Math.floor(duration / 60)}m ${duration % 60}s` : "-"}
                          </TableCell>
                          <TableCell className="max-w-[150px] truncate text-xs text-red-600" title={run.errorMessage || ""}>
                            {run.errorMessage || "-"}
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
      </Tabs>
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
          <Input
            type="number"
            value={maxPages}
            onChange={(e) => setMaxPages(e.target.value)}
            placeholder="Default (no limit)"
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

function RunHistoryGlobal() {
  const [page, setPage] = useState(0);
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
                <TableRow key={run.id} data-testid={`row-run-${run.id}`}>
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
              );
            })}
          </TableBody>
        </Table>
      </ScrollArea>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} total={data?.total || 0} />
    </div>
  );
}

export default function AdminCrawler() {
  const [, setLocation] = useLocation();
  const [selectedTown, setSelectedTown] = useState<TownOverview | null>(null);
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

  const resetStuck = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/crawler/reset-stuck", { method: "POST" });
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
                variant="outline"
                size="sm"
                onClick={() => resetStuck.mutate()}
                disabled={resetStuck.isPending}
                data-testid="button-reset-stuck"
              >
                <RotateCcw className="w-3 h-3 mr-1" />
                Reset Stuck
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
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="towns" data-testid="tab-towns">
                <MapPin className="w-3 h-3 mr-1" />Towns
              </TabsTrigger>
              <TabsTrigger value="runs" data-testid="tab-all-runs">
                <Activity className="w-3 h-3 mr-1" />All Runs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="towns">
              <TownsDashboard onSelectTown={setSelectedTown} />
            </TabsContent>

            <TabsContent value="runs">
              <RunHistoryGlobal />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
