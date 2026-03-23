import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Plus, MessageCircle, Rss } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { ChatSession } from "@shared/schema";

export function ChatSidebarPanel() {
  const [location, navigate] = useLocation();
  const searchString = useSearch();

  const { data: sessions } = useQuery<ChatSession[]>({
    queryKey: ["/api/chat/sessions"],
  });

  const { data: townsData } = useQuery<{ towns: string[] }>({
    queryKey: ["/api/meta/towns"],
  });

  const { data: prefData } = useQuery<{ town: string }>({
    queryKey: ["/api/preferences/town"],
  });

  const towns = townsData?.towns || ["Ossipee"];
  const selectedTown = prefData?.town || towns[0] || "Ossipee";

  const activeSessionId = new URLSearchParams(searchString).get("session");

  const setTownMutation = useMutation({
    mutationFn: async (town: string) => {
      await apiRequest("POST", "/api/preferences/town", {
        town,
        sessionId: activeSessionId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/preferences/town"] });
      queryClient.invalidateQueries({ queryKey: ["/api/updates/minutes"] });
    },
  });

  const createSessionMutation = useMutation({
    mutationFn: async (): Promise<ChatSession> => {
      const res = await apiRequest("POST", "/api/chat/sessions", {
        title: "New conversation",
      });
      return res.json();
    },
    onSuccess: (newSession: ChatSession) => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/sessions"] });
      navigate(`/chat?session=${newSession.id}`);
    },
  });

  const handleNewChat = () => {
    createSessionMutation.mutate();
  };

  const handleSessionClick = (id: string) => {
    navigate(`/chat?session=${id}`);
  };

  const handleTownChange = (town: string) => {
    setTownMutation.mutate(town);
  };

  const isFeedActive = location.startsWith("/feed");

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 space-y-2 border-b border-sidebar-border">
        <Button
          onClick={handleNewChat}
          className="w-full font-headline font-semibold"
          disabled={createSessionMutation.isPending}
          data-testid="button-new-chat"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Chat
        </Button>
        <Button
          asChild
          className="w-full font-headline"
          variant={isFeedActive ? "default" : "outline"}
          data-testid="link-town-feed"
        >
          <Link href="/feed">
            <Rss className="w-4 h-4 mr-2" />
            Town Feed
          </Link>
        </Button>
      </div>

      <div className="p-3 border-b border-sidebar-border">
        <label className="text-xs font-semibold text-muted-foreground mb-1.5 block uppercase tracking-wider">
          Town
        </label>
        <Select value={selectedTown} onValueChange={handleTownChange}>
          <SelectTrigger className="w-full" data-testid="select-chat-town">
            <SelectValue placeholder="Select a town" />
          </SelectTrigger>
          <SelectContent>
            {towns.map((town) => (
              <SelectItem key={town} value={town} data-testid={`chat-town-option-${town}`}>
                {town}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator />

      <div className="p-3 pb-1">
        <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-2">
          Conversations
        </h3>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-2 pb-2 space-y-0.5">
          {sessions?.map((session) => (
            <button
              key={session.id}
              onClick={() => handleSessionClick(session.id)}
              className={`w-full text-left p-3 rounded-md hover-elevate active-elevate-2 transition-colors ${
                activeSessionId === session.id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground"
              }`}
              data-testid={`button-session-${session.id}`}
            >
              <div className="flex items-start gap-2">
                <MessageCircle className="w-3.5 h-3.5 mt-1 flex-shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{session.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(session.updatedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
