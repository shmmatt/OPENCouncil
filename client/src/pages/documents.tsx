import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar } from "@/components/ui/calendar";
import { ChatDrawer } from "@/components/ChatDrawer";
import type { ChatDrawerState } from "@/components/ChatDrawer";
import { useAuth } from "@/hooks/use-auth";
import { useSignInDialog } from "@/contexts/auth-dialog-context";
import {
  FileText,
  Calendar as CalendarIcon,
  List,
  ExternalLink,
  MessageSquare,
  Lock,
  ChevronDown,
} from "lucide-react";
import type { DocumentBrowseItem, DocumentBrowseResponse } from "@shared/schema";
import { NH_TOWNS } from "@shared/schema";
import type { DayContentProps } from "react-day-picker";

const CATEGORY_LABELS: Record<string, string> = {
  budget: "Budget",
  zoning: "Zoning",
  meeting_minutes: "Minutes",
  town_report: "Town Report",
  warrant_article: "Warrant Article",
  ordinance: "Ordinance",
  policy: "Policy",
  planning_board_docs: "Planning Board",
  zba_docs: "ZBA",
  licensing_permits: "Licensing & Permits",
  cip: "CIP",
  elections: "Elections",
  misc_other: "Other",
};

const CATEGORY_COLORS: Record<string, string> = {
  budget: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  zoning: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  meeting_minutes: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  town_report: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  warrant_article: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  ordinance: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  policy: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  planning_board_docs: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  zba_docs: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
  licensing_permits: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
  cip: "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200",
  elections: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  misc_other: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
};

const DOT_COLORS: Record<string, string> = {
  budget: "bg-blue-500",
  zoning: "bg-purple-500",
  meeting_minutes: "bg-green-500",
  town_report: "bg-yellow-500",
  warrant_article: "bg-orange-500",
  ordinance: "bg-red-500",
  policy: "bg-cyan-500",
  planning_board_docs: "bg-indigo-500",
  zba_docs: "bg-pink-500",
  licensing_permits: "bg-teal-500",
  cip: "bg-slate-500",
  elections: "bg-amber-500",
  misc_other: "bg-gray-500",
};

function formatMeetingDate(dateStr: string | null): string {
  if (!dateStr) return "Undated";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function getMonthYear(dateStr: string | null): string {
  if (!dateStr) return "Undated";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function DocumentCardSkeleton() {
  return (
    <Card className="overflow-visible">
      <CardHeader className="pb-2 flex-wrap gap-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-3/4" />
      </CardHeader>
      <CardContent className="pb-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6 mt-1" />
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-28" />
      </CardFooter>
    </Card>
  );
}

function DocumentCard({
  item,
  onAskAbout,
}: {
  item: DocumentBrowseItem;
  onAskAbout: (item: DocumentBrowseItem) => void;
}) {
  const handleViewDocument = useCallback(async () => {
    window.open(`/api/documents/view/${item.fileBlobId}`, "_blank");
  }, [item.fileBlobId]);

  const categoryLabel = CATEGORY_LABELS[item.category] || item.category;
  const categoryColor = CATEGORY_COLORS[item.category] || CATEGORY_COLORS.misc_other;

  function cleanFilename(raw: string): string {
    return raw
      .replace(/\.pdf$/i, "")
      .replace(/[_-]+/g, " ")
      .trim();
  }

  const rawTitle = item.canonicalTitle && item.canonicalTitle.trim()
    ? item.canonicalTitle
    : null;
  const displayTitle = rawTitle || cleanFilename(item.fileBlobId) || "Untitled Document";

  return (
    <Card className="overflow-visible" data-testid={`doc-card-${item.id}`}>
      <CardHeader className="pb-2 flex-wrap gap-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className="text-xs no-default-hover-elevate no-default-active-elevate"
            data-testid={`badge-town-${item.id}`}
          >
            {item.town}
          </Badge>
          {item.board && (
            <span className="text-sm font-medium text-foreground" data-testid={`text-board-${item.id}`}>
              {item.board}
            </span>
          )}
          <Badge
            variant="secondary"
            className={`text-xs no-default-hover-elevate no-default-active-elevate ${categoryColor}`}
            data-testid={`badge-category-${item.id}`}
          >
            {categoryLabel}
          </Badge>
        </div>
        <h3 className="text-sm font-semibold leading-snug" data-testid={`text-title-${item.id}`}>
          {displayTitle}
        </h3>
        <p className="text-xs text-muted-foreground" data-testid={`text-date-${item.id}`}>
          {formatMeetingDate(item.meetingDate)}
        </p>
      </CardHeader>
      {item.previewText && (
        <CardContent className="pb-2">
          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3" data-testid={`text-preview-${item.id}`}>
            {item.previewText}
          </p>
        </CardContent>
      )}
      <CardFooter className="flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleViewDocument}
          data-testid={`button-view-doc-${item.id}`}
        >
          <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
          View Document
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAskAbout(item)}
          data-testid={`button-ask-doc-${item.id}`}
        >
          <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
          Ask about this
        </Button>
      </CardFooter>
    </Card>
  );
}

interface ListViewProps {
  town: string;
  onAskAbout: (item: DocumentBrowseItem) => void;
}

function DocumentListView({ town, onAskAbout }: ListViewProps) {
  const observerRef = useRef<HTMLDivElement | null>(null);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery<DocumentBrowseResponse>({
    queryKey: ["/api/documents", town, "list"],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("town", town);
      params.set("viewMode", "list");
      params.set("limit", "20");
      if (pageParam) params.set("cursor", pageParam as string);
      const res = await fetch(`/api/documents?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch documents");
      return res.json();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!town,
  });

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

  const datedItems = allItems.filter((item) => item.meetingDate !== null);
  const undatedItems = allItems.filter((item) => item.meetingDate === null);

  const grouped = useMemo(() => {
    const groups: Array<{ monthYear: string; items: DocumentBrowseItem[] }> = [];
    for (const item of datedItems) {
      const key = getMonthYear(item.meetingDate);
      const last = groups[groups.length - 1];
      if (!last || last.monthYear !== key) {
        groups.push({ monthYear: key, items: [item] });
      } else {
        last.items.push(item);
      }
    }
    return groups;
  }, [datedItems]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <DocumentCardSkeleton />
        <DocumentCardSkeleton />
        <DocumentCardSkeleton />
      </div>
    );
  }

  if (!isLoading && allItems.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground" data-testid="text-no-docs">
        <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="text-sm">No documents found for {town}.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="document-list">
      {grouped.map((group) => (
        <div key={group.monthYear}>
          <h2 className="text-xs font-black tracking-widest uppercase text-primary font-headline mb-3" data-testid={`heading-${group.monthYear}`}>
            {group.monthYear}
          </h2>
          <div className="space-y-3">
            {group.items.map((item) => (
              <DocumentCard key={item.id} item={item} onAskAbout={onAskAbout} />
            ))}
          </div>
        </div>
      ))}

      {undatedItems.length > 0 && (
        <div>
          <h2 className="text-xs font-black tracking-widest uppercase text-muted-foreground font-headline mb-3">
            Undated
          </h2>
          <div className="space-y-3">
            {undatedItems.map((item) => (
              <DocumentCard key={item.id} item={item} onAskAbout={onAskAbout} />
            ))}
          </div>
        </div>
      )}

      <div ref={observerRef} className="h-4" />
      {isFetchingNextPage && (
        <div className="space-y-3">
          <DocumentCardSkeleton />
          <DocumentCardSkeleton />
        </div>
      )}
    </div>
  );
}

interface CalendarViewProps {
  town: string;
  onAskAbout: (item: DocumentBrowseItem) => void;
}

function DocumentCalendarView({ town, onAskAbout }: CalendarViewProps) {
  const today = new Date();
  const [calendarMonth, setCalendarMonth] = useState<Date>(
    new Date(today.getFullYear(), today.getMonth(), 1)
  );
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  const month = calendarMonth.getMonth() + 1;
  const year = calendarMonth.getFullYear();

  const { data, isLoading } = useQuery<DocumentBrowseResponse>({
    queryKey: ["/api/documents", town, "calendar", year, month],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("town", town);
      params.set("viewMode", "calendar");
      params.set("month", String(month));
      params.set("year", String(year));
      const res = await fetch(`/api/documents?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch calendar documents");
      return res.json();
    },
    enabled: !!town,
  });

  const items = data?.items || [];

  const dayToItems = useMemo(() => {
    const map = new Map<string, DocumentBrowseItem[]>();
    for (const item of items) {
      if (!item.meetingDate) continue;
      const key = item.meetingDate;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [items]);

  const datesWithDocs = useMemo(
    () => Array.from(dayToItems.keys()).map((k) => new Date(k + "T00:00:00")),
    [dayToItems]
  );

  const selectedDayItems = useMemo(() => {
    if (!selectedDay) return items;
    const key = selectedDay.toISOString().split("T")[0];
    return dayToItems.get(key) || [];
  }, [selectedDay, dayToItems, items]);

  function DayContent({ date }: DayContentProps) {
    const key = date.toISOString().split("T")[0];
    const dayItems = dayToItems.get(key) || [];
    const seen = new Set<string>();
    const categories: string[] = [];
    for (const i of dayItems) {
      if (!seen.has(i.category) && categories.length < 3) {
        seen.add(i.category);
        categories.push(i.category);
      }
    }
    return (
      <div className="relative flex flex-col items-center">
        <span>{date.getDate()}</span>
        {categories.length > 0 && (
          <div className="flex gap-0.5 mt-0.5">
            {categories.map((cat) => (
              <span
                key={cat}
                className={`w-1.5 h-1.5 rounded-full ${DOT_COLORS[cat] || "bg-gray-400"}`}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-6" data-testid="document-calendar-view">
      <div className="md:col-span-4">
        <Card className="overflow-visible">
          <CardContent className="p-3">
            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <Calendar
                mode="single"
                month={calendarMonth}
                onMonthChange={setCalendarMonth}
                selected={selectedDay ?? undefined}
                onSelect={(day) => setSelectedDay(day ?? null)}
                modifiers={{ hasDocs: datesWithDocs }}
                modifiersClassNames={{ hasDocs: "font-semibold" }}
                components={{
                  DayContent,
                }}
                data-testid="calendar-picker"
              />
            )}
            {selectedDay && (
              <div className="mt-2 px-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs text-muted-foreground"
                  onClick={() => setSelectedDay(null)}
                  data-testid="button-clear-day-filter"
                >
                  Clear filter — show all {month}/{year}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="md:col-span-8 min-w-0">
        {selectedDay && (
          <p className="text-xs font-semibold text-muted-foreground mb-3" data-testid="text-day-filter-label">
            Showing documents for {formatMeetingDate(selectedDay.toISOString().split("T")[0])}
          </p>
        )}
        {isLoading ? (
          <div className="space-y-3">
            <DocumentCardSkeleton />
            <DocumentCardSkeleton />
          </div>
        ) : selectedDayItems.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground" data-testid="text-no-docs-calendar">
            <CalendarIcon className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">
              {selectedDay
                ? `No documents for ${formatMeetingDate(selectedDay.toISOString().split("T")[0])}.`
                : `No documents found for ${month}/${year} in ${town}.`}
            </p>
          </div>
        ) : (
          <div className="space-y-3" data-testid="calendar-doc-list">
            {selectedDayItems.map((item) => (
              <DocumentCard key={item.id} item={item} onAskAbout={onAskAbout} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AuthGate() {
  const { openSignIn } = useSignInDialog();
  return (
    <div className="relative h-full min-h-[70vh] overflow-hidden" data-testid="auth-gate">
      <div className="absolute inset-0 pointer-events-none select-none opacity-30 blur-sm p-8">
        <div className="max-w-3xl mx-auto space-y-6">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="overflow-visible">
              <CardHeader className="pb-2 flex-wrap gap-1">
                <div className="flex gap-2">
                  <div className="h-4 w-24 bg-muted rounded" />
                  <div className="h-4 w-16 bg-muted rounded" />
                </div>
                <div className="h-5 w-3/4 bg-muted rounded" />
                <div className="h-3 w-1/4 bg-muted rounded" />
              </CardHeader>
              <CardContent className="pb-2 space-y-1">
                <div className="h-3 w-full bg-muted rounded" />
                <div className="h-3 w-5/6 bg-muted rounded" />
              </CardContent>
              <CardFooter className="gap-2">
                <div className="h-8 w-32 bg-muted rounded" />
                <div className="h-8 w-28 bg-muted rounded" />
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <Card className="overflow-visible max-w-sm w-full text-center shadow-lg" data-testid="auth-prompt-card">
          <CardHeader>
            <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Lock className="w-6 h-6 text-primary" />
            </div>
            <h2 className="text-lg font-bold font-headline">Sign in to browse documents</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Access the full document archive including meeting minutes, budgets, and more from your town.
            </p>
          </CardHeader>
          <CardFooter className="flex-col gap-2">
            <Button className="w-full font-headline font-semibold" onClick={openSignIn} data-testid="button-signin-auth-gate">
              Sign in
            </Button>
            <Button variant="ghost" className="w-full" onClick={openSignIn} data-testid="button-create-account-auth-gate">
              Create an account
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}

const AVAILABLE_TOWNS = NH_TOWNS.filter((t) => t !== "statewide").slice(0, 30);

export default function DocumentsPage() {
  const { user, isLoading: authLoading } = useAuth();

  const { data: prefData } = useQuery<{ preferredTowns: string[] }>({
    queryKey: ["/api/feed/user/preferences"],
    enabled: !!user,
  });

  const defaultTown = useMemo(() => {
    if (user?.defaultTown) return user.defaultTown;
    const prefs = prefData?.preferredTowns;
    if (prefs && prefs.length > 0) return prefs[0];
    return "Conway";
  }, [user, prefData]);

  const userChangedTown = useRef(false);
  const [selectedTown, setSelectedTown] = useState<string>("Conway");

  useEffect(() => {
    if (!userChangedTown.current) {
      setSelectedTown(defaultTown);
    }
  }, [defaultTown]);

  const handleTownChange = useCallback((town: string) => {
    userChangedTown.current = true;
    setSelectedTown(town);
  }, []);

  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  const [drawer, setDrawer] = useState<ChatDrawerState>({ isOpen: false });
  const [townMenuOpen, setTownMenuOpen] = useState(false);
  const townMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (townMenuRef.current && !townMenuRef.current.contains(e.target as Node)) {
        setTownMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleAskAbout = useCallback((item: DocumentBrowseItem) => {
    const question = `Tell me about this document: ${item.canonicalTitle}`;
    setDrawer({
      isOpen: true,
      documentVersionId: item.id,
      question,
    });
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setDrawer({ isOpen: false });
  }, []);

  useEffect(() => {
    if (drawer.isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawer.isOpen]);

  if (authLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="border-b bg-card px-6 py-5 flex-shrink-0">
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="flex-1 p-6">
          <div className="max-w-3xl mx-auto space-y-4">
            <DocumentCardSkeleton />
            <DocumentCardSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col h-full">
        <div className="border-b bg-card px-6 md:px-8 py-5 flex-shrink-0">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center gap-3">
              <FileText className="w-5 h-5 text-primary" />
              <h1 className="text-xl font-black font-headline" data-testid="text-documents-title">
                Documents
              </h1>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Browse municipal documents, meeting minutes, and more.
            </p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <AuthGate />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="documents-page">
      <div className="border-b bg-card px-6 md:px-8 py-5 flex-shrink-0">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-primary flex-shrink-0" />
            <div>
              <h1 className="text-xl font-black font-headline" data-testid="text-documents-title">
                Documents
              </h1>
              <p className="text-xs text-muted-foreground">
                Browse municipal documents and meeting minutes
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative" ref={townMenuRef}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTownMenuOpen((v) => !v)}
                data-testid="button-town-selector"
              >
                {selectedTown}
                <ChevronDown className="w-3.5 h-3.5 ml-1.5" />
              </Button>
              {townMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg max-h-64 overflow-y-auto min-w-[10rem]">
                  {AVAILABLE_TOWNS.map((town) => (
                    <button
                      key={town}
                      className={`w-full text-left px-3 py-1.5 text-sm hover-elevate ${town === selectedTown ? "text-primary font-semibold" : "text-foreground"}`}
                      onClick={() => {
                        handleTownChange(town);
                        setTownMenuOpen(false);
                      }}
                      data-testid={`option-town-${town}`}
                    >
                      {town}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center border border-border rounded-md overflow-hidden">
              <Button
                variant={viewMode === "list" ? "default" : "ghost"}
                size="sm"
                className="rounded-none border-0"
                onClick={() => setViewMode("list")}
                data-testid="button-view-list"
              >
                <List className="w-3.5 h-3.5 mr-1.5" />
                List
              </Button>
              <Button
                variant={viewMode === "calendar" ? "default" : "ghost"}
                size="sm"
                className="rounded-none border-0"
                onClick={() => setViewMode("calendar")}
                data-testid="button-view-calendar"
              >
                <CalendarIcon className="w-3.5 h-3.5 mr-1.5" />
                Calendar
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-8 py-6">
          {viewMode === "list" ? (
            <div className="max-w-2xl">
              <DocumentListView town={selectedTown} onAskAbout={handleAskAbout} />
            </div>
          ) : (
            <DocumentCalendarView town={selectedTown} onAskAbout={handleAskAbout} />
          )}
        </div>
      </div>

      {drawer.isOpen && (
        <ChatDrawer state={drawer} onClose={handleCloseDrawer} />
      )}
    </div>
  );
}
