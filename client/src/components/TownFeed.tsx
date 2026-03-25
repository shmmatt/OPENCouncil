import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useInfiniteQuery, useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowBigUp,
  Clock,
  MapPin,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Check,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { NH_TOWNS } from "@shared/schema";
import type { TownFeedItem, TownFeedPayload, ChatTemplate } from "@shared/schema";

interface FeedItemWithUpvote extends TownFeedItem {
  hasUpvoted: boolean;
}

interface FeedPage {
  items: FeedItemWithUpvote[];
  nextCursor: string | null;
  hasMore: boolean;
}

type FeedEntry =
  | { type: "post"; item: FeedItemWithUpvote }
  | { type: "template"; template: Partial<ChatTemplate> };

function formatRelativeTime(dateVal: string | Date | null): string {
  if (!dateVal) return "";
  const d = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function interleaveTemplates(
  items: FeedItemWithUpvote[],
  templates: Partial<ChatTemplate>[]
): FeedEntry[] {
  if (!templates.length) {
    return items.map((item) => ({ type: "post" as const, item }));
  }
  const entries: FeedEntry[] = [];
  let tIdx = 0;
  for (let i = 0; i < items.length; i++) {
    entries.push({ type: "post", item: items[i] });
    if ((i + 1) % 5 === 0 && tIdx < templates.length) {
      entries.push({ type: "template", template: templates[tIdx % templates.length] });
      tIdx++;
    }
  }
  return entries;
}

function PostCardSkeleton() {
  return (
    <Card className="overflow-visible" data-testid="skeleton-feed-card">
      <CardHeader className="flex flex-row items-center gap-2 pb-2 flex-wrap">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-16" />
      </CardHeader>
      <CardContent className="space-y-2 pb-3">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Skeleton className="h-8 w-24" />
      </CardFooter>
    </Card>
  );
}

function TemplatePromoCard({
  template,
  onQuestionClick,
}: {
  template: Partial<ChatTemplate>;
  onQuestionClick: (question: string, templateId?: string) => void;
}) {
  const payload = template.generatedPayload as TownFeedPayload | undefined;
  const questions = payload?.highLevelQuestions?.slice(0, 2) || [];

  return (
    <Card
      className="overflow-visible border-primary/20 bg-primary/5 dark:bg-primary/10"
      data-testid={`template-promo-${template.id}`}
    >
      <CardHeader className="pb-2 flex-wrap gap-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold" data-testid={`text-template-title-${template.id}`}>
            {template.title}
          </span>
        </div>
        {template.bannerText && (
          <p className="text-xs text-muted-foreground" data-testid={`text-template-banner-${template.id}`}>
            {template.bannerText}
          </p>
        )}
      </CardHeader>
      {questions.length > 0 && (
        <CardContent className="pb-3">
          <div className="flex flex-wrap gap-2">
            {questions.map((q, idx) => (
              <Button
                key={idx}
                variant="outline"
                size="sm"
                className="text-xs text-left whitespace-normal"
                onClick={() => onQuestionClick(q, template.id)}
                data-testid={`button-template-question-${template.id}-${idx}`}
              >
                {q}
              </Button>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function PostCard({
  item,
  onQuestionClick,
  onUpvote,
  isUpvoting,
}: {
  item: FeedItemWithUpvote;
  onQuestionClick: (question: string, feedItemId: string) => void;
  onUpvote: (feedItemId: string) => void;
  isUpvoting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { user } = useAuth();
  const payload = item.generatedPayload as TownFeedPayload | undefined;

  const allQuestions = useMemo(() => {
    const qs: string[] = [];
    if (payload?.highLevelQuestions) qs.push(...payload.highLevelQuestions);
    if (payload?.sections) {
      for (const s of payload.sections) {
        if (s.suggestedQuestions) qs.push(...s.suggestedQuestions);
      }
    }
    return qs.slice(0, 4);
  }, [payload]);

  const topics = (item.topics || []) as Array<{ topic: string; score: number }>;
  const maxScore = topics.reduce((m, t) => Math.max(m, t.score ?? 0), 0);
  const isHighImpact = maxScore >= 8;

  const summaryText = item.summary || "";
  const truncateLength = 280;
  const needsTruncation = summaryText.length > truncateLength;
  const displaySummary = useMemo(() => {
    if (expanded || !needsTruncation) return summaryText;
    let truncated = summaryText.slice(0, truncateLength);
    const boldCount = (truncated.match(/\*\*/g) || []).length;
    if (boldCount % 2 !== 0) truncated += "**";
    return truncated + "...";
  }, [summaryText, expanded, needsTruncation]);

  return (
    <Card className="overflow-visible" data-testid={`feed-card-${item.id}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-sm font-medium" data-testid={`text-town-${item.id}`}>
              {item.town}
            </span>
          </div>
          {item.topicEmoji && (
            <span className="text-sm" data-testid={`text-emoji-${item.id}`}>
              {item.topicEmoji}
            </span>
          )}
          {isHighImpact && (
            <Badge variant="secondary" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid={`badge-high-impact-${item.id}`}>
              <TrendingUp className="w-3 h-3 mr-0.5" />
              High Impact
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span data-testid={`text-time-${item.id}`}>
            {formatRelativeTime(item.publishedAt)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="pb-3 space-y-2">
        <h3 className="text-base font-semibold leading-snug" data-testid={`text-title-${item.id}`}>
          {item.title}
        </h3>
        <div className="text-sm text-muted-foreground leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:text-muted-foreground prose-strong:text-foreground [&>p]:mb-2 [&>p:last-child]:mb-0" data-testid={`text-summary-${item.id}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{displaySummary}</ReactMarkdown>
        </div>
        {needsTruncation && (
          <button
            className="text-xs text-primary font-medium flex items-center gap-0.5"
            onClick={() => setExpanded(!expanded)}
            data-testid={`button-read-more-${item.id}`}
          >
            {expanded ? (
              <>Show less <ChevronUp className="w-3 h-3" /></>
            ) : (
              <>Read more <ChevronDown className="w-3 h-3" /></>
            )}
          </button>
        )}
      </CardContent>

      <CardFooter className="flex-col items-start gap-3">
        <div className="flex items-center gap-3 w-full">
          <Button
            variant={item.hasUpvoted ? "default" : "outline"}
            size="sm"
            onClick={() => onUpvote(item.id)}
            disabled={isUpvoting || !user}
            data-testid={`button-upvote-${item.id}`}
          >
            <ArrowBigUp className="w-4 h-4" />
            <span data-testid={`text-upvote-count-${item.id}`}>{item.upvoteCount}</span>
            <span className="sr-only">Important</span>
          </Button>
          {!user && (
            <span className="text-xs text-muted-foreground">Sign in to vote</span>
          )}
        </div>

        {allQuestions.length > 0 && (
          <div className="w-full space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">Ask about this:</p>
            <div className="flex flex-wrap gap-2">
              {allQuestions.map((q, idx) => (
                <Badge
                  key={idx}
                  variant="outline"
                  className="cursor-pointer text-xs font-normal text-left whitespace-normal"
                  onClick={() => onQuestionClick(q, item.id)}
                  data-testid={`button-question-${item.id}-${idx}`}
                >
                  {q}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardFooter>
    </Card>
  );
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function getTopicLabel(item: FeedItemWithUpvote): string {
  const topics = (item.topics || []) as Array<{ topic: string; score: number }>;
  if (!topics.length) return "Municipal";
  const top = topics.reduce((a, b) => (b.score > a.score ? b : a));
  return top.topic || "Municipal";
}

function HeroFeedCard({
  item,
  onQuestionClick,
}: {
  item: FeedItemWithUpvote;
  onQuestionClick: (question: string, feedItemId: string) => void;
}) {
  const payload = item.generatedPayload as TownFeedPayload | undefined;
  const firstQuestion = payload?.highLevelQuestions?.[0] ?? `Tell me about: ${item.title}`;
  const topicLabel = getTopicLabel(item);
  const plainSummary = stripMarkdown(item.summary || "");

  return (
    <div
      className="relative overflow-hidden rounded-md col-span-12 lg:col-span-8"
      data-testid={`hero-card-${item.id}`}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-primary via-primary to-primary/80" />
      <div className="relative p-6 md:p-8 flex flex-col h-full min-h-[280px] justify-between">
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Badge
              className="bg-white/20 text-white border-white/30 no-default-hover-elevate no-default-active-elevate text-xs"
              data-testid={`hero-badge-${item.id}`}
            >
              {topicLabel}
            </Badge>
            <span className="text-white/50 text-xs flex items-center gap-1">
              <MapPin className="w-3 h-3" />{item.town}
            </span>
          </div>
          <h2
            className="text-white font-black font-headline text-2xl md:text-3xl leading-tight mb-3 line-clamp-3"
            data-testid={`hero-title-${item.id}`}
          >
            {item.title}
          </h2>
          <p className="text-white/75 text-sm leading-relaxed line-clamp-3 max-w-2xl">
            {plainSummary}
          </p>
        </div>
        <div className="flex items-center gap-3 mt-6 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="border-white/40 text-white bg-white/10 font-headline font-semibold"
            onClick={() => onQuestionClick(firstQuestion, item.id)}
            data-testid={`hero-cta-${item.id}`}
          >
            Read Full Directive
          </Button>
          <span className="text-white/50 text-xs flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatRelativeTime(item.publishedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

function BentoSideCard({
  item,
  onQuestionClick,
}: {
  item: FeedItemWithUpvote;
  onQuestionClick: (question: string, feedItemId: string) => void;
}) {
  const payload = item.generatedPayload as TownFeedPayload | undefined;
  const firstQuestion = payload?.highLevelQuestions?.[0] ?? `Tell me about: ${item.title}`;
  const topicLabel = getTopicLabel(item);
  const plainSummary = stripMarkdown(item.summary || "");

  return (
    <Card
      className="overflow-visible col-span-12 lg:col-span-4 flex flex-col"
      data-testid={`bento-side-card-${item.id}`}
    >
      <CardHeader className="pb-3 flex-wrap gap-1">
        <Badge
          variant="outline"
          className="text-primary border-primary/30 text-xs w-fit no-default-hover-elevate no-default-active-elevate"
        >
          {topicLabel}
        </Badge>
        <h3
          className="text-base font-bold font-headline leading-snug mt-1"
          data-testid={`bento-side-title-${item.id}`}
        >
          {item.title}
        </h3>
        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
          <MapPin className="w-3 h-3" />
          <span>{item.town}</span>
          <span className="mx-1">·</span>
          <Clock className="w-3 h-3" />
          <span>{formatRelativeTime(item.publishedAt)}</span>
        </div>
      </CardHeader>
      <CardContent className="flex-1 pb-3">
        <p className="text-sm text-muted-foreground leading-relaxed line-clamp-5">
          {plainSummary}
        </p>
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="font-headline font-semibold text-xs"
          onClick={() => onQuestionClick(firstQuestion, item.id)}
          data-testid={`bento-side-cta-${item.id}`}
        >
          Ask a Question
        </Button>
      </CardFooter>
    </Card>
  );
}

function SmallNewsCard({
  item,
  onQuestionClick,
}: {
  item: FeedItemWithUpvote;
  onQuestionClick: (question: string, feedItemId: string) => void;
}) {
  const payload = item.generatedPayload as TownFeedPayload | undefined;
  const firstQuestion = payload?.highLevelQuestions?.[0] ?? `Tell me about: ${item.title}`;
  const topicLabel = getTopicLabel(item);
  const plainSummary = stripMarkdown(item.summary || "");

  return (
    <Card
      className="overflow-visible flex flex-col"
      data-testid={`small-news-card-${item.id}`}
    >
      <CardHeader className="pb-2 flex-wrap gap-1">
        <Badge
          variant="secondary"
          className="text-xs w-fit no-default-hover-elevate no-default-active-elevate"
        >
          {topicLabel}
        </Badge>
        <h4
          className="text-sm font-bold font-headline leading-snug mt-1 line-clamp-2"
          data-testid={`small-card-title-${item.id}`}
        >
          {item.title}
        </h4>
      </CardHeader>
      <CardContent className="flex-1 pb-2">
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
          {plainSummary}
        </p>
      </CardContent>
      <CardFooter className="pt-1 flex-wrap gap-2">
        <button
          className="text-xs text-primary font-semibold font-headline hover:underline"
          onClick={() => onQuestionClick(firstQuestion, item.id)}
          data-testid={`small-card-link-${item.id}`}
        >
          Ask about this
        </button>
        <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {formatRelativeTime(item.publishedAt)}
        </span>
      </CardFooter>
    </Card>
  );
}

function TownPreferencePicker({
  onSave,
  initialTowns,
}: {
  onSave: (towns: string[]) => void;
  initialTowns: string[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialTowns));
  const popularTowns = [
    "Conway", "Ossipee", "Wolfeboro", "Moultonborough", "Tamworth",
    "Madison", "Bartlett", "Jackson", "Sandwich", "Wakefield",
    "Freedom", "Effingham", "Tuftonboro", "Brookfield", "Eaton",
    "Chatham", "Albany",
  ];

  const toggleTown = (t: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  return (
    <Card className="overflow-visible max-w-lg mx-auto" data-testid="town-picker">
      <CardHeader>
        <h2 className="text-lg font-semibold">Choose your towns</h2>
        <p className="text-sm text-muted-foreground">
          Select the towns you want updates about.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {popularTowns.map((t) => (
            <Button
              key={t}
              variant={selected.has(t) ? "default" : "outline"}
              size="sm"
              onClick={() => toggleTown(t)}
              data-testid={`button-town-pick-${t}`}
            >
              {selected.has(t) && <Check className="w-3 h-3 mr-1" />}
              {t}
            </Button>
          ))}
        </div>
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Button
          onClick={() => onSave(Array.from(selected))}
          disabled={selected.size === 0}
          data-testid="button-save-towns"
        >
          Continue ({selected.size} selected)
        </Button>
      </CardFooter>
    </Card>
  );
}

export interface TownFeedProps {
  onQuestionClick: (question: string, feedItemId?: string, templateId?: string) => void;
}

export default function TownFeedComponent({ onQuestionClick }: TownFeedProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const observerRef = useRef<HTMLDivElement | null>(null);

  // Active town selection — initialized from localStorage so guests can filter too
  const [activeTowns, setActiveTowns] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("oc_selected_towns");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return [];
  });

  const [showPicker, setShowPicker] = useState(false);

  // Load server preferences for authenticated users; use as fallback when localStorage is empty
  const { data: prefData, isLoading: prefLoading } = useQuery<{ preferredTowns: string[] }>({
    queryKey: ["/api/feed/user/preferences"],
  });

  const preferredTowns = prefData?.preferredTowns || [];

  // Sync server preferences → activeTowns when no local preference is stored yet
  useEffect(() => {
    if (!prefLoading && preferredTowns.length > 0 && activeTowns.length === 0) {
      setActiveTowns(preferredTowns);
      try {
        localStorage.setItem("oc_selected_towns", JSON.stringify(preferredTowns));
      } catch {}
    }
  }, [prefLoading, preferredTowns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save towns — updates local state + localStorage immediately; PUTs to server only if auth'd
  const handleSaveTowns = useCallback((towns: string[]) => {
    setActiveTowns(towns);
    try {
      localStorage.setItem("oc_selected_towns", JSON.stringify(towns));
    } catch {}
    setShowPicker(false);
    queryClient.invalidateQueries({ queryKey: ["/api/feed/user"] });
    // Fire-and-forget server save for authenticated users
    if (user) {
      apiRequest("PUT", "/api/feed/user/preferences", { preferredTowns: towns }).catch(() => {});
    }
  }, [user]);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery<FeedPage>({
    queryKey: ["/api/feed/user", activeTowns],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam as string);
      params.set("limit", "10");
      if (activeTowns.length > 0) params.set("towns", activeTowns.join(","));
      const res = await fetch(`/api/feed/user?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch feed");
      return res.json();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !showPicker,
  });

  const upvoteMutation = useMutation({
    mutationFn: async (feedItemId: string) => {
      const res = await apiRequest("POST", `/api/feed/items/${feedItemId}/upvote`);
      return res.json() as Promise<{ upvoteCount: number; hasUpvoted: boolean }>;
    },
    onMutate: async (feedItemId) => {
      const qKey = ["/api/feed/user", activeTowns];
      await queryClient.cancelQueries({ queryKey: qKey });
      const prev = queryClient.getQueryData(qKey);
      queryClient.setQueryData<{ pages: FeedPage[]; pageParams: unknown[] }>(
        qKey,
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((item) =>
                item.id === feedItemId
                  ? {
                      ...item,
                      hasUpvoted: !item.hasUpvoted,
                      upvoteCount: item.hasUpvoted
                        ? item.upvoteCount - 1
                        : item.upvoteCount + 1,
                    }
                  : item
              ),
            })),
          };
        }
      );
      return { prev };
    },
    onError: (_err, _feedItemId, context) => {
      if (context?.prev) {
        queryClient.setQueryData(["/api/feed/user", activeTowns], context.prev);
      }
      toast({ title: "Failed to update vote", variant: "destructive" });
    },
  });

  const { data: templateData } = useQuery<Partial<ChatTemplate> | null>({
    queryKey: ["/api/templates/active"],
  });

  const templates: Partial<ChatTemplate>[] = templateData ? [templateData] : [];

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage]
  );

  useEffect(() => {
    const node = observerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(handleIntersect, {
      rootMargin: "200px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [handleIntersect]);

  const allItems = useMemo(
    () => data?.pages.flatMap((p) => p.items) || [],
    [data]
  );

  const entries = useMemo(
    () => interleaveTemplates(allItems, templates),
    [allItems, templates]
  );

  // Show picker automatically when no town is selected (guests + new auth'd users)
  useEffect(() => {
    if (!prefLoading && activeTowns.length === 0) {
      setShowPicker(true);
    }
  }, [prefLoading, activeTowns.length]);

  if (prefLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <PostCardSkeleton />
        <PostCardSkeleton />
        <PostCardSkeleton />
      </div>
    );
  }

  if (showPicker) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <TownPreferencePicker
          initialTowns={activeTowns}
          onSave={handleSaveTowns}
        />
      </div>
    );
  }

  const bentoItems = allItems.slice(0, 5);
  const bentoItemIds = new Set(bentoItems.map((i) => i.id));
  const remainingEntries = entries.filter(
    (e) => e.type === "template" || !bentoItemIds.has(e.item.id)
  );

  const heroItem = bentoItems[0];
  const sideItem = bentoItems[1];
  const gridItems = bentoItems.slice(2);

  return (
    <div className="space-y-6 pb-8" data-testid="town-feed">
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowPicker(true)}
          data-testid="button-edit-towns"
        >
          <MapPin className="w-3.5 h-3.5 mr-1" />
          {activeTowns.length === 0
            ? "Choose Towns"
            : activeTowns.length <= 2
            ? activeTowns.join(", ")
            : `${activeTowns.length} towns`}
        </Button>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <PostCardSkeleton />
          <PostCardSkeleton />
          <PostCardSkeleton />
        </div>
      )}

      {!isLoading && allItems.length === 0 && (
        <Card className="overflow-visible" data-testid="feed-empty">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No feed items yet. Check back soon for updates from your selected towns.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && heroItem && (
        <div className="space-y-4">
          <div className="grid grid-cols-12 gap-4">
            <HeroFeedCard
              item={heroItem}
              onQuestionClick={(q, fid) => onQuestionClick(q, fid)}
            />
            {sideItem && (
              <BentoSideCard
                item={sideItem}
                onQuestionClick={(q, fid) => onQuestionClick(q, fid)}
              />
            )}
          </div>

          {gridItems.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {gridItems.map((item) => (
                <SmallNewsCard
                  key={item.id}
                  item={item}
                  onQuestionClick={(q, fid) => onQuestionClick(q, fid)}
                />
              ))}
            </div>
          )}

          {remainingEntries.length > 0 && (
            <div className="pt-2">
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs font-semibold font-headline uppercase tracking-widest text-muted-foreground">
                  More Updates
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <div className="space-y-4">
                {remainingEntries.map((entry, idx) =>
                  entry.type === "post" ? (
                    <PostCard
                      key={entry.item.id}
                      item={entry.item}
                      onQuestionClick={(q, fid) => onQuestionClick(q, fid)}
                      onUpvote={(fid) => upvoteMutation.mutate(fid)}
                      isUpvoting={upvoteMutation.isPending}
                    />
                  ) : (
                    <TemplatePromoCard
                      key={`tpl-${idx}`}
                      template={entry.template}
                      onQuestionClick={(q, tid) => onQuestionClick(q, undefined, tid)}
                    />
                  )
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div ref={observerRef} className="h-4" />

      {isFetchingNextPage && (
        <div className="space-y-4">
          <PostCardSkeleton />
        </div>
      )}

      {!hasNextPage && allItems.length > 0 && (
        <p className="text-center text-sm text-muted-foreground py-4" data-testid="text-feed-end">
          You&apos;re all caught up.
        </p>
      )}
    </div>
  );
}
