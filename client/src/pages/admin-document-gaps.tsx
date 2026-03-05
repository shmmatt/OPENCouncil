import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  FileWarning,
  MapPin,
  TrendingUp,
  CheckCircle2,
  Clock,
  Search,
  XCircle,
  AlertTriangle,
  MessageSquare,
} from "lucide-react";

interface DocumentGap {
  id: string;
  town: string | null;
  description: string;
  userQuery: string;
  sessionId: string | null;
  messageId: string | null;
  detectionSource: string;
  recordStrengthTier: string | null;
  status: string;
  hitCount: number;
  resolvedAt: string | null;
  adminNotes: string | null;
  createdAt: string;
}

interface DocumentGapStats {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  dismissed: number;
  byTown: { town: string; count: number }[];
  resolvedThisWeek: number;
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { label: string; className: string }> = {
    open: { label: "Open", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
    in_progress: { label: "In Progress", className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300" },
    resolved: { label: "Resolved", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" },
    dismissed: { label: "Dismissed", className: "bg-muted text-muted-foreground" },
  };
  const v = variants[status] || variants.open;
  return <Badge className={v.className} data-testid={`badge-status-${status}`}>{v.label}</Badge>;
}

function DetectionSourceBadge({ source }: { source: string }) {
  const labels: Record<string, string> = {
    retrieval_empty: "No docs found",
    insufficient_context: "Insufficient context",
    insufficient_context_after_second_hop: "Missing after retry",
  };
  return (
    <Badge variant="outline" data-testid={`badge-detection-${source}`}>
      {labels[source] || source}
    </Badge>
  );
}

function MetricCard({ title, value, icon: Icon, subtitle }: {
  title: string;
  value: string | number;
  icon: typeof FileWarning;
  subtitle?: string;
}) {
  return (
    <Card data-testid={`card-metric-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`text-metric-value-${title.toLowerCase().replace(/\s+/g, '-')}`}>{value}</div>
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}

export default function AdminDocumentGaps() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [townFilter, setTownFilter] = useState<string>("all");
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [notesValue, setNotesValue] = useState("");

  const adminToken = localStorage.getItem("adminToken");
  const authHeaders = { Authorization: `Bearer ${adminToken}` };

  const { data: stats, isLoading: statsLoading } = useQuery<DocumentGapStats>({
    queryKey: ["/api/admin/document-gaps/stats"],
    queryFn: async () => {
      const res = await fetch("/api/admin/document-gaps/stats", { headers: authHeaders });
      if (!res.ok) throw new Error("Failed to fetch stats");
      return res.json();
    },
  });

  const { data: towns } = useQuery<string[]>({
    queryKey: ["/api/admin/document-gaps/towns"],
    queryFn: async () => {
      const res = await fetch("/api/admin/document-gaps/towns", { headers: authHeaders });
      if (!res.ok) throw new Error("Failed to fetch towns");
      return res.json();
    },
  });

  const queryParams = new URLSearchParams();
  if (statusFilter !== "all") queryParams.set("status", statusFilter);
  if (townFilter !== "all") queryParams.set("town", townFilter);

  const { data: gaps, isLoading: gapsLoading } = useQuery<DocumentGap[]>({
    queryKey: ["/api/admin/document-gaps", statusFilter, townFilter],
    queryFn: async () => {
      const res = await fetch(`/api/admin/document-gaps?${queryParams.toString()}`, { headers: authHeaders });
      if (!res.ok) throw new Error("Failed to fetch gaps");
      return res.json();
    },
  });

  const updateGapMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: { status?: string; adminNotes?: string } }) => {
      const res = await apiRequest("PATCH", `/api/admin/document-gaps/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/document-gaps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/document-gaps/stats"] });
      toast({ title: "Gap updated" });
    },
    onError: () => {
      toast({ title: "Failed to update gap", variant: "destructive" });
    },
  });

  const handleStatusChange = (gapId: string, newStatus: string) => {
    updateGapMutation.mutate({ id: gapId, updates: { status: newStatus } });
  };

  const handleSaveNotes = (gapId: string) => {
    updateGapMutation.mutate({ id: gapId, updates: { adminNotes: notesValue } });
    setEditingNotes(null);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center gap-4 flex-wrap">
          <Link href="/admin/usage">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Document Gaps</h1>
            <p className="text-sm text-muted-foreground">
              Automatically flagged when chats indicate missing documents in the archive
            </p>
          </div>
        </div>

        {statsLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <Card key={i}><CardContent className="p-6"><Skeleton className="h-8 w-20" /></CardContent></Card>
            ))}
          </div>
        ) : stats ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard
              title="Open Gaps"
              value={stats.open}
              icon={AlertTriangle}
              subtitle={`${stats.total} total tracked`}
            />
            <MetricCard
              title="In Progress"
              value={stats.inProgress}
              icon={Clock}
            />
            <MetricCard
              title="Resolved This Week"
              value={stats.resolvedThisWeek}
              icon={CheckCircle2}
              subtitle={`${stats.resolved} total resolved`}
            />
            <MetricCard
              title="Towns Affected"
              value={stats.byTown.length}
              icon={MapPin}
              subtitle={stats.byTown.length > 0 ? `Top: ${stats.byTown[0].town} (${stats.byTown[0].count})` : undefined}
            />
          </div>
        ) : null}

        {stats && stats.byTown.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Open Gaps by Town</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {stats.byTown.map((t) => (
                  <Badge
                    key={t.town}
                    variant="outline"
                    className="cursor-pointer hover-elevate"
                    onClick={() => setTownFilter(t.town)}
                    data-testid={`badge-town-${t.town}`}
                  >
                    <MapPin className="h-3 w-3 mr-1" />
                    {t.town}: {t.count}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
            </SelectContent>
          </Select>

          <Select value={townFilter} onValueChange={setTownFilter}>
            <SelectTrigger className="w-[160px]" data-testid="select-town-filter">
              <SelectValue placeholder="Filter by town" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Towns</SelectItem>
              {(towns || []).map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(statusFilter !== "all" || townFilter !== "all") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setStatusFilter("all"); setTownFilter("all"); }}
              data-testid="button-clear-filters"
            >
              <XCircle className="h-4 w-4 mr-1" />
              Clear filters
            </Button>
          )}
        </div>

        <Card>
          <CardContent className="p-0">
            {gapsLoading ? (
              <div className="p-6 space-y-3">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : !gaps || gaps.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <Search className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p className="font-medium">No document gaps found</p>
                <p className="text-sm mt-1">
                  {statusFilter !== "all" || townFilter !== "all"
                    ? "Try adjusting your filters"
                    : "Gaps will appear here when chats indicate missing documents"}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Town</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Detection</TableHead>
                    <TableHead className="text-center">Hits</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gaps.map((gap) => (
                    <TableRow key={gap.id} data-testid={`row-gap-${gap.id}`}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {gap.town || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="max-w-xs">
                        <div className="space-y-1">
                          <p className="text-sm line-clamp-2" data-testid={`text-description-${gap.id}`}>
                            {gap.description}
                          </p>
                          <p className="text-xs text-muted-foreground line-clamp-1 flex items-center gap-1">
                            <MessageSquare className="h-3 w-3 shrink-0" />
                            {gap.userQuery.slice(0, 80)}{gap.userQuery.length > 80 ? "..." : ""}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <DetectionSourceBadge source={gap.detectionSource} />
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary" data-testid={`text-hits-${gap.id}`}>
                          <TrendingUp className="h-3 w-3 mr-1" />
                          {gap.hitCount}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={gap.status}
                          onValueChange={(val) => handleStatusChange(gap.id, val)}
                        >
                          <SelectTrigger className="w-[130px] h-8" data-testid={`select-status-${gap.id}`}>
                            <StatusBadge status={gap.status} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="open">Open</SelectItem>
                            <SelectItem value="in_progress">In Progress</SelectItem>
                            <SelectItem value="resolved">Resolved</SelectItem>
                            <SelectItem value="dismissed">Dismissed</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatDate(gap.createdAt)}
                      </TableCell>
                      <TableCell className="min-w-[200px]">
                        {editingNotes === gap.id ? (
                          <div className="space-y-2">
                            <Textarea
                              value={notesValue}
                              onChange={(e) => setNotesValue(e.target.value)}
                              className="text-sm min-h-[60px]"
                              placeholder="Add notes about tracking this document..."
                              data-testid={`input-notes-${gap.id}`}
                            />
                            <div className="flex gap-1">
                              <Button
                                size="sm"
                                onClick={() => handleSaveNotes(gap.id)}
                                disabled={updateGapMutation.isPending}
                                data-testid={`button-save-notes-${gap.id}`}
                              >
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingNotes(null)}
                                data-testid={`button-cancel-notes-${gap.id}`}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div
                            className="cursor-pointer text-sm hover-elevate rounded-md p-1"
                            onClick={() => { setEditingNotes(gap.id); setNotesValue(gap.adminNotes || ""); }}
                            data-testid={`text-notes-${gap.id}`}
                          >
                            {gap.adminNotes ? (
                              <span>{gap.adminNotes}</span>
                            ) : (
                              <span className="text-muted-foreground italic">Click to add notes...</span>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
