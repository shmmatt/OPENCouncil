import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { adminFetch } from "@/lib/adminFetch";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ArrowUpDown,
  CalendarDays,
  FileText,
  LayoutGrid,
  LayoutList,
  Loader2,
  Sparkles,
  Send,
  Search,
  ThumbsUp,
  Video,
  Trash2,
  Pencil,
  ExternalLink,
  LogOut,
  GitBranch,
  FolderUp,
  BarChart3,
  ScanLine,
  Globe,
  FlaskConical,
  Newspaper,
  Megaphone,
  Microscope,
  Inbox,
} from "lucide-react";
import { NH_TOWNS } from "@shared/schema";
import type { TownFeedItem, ScoredTopic, RoutineTopic, TownFeedNewsArticle, TownFeedPayload, MinutesUpdateItem } from "@shared/schema";

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

        {newsArticles.length > 0 && (
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

function EditPayloadDialog({
  item,
  open,
  onOpenChange,
}: {
  item: TownFeedItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const payload = item.generatedPayload as TownFeedPayload | null;

  const [headline, setHeadline] = useState(item.title);
  const [summary, setSummary] = useState(payload?.summary || item.summary);
  const [topicEmoji, setTopicEmoji] = useState(item.topicEmoji || "");
  const [sections, setSections] = useState<{ title: string; description: string; suggestedQuestions: string[] }[]>(
    payload?.sections || []
  );
  const [highLevelQuestions, setHighLevelQuestions] = useState<string[]>(
    payload?.highLevelQuestions || []
  );

  useEffect(() => {
    if (open) {
      setHeadline(item.title);
      const p = item.generatedPayload as TownFeedPayload | null;
      setSummary(p?.summary || item.summary);
      setTopicEmoji(item.topicEmoji || "");
      setSections(p?.sections || []);
      setHighLevelQuestions(p?.highLevelQuestions || []);
    }
  }, [open, item]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const updatedPayload: TownFeedPayload = {
        summary,
        sections,
        highLevelQuestions,
      };
      const res = await adminFetch(`/api/admin/content/feed-items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: headline,
          summary,
          topicEmoji: topicEmoji || null,
          generatedPayload: updatedPayload,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({ title: "Payload updated" });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const updateSectionQuestion = (sIdx: number, qIdx: number, val: string) => {
    setSections(prev => prev.map((s, i) =>
      i === sIdx ? { ...s, suggestedQuestions: s.suggestedQuestions.map((q, j) => j === qIdx ? val : q) } : s
    ));
  };

  const addSectionQuestion = (sIdx: number) => {
    setSections(prev => prev.map((s, i) =>
      i === sIdx ? { ...s, suggestedQuestions: [...s.suggestedQuestions, ""] } : s
    ));
  };

  const removeSectionQuestion = (sIdx: number, qIdx: number) => {
    setSections(prev => prev.map((s, i) =>
      i === sIdx ? { ...s, suggestedQuestions: s.suggestedQuestions.filter((_, j) => j !== qIdx) } : s
    ));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Feed Item Payload</DialogTitle>
          <DialogDescription>Edit headline, summary, suggested questions, and topic icon for this feed item.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-headline">Headline</Label>
            <Input
              id="edit-headline"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              data-testid="input-edit-headline"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-topic-emoji">Topic Icon (emoji or short label)</Label>
            <Input
              id="edit-topic-emoji"
              value={topicEmoji}
              onChange={(e) => setTopicEmoji(e.target.value)}
              placeholder="e.g. budget, zoning, roads"
              data-testid="input-edit-topic-emoji"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-payload-summary">Summary</Label>
            <Textarea
              id="edit-payload-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={5}
              data-testid="input-edit-payload-summary"
            />
          </div>

          {sections.length > 0 && (
            <div className="space-y-4">
              <Label>Sections & Suggested Questions</Label>
              {sections.map((section, sIdx) => (
                <div key={sIdx} className="border rounded-md p-3 space-y-2">
                  <div className="font-medium text-sm">{section.title}</div>
                  <div className="space-y-1">
                    {section.suggestedQuestions.map((q, qIdx) => (
                      <div key={qIdx} className="flex items-center gap-2">
                        <Input
                          value={q}
                          onChange={(e) => updateSectionQuestion(sIdx, qIdx, e.target.value)}
                          className="flex-1"
                          data-testid={`input-section-${sIdx}-question-${qIdx}`}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeSectionQuestion(sIdx, qIdx)}
                          data-testid={`button-remove-question-${sIdx}-${qIdx}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => addSectionQuestion(sIdx)}
                      data-testid={`button-add-question-${sIdx}`}
                    >
                      Add Question
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <Label>High-Level Questions</Label>
            {highLevelQuestions.map((q, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  value={q}
                  onChange={(e) => setHighLevelQuestions(prev => prev.map((v, i) => i === idx ? e.target.value : v))}
                  className="flex-1"
                  data-testid={`input-high-level-question-${idx}`}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setHighLevelQuestions(prev => prev.filter((_, i) => i !== idx))}
                  data-testid={`button-remove-hl-question-${idx}`}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setHighLevelQuestions(prev => [...prev, ""])}
              data-testid="button-add-hl-question"
            >
              Add Question
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-edit-payload">
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            data-testid="button-save-payload"
          >
            {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Payload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface EnrichedMinutesItem extends MinutesUpdateItem {
  canonicalTitle: string | null;
}

const MAX_MINUTES_SELECTION = 3;

function RecentMinutesPanel({ onGenerateSuccess }: { onGenerateSuccess: (itemId: string) => void }) {
  const { toast } = useToast();
  const [minutesTown, setMinutesTown] = useState("");
  const [selectedMinutes, setSelectedMinutes] = useState<Set<string>>(new Set());

  const { data: minutesData, isLoading: minutesLoading } = useQuery<{ items: EnrichedMinutesItem[] }>({
    queryKey: ["/api/admin/content/recent-minutes", minutesTown],
    queryFn: async () => {
      const res = await adminFetch(`/api/admin/content/recent-minutes?town=${encodeURIComponent(minutesTown)}&limit=20`);
      if (!res.ok) throw new Error("Failed to fetch minutes");
      return res.json();
    },
    enabled: !!minutesTown,
  });

  const minutesItems = minutesData?.items || [];

  const generateFromDocsMutation = useMutation({
    mutationFn: async (documentVersionIds: string[]) => {
      const res = await adminFetch("/api/admin/content/generate-from-documents", {
        method: "POST",
        body: JSON.stringify({ town: minutesTown, documentVersionIds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Generation failed" }));
        throw new Error(err.message || "Generation failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({ title: "Feed item generated", description: `Draft created from ${selectedMinutes.size} document(s)` });
      setSelectedMinutes(new Set());
      onGenerateSuccess(data.id);
    },
    onError: (err: Error) => {
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleMinuteSelection = (docVersionId: string) => {
    setSelectedMinutes(prev => {
      const next = new Set(prev);
      if (next.has(docVersionId)) {
        next.delete(docVersionId);
      } else {
        if (next.size >= MAX_MINUTES_SELECTION) {
          toast({
            title: "Selection limit reached",
            description: "Maximum 3 documents per generation to keep summaries focused",
            variant: "destructive",
          });
          return prev;
        }
        next.add(docVersionId);
      }
      return next;
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle data-testid="text-recent-minutes-title">Recent Minutes</CardTitle>
        <CardDescription>
          Select a town, then choose up to 3 minutes documents to generate a feed item from.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <Label className="mb-2 block">Select Town</Label>
            <Select value={minutesTown} onValueChange={(v) => { setMinutesTown(v); setSelectedMinutes(new Set()); }}>
              <SelectTrigger data-testid="select-minutes-town">
                <SelectValue placeholder="Choose a town..." />
              </SelectTrigger>
              <SelectContent>
                {NH_TOWNS.filter(t => t !== "statewide").map(t => (
                  <SelectItem key={t} value={t} data-testid={`option-minutes-town-${t}`}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => generateFromDocsMutation.mutate(Array.from(selectedMinutes))}
            disabled={selectedMinutes.size === 0 || generateFromDocsMutation.isPending}
            data-testid="button-generate-from-minutes"
          >
            {generateFromDocsMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate Feed Item ({selectedMinutes.size})
              </>
            )}
          </Button>
        </div>

        {generateFromDocsMutation.isPending && (
          <div className="flex items-center gap-2 p-3 border rounded-md bg-muted/50">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground" data-testid="text-generating-notice">
              Generation may take 30-60 seconds for multiple documents...
            </span>
          </div>
        )}

        {!minutesTown ? (
          <div className="text-center py-8">
            <CalendarDays className="w-12 h-12 mx-auto text-muted-foreground mb-4 opacity-50" />
            <p className="text-muted-foreground" data-testid="text-select-town-prompt">
              Select a town to see recent minutes
            </p>
          </div>
        ) : minutesLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : minutesItems.length === 0 ? (
          <div className="text-center py-8">
            <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4 opacity-50" />
            <p className="text-muted-foreground" data-testid="text-no-minutes">
              No minutes found for {minutesTown}
            </p>
          </div>
        ) : (
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]"></TableHead>
                  <TableHead>Board</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Meeting Date</TableHead>
                  <TableHead>Ingested</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {minutesItems.map((item, idx) => {
                  const isSelected = selectedMinutes.has(item.documentVersionId);
                  const isDisabled = !isSelected && selectedMinutes.size >= MAX_MINUTES_SELECTION;
                  return (
                    <TableRow
                      key={item.documentVersionId}
                      className={isSelected ? "bg-primary/5" : ""}
                      data-testid={`row-minutes-${item.documentVersionId}`}
                    >
                      <TableCell>
                        <Checkbox
                          checked={isSelected}
                          disabled={isDisabled}
                          onCheckedChange={() => toggleMinuteSelection(item.documentVersionId)}
                          data-testid={`checkbox-minutes-${item.documentVersionId}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {item.board || "Unknown Board"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-medium" data-testid={`text-minutes-title-${item.documentVersionId}`}>
                          {item.canonicalTitle || `${item.board || "Minutes"} - ${item.town}`}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {item.meetingDate
                          ? new Date(item.meetingDate).toLocaleDateString()
                          : "N/A"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(item.ingestedAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminContent() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedTown, setSelectedTown] = useState("");
  const [viewingItemId, setViewingItemId] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [townFilter, setTownFilter] = useState("all");
  const [sortBy, setSortBy] = useState("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [viewMode, setViewMode] = useState<"card" | "table">("card");
  const [editPayloadItem, setEditPayloadItem] = useState<TownFeedItem | null>(null);

  const token = localStorage.getItem("adminToken");
  useEffect(() => {
    if (!token) setLocation("/admin/login");
  }, [token, setLocation]);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (townFilter !== "all") params.set("town", townFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (searchQuery) params.set("search", searchQuery);
    if (sortBy !== "date") params.set("sortBy", sortBy);
    if (sortDir !== "desc") params.set("sortDir", sortDir);
    return params.toString();
  }, [townFilter, statusFilter, searchQuery, sortBy, sortDir]);

  const { data: feedItems, isLoading: itemsLoading } = useQuery<TownFeedItem[]>({
    queryKey: ["/api/admin/content/feed-items", queryParams],
    queryFn: async () => {
      const url = queryParams
        ? `/api/admin/content/feed-items?${queryParams}`
        : "/api/admin/content/feed-items";
      const res = await adminFetch(url);
      if (res.status === 401) {
        localStorage.removeItem("adminToken");
        setLocation("/admin/login");
        throw new Error("Unauthorized");
      }
      return res.json();
    },
    enabled: !!token,
  });

  const { data: draftItems } = useQuery<TownFeedItem[]>({
    queryKey: ["/api/admin/content/feed-items", "status=draft"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/content/feed-items?status=draft");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!token,
    staleTime: 30000,
  });
  const draftCount = draftItems?.length ?? 0;

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

  const catchupMutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch("/api/admin/content/catchup-feed", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Catch-up failed" }));
        throw new Error(err.message || "Catch-up failed");
      }
      return res.json() as Promise<{ queued: number; message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({
        title: "Feed catch-up queued",
        description: `${data.queued} document${data.queued !== 1 ? "s" : ""} queued for feed generation (since Feb 2026).`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Catch-up failed", description: err.message, variant: "destructive" });
    },
  });

  const enrichMutation = useMutation({
    mutationFn: async (limit?: number) => {
      const url = `/api/admin/content/enrich-metadata${limit ? `?limit=${limit}` : ""}`;
      const res = await adminFetch(url, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Enrich metadata failed" }));
        throw new Error(err.message || "Enrich metadata failed");
      }
      return res.json() as Promise<{ queued: number; message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/content/feed-items"] });
      toast({
        title: "Metadata enrichment queued",
        description: `${data.queued} document${data.queued !== 1 ? "s" : ""} queued for enrichment.`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Enrich metadata failed", description: err.message, variant: "destructive" });
    },
  });

  const handleLogout = () => {
    localStorage.removeItem("adminToken");
    setLocation("/admin/login");
  };

  const toggleSort = (col: string) => {
    if (sortBy === col) {
      setSortDir(prev => prev === "desc" ? "asc" : "desc");
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
  };

  const availableTowns = useMemo(() => {
    if (!feedItems) return [];
    const towns = new Set(feedItems.map(i => i.town));
    return Array.from(towns).sort();
  }, [feedItems]);

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

  const renderCardView = (items: TownFeedItem[]) => (
    <div className="space-y-3">
      {items.map(item => {
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
                    {item.topicEmoji && (
                      <span className="text-sm" data-testid={`text-emoji-${item.id}`}>{item.topicEmoji}</span>
                    )}
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
                    {item.publishedAt && (
                      <span className="text-xs text-muted-foreground">
                        Published: {new Date(item.publishedAt).toLocaleDateString()}
                      </span>
                    )}
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
                    <Badge variant="secondary" className="text-xs gap-1">
                      <ThumbsUp className="w-3 h-3" />
                      {item.upvoteCount ?? 0}
                    </Badge>
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
                <div className="flex flex-col gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditPayloadItem(item);
                    }}
                    data-testid={`button-edit-payload-${item.id}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
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
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );

  const renderTableView = (items: TownFeedItem[]) => (
    <div className="border rounded-md">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="cursor-pointer" onClick={() => toggleSort("town")} data-testid="table-head-town">
              <span className="flex items-center gap-1">Town <ArrowUpDown className="w-3 h-3" /></span>
            </TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="cursor-pointer" onClick={() => toggleSort("date")} data-testid="table-head-date">
              <span className="flex items-center gap-1">Date <ArrowUpDown className="w-3 h-3" /></span>
            </TableHead>
            <TableHead className="cursor-pointer" onClick={() => toggleSort("upvoteCount")} data-testid="table-head-upvotes">
              <span className="flex items-center gap-1">Upvotes <ArrowUpDown className="w-3 h-3" /></span>
            </TableHead>
            <TableHead>Topics</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map(item => {
            const topics = (item.topics || []) as ScoredTopic[];
            const highTopics = topics.filter(t => t.score >= 8);
            return (
              <TableRow
                key={item.id}
                className="cursor-pointer"
                onClick={() => setViewingItemId(item.id)}
                data-testid={`row-feed-item-${item.id}`}
              >
                <TableCell>
                  <Badge variant="outline" className="text-xs">{item.town}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {item.topicEmoji && <span className="text-sm">{item.topicEmoji}</span>}
                    <span className="text-sm font-medium truncate max-w-[250px]">{item.title}</span>
                  </div>
                </TableCell>
                <TableCell><StatusBadge status={item.status} /></TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(item.createdAt).toLocaleDateString()}
                  {item.publishedAt && (
                    <div className="text-xs">Pub: {new Date(item.publishedAt).toLocaleDateString()}</div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-xs gap-1">
                    <ThumbsUp className="w-3 h-3" />
                    {item.upvoteCount ?? 0}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {highTopics.length > 0 ? `${highTopics.length} high` : `${topics.length} total`}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditPayloadItem(item);
                      }}
                      data-testid={`button-table-edit-${item.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteMutation.mutate(item.id);
                      }}
                      data-testid={`button-table-delete-${item.id}`}
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
    </div>
  );

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
              <Link href="/admin/documents-v2">
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
              <Link href="/admin/query">
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
            <Button variant="outline" size="sm" asChild data-testid="link-publishing-inbox">
              <Link href="/admin/publishing">
                <Inbox className="w-4 h-4 mr-2" />
                Publishing Inbox
                {draftCount > 0 && (
                  <Badge variant="default" className="ml-2 text-xs" data-testid="badge-inbox-count">
                    {draftCount}
                  </Badge>
                )}
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-research-chat">
              <Link href="/admin/research-chat">
                <Microscope className="w-4 h-4 mr-2" />
                Research Chat
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
        <div className="flex items-center gap-3 p-4 border rounded-md bg-muted/40" data-testid="banner-publishing-inbox">
          <Inbox className="w-5 h-5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">New: Publishing Inbox</p>
            <p className="text-xs text-muted-foreground">Review and approve AI-generated draft articles in one click.</p>
          </div>
          <Button size="sm" variant="outline" asChild data-testid="button-go-publishing-inbox">
            <Link href="/admin/publishing">
              Open Inbox
            </Link>
          </Button>
        </div>
        <Tabs defaultValue="feed-items" className="space-y-6">
          <TabsList data-testid="tabs-content-management">
            <TabsTrigger value="feed-items" data-testid="tab-feed-items">
              <Newspaper className="w-4 h-4 mr-2" />
              Feed Items
            </TabsTrigger>
            <TabsTrigger value="recent-minutes" data-testid="tab-recent-minutes">
              <CalendarDays className="w-4 h-4 mr-2" />
              Recent Minutes
            </TabsTrigger>
          </TabsList>

          <TabsContent value="recent-minutes" className="space-y-6">
            <RecentMinutesPanel onGenerateSuccess={(itemId) => setViewingItemId(itemId)} />
          </TabsContent>

          <TabsContent value="feed-items" className="space-y-6">
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
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <CardTitle>Feed Items</CardTitle>
                <CardDescription>
                  {(feedItems || []).length} item{(feedItems || []).length !== 1 ? "s" : ""} generated
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => catchupMutation.mutate()}
                  disabled={catchupMutation.isPending}
                  data-testid="button-catchup-feed"
                >
                  {catchupMutation.isPending ? "Queuing..." : "Catch Up Feed (max 200)"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => enrichMutation.mutate(undefined)}
                  disabled={enrichMutation.isPending}
                  data-testid="button-enrich-metadata"
                >
                  {enrichMutation.isPending ? "Enriching..." : "Enrich Metadata"}
                </Button>
                <Button
                  variant={viewMode === "card" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("card")}
                  data-testid="button-view-card"
                >
                  <LayoutGrid className="w-4 h-4" />
                </Button>
                <Button
                  variant={viewMode === "table" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("table")}
                  data-testid="button-view-table"
                >
                  <LayoutList className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search items..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-items"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[140px]" data-testid="select-status-filter">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                </SelectContent>
              </Select>
              <Select value={townFilter} onValueChange={setTownFilter}>
                <SelectTrigger className="w-[160px]" data-testid="select-town-filter">
                  <SelectValue placeholder="Town" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Towns</SelectItem>
                  {availableTowns.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v) => { setSortBy(v); setSortDir("desc"); }}>
                <SelectTrigger className="w-[150px]" data-testid="select-sort-by">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date">Date</SelectItem>
                  <SelectItem value="upvoteCount">Upvotes</SelectItem>
                  <SelectItem value="town">Town</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setSortDir(prev => prev === "desc" ? "asc" : "desc")}
                data-testid="button-toggle-sort-dir"
              >
                <ArrowUpDown className="w-4 h-4" />
              </Button>
            </div>

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
            ) : viewMode === "card" ? (
              renderCardView(feedItems)
            ) : (
              renderTableView(feedItems)
            )}
          </CardContent>
        </Card>
          </TabsContent>
        </Tabs>
      </main>

      {editPayloadItem && (
        <EditPayloadDialog
          item={editPayloadItem}
          open={!!editPayloadItem}
          onOpenChange={(open) => { if (!open) setEditPayloadItem(null); }}
        />
      )}
    </div>
  );
}
