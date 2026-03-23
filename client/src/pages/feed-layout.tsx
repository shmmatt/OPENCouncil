import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import TownFeedComponent from "@/components/TownFeed";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, MapPin } from "lucide-react";
import { ChatDrawer } from "@/components/ChatDrawer";
import type { ChatDrawerState } from "@/components/ChatDrawer";

export default function FeedLayout() {
  const [drawer, setDrawer] = useState<ChatDrawerState>({ isOpen: false });

  const { data: townsData } = useQuery<{ towns: string[] }>({
    queryKey: ["/api/meta/towns"],
  });

  const { data: prefData } = useQuery<{ preferredTowns: string[] }>({
    queryKey: ["/api/feed/user/preferences"],
  });

  const towns = townsData?.towns || ["Ossipee"];
  const selectedTown = prefData?.preferredTowns?.[0] || "";

  const setTownMutation = useMutation({
    mutationFn: async (town: string) => {
      await apiRequest("PUT", "/api/feed/user/preferences", {
        preferredTowns: [town],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed/user/preferences"] });
      queryClient.invalidateQueries({ queryKey: ["/api/feed/user"] });
    },
  });

  const handleTownChange = (town: string) => {
    setTownMutation.mutate(town);
  };

  const handleQuestionClick = useCallback(
    (question: string, feedItemId?: string, templateId?: string) => {
      const params = new URLSearchParams();
      params.set("chat", "open");
      if (feedItemId) params.set("feedId", feedItemId);
      if (templateId) params.set("templateId", templateId);

      window.history.pushState(null, "", `/feed?${params.toString()}`);

      setDrawer({
        isOpen: true,
        feedItemId,
        templateId,
        question,
        sessionId: undefined,
      });
    },
    []
  );

  const handleCloseDrawer = useCallback(() => {
    setDrawer({ isOpen: false });
    window.history.replaceState(null, "", "/feed");
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("chat")) {
        setDrawer({ isOpen: false });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
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

  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).toUpperCase();

  return (
    <div className="flex flex-col h-full" data-testid="feed-layout">
      <div className="border-b bg-card px-6 md:px-8 py-6 flex-shrink-0">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-black tracking-widest text-primary uppercase font-headline mb-1">
              Official Publication
            </p>
            <h1 className="text-3xl md:text-4xl font-black font-headline text-foreground leading-tight" data-testid="text-feed-title">
              The Civic Ledger
            </h1>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed max-w-xl">
              Verified municipal activities and legislative updates for the community of OPENCouncil.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              <Select value={selectedTown || towns[0]} onValueChange={handleTownChange}>
                <SelectTrigger className="w-44 h-8 text-sm" data-testid="select-feed-town">
                  <SelectValue placeholder="Select a town" />
                </SelectTrigger>
                <SelectContent>
                  {towns.map((town) => (
                    <SelectItem key={town} value={town} data-testid={`feed-town-option-${town}`}>
                      {town}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2 bg-muted border border-border rounded-full px-4 py-2 flex-shrink-0 self-start sm:self-auto">
            <Calendar className="w-3.5 h-3.5 text-primary flex-shrink-0" />
            <span className="text-[10px] font-black font-headline tracking-widest whitespace-nowrap" data-testid="text-feed-date">
              {today}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-8 py-6">
          <TownFeedComponent onQuestionClick={handleQuestionClick} />
        </div>
      </div>

      {drawer.isOpen && (
        <ChatDrawer state={drawer} onClose={handleCloseDrawer} />
      )}
    </div>
  );
}
