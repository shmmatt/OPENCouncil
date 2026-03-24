import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Send,
  Pencil,
  Trash2,
  Loader2,
  CheckCircle,
  Inbox,
  LogOut,
  FileText,
  GitBranch,
  FolderUp,
  BarChart3,
  ScanLine,
  Globe,
  FlaskConical,
  Megaphone,
  Microscope,
  Newspaper,
  X,
  Save,
  CalendarDays,
  Sparkles,
} from "lucide-react";
import type { TownFeedItem } from "@shared/schema";

function adminFetch(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem("adminToken");
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

function DraftItemCard({ item, onRemove }: { item: TownFeedItem; onRemove: (id: string) => void }) {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(item.title);
  const [editSummary, setEditSummary] = useState(item.summary);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);

  const publishMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch(`/api/admin/content/feed-items/${item.id}/publish`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to publish");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items", "status=draft"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/inbox"] });
      toast({ title: "Published to town feed" });
      onRemove(item.id);
    },
    onError: (err: Error) => {
      toast({ title: "Publish failed", description: err.message, variant: "destructive" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch(`/api/admin/content/feed-items/${item.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items", "status=draft"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/inbox"] });
      toast({ title: "Draft removed" });
      onRemove(item.id);
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch(`/api/admin/content/feed-items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editTitle, summary: editSummary }),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items", "status=draft"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/inbox"] });
      toast({ title: "Draft updated" });
      setIsEditing(false);
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const isAutomated = item.feedType === "automated_feature" || item.feedType === "automated_digest";

  return (
    <>
      <Card data-testid={`card-draft-${item.id}`}>
        {item.headerImageUrl && (
          <div className="w-full h-48 overflow-hidden rounded-t-md">
            <img
              src={item.headerImageUrl}
              alt="AI-generated header"
              className="w-full h-full object-cover"
              data-testid={`img-header-${item.id}`}
            />
          </div>
        )}

        <CardContent className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" data-testid={`badge-town-${item.id}`}>
                {item.town}
              </Badge>
              <Badge variant="secondary" className="text-xs" data-testid={`badge-date-${item.id}`}>
                <CalendarDays className="w-3 h-3 mr-1" />
                {new Date(item.createdAt).toLocaleDateString()}
              </Badge>
              {isAutomated && (
                <Badge variant="secondary" className="text-xs gap-1" data-testid={`badge-auto-${item.id}`}>
                  <Sparkles className="w-3 h-3" />
                  Auto-generated
                </Badge>
              )}
            </div>
          </div>

          {isEditing ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor={`edit-title-${item.id}`}>Title</Label>
                <Input
                  id={`edit-title-${item.id}`}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  data-testid={`input-title-${item.id}`}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`edit-summary-${item.id}`}>Summary</Label>
                <Textarea
                  id={`edit-summary-${item.id}`}
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  rows={6}
                  data-testid={`input-summary-${item.id}`}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  data-testid={`button-save-${item.id}`}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setIsEditing(false);
                    setEditTitle(item.title);
                    setEditSummary(item.summary);
                  }}
                  data-testid={`button-cancel-edit-${item.id}`}
                >
                  <X className="w-4 h-4 mr-2" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <h3 className="font-semibold text-base leading-snug" data-testid={`text-title-${item.id}`}>
                  {item.title}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed line-clamp-4" data-testid={`text-summary-${item.id}`}>
                  {item.summary}
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap pt-1">
                <Button
                  size="sm"
                  onClick={() => setPublishDialogOpen(true)}
                  disabled={publishMutation.isPending}
                  data-testid={`button-publish-${item.id}`}
                >
                  {publishMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  Publish
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setIsEditing(true)}
                  data-testid={`button-edit-${item.id}`}
                >
                  <Pencil className="w-4 h-4 mr-2" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRejectDialogOpen(true)}
                  disabled={rejectMutation.isPending}
                  data-testid={`button-reject-${item.id}`}
                >
                  {rejectMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4 mr-2" />
                  )}
                  Reject
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish to Town Feed?</AlertDialogTitle>
            <AlertDialogDescription>
              This will make this content visible to the public in the {item.town} town feed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-publish-${item.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setPublishDialogOpen(false); publishMutation.mutate(); }}
              data-testid={`button-confirm-publish-${item.id}`}
            >
              Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this draft. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-reject-${item.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setRejectDialogOpen(false); rejectMutation.mutate(); }}
              className="bg-destructive text-destructive-foreground"
              data-testid={`button-confirm-reject-${item.id}`}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function AdminPublishing() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const token = localStorage.getItem("adminToken");

  if (!token) {
    setLocation("/admin/login");
    return null;
  }

  const { data: draftItems, isLoading } = useQuery<TownFeedItem[]>({
    queryKey: ["/api/admin/content/feed-items", "status=draft"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/content/feed-items?status=draft");
      if (res.status === 401) {
        localStorage.removeItem("adminToken");
        setLocation("/admin/login");
        throw new Error("Unauthorized");
      }
      if (!res.ok) throw new Error("Failed to fetch drafts");
      return res.json();
    },
    enabled: !!token,
  });

  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());

  const visibleItems = (draftItems || []).filter(
    (item) => !removedIds.has(item.id)
  );

  const handleRemove = (id: string) => {
    setRemovedIds((prev) => new Set([...prev, id]));
  };

  const handleLogout = () => {
    localStorage.removeItem("adminToken");
    setLocation("/admin/login");
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10">
              <Inbox className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold" data-testid="text-page-title">OPENCouncil Admin</h1>
              <p className="text-sm text-muted-foreground">Publishing Inbox</p>
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
            <Button variant="outline" size="sm" asChild data-testid="link-crawler">
              <Link href="/admin/crawler">
                <Globe className="w-4 h-4 mr-2" />
                Crawler
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-content">
              <Link href="/admin/content">
                <Newspaper className="w-4 h-4 mr-2" />
                Content
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-research">
              <Link href="/admin/research">
                <FlaskConical className="w-4 h-4 mr-2" />
                OC Research
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-promotions">
              <Link href="/admin/promotions">
                <Megaphone className="w-4 h-4 mr-2" />
                Promotions
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout} data-testid="button-logout">
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-semibold" data-testid="text-inbox-heading">Publishing Inbox</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Review auto-generated and manually drafted content before publishing.
            </p>
          </div>
          {!isLoading && visibleItems.length > 0 && (
            <Badge variant="secondary" data-testid="badge-draft-count">
              {visibleItems.length} draft{visibleItems.length !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-5 space-y-3">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-9 w-48" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="section-empty-inbox">
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
              <CheckCircle className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground" data-testid="text-empty-state">
              Your inbox is clear
            </h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              New draft articles will appear here automatically when documents are ingested.
            </p>
            <Button variant="outline" size="sm" className="mt-4" asChild data-testid="link-go-content">
              <Link href="/admin/content">
                <Newspaper className="w-4 h-4 mr-2" />
                Manage all feed items
              </Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-4" data-testid="list-drafts">
            {visibleItems.map((item) => (
              <DraftItemCard key={item.id} item={item} onRemove={handleRemove} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
