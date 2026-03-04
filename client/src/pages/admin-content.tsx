import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  FileText,
  Loader2,
  Sparkles,
  Send,
  Search,
  Video,
  Trash2,
  ExternalLink,
  LogOut,
  GitBranch,
  FolderUp,
  BarChart3,
  ScanLine,
  Globe,
  FlaskConical,
  Newspaper,
} from "lucide-react";
import { NH_TOWNS } from "@shared/schema";
import type { TownFeedItem, ScoredTopic, RoutineTopic, TownFeedNewsArticle } from "@shared/schema";

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

function StatusBadge({ status }: { status: string }) {
  if (status === "published") {
    return <Badge variant="default" data-testid="badge-status-published">Published</Badge>;
  }
  return <Badge variant="secondary" data-testid="badge-status-draft">Draft</Badge>;
}

function TopicBadge({ topic }: { topic: ScoredTopic }) {
  const isHigh = topic.score >= 8;
  return (
    <Badge
      variant={isHigh ? "default" : "secondary"}
      className="gap-1"
      data-testid={`badge-topic-${topic.topic.replace(/\s+/g, "-").toLowerCase()}`}
    >
      {topic.topic}
      <span className="opacity-70">({topic.score})</span>
    </Badge>
  );
}

function NewsArticleCard({ article }: { article: TownFeedNewsArticle }) {
  const score = article.relevancyScore ?? 0;
  const isHighRelevancy = score >= 7;
  return (
    <div
      className={`flex flex-col gap-1 p-3 border rounded-md ${isHighRelevancy ? "border-primary/30 bg-primary/5" : ""}`}
      data-testid={`card-news-${article.url}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-xs">{article.source}</Badge>
        {score > 0 && (
          <Badge
            variant={isHighRelevancy ? "default" : "secondary"}
            className="text-xs"
            data-testid={`badge-relevancy-${encodeURIComponent(article.url)}`}
          >
            Relevancy: {score}/10
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {new Date(article.fetchedAt).toLocaleDateString()}
        </span>
      </div>
      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-medium hover:underline flex items-center gap-1"
        data-testid={`link-news-${article.url}`}
      >
        {article.title}
        <ExternalLink className="w-3 h-3 shrink-0" />
      </a>
      {article.snippet && (
        <p className="text-xs text-muted-foreground line-clamp-2">{article.snippet}</p>
      )}
    </div>
  );
}

function FeedItemDetail({
  item,
  onBack,
}: {
  item: TownFeedItem;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.summary);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [investigateDialogOpen, setInvestigateDialogOpen] = useState(false);
  const [selectedInvestigateTopics, setSelectedInvestigateTopics] = useState<Set<string>>(new Set());

  const topics = (item.topics || []) as ScoredTopic[];
  const routineTopics = (item.routineTopics || []) as RoutineTopic[];
  const newsArticles = (item.newsArticles || []) as TownFeedNewsArticle[];

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch(`/api/admin/content/feed-items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title, summary }),
      });
      if (!res.ok) throw new Error("Failed to update");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({ title: "Feed item updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch(`/api/admin/content/feed-items/${item.id}/publish`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to publish");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({ title: "Published to town feed" });
      onBack();
    },
    onError: (err: Error) => {
      toast({ title: "Publish failed", description: err.message, variant: "destructive" });
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch(`/api/admin/content/feed-items/${item.id}/unpublish`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to unpublish");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({ title: "Reverted to draft" });
      onBack();
    },
    onError: (err: Error) => {
      toast({ title: "Unpublish failed", description: err.message, variant: "destructive" });
    },
  });

  const investigateMutation = useMutation({
    mutationFn: async (topicStrings: string[]) => {
      const res = await adminFetch(`/api/admin/content/feed-items/${item.id}/investigate`, {
        method: "POST",
        body: JSON.stringify({ topics: topicStrings }),
      });
      if (!res.ok) throw new Error("Investigation failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      setInvestigateDialogOpen(false);
      setSelectedInvestigateTopics(new Set());
      toast({ title: "Investigation complete", description: "News articles have been scored for relevancy" });
    },
    onError: (err: Error) => {
      toast({ title: "Investigation failed", description: err.message, variant: "destructive" });
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch(`/api/admin/content/feed-items/${item.id}/regenerate-summary`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Summary regeneration failed");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      setSummary(data.summary);
      toast({ title: "Summary regenerated", description: "News facts have been incorporated with source attribution" });
    },
    onError: (err: Error) => {
      toast({ title: "Regeneration failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleInvestigateTopic = (topic: string) => {
    setSelectedInvestigateTopics(prev => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  };

  const highScoringTopics = topics.filter(t => t.score >= 8);
  const lowerTopics = topics.filter(t => t.score < 8);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-detail">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-lg font-semibold" data-testid="text-detail-title">{item.title}</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">{item.town}</span>
            <StatusBadge status={item.status} />
            <span className="text-xs text-muted-foreground">
              {new Date(item.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Edit Content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-title">Title</Label>
            <Input
              id="edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="input-edit-title"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-summary">Summary</Label>
            <Textarea
              id="edit-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={8}
              data-testid="input-edit-summary"
            />
          </div>
          <Button
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending || (title === item.title && summary === item.summary)}
            data-testid="button-save-changes"
          >
            {updateMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        </CardContent>
      </Card>

      {highScoringTopics.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">High-Scoring Topics (8+)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {highScoringTopics.map((topic, idx) => (
                <div key={idx} className="space-y-2" data-testid={`section-topic-high-${idx}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <TopicBadge topic={topic} />
                    {topic.board && <span className="text-xs text-muted-foreground">{topic.board}</span>}
                    {topic.meetingDate && <span className="text-xs text-muted-foreground">{topic.meetingDate}</span>}
                  </div>
                  <div className="text-sm space-y-1 pl-2">
                    <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
                      <span>Financial: {topic.financialImpact}/10</span>
                      <span>Friction: {topic.publicFriction}/10</span>
                      <span>QoL: {topic.qualityOfLife}/10</span>
                    </div>
                    {topic.keyPoints && topic.keyPoints.length > 0 && (
                      <ul className="list-disc pl-4 text-sm">
                        {topic.keyPoints.map((kp, kpIdx) => (
                          <li key={kpIdx}>{kp}</li>
                        ))}
                      </ul>
                    )}
                    {topic.historicalContext && (
                      <p className="text-sm text-muted-foreground italic">{topic.historicalContext}</p>
                    )}
                  </div>
                  {idx < highScoringTopics.length - 1 && <Separator />}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {(lowerTopics.length > 0 || routineTopics.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Routine Roll-Up</CardTitle>
            <CardDescription>Lower-scoring topics with brief summaries</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {routineTopics.map((rt, idx) => (
                <div key={`routine-${idx}`} className="flex items-start gap-2" data-testid={`text-routine-${idx}`}>
                  <Badge variant="secondary" className="shrink-0 mt-0.5">{rt.score}</Badge>
                  <div>
                    <span className="text-sm font-medium">{rt.topic}</span>
                    <p className="text-sm text-muted-foreground">{rt.rollupSentence}</p>
                  </div>
                </div>
              ))}
              {lowerTopics.filter(t => !routineTopics.some(rt => rt.topic === t.topic)).map((topic, idx) => (
                <div key={`lower-${idx}`} className="flex items-start gap-2">
                  <Badge variant="secondary" className="shrink-0 mt-0.5">{topic.score}</Badge>
                  <span className="text-sm">{topic.topic}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {(item.sourceMinutesIds as string[] || []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Source Minutes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {(item.sourceMinutesIds as string[]).map((docId, idx) => (
                <Badge key={idx} variant="outline" className="text-xs" data-testid={`badge-source-${idx}`}>
                  <FileText className="w-3 h-3 mr-1" />
                  {docId.slice(0, 8)}...
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {newsArticles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Newspaper className="w-4 h-4" />
              News Articles ({newsArticles.length})
            </CardTitle>
            <CardDescription>
              {newsArticles.filter(a => (a.relevancyScore ?? 0) >= 7).length} high-relevancy articles
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[...newsArticles]
                .sort((a, b) => (b.relevancyScore ?? 0) - (a.relevancyScore ?? 0))
                .map((article, idx) => (
                  <NewsArticleCard key={idx} article={article} />
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {item.status === "draft" ? (
          <Button
            onClick={() => setPublishDialogOpen(true)}
            disabled={publishMutation.isPending}
            data-testid="button-publish"
          >
            {publishMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            <Send className="w-4 h-4 mr-2" />
            Publish
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => unpublishMutation.mutate()}
            disabled={unpublishMutation.isPending}
            data-testid="button-unpublish"
          >
            {unpublishMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Unpublish
          </Button>
        )}

        <Button
          variant="outline"
          onClick={() => {
            setSelectedInvestigateTopics(new Set());
            setInvestigateDialogOpen(true);
          }}
          disabled={investigateMutation.isPending}
          data-testid="button-investigate"
        >
          {investigateMutation.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Search className="w-4 h-4 mr-2" />
          )}
          {newsArticles.length > 0 ? "Re-Investigate" : "Investigate"}
        </Button>

        {newsArticles.some(a => (a.relevancyScore ?? 0) >= 7) && (
          <Button
            variant="outline"
            onClick={() => regenerateMutation.mutate()}
            disabled={regenerateMutation.isPending}
            data-testid="button-regenerate-summary"
          >
            {regenerateMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-2" />
            )}
            Regenerate with News
          </Button>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button variant="outline" disabled data-testid="button-generate-video">
                <Video className="w-4 h-4 mr-2" />
                Generate Video
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Coming Soon</TooltipContent>
        </Tooltip>
      </div>

      <AlertDialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish to Town Feed?</AlertDialogTitle>
            <AlertDialogDescription>
              This will make this content visible to the public in the {item.town} town feed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-publish">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => publishMutation.mutate()}
              data-testid="button-confirm-publish"
            >
              Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={investigateDialogOpen} onOpenChange={setInvestigateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Select Topics to Investigate</AlertDialogTitle>
            <AlertDialogDescription>
              Choose which topics to search local news sources for.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 py-4 max-h-[300px] overflow-y-auto">
            {topics.map((topic, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Checkbox
                  id={`inv-topic-${idx}`}
                  checked={selectedInvestigateTopics.has(topic.topic)}
                  onCheckedChange={() => toggleInvestigateTopic(topic.topic)}
                  data-testid={`checkbox-investigate-${idx}`}
                />
                <label htmlFor={`inv-topic-${idx}`} className="text-sm cursor-pointer flex items-center gap-2">
                  {topic.topic}
                  <Badge variant={topic.score >= 8 ? "default" : "secondary"} className="text-xs">
                    {topic.score}
                  </Badge>
                </label>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-investigate">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => investigateMutation.mutate(Array.from(selectedInvestigateTopics))}
              disabled={selectedInvestigateTopics.size === 0 || investigateMutation.isPending}
              data-testid="button-confirm-investigate"
            >
              {investigateMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 mr-2" />
                  Search News
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function AdminContent() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedTown, setSelectedTown] = useState("");
  const [viewingItemId, setViewingItemId] = useState<string | null>(null);

  const token = localStorage.getItem("adminToken");
  useEffect(() => {
    if (!token) setLocation("/admin/login");
  }, [token, setLocation]);

  const { data: feedItems, isLoading: itemsLoading } = useQuery<TownFeedItem[]>({
    queryKey: ["/api/admin/content/feed-items"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/content/feed-items");
      if (res.status === 401) {
        localStorage.removeItem("adminToken");
        setLocation("/admin/login");
        throw new Error("Unauthorized");
      }
      return res.json();
    },
    enabled: !!token,
  });

  const generateMutation = useMutation({
    mutationFn: async (town: string) => {
      const res = await adminFetch("/api/admin/content/generate", {
        method: "POST",
        body: JSON.stringify({ town }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Generation failed" }));
        throw new Error(err.message || "Generation failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({ title: "Content generated", description: `Draft created for ${data.town}` });
      setViewingItemId(data.id);
    },
    onError: (err: Error) => {
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await adminFetch(`/api/admin/content/feed-items/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({ title: "Feed item deleted" });
    },
  });

  const handleLogout = () => {
    localStorage.removeItem("adminToken");
    setLocation("/admin/login");
  };

  const viewingItem = viewingItemId ? (feedItems || []).find(i => i.id === viewingItemId) : null;

  if (viewingItem) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10">
                <Sparkles className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">OPENCouncil Admin</h1>
                <p className="text-sm text-muted-foreground">Content Generation</p>
              </div>
            </div>
          </div>
        </header>
        <main className="max-w-4xl mx-auto px-6 py-8">
          <FeedItemDetail
            item={viewingItem}
            onBack={() => setViewingItemId(null)}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10">
              <Sparkles className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold" data-testid="text-page-title">OPENCouncil Admin</h1>
              <p className="text-sm text-muted-foreground">Content Generation</p>
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
            <Button variant="outline" size="sm" asChild data-testid="link-templates">
              <Link href="/admin/templates">
                <FileText className="w-4 h-4 mr-2" />
                Templates
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-research">
              <Link href="/admin/research">
                <FlaskConical className="w-4 h-4 mr-2" />
                OC Research
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
            <CardTitle data-testid="text-generate-title">Generate Town Content</CardTitle>
            <CardDescription>
              Extract topics from recent meeting minutes, score them for story-worthiness,
              and generate an editable summary with historical context.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <Label className="mb-2 block">Select Town</Label>
                <Select value={selectedTown} onValueChange={setSelectedTown}>
                  <SelectTrigger data-testid="select-town">
                    <SelectValue placeholder="Choose a town..." />
                  </SelectTrigger>
                  <SelectContent>
                    {NH_TOWNS.filter(t => t !== "statewide").map(t => (
                      <SelectItem key={t} value={t} data-testid={`option-town-${t}`}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() => generateMutation.mutate(selectedTown)}
                disabled={!selectedTown || generateMutation.isPending}
                data-testid="button-generate-content"
              >
                {generateMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    Generate Content
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Feed Items</CardTitle>
            <CardDescription>
              {(feedItems || []).length} item{(feedItems || []).length !== 1 ? "s" : ""} generated
            </CardDescription>
          </CardHeader>
          <CardContent>
            {itemsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))}
              </div>
            ) : !feedItems || feedItems.length === 0 ? (
              <div className="text-center py-12">
                <Sparkles className="w-12 h-12 mx-auto text-muted-foreground mb-4 opacity-50" />
                <p className="text-muted-foreground mb-2" data-testid="text-no-items">No content generated yet</p>
                <p className="text-sm text-muted-foreground">
                  Select a town above and click "Generate Content" to get started.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {feedItems.map(item => {
                  const topics = (item.topics || []) as ScoredTopic[];
                  const highTopics = topics.filter(t => t.score >= 8);
                  return (
                    <Card
                      key={item.id}
                      className="hover-elevate cursor-pointer"
                      onClick={() => setViewingItemId(item.id)}
                      data-testid={`card-feed-item-${item.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0 space-y-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-medium text-sm truncate" data-testid={`text-item-title-${item.id}`}>
                                {item.title}
                              </h3>
                              <StatusBadge status={item.status} />
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant="outline" className="text-xs">{item.town}</Badge>
                              <span className="text-xs text-muted-foreground">
                                {new Date(item.createdAt).toLocaleDateString()}
                              </span>
                              {highTopics.length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  {highTopics.length} high-scoring topic{highTopics.length !== 1 ? "s" : ""}
                                </span>
                              )}
                              {((item.newsArticles || []) as TownFeedNewsArticle[]).length > 0 && (
                                <Badge variant="outline" className="text-xs gap-1">
                                  <Newspaper className="w-3 h-3" />
                                  {((item.newsArticles || []) as TownFeedNewsArticle[]).length}
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground line-clamp-2">{item.summary}</p>
                            {topics.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {topics.slice(0, 5).map((t, idx) => (
                                  <TopicBadge key={idx} topic={t} />
                                ))}
                                {topics.length > 5 && (
                                  <Badge variant="secondary" className="text-xs">+{topics.length - 5} more</Badge>
                                )}
                              </div>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteMutation.mutate(item.id);
                            }}
                            data-testid={`button-delete-${item.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
