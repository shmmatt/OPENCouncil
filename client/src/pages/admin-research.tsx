import { useState } from "react";
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
import { useToast } from "@/hooks/use-toast";
import {
  FlaskConical,
  LogOut,
  FileText,
  GitBranch,
  FolderUp,
  BarChart3,
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
  Flame,
  Target,
  Users,
  TrendingUp,
  Ghost,
  Info,
} from "lucide-react";
import type { ResearchReport, FrictionReportData, SitePlanApplication, FunnelStage, FrictionCategory, TimeToDecisionData, FrequentFlyerData, OrdinanceHitListData, DeveloperScorecardData, TemporalTrendsData, YoYDeltas } from "@shared/schema";

interface TownOption {
  name: string;
  docCount: number;
  analyzableCount: number;
  failedOcrCount: number;
  dateRange: string | null;
}

export default function AdminResearch() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedTown, setSelectedTown] = useState("");
  const [viewingReport, setViewingReport] = useState<ResearchReport | null>(null);
  const [expandedApps, setExpandedApps] = useState<Set<number>>(new Set());

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
            <Button variant="ghost" size="sm" onClick={handleLogout} data-testid="button-logout">
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
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
              <Button variant="outline" size="sm" onClick={() => setViewingReport(null)} data-testid="button-close-report">
                Back to Reports
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-2xl font-bold" data-testid="text-stat-applications">{reportData.applications.length}</div>
                    {reportData.temporalTrends?.yoyDeltas && (
                      <YoYBadge value={reportData.temporalTrends.yoyDeltas.volumePct} label="vs. prev year" />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Unique Projects
                    {reportData.rawApplicationCount ? ` (from ${reportData.rawApplicationCount.toLocaleString()} appearances)` : ""}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold" data-testid="text-stat-documents">{reportData.documentsAnalyzed ?? reportData.batchesProcessed}</div>
                  <p className="text-sm text-muted-foreground">Documents Analyzed</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold" data-testid="text-stat-chunks">{reportData.chunksAnalyzed}</div>
                  <p className="text-sm text-muted-foreground">Agenda Items</p>
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
                  <p className="text-sm text-muted-foreground">Approval Rate</p>
                </CardContent>
              </Card>
            </div>

            {reportData.funnelStages.length > 0 && (
              <FunnelVisualization stages={reportData.funnelStages} />
            )}

            {reportData.frictionMatrix.length > 0 && (
              <FrictionMatrixCard matrix={reportData.frictionMatrix} />
            )}

            {reportData.ordinanceHitList && reportData.ordinanceHitList.length > 0 && (
              <OrdinanceHitListCard entries={reportData.ordinanceHitList} />
            )}

            {reportData.timeToDecision && reportData.timeToDecision.overall.avgDays > 0 && (
              <TimeToDecisionCard data={reportData.timeToDecision} yoyDeltas={reportData.temporalTrends?.yoyDeltas} />
            )}

            {reportData.frequentFlyers && reportData.frequentFlyers.length > 0 && (
              <FrequentFlyersCard flyers={reportData.frequentFlyers} />
            )}

            {reportData.developerScorecard && reportData.developerScorecard.length > 0 && (
              <DeveloperScorecardCard entries={reportData.developerScorecard} />
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
                <CardHeader>
                  <CardTitle>Extracted Applications ({reportData.applications.length})</CardTitle>
                  <CardDescription>Individual site plan applications identified from meeting minutes</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
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

function FunnelVisualization({ stages }: { stages: FunnelStage[] }) {
  const maxCount = Math.max(...stages.map((s) => s.count), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingDown className="w-5 h-5" />
          Site Plan Approval Funnel
        </CardTitle>
        <CardDescription>Attrition rate of site plans through the municipal approval process</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {stages.map((stage, i) => {
            const widthPct = Math.max((stage.count / maxCount) * 100, 4);
            const isTop = i === 0;
            const isDenied = stage.label.toLowerCase().includes("denied");
            const isAppeal = stage.label.toLowerCase().includes("appeal");
            const isGhost = stage.label.toLowerCase().includes("withdrawn") || stage.label.toLowerCase().includes("abandoned");

            let barColor = "bg-primary/80";
            if (isGhost) barColor = "bg-muted-foreground/50";
            else if (isDenied) barColor = "bg-destructive/70";
            else if (isAppeal) barColor = "bg-amber-500/70 dark:bg-amber-400/70";
            else if (!isTop) barColor = "bg-primary/60";

            return (
              <div key={stage.label} className="space-y-1" data-testid={`funnel-stage-${i}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium flex items-center gap-1">
                    {stage.label}
                    {isGhost && (
                      <Info className="w-3.5 h-3.5 text-muted-foreground" title="Applications that were never formally approved or denied, but saw no board action for over 365 days, effectively abandoning the project." data-testid="info-ghost-projects" />
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
      </CardContent>
    </Card>
  );
}

function FrictionMatrixCard({ matrix }: { matrix: FrictionCategory[] }) {
  const maxPct = Math.max(...matrix.map((m) => m.percentage), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5" />
          Ordinance Heatmap
        </CardTitle>
        <CardDescription>Where your zoning and land use regulations create the most friction</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {matrix.map((item, i) => {
            const widthPct = Math.max((item.percentage / maxPct) * 100, 4);

            return (
              <div key={item.category} className="space-y-1" data-testid={`friction-category-${i}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium flex items-center gap-1">
                    {item.category}
                    {item.category === "Procedural/Incomplete" && (
                      <Info className="w-3.5 h-3.5 text-muted-foreground" title="Delays caused by missing paperwork, unpaid fees, or incomplete site maps prior to substantive project review." data-testid="info-procedural" />
                    )}
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {item.count} ({item.percentage}%)
                  </span>
                </div>
                <div className="h-6 w-full bg-muted rounded-md overflow-hidden">
                  <div
                    className="h-full rounded-md bg-amber-500/70 dark:bg-amber-400/70 transition-all"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                {item.examples && item.examples.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Examples: {item.examples.join(", ")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function TimeToDecisionCard({ data, yoyDeltas }: { data: TimeToDecisionData; yoyDeltas?: YoYDeltas | null }) {
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="text-center p-3 bg-muted rounded-md">
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <div className="text-2xl font-bold" data-testid="text-avg-days">{data.overall.avgDays}</div>
              {yoyDeltas && <YoYBadge value={yoyDeltas.ttdPct} label="vs. prev year" invertColor />}
            </div>
            <p className="text-sm text-muted-foreground">Avg Days</p>
          </div>
          <div className="text-center p-3 bg-muted rounded-md">
            <div className="text-2xl font-bold" data-testid="text-median-days">{data.overall.medianDays}</div>
            <p className="text-sm text-muted-foreground">Median Days</p>
          </div>
          <div className="text-center p-3 bg-muted rounded-md">
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <div className="text-2xl font-bold" data-testid="text-avg-continuances">{data.overall.avgContinuances}</div>
              {yoyDeltas && <YoYBadge value={yoyDeltas.continuancesPct} label="vs. prev year" invertColor />}
            </div>
            <p className="text-sm text-muted-foreground">Avg Continuances</p>
          </div>
        </div>
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

function FrequentFlyersCard({ flyers }: { flyers: FrequentFlyerData[] }) {
  const outcomeVariant = (outcome: string) => {
    switch (outcome) {
      case "approved": return "default" as const;
      case "approved_with_conditions": return "secondary" as const;
      case "denied": return "destructive" as const;
      default: return "outline" as const;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Flame className="w-5 h-5" />
          Most Contested Projects
        </CardTitle>
        <CardDescription>Projects requiring the most board meetings before resolution</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {flyers.map((flyer, i) => (
            <div key={i} className="flex items-start justify-between gap-3 p-3 border rounded-md" data-testid={`flyer-row-${i}`}>
              <div className="space-y-1 min-w-0">
                <div className="font-medium truncate">{flyer.entityName}</div>
                {flyer.address && (
                  <div className="text-sm text-muted-foreground truncate">{flyer.address}</div>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={outcomeVariant(flyer.outcome)} className="text-xs">
                    {flyer.outcome.replace(/_/g, " ")}
                  </Badge>
                  {flyer.frictionCategories.slice(0, 3).map((cat, ci) => (
                    <Badge key={ci} variant="outline" className="text-xs">{cat}</Badge>
                  ))}
                </div>
              </div>
              <div className="text-right shrink-0 space-y-1">
                <div className="text-lg font-bold tabular-nums">{flyer.meetingCount}</div>
                <div className="text-xs text-muted-foreground">meetings</div>
                {flyer.daysElapsed > 0 && (
                  <div className="text-xs text-muted-foreground tabular-nums">{flyer.daysElapsed} days</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function OrdinanceHitListCard({ entries }: { entries: OrdinanceHitListData[] }) {
  const maxCount = entries.length > 0 ? entries[0].count : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="w-5 h-5" />
          Ordinance Hit List
        </CardTitle>
        <CardDescription>Specific zoning and procedural rules causing the most friction</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {entries.map((entry, i) => (
            <div key={entry.keyword} className="space-y-1" data-testid={`hitlist-row-${i}`}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className="font-medium capitalize">{entry.keyword}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm tabular-nums text-muted-foreground">{entry.count} apps</span>
                  <Badge variant="outline" className="text-xs tabular-nums">{entry.percentage}%</Badge>
                </div>
              </div>
              <div className="w-full bg-muted rounded-md h-2 overflow-hidden">
                <div
                  className="h-full bg-primary rounded-md transition-all"
                  style={{ width: `${Math.round((entry.count / maxCount) * 100)}%` }}
                />
              </div>
              {entry.exampleProjects.length > 0 && (
                <p className="text-xs text-muted-foreground truncate">
                  e.g. {entry.exampleProjects.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DeveloperScorecardCard({ entries }: { entries: DeveloperScorecardData[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="w-5 h-5" />
          Frequent Applicants & Property Owners
        </CardTitle>
        <CardDescription>Entities submitting the highest volume of applications and their respective friction rates.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Applicant</TableHead>
              <TableHead className="text-right">Projects</TableHead>
              <TableHead className="text-right">Avg Cont.</TableHead>
              <TableHead className="text-right">Avg Days</TableHead>
              <TableHead className="text-right">Approval</TableHead>
              <TableHead>Top Friction</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, i) => (
              <TableRow key={i} data-testid={`scorecard-row-${i}`}>
                <TableCell className="font-medium max-w-[200px] truncate" title={entry.applicantName}>
                  {entry.applicantName}
                </TableCell>
                <TableCell className="text-right tabular-nums">{entry.projectCount}</TableCell>
                <TableCell className="text-right tabular-nums">{entry.avgContinuances}</TableCell>
                <TableCell className="text-right tabular-nums">{entry.avgDaysToDecision}</TableCell>
                <TableCell className="text-right tabular-nums">{entry.approvalRate}%</TableCell>
                <TableCell>
                  <div className="flex gap-1 flex-wrap">
                    {entry.topFrictionCategories.slice(0, 2).map((cat, ci) => (
                      <Badge key={ci} variant="outline" className="text-xs">{cat}</Badge>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
