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
  Flame,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Check,
} from "lucide-react";
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
  const isHotTopic = maxScore >= 8;

  const summaryText = item.summary || "";
  const truncateLength = 280;
  const needsTruncation = summaryText.length > truncateLength;
  const displaySummary = expanded || !needsTruncation
    ? summaryText
    : summaryText.slice(0, truncateLength) + "...";

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
          {isHotTopic && (
            <Badge variant="destructive" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid={`badge-hot-topic-${item.id}`}>
              <Flame className="w-3 h-3 mr-0.5" />
              Hot Topic
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
        <p className="text-sm text-muted-foreground leading-relaxed" data-testid={`text-summary-${item.id}`}>
          {displaySummary}
        </p>
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
          <div className="flex flex-wrap gap-2 w-full">
            {allQuestions.map((q, idx) => (
              <Button
                key={idx}
                variant="ghost"
                size="sm"
                className="text-xs text-left whitespace-normal border border-border"
                onClick={() => onQuestionClick(q, item.id)}
                data-testid={`button-question-${item.id}-${idx}`}
              >
                {q}
              </Button>
            ))}
          </div>
        )}

        {isHotTopic && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onQuestionClick(`Deep dive: What's the full story on ${item.title}?`, item.id)}
            data-testid={`button-deep-dive-${item.id}`}
          >
            <Sparkles className="w-3.5 h-3.5 mr-1" />
            Deep Dive
          </Button>
        )}
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

  const { data: prefData, isLoading: prefLoading } = useQuery<{ preferredTowns: string[] }>({
    queryKey: ["/api/feed/user/preferences"],
  });

  const preferredTowns = prefData?.preferredTowns || [];
  const [showPicker, setShowPicker] = useState(false);

  const savePreferencesMutation = useMutation({
    mutationFn: async (towns: string[]) => {
      await apiRequest("PUT", "/api/feed/user/preferences", { preferredTowns: towns });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed/user/preferences"] });
      queryClient.invalidateQueries({ queryKey: ["/api/feed/user"] });
      setShowPicker(false);
    },
  });

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery<FeedPage>({
    queryKey: ["/api/feed/user"],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam as string);
      params.set("limit", "10");
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
      await queryClient.cancelQueries({ queryKey: ["/api/feed/user"] });
      const prev = queryClient.getQueryData(["/api/feed/user"]);
      queryClient.setQueryData<{ pages: FeedPage[]; pageParams: unknown[] }>(
        ["/api/feed/user"],
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
        queryClient.setQueryData(["/api/feed/user"], context.prev);
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

  useEffect(() => {
    if (!prefLoading && user && preferredTowns.length === 0) {
      setShowPicker(true);
    }
  }, [prefLoading, user, preferredTowns.length]);

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
          initialTowns={preferredTowns}
          onSave={(towns) => savePreferencesMutation.mutate(towns)}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4" data-testid="town-feed">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-xl font-bold" data-testid="text-feed-heading">
          Town Feed
        </h1>
        {user && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPicker(true)}
            data-testid="button-edit-towns"
          >
            <MapPin className="w-3.5 h-3.5 mr-1" />
            Edit Towns
          </Button>
        )}
      </div>

      {isLoading && (
        <div className="space-y-4">
          <PostCardSkeleton />
          <PostCardSkeleton />
          <PostCardSkeleton />
        </div>
      )}

      {!isLoading && entries.length === 0 && (
        <Card className="overflow-visible" data-testid="feed-empty">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No feed items yet. Check back soon for updates from your selected towns.
            </p>
          </CardContent>
        </Card>
      )}

      {entries.map((entry, idx) =>
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

      <div ref={observerRef} className="h-4" />

      {isFetchingNextPage && (
        <div className="space-y-4">
          <PostCardSkeleton />
        </div>
      )}

      {!hasNextPage && allItems.length > 0 && (
        <p className="text-center text-sm text-muted-foreground py-4" data-testid="text-feed-end">
          You're all caught up.
        </p>
      )}
    </div>
  );
}
