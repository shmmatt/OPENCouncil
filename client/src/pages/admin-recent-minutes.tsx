import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, FileText, ExternalLink, RefreshCw } from "lucide-react";
import type { MinutesUpdateItem } from "@shared/schema";

export default function AdminRecentMinutes() {
  const [townFilter, setTownFilter] = useState<string>("");
  const [boardFilter, setBoardFilter] = useState<string>("");
  const [limit, setLimit] = useState<number>(50);

  const { data: townsData } = useQuery<{ towns: string[] }>({
    queryKey: ["/api/meta/towns"],
  });

  const queryParams = new URLSearchParams();
  if (townFilter) queryParams.set("town", townFilter);
  if (boardFilter) queryParams.set("board", boardFilter);
  queryParams.set("limit", limit.toString());

  const { data, isLoading, refetch, isRefetching } = useQuery<{ items: MinutesUpdateItem[] }>({
    queryKey: ["/api/admin/updates/minutes", townFilter, boardFilter, limit],
    queryFn: async () => {
      const res = await fetch(`/api/admin/updates/minutes?${queryParams.toString()}`);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error("Authentication required");
        }
        throw new Error("Failed to fetch minutes updates");
      }
      return res.json();
    },
  });

  const items = data?.items || [];
  const towns = townsData?.towns || [];

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    try {
      return new Date(dateStr).toLocaleDateString("en-US", { 
        month: "short", 
        day: "numeric", 
        year: "numeric" 
      });
    } catch {
      return "—";
    }
  };

  const formatDateTime = (dateStr: string | null) => {
    if (!dateStr) return "—";
    try {
      return new Date(dateStr).toLocaleString("en-US", { 
        month: "short", 
        day: "numeric", 
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    } catch {
      return "—";
    }
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/admin/ingestion">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Recent Minutes Ingested</h1>
            <p className="text-muted-foreground">
              View recently ingested meeting minutes across all towns
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <CardTitle>Minutes Updates</CardTitle>
                <CardDescription>
                  Showing {items.length} most recently ingested meeting minutes
                </CardDescription>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => refetch()}
                disabled={isRefetching}
                data-testid="button-refresh"
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4 mb-4">
              <div className="w-48">
                <Select value={townFilter} onValueChange={setTownFilter}>
                  <SelectTrigger data-testid="select-town-filter">
                    <SelectValue placeholder="All towns" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All towns</SelectItem>
                    {towns.map((town) => (
                      <SelectItem key={town} value={town}>
                        {town}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-48">
                <Input
                  placeholder="Filter by board..."
                  value={boardFilter}
                  onChange={(e) => setBoardFilter(e.target.value)}
                  data-testid="input-board-filter"
                />
              </div>
              <div className="w-32">
                <Select value={limit.toString()} onValueChange={(v) => setLimit(parseInt(v))}>
                  <SelectTrigger data-testid="select-limit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="25">25 rows</SelectItem>
                    <SelectItem value="50">50 rows</SelectItem>
                    <SelectItem value="100">100 rows</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No meeting minutes found</p>
                <p className="text-sm">Try adjusting your filters or check if documents have been indexed.</p>
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ingested At</TableHead>
                      <TableHead>Town</TableHead>
                      <TableHead>Board</TableHead>
                      <TableHead>Meeting Date</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.documentVersionId} data-testid={`row-minutes-${item.documentVersionId}`}>
                        <TableCell className="font-medium">
                          {formatDateTime(item.ingestedAt)}
                        </TableCell>
                        <TableCell>{item.town}</TableCell>
                        <TableCell>{item.board || "—"}</TableCell>
                        <TableCell>{formatDate(item.meetingDate)}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {item.category}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            asChild
                            data-testid={`button-view-doc-${item.documentVersionId}`}
                          >
                            <Link href={`/admin/documents-v2?doc=${item.logicalDocumentId}`}>
                              <ExternalLink className="w-4 h-4 mr-1" />
                              View
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
