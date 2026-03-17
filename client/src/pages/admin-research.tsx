import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  FlaskConical,
  LogOut,
  FileText,
  GitBranch,
  FolderUp,
  ScanLine,
  Globe,
  Loader2,
  Trash2,
  Eye,
  ChevronDown,
  ChevronUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Lightbulb,
  Timer,
  Users,
  BarChart3,
  Info,
  Download,
  FileSpreadsheet,
  Database,
  Brain,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import type { ResearchReport, FrictionReportData, SitePlanApplication, FunnelStage, FrictionCategory, TimeToDecisionData, OrdinanceHitListData, TemporalTrendsData, YoYDeltas, RepresentationGapData, ProjectTypeComparisonData, ProjectTypeGroupStats, AttritionCurveEntry, DaysAddedEntry, ApplicationModifiers, DynamicReportPayload, ResearchBoardType } from "@shared/schema";

interface DynamicReportListItem {
  id: string;
  townName: string;
  status: string;
  boardType: string | null;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  prompt: string | null;
  documentCount: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
import { RESEARCH_BOARD_TYPES } from "@shared/schema";
import { exportFrictionReportPDF, exportFrictionReportCSV } from "@/lib/exportFrictionReport";
import DynamicReportRenderer from "@/components/research/DynamicReportRenderer";

interface TownOption {
  name: string;
  docCount: number;
  analyzableCount: number;
  failedOcrCount: number;
  dateRange: string | null;
}

const BOARD_LABELS: Record<ResearchBoardType, string> = {
  planning: "Planning Board",
  zoning: "Zoning Board",
  selectboard: "Select Board",
  budget: "Budget Committee",
};

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function AdminResearch() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedTown, setSelectedTown] = useState("");
  const [viewingReport, setViewingReport] = useState<ResearchReport | null>(null);
  const [expandedApps, setExpandedApps] = useState<Set<number>>(new Set());

  const [selectedBoard, setSelectedBoard] = useState<ResearchBoardType>("planning");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [dynamicPrompt, setDynamicPrompt] = useState("");
  const [dynamicReport, setDynamicReport] = useState<DynamicReportPayload | null>(null);
  const [dynamicTown, setDynamicTown] = useState("");

  const { data: townsData, isLoading: townsLoading } = useQuery<{ towns: TownOption[] }>({
    queryKey: ["/api/admin/research/towns"],
    queryFn: async () => {
      const token = localStorage.getItem("adminToken");
      const res = await fetch("/api/admin/research/towns", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        localStorage.removeItem("adminToken");
        setLocation("/admin/login");
        throw new Error("Unauthorized");
      }
      return res.json();
    },
  });

  const corpusQuery = useQuery<{ totalDocuments: number; embeddedCount: number; pendingCount: number; ready: boolean; pipelineRunning: boolean }>({
    queryKey: ["/api/admin/research/prepare-corpus", dynamicTown, selectedBoard],
    queryFn: async () => {
      const token = localStorage.getItem("adminToken");
      const res = await fetch("/api/admin/research/prepare-corpus", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ townName: dynamicTown, boardType: selectedBoard }),
      });
      if (!res.ok) throw new Error("Failed to check corpus");
      return res.json();
    },
    enabled: !!dynamicTown && !!selectedBoard,
    refetchInterval: 10000,
  });

  const prepareCorpusMutation = useMutation({
    mutationFn: async () => {
      const token = localStorage.getItem("adminToken");
      const res = await fetch("/api/admin/research/prepare-corpus", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ townName: dynamicTown, boardType: selectedBoard, trigger: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      const msg = data.triggerStatus === "started"
        ? `Embedding pipeline started for ${dynamicTown}`
        : data.triggerStatus === "already_running"
        ? "Embedding pipeline is already running"
        : "Corpus status updated";
      toast({ title: "Corpus Preparation", description: msg });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/research/prepare-corpus"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const corpusReady = corpusQuery.data?.ready === true;

  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const jobStatusQuery = useQuery<{ status: string; message: string; progress: number; result?: DynamicReportPayload; error?: string }>({
    queryKey: ["/api/admin/research/job-status", activeJobId],
    queryFn: async () => {
      const token = localStorage.getItem("adminToken");
      const res = await fetch(`/api/admin/research/job-status/${activeJobId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Job not found");
      return res.json();
    },
    enabled: !!activeJobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "completed" || status === "error") return false;
      return 3000;
    },
  });

  const jobStatus = jobStatusQuery.data?.status;
  const jobMessage = jobStatusQuery.data?.message ?? "";
  const jobProgress = jobStatusQuery.data?.progress ?? 0;

  // Handle job completion / error in an effect so state updates don't happen during render
  useEffect(() => {
    if (jobStatus === "completed" && jobStatusQuery.data?.result && activeJobId) {
      setDynamicReport(jobStatusQuery.data.result);
      setActiveJobId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/research/dynamic-reports"] });
      toast({ title: "Report generated", description: "Your dynamic intelligence report is ready." });
    }
    if (jobStatus === "error" && activeJobId) {
      setActiveJobId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/research/dynamic-reports"] });
      toast({ title: "Generation failed", description: jobStatusQuery.data?.error ?? "Unknown error", variant: "destructive" });
    }
  }, [jobStatus, activeJobId]);

  const isJobRunning = !!activeJobId && jobStatus !== "completed" && jobStatus !== "error";

  const dynamicGenerateMutation = useMutation({
    mutationFn: async () => {
      const token = localStorage.getItem("adminToken");
      const res = await fetch("/api/admin/research/dynamic-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          townName: dynamicTown,
          boardType: selectedBoard,
          dateRange: (dateStart || dateEnd) ? { start: dateStart || undefined, end: dateEnd || undefined } : undefined,
          prompt: dynamicPrompt,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed" }));
        throw new Error(err.message || "Dynamic report generation failed");
      }
      return res.json() as Promise<{ jobId: string }>;
    },
    onSuccess: (data) => {
      setDynamicReport(null);
      setActiveJobId(data.jobId);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/research/dynamic-reports"] });
    },
    onError: (err) => {
      toast({ title: "Generation failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    },
  });

  const [showHistory, setShowHistory] = useState(true);

  const { data: dynamicReportsData } = useQuery<{ reports: DynamicReportListItem[] }>({
    queryKey: ["/api/admin/research/dynamic-reports", dynamicTown],
    queryFn: async () => {
      const token = localStorage.getItem("adminToken");
      const url = dynamicTown
        ? `/api/admin/research/dynamic-reports?townName=${encodeURIComponent(dynamicTown)}`
        : `/api/admin/research/dynamic-reports`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json();
    },
    refetchInterval: 15000,
  });

  const deleteDynamicReportMutation = useMutation({
    mutationFn: async (id: string) => {
      const token = localStorage.getItem("adminToken");
      await fetch(`/api/admin/research/dynamic-report/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/research/dynamic-reports"] });
      toast({ title: "Report deleted" });
    },
  });

  const loadSavedReport = async (id: string) => {
    const token = localStorage.getItem("adminToken");
    const res = await fetch(`/api/admin/research/dynamic-report/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      toast({ title: "Error", description: "Failed to load report", variant: "destructive" });
      return;
    }
    const report = await res.json();
    if (report.reportData) {
      setDynamicReport(report.reportData as DynamicReportPayload);
    } else {
      toast({ title: "No data", description: "This report has no saved data to display", variant: "destructive" });
    }
  };

  const { data: reportsData, isLoading: reportsLoading } = useQuery<{ reports: ResearchReport[] }>({
    queryKey: ["/api/admin/research/friction-reports"],
    queryFn: async () => {
      const token = localStorage.getItem("adminToken");
      const res = await fetch("/api/admin/research/friction-reports", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json();
    },
    refetchInterval: 5000,
  });

  const generateMutation = useMutation({
    mutationFn: async (townName: string) => {
      const token = localStorage.getItem("adminToken");
      const res = await fetch("/api/admin/research/friction-report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ townName }),
      });
      if (!res.ok) throw new Error("Failed to generate report");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/research/friction-reports"] });
      toast({ title: "Report generation started", description: "The friction report is being generated. This may take a few minutes." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to start report generation", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const token = localStorage.getItem("adminToken");
      await fetch(`/api/admin/research/friction-report/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/research/friction-reports"] });
      if (viewingReport) setViewingReport(null);
      toast({ title: "Report deleted" });
    },
  });

  const reanalyzeMutation = useMutation({
    mutationFn: async (id: string) => {
      const token = localStorage.getItem("adminToken");
      const res = await fetch(`/api/admin/research/friction-report/${id}/reanalyze`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to start re-analysis");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/research/friction-reports"] });
      setViewingReport(null);
      toast({ title: "Re-analysis started", description: "The report is being re-analyzed with improved deduplication and analytics." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to start re-analysis", variant: "destructive" });
    },
  });

  const viewReport = async (id: string) => {
    const token = localStorage.getItem("adminToken");
    const res = await fetch(`/api/admin/research/friction-report/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const report = await res.json();
    setViewingReport(report);
    setExpandedApps(new Set());
  };

  const handleLogout = () => {
    localStorage.removeItem("adminToken");
    setLocation("/admin/login");
  };

  const toggleAppExpand = (idx: number) => {
    setExpandedApps((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const towns = townsData?.towns || [];
  const reports = reportsData?.reports || [];

  const reportData = viewingReport?.reportData as FrictionReportData | null | undefined;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10">
              <FlaskConical className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold" data-testid="text-page-title">OPENCouncil Admin</h1>
              <p className="text-sm text-muted-foreground">OC Research</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" asChild data-testid="link-documents">
              <Link href="/admin/documents">
                <FileText className="w-4 h-4 mr-2" />
                Documents
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-ingestion">
              <Link href="/admin/ingestion">
                <GitBranch className="w-4 h-4 mr-2" />
                v2 Pipeline
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-bulk-upload">
              <Link href="/admin/bulk-upload">
                <FolderUp className="w-4 h-4 mr-2" />
                Bulk Upload
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-usage">
              <Link href="/admin/usage">
                <BarChart3 className="w-4 h-4 mr-2" />
                Analytics
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-ocr-pipeline">
              <Link href="/admin/ocr-pipeline">
                <ScanLine className="w-4 h-4 mr-2" />
                Textract Pipeline
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-chat-analytics">
              <Link href="/admin/chat-analytics">
                Chat Reviews
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-crawler">
              <Link href="/admin/crawler">
                <Globe className="w-4 h-4 mr-2" />
                Crawler
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-templates">
              <Link href="/admin/templates">
                <FileText className="w-4 h-4 mr-2" />
                Templates
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-content">
              <Link href="/admin/content">
                <FlaskConical className="w-4 h-4 mr-2" />
                Content
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout} data-testid="button-logout">
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        <Tabs defaultValue="intelligence" className="space-y-6">
          <TabsList className="grid w-full grid-cols-2 max-w-md">
            <TabsTrigger value="intelligence" data-testid="tab-intelligence">
              <Brain className="w-4 h-4 mr-2" />
              Intelligence Engine
            </TabsTrigger>
            <TabsTrigger value="friction" data-testid="tab-friction">
              <FlaskConical className="w-4 h-4 mr-2" />
              Friction Report
            </TabsTrigger>
          </TabsList>

          <TabsContent value="intelligence" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle data-testid="text-intelligence-title">Municipal Intelligence Engine</CardTitle>
                <CardDescription>
                  Query 10-year longitudinal data across Planning Board, Zoning Board, Select Board, and Budget Committee.
                  Ask any question and receive a dynamic dashboard with charts, stats, and narrative analysis.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="text-sm font-medium mb-2 block text-foreground">Town</label>
                    <Select value={dynamicTown} onValueChange={(v) => { setDynamicTown(v); setDynamicReport(null); }}>
                      <SelectTrigger data-testid="select-dynamic-town">
                        <SelectValue placeholder={townsLoading ? "Loading..." : "Select town"} />
                      </SelectTrigger>
                      <SelectContent>
                        {towns.map((t) => (
                          <SelectItem key={t.name} value={t.name} data-testid={`option-dyn-town-${t.name}`}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-2 block text-foreground">Board</label>
                    <Select value={selectedBoard} onValueChange={(v) => { setSelectedBoard(v as ResearchBoardType); setDynamicReport(null); }}>
                      <SelectTrigger data-testid="select-board">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RESEARCH_BOARD_TYPES.map((bt) => (
                          <SelectItem key={bt} value={bt} data-testid={`option-board-${bt}`}>
                            {BOARD_LABELS[bt]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-2 block text-foreground">Date Start</label>
                    <Input
                      type="date"
                      value={dateStart}
                      onChange={(e) => setDateStart(e.target.value)}
                      data-testid="input-date-start"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-2 block text-foreground">Date End</label>
                    <Input
                      type="date"
                      value={dateEnd}
                      onChange={(e) => setDateEnd(e.target.value)}
                      data-testid="input-date-end"
                    />
                  </div>
                </div>

                {dynamicTown && corpusQuery.data && (
                  <div className="p-3 bg-muted rounded-md space-y-2" data-testid="corpus-status">
                    <div className="flex items-center gap-4 flex-wrap">
                      <Database className="w-5 h-5 text-muted-foreground shrink-0" />
                      <div className="text-sm flex-1">
                        <span className="font-medium text-foreground">{corpusQuery.data.embeddedCount}</span>
                        <span className="text-muted-foreground"> / {corpusQuery.data.totalDocuments} documents embedded</span>
                        {corpusQuery.data.pendingCount > 0 && (
                          <span className="text-amber-600 dark:text-amber-400 ml-2">
                            ({corpusQuery.data.pendingCount} pending)
                          </span>
                        )}
                        {corpusQuery.data.pipelineRunning && (
                          <span className="text-blue-600 dark:text-blue-400 ml-2 inline-flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" /> Pipeline running...
                          </span>
                        )}
                      </div>
                      {corpusQuery.data.pendingCount > 0 && !corpusQuery.data.pipelineRunning && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => prepareCorpusMutation.mutate()}
                          disabled={prepareCorpusMutation.isPending}
                          data-testid="button-prepare-corpus"
                        >
                          {prepareCorpusMutation.isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Database className="w-4 h-4 mr-2" />
                          )}
                          Prepare Corpus
                        </Button>
                      )}
                    </div>
                    {corpusQuery.data.totalDocuments === 0 && (
                      <Badge variant="outline">No documents found for this board</Badge>
                    )}
                    {corpusReady && (
                      <div className="text-sm text-green-600 dark:text-green-400" data-testid="text-corpus-ready">
                        Corpus ready for analysis
                      </div>
                    )}
                    {!corpusReady && corpusQuery.data.totalDocuments > 0 && (
                      <div className="text-sm text-amber-600 dark:text-amber-400" data-testid="text-corpus-not-ready">
                        Corpus not fully embedded. Prepare corpus before generating a report.
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <label className="text-sm font-medium mb-2 block text-foreground">Analysis Prompt</label>
                  <Textarea
                    placeholder="e.g., What are the most contentious topics discussed by the Select Board over the last 5 years? Show trends by year."
                    value={dynamicPrompt}
                    onChange={(e) => setDynamicPrompt(e.target.value)}
                    className="min-h-[80px]"
                    disabled={!dynamicTown || !corpusReady}
                    data-testid="input-dynamic-prompt"
                  />
                </div>

                <Button
                  onClick={() => dynamicGenerateMutation.mutate()}
                  disabled={
                    !dynamicTown ||
                    !dynamicPrompt.trim() ||
                    dynamicGenerateMutation.isPending ||
                    isJobRunning ||
                    !corpusReady
                  }
                  data-testid="button-generate-dynamic"
                >
                  {(dynamicGenerateMutation.isPending || isJobRunning) ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Brain className="w-4 h-4 mr-2" />
                  )}
                  {dynamicGenerateMutation.isPending ? "Starting..." : isJobRunning ? "Analyzing..." : "Generate Report"}
                </Button>

                {isJobRunning && (
                  <div className="space-y-2" data-testid="text-generation-status">
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                      <span>{jobMessage || "Processing..."}</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-primary h-2 rounded-full transition-all duration-500"
                        style={{ width: `${jobProgress}%` }}
                        data-testid="progress-bar-generate"
                      />
                    </div>
                    <div className="text-xs text-muted-foreground text-right">{jobProgress}%</div>
                  </div>
                )}
              </CardContent>
            </Card>

            {(dynamicReportsData?.reports?.length ?? 0) > 0 && (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
                  <CardTitle className="text-base" data-testid="text-past-reports-title">Past Reports</CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowHistory(!showHistory)}
                    data-testid="button-toggle-history"
                  >
                    {showHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </Button>
                </CardHeader>
                {showHistory && (
                  <CardContent className="pt-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Prompt</TableHead>
                          <TableHead>Board</TableHead>
                          <TableHead>Date Range</TableHead>
                          <TableHead>Docs</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {dynamicReportsData?.reports.map((r) => (
                          <TableRow
                            key={r.id}
                            data-testid={`row-dynamic-report-${r.id}`}
                            className={r.status === "completed" ? "cursor-pointer hover-elevate" : ""}
                            onClick={() => r.status === "completed" && loadSavedReport(r.id)}
                          >
                            <TableCell className="max-w-[250px]">
                              <span className="line-clamp-2 text-sm" title={r.prompt || ""}>
                                {r.prompt ? (r.prompt.length > 80 ? r.prompt.slice(0, 80) + "..." : r.prompt) : "—"}
                              </span>
                            </TableCell>
                            <TableCell>
                              {r.boardType ? BOARD_LABELS[r.boardType as ResearchBoardType] || r.boardType : "—"}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                              {r.dateRangeStart || r.dateRangeEnd
                                ? `${r.dateRangeStart || "..."} to ${r.dateRangeEnd || "..."}`
                                : "All dates"}
                            </TableCell>
                            <TableCell className="text-sm">{r.documentCount ?? "—"}</TableCell>
                            <TableCell>
                              <Badge
                                variant={r.status === "completed" ? "default" : r.status === "error" ? "destructive" : "secondary"}
                                data-testid={`badge-status-${r.id}`}
                              >
                                {r.status}
                              </Badge>
                            </TableCell>
                            <TableCell
                              className="text-sm text-muted-foreground whitespace-nowrap"
                              title={new Date(r.createdAt).toLocaleString()}
                            >
                              {formatRelativeTime(r.createdAt)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                {r.status === "completed" && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={(e) => { e.stopPropagation(); loadSavedReport(r.id); }}
                                    data-testid={`button-view-report-${r.id}`}
                                    title="View report"
                                  >
                                    <Eye className="w-4 h-4" />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => { e.stopPropagation(); deleteDynamicReportMutation.mutate(r.id); }}
                                  data-testid={`button-delete-report-${r.id}`}
                                  title="Delete report"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                )}
              </Card>
            )}

            {dynamicReport && (
              <DynamicReportRenderer payload={dynamicReport} />
            )}
          </TabsContent>

          <TabsContent value="friction" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle data-testid="text-generate-title">Development Friction Report</CardTitle>
            <CardDescription>
              Analyze Planning Board and ZBA meeting minutes to extract site plan approval data,
              identify friction patterns, and generate predictive insights for any town in the system.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label className="text-sm font-medium mb-2 block text-foreground">Select Town</label>
                <Select value={selectedTown} onValueChange={setSelectedTown}>
                  <SelectTrigger data-testid="select-town">
                    <SelectValue placeholder={townsLoading ? "Loading towns..." : "Choose a town to analyze"} />
                  </SelectTrigger>
                  <SelectContent>
                    {towns.map((t) => (
                      <SelectItem key={t.name} value={t.name} data-testid={`option-town-${t.name}`}>
                        {t.name} — {t.analyzableCount} analyzable / {t.docCount} total
                        {t.failedOcrCount > 0 ? ` (${t.failedOcrCount} need OCR)` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() => generateMutation.mutate(selectedTown)}
                disabled={!selectedTown || generateMutation.isPending}
                data-testid="button-generate-report"
              >
                {generateMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <FlaskConical className="w-4 h-4 mr-2" />
                )}
                Generate Report
              </Button>
            </div>
            {selectedTown && (() => {
              const t = towns.find(tw => tw.name === selectedTown);
              if (!t) return null;
              return (
                <div className="mt-3 text-sm text-muted-foreground space-y-1" data-testid="text-town-coverage">
                  <p>
                    <span className="font-medium text-foreground">{t.analyzableCount}</span> of {t.docCount} Planning/ZBA meeting minutes have analyzable text
                    {t.failedOcrCount > 0 && (
                      <span className="text-destructive"> ({t.failedOcrCount} failed OCR)</span>
                    )}
                  </p>
                  {t.dateRange && <p>Date coverage: {t.dateRange}</p>}
                </div>
              );
            })()}
          </CardContent>
        </Card>

        {viewingReport && reportData && (
          <div className="space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-lg font-semibold" data-testid="text-report-title">
                Friction Report: {reportData.townName}
              </h2>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    try {
                      exportFrictionReportPDF(reportData, reportData.townName);
                    } catch (err) {
                      console.error("PDF export error:", err);
                      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Could not generate PDF", variant: "destructive" });
                    }
                  }}
                  data-testid="button-export-pdf"
                >
                  <Download className="w-4 h-4 mr-1" />
                  Export PDF
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    try {
                      exportFrictionReportCSV(reportData, reportData.townName);
                    } catch (err) {
                      console.error("CSV export error:", err);
                      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Could not generate CSV", variant: "destructive" });
                    }
                  }}
                  data-testid="button-export-csv"
                >
                  <FileSpreadsheet className="w-4 h-4 mr-1" />
                  Export CSV
                </Button>
                <Button variant="outline" size="sm" onClick={() => setViewingReport(null)} data-testid="button-close-report">
                  Back to Reports
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold" data-testid="text-stat-applications">{reportData.applications.length}</div>
                  <p className="text-sm text-muted-foreground">
                    Unique Projects
                    {reportData.rawApplicationCount ? ` (from ${reportData.rawApplicationCount.toLocaleString()} appearances)` : ""}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold" data-testid="text-stat-date-range">
                    {reportData.dateRangeStart && reportData.dateRangeEnd
                      ? `${reportData.dateRangeStart.slice(0, 7)} — ${reportData.dateRangeEnd.slice(0, 7)}`
                      : "N/A"}
                  </div>
                  <p className="text-sm text-muted-foreground">Date Range</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-primary" data-testid="text-stat-approval-rate">
                    {reportData.applications.length > 0
                      ? `${Math.round((reportData.applications.filter(a => a.outcome === "approved" || a.outcome === "approved_with_conditions").length / reportData.applications.length) * 100)}%`
                      : "N/A"}
                  </div>
                  <p className="text-sm text-muted-foreground">Approval Rate (all applications)</p>
                </CardContent>
              </Card>
            </div>

            {reportData.funnelStages.length > 0 && (
              <FunnelVisualization stages={reportData.funnelStages} applicationModifiers={reportData.applicationModifiers} />
            )}

            {reportData.representationGap && (reportData.representationGap.citizenStats.count > 0 || reportData.representationGap.proStats.count > 0) && (
              <RepresentationGapCard data={reportData.representationGap} />
            )}

            {reportData.projectTypeComparison && (
              <ProjectTypeComparisonCard data={reportData.projectTypeComparison} />
            )}

            {reportData.attritionCurve && reportData.attritionCurve.length > 0 && (
              <AttritionCurveCard entries={reportData.attritionCurve} />
            )}

            {reportData.daysAddedByConstraint && reportData.daysAddedByConstraint.length > 0 && (
              <DaysAddedCard entries={reportData.daysAddedByConstraint} />
            )}

            {(reportData.frictionMatrix.length > 0 || (reportData.ordinanceHitList && reportData.ordinanceHitList.length > 0)) && (
              <TopFrictionTriggersCard matrix={reportData.frictionMatrix} hitList={reportData.ordinanceHitList} />
            )}

            {reportData.timeToDecision && reportData.timeToDecision.overall.avgDays > 0 && (
              <TimeToDecisionCard data={reportData.timeToDecision} temporalTrends={reportData.temporalTrends} />
            )}

            {reportData.predictiveInsights.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Lightbulb className="w-5 h-5" />
                    Predictive Insights
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3">
                    {reportData.predictiveInsights.map((insight, i) => (
                      <li key={i} className="flex items-start gap-3" data-testid={`text-insight-${i}`}>
                        <span className="text-muted-foreground font-medium shrink-0">{i + 1}.</span>
                        <span>{insight}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {reportData.applications.length > 0 && (
              <Card>
                <CardContent className="pt-4 pb-0">
                  <Accordion type="single" collapsible>
                    <AccordionItem value="raw-applications" className="border-b-0">
                      <AccordionTrigger data-testid="button-toggle-raw-apps">
                        View Raw Application Data ({reportData.applications.length})
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-2 pt-2">
                          {reportData.applications.map((app, idx) => (
                            <ApplicationRow
                              key={idx}
                              app={app}
                              idx={idx}
                              expanded={expandedApps.has(idx)}
                              onToggle={() => toggleAppExpand(idx)}
                            />
                          ))}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Generated Reports</CardTitle>
            <CardDescription>Previously generated friction reports</CardDescription>
          </CardHeader>
          <CardContent>
            {reportsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : reports.length === 0 ? (
              <p className="text-muted-foreground text-center py-8" data-testid="text-no-reports">
                No reports generated yet. Select a town above to get started.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Town</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Documents</TableHead>
                    <TableHead>Applications</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reports.map((report) => {
                    const rd = report.reportData as FrictionReportData | null;
                    return (
                      <TableRow key={report.id} data-testid={`row-report-${report.id}`}>
                        <TableCell className="font-medium" data-testid={`text-report-town-${report.id}`}>
                          {report.townName}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={report.status} />
                        </TableCell>
                        <TableCell>{rd?.documentsAnalyzed ?? rd?.batchesProcessed ?? report.chunksAnalyzed}</TableCell>
                        <TableCell>{rd?.applications?.length ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(report.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {report.status === "completed" && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => viewReport(report.id)}
                                  data-testid={`button-view-${report.id}`}
                                >
                                  <Eye className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => reanalyzeMutation.mutate(report.id)}
                                  disabled={reanalyzeMutation.isPending}
                                  data-testid={`button-reanalyze-${report.id}`}
                                >
                                  <BarChart3 className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteMutation.mutate(report.id)}
                              data-testid={`button-delete-${report.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <Badge variant="default" data-testid="badge-status-completed"><CheckCircle className="w-3 h-3 mr-1" />Completed</Badge>;
    case "processing":
      return <Badge variant="secondary" data-testid="badge-status-processing"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Processing</Badge>;
    case "failed":
      return <Badge variant="destructive" data-testid="badge-status-failed"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
    default:
      return <Badge variant="outline" data-testid="badge-status-pending"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
  }
}

function YoYBadge({ value, label, invertColor }: { value: number; label?: string; invertColor?: boolean }) {
  if (value === 0) return null;
  const isUp = value > 0;
  const isGood = invertColor ? !isUp : isUp;
  const colorClass = isGood ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
  const arrow = isUp ? "\u2191" : "\u2193";
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-md font-medium ${colorClass}`} data-testid={`badge-yoy-${label || "delta"}`}>
      {arrow} {Math.abs(value)}%{label ? ` ${label}` : ""}
    </span>
  );
}

function FunnelVisualization({ stages, applicationModifiers }: { stages: FunnelStage[]; applicationModifiers?: ApplicationModifiers }) {
  const maxCount = Math.max(...stages.map((s) => s.count), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingDown className="w-5 h-5" />
          Site Plan Approval Funnel
        </CardTitle>
        <CardDescription>Base outcomes sum to 100% of all applications</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {stages.map((stage, i) => {
            const widthPct = Math.max((stage.count / maxCount) * 100, 4);
            const isDenied = stage.label.toLowerCase().includes("denied");
            const isWithdrawn = stage.label.toLowerCase().includes("withdrawn") || stage.label.toLowerCase().includes("abandoned");
            const isPending = stage.label.toLowerCase().includes("pending");

            let barColor = "bg-primary/80";
            if (isWithdrawn) barColor = "bg-muted-foreground/50";
            else if (isDenied) barColor = "bg-destructive/70";
            else if (isPending) barColor = "bg-amber-500/70 dark:bg-amber-400/70";

            return (
              <div key={stage.label} className="space-y-1" data-testid={`funnel-stage-${i}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium flex items-center gap-1">
                    {stage.label}
                    {isWithdrawn && (
                      <span data-testid="info-withdrawn-projects"><Info className="w-3.5 h-3.5 text-muted-foreground" /></span>
                    )}
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {stage.count} ({stage.percentage}%)
                  </span>
                </div>
                <div className="h-8 w-full bg-muted rounded-md overflow-hidden">
                  <div
                    className={`h-full rounded-md transition-all ${barColor}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                {stage.description && (
                  <p className="text-xs text-muted-foreground">{stage.description}</p>
                )}
              </div>
            );
          })}
        </div>

        {applicationModifiers && (
          <div className="mt-6 pt-4 border-t">
            <h4 className="text-sm font-medium mb-3 text-muted-foreground">Application Modifiers (overlapping, not additive)</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="text-center p-3 bg-muted rounded-md" data-testid="modifier-approved-with-conditions">
                <div className="text-lg font-bold">{applicationModifiers.approvedWithConditions}</div>
                <p className="text-xs text-muted-foreground">Approved w/ Conditions</p>
              </div>
              <div className="text-center p-3 bg-muted rounded-md" data-testid="modifier-approved-after-delay">
                <div className="text-lg font-bold">{applicationModifiers.approvedAfterDelay}</div>
                <p className="text-xs text-muted-foreground">Approved After Delay</p>
              </div>
              <div className="text-center p-3 bg-muted rounded-md" data-testid="modifier-appeals-filed">
                <div className="text-lg font-bold">{applicationModifiers.appealsFiled}</div>
                <p className="text-xs text-muted-foreground">Appeals Filed</p>
              </div>
              <div className="text-center p-3 bg-muted rounded-md" data-testid="modifier-appeal-successes">
                <div className="text-lg font-bold">{applicationModifiers.appealSuccesses}</div>
                <p className="text-xs text-muted-foreground">Appeal Successes</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TopFrictionTriggersCard({ matrix, hitList }: { matrix: FrictionCategory[]; hitList?: OrdinanceHitListData[] }) {
  const grouped = new Map<string, { count: number; percentage: number; keywords: string[] }>();

  for (const item of matrix) {
    grouped.set(item.category, { count: item.count, percentage: item.percentage, keywords: [] });
  }

  if (hitList) {
    for (const entry of hitList) {
      let matched = false;
      const groupedKeys = Array.from(grouped.keys());
      for (const cat of groupedKeys) {
        const data = grouped.get(cat)!;
        if (entry.keyword.toLowerCase().includes(cat.toLowerCase()) || cat.toLowerCase().includes(entry.keyword.toLowerCase())) {
          data.keywords.push(entry.keyword);
          matched = true;
          break;
        }
      }
      if (!matched) {
        const existing = grouped.get("Other");
        if (existing) {
          existing.keywords.push(entry.keyword);
        } else {
          grouped.set(entry.keyword, { count: entry.count, percentage: entry.percentage, keywords: [] });
        }
      }
    }
  }

  const entries = Array.from(grouped.entries()).sort((a, b) => b[1].count - a[1].count);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" data-testid="title-top-friction-triggers">
          <AlertTriangle className="w-5 h-5" />
          Top Friction Triggers
        </CardTitle>
        <CardDescription>Consolidated view of zoning, procedural, and regulatory friction sources</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">%</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map(([category, data], i) => (
              <TableRow key={category} data-testid={`row-friction-${i}`}>
                <TableCell className="font-medium">{category}</TableCell>
                <TableCell className="text-right tabular-nums">{data.count}</TableCell>
                <TableCell className="text-right tabular-nums">{data.percentage}%</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {data.keywords.length > 0
                    ? data.keywords.join(", ")
                    : frictionDescription(category)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function frictionDescription(category: string): string {
  const descriptions: Record<string, string> = {
    "Wetlands/Environmental": "Delays from wetland setback reviews, DES permits, and environmental impact assessments",
    "Zoning Setback": "Non-conforming setback distances requiring variances or redesign",
    "Procedural/Incomplete": "Missing paperwork, unpaid fees, or incomplete site plans delaying substantive review",
    "Drainage/Stormwater": "Stormwater management plan reviews and drainage engineering requirements",
    "Fire Dept": "Fire department access, hydrant placement, and safety code compliance reviews",
    "NHDES": "State environmental permits and NH Department of Environmental Services coordination",
    "Access/Traffic": "Driveway permits, traffic studies, and road access safety reviews",
    "Septic/Water": "Septic system design approvals and water supply adequacy reviews",
    "Landscaping/Screening": "Buffer zone, screening, and landscaping plan requirements",
  };
  return descriptions[category] || "Regulatory friction from this category of requirements";
}

function TimeToDecisionCard({ data, temporalTrends }: { data: TimeToDecisionData; temporalTrends?: TemporalTrendsData }) {
  const yearlyData = temporalTrends?.yearlyBreakdown ?? [];
  const chartData = yearlyData.map(y => ({
    year: y.year.toString(),
    avgDays: y.avgDays,
    avgContinuances: y.avgContinuances,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Timer className="w-5 h-5" />
          Time-to-Decision
        </CardTitle>
        <CardDescription>How long applications take from submission to final decision</CardDescription>
      </CardHeader>
      <CardContent>
        {chartData.length > 1 ? (
          <div className="mb-6" data-testid="chart-time-to-decision">
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="year" className="text-xs" />
                <YAxis yAxisId="days" className="text-xs" />
                <YAxis yAxisId="cont" orientation="right" className="text-xs" />
                <RechartsTooltip />
                <Legend />
                <Line yAxisId="days" type="monotone" dataKey="avgDays" name="Average Days to Decision" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 4 }} />
                <Line yAxisId="cont" type="monotone" dataKey="avgContinuances" name="Average Continuances" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <div className="text-center p-3 bg-muted rounded-md">
              <div className="text-2xl font-bold" data-testid="text-avg-days">{data.overall.avgDays}</div>
              <p className="text-sm text-muted-foreground">Avg Days</p>
            </div>
            <div className="text-center p-3 bg-muted rounded-md">
              <div className="text-2xl font-bold" data-testid="text-median-days">{data.overall.medianDays}</div>
              <p className="text-sm text-muted-foreground">Median Days</p>
            </div>
            <div className="text-center p-3 bg-muted rounded-md">
              <div className="text-2xl font-bold" data-testid="text-avg-continuances">{data.overall.avgContinuances}</div>
              <p className="text-sm text-muted-foreground">Avg Continuances</p>
            </div>
          </div>
        )}
        {data.byCategory.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-3 text-muted-foreground">Breakdown by Friction Type</h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Friction Category</TableHead>
                  <TableHead className="text-right">Avg Days</TableHead>
                  <TableHead className="text-right">Applications</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byCategory.map((cat, i) => (
                  <TableRow key={cat.category} data-testid={`row-ttd-${i}`}>
                    <TableCell className="font-medium">{cat.category}</TableCell>
                    <TableCell className="text-right tabular-nums">{cat.avgDays}</TableCell>
                    <TableCell className="text-right tabular-nums">{cat.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RepresentationGapCard({ data }: { data: RepresentationGapData }) {
  const metrics = [
    { label: "Approval Rate", citizen: `${data.citizenStats.approvalRate}%`, pro: `${data.proStats.approvalRate}%`, delta: data.delta.approvalRate, suffix: "pp", invertColor: false },
    { label: "Continuance Rate", citizen: `${data.citizenStats.continuanceRate}%`, pro: `${data.proStats.continuanceRate}%`, delta: data.delta.continuanceRate, suffix: "pp", invertColor: true },
    { label: "Abandonment Rate", citizen: `${data.citizenStats.abandonmentRate}%`, pro: `${data.proStats.abandonmentRate}%`, delta: data.delta.abandonmentRate, suffix: "pp", invertColor: true },
    { label: "Avg Days to Decision", citizen: `${data.citizenStats.avgDaysToDecision}`, pro: `${data.proStats.avgDaysToDecision}`, delta: data.delta.avgDaysToDecision, suffix: " days", invertColor: true },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" data-testid="title-representation-gap">
          <Users className="w-5 h-5" />
          The Representation Gap
        </CardTitle>
        <CardDescription>How unrepresented citizens fare vs. professionally represented applicants</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div className="text-center p-3 bg-muted rounded-md">
            <div className="text-lg font-bold" data-testid="text-citizen-count">{data.citizenStats.count}</div>
            <p className="text-sm text-muted-foreground">Citizen/Owner Apps</p>
          </div>
          <div className="text-center p-3 bg-muted rounded-md">
            <div className="text-lg font-bold" data-testid="text-pro-count">{data.proStats.count}</div>
            <p className="text-sm text-muted-foreground">Professional Apps</p>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Metric</TableHead>
              <TableHead className="text-right">Citizen/Owner</TableHead>
              <TableHead className="text-right">Professional</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {metrics.map((m, i) => (
              <TableRow key={i} data-testid={`row-gap-${i}`}>
                <TableCell className="font-medium">{m.label}</TableCell>
                <TableCell className="text-right tabular-nums">{m.citizen}</TableCell>
                <TableCell className="text-right tabular-nums">{m.pro}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ProjectTypeComparisonCard({ data }: { data: ProjectTypeComparisonData }) {
  const rows: Array<{ label: string; stats: ProjectTypeGroupStats }> = [
    { label: "Residential", stats: data.residential },
    { label: "Commercial", stats: data.commercial },
    { label: "Mixed-Use", stats: data.mixedUse },
  ].filter(r => r.stats.count > 0);

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" data-testid="title-project-type">
          <BarChart3 className="w-5 h-5" />
          Residential vs. Commercial Timelines
        </CardTitle>
        <CardDescription>How project type affects processing time and friction sources</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project Type</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Avg Days</TableHead>
              <TableHead className="text-right">Avg Cont.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i} data-testid={`row-ptype-${i}`}>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell className="text-right tabular-nums">{r.stats.count}</TableCell>
                <TableCell className="text-right tabular-nums">{r.stats.avgDays}</TableCell>
                <TableCell className="text-right tabular-nums">{r.stats.avgContinuances}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AttritionCurveCard({ entries }: { entries: AttritionCurveEntry[] }) {
  const maxCount = Math.max(...entries.map(e => e.count), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" data-testid="title-attrition-curve">
          <TrendingDown className="w-5 h-5" />
          The Attrition Curve
        </CardTitle>
        <CardDescription>Where abandoned and withdrawn projects exit the process</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {entries.map((entry, i) => {
            const widthPct = Math.max((entry.count / maxCount) * 100, 4);
            return (
              <div key={entry.stage} className="space-y-1" data-testid={`attrition-stage-${i}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{entry.stage}</span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {entry.count} ({entry.percentage}%)
                  </span>
                </div>
                <div className="h-6 w-full bg-muted rounded-md overflow-hidden">
                  <div
                    className="h-full rounded-md bg-destructive/60 transition-all"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                {entry.description && (
                  <p className="text-xs text-muted-foreground">{entry.description}</p>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function DaysAddedCard({ entries }: { entries: DaysAddedEntry[] }) {
  const chartData = entries.map(e => ({
    constraint: e.constraint,
    avgDaysAdded: e.avgDaysAdded,
    count: e.count,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" data-testid="title-days-added">
          <Clock className="w-5 h-5" />
          Average Days Added by Constraint
        </CardTitle>
        <CardDescription>How many extra days each friction trigger adds to the approval timeline</CardDescription>
      </CardHeader>
      <CardContent>
        {chartData.length > 0 && (
          <div data-testid="chart-days-added">
            <ResponsiveContainer width="100%" height={Math.max(entries.length * 44, 200)}>
              <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                <XAxis type="number" className="text-xs" />
                <YAxis type="category" dataKey="constraint" width={140} className="text-xs" tick={{ fontSize: 12 }} />
                <RechartsTooltip formatter={(value: number, name: string) => [
                  name === "avgDaysAdded" ? `${value} days` : `${value} apps`,
                  name === "avgDaysAdded" ? "Avg Days Added" : "Applications"
                ]} />
                <Bar dataKey="avgDaysAdded" name="Avg Days Added" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]}>
                  {chartData.map((_, index) => (
                    <Cell key={index} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-3 space-y-1">
              {entries.map((e, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-sm" data-testid={`days-added-row-${i}`}>
                  <span className="text-muted-foreground">{e.constraint}</span>
                  <span className="tabular-nums font-medium">{e.avgDaysAdded} days avg ({e.count} apps)</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ApplicationRow({
  app,
  idx,
  expanded,
  onToggle,
}: {
  app: SitePlanApplication;
  idx: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const outcomeVariant = (() => {
    switch (app.outcome) {
      case "approved": return "default" as const;
      case "approved_with_conditions": return "secondary" as const;
      case "denied": return "destructive" as const;
      case "withdrawn": return "outline" as const;
      default: return "outline" as const;
    }
  })();

  const outcomeLabel = app.outcome.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="border rounded-md" data-testid={`app-row-${idx}`}>
      <button
        className="w-full flex items-center justify-between p-3 text-left hover-elevate rounded-md"
        onClick={onToggle}
        data-testid={`button-expand-app-${idx}`}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-medium">{app.entityName}</span>
          <Badge variant={outcomeVariant} className="text-xs">
            {outcomeLabel}
          </Badge>
          {app.totalContinuances > 0 && (
            <Badge variant="outline" className="text-xs">
              {app.totalContinuances} continuance{app.totalContinuances !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t pt-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 text-sm">
            {app.address && (
              <div><span className="text-muted-foreground">Address:</span> {app.address}</div>
            )}
            {app.applicant && (
              <div><span className="text-muted-foreground">Applicant:</span> {app.applicant}</div>
            )}
            {app.initialAppearanceDate && (
              <div><span className="text-muted-foreground">First Appearance:</span> {app.initialAppearanceDate}</div>
            )}
            {app.lastAppearanceDate && (
              <div><span className="text-muted-foreground">Last Appearance:</span> {app.lastAppearanceDate}</div>
            )}
            {app.appealPath && app.appealPath !== "none" && (
              <div><span className="text-muted-foreground">Appeal:</span> {app.appealPath.toUpperCase()}{app.appealOutcome ? ` — ${app.appealOutcome}` : ""}</div>
            )}
            {app.primaryFrictionReason && (
              <div className="sm:col-span-2"><span className="text-muted-foreground">Friction:</span> {app.primaryFrictionReason}</div>
            )}
          </div>
          {app.conditions && app.conditions.length > 0 && (
            <div className="text-sm">
              <span className="text-muted-foreground">Conditions:</span>
              <ul className="list-disc list-inside ml-2 mt-1">
                {app.conditions.map((c, ci) => <li key={ci}>{c}</li>)}
              </ul>
            </div>
          )}
          {app.meetingReferences.length > 0 && (
            <div className="text-sm">
              <span className="text-muted-foreground">Meeting References:</span>
              <span className="ml-1">{app.meetingReferences.join(", ")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
