import { useState, useCallback, useEffect } from "react";
import TownFeedComponent from "@/components/TownFeed";
import { ChatDrawer } from "@/components/ChatDrawer";
import type { ChatDrawerState } from "@/components/ChatDrawer";

export default function FeedLayout() {
  const [drawer, setDrawer] = useState<ChatDrawerState>({ isOpen: false });

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

  return (
    <div className="flex flex-col h-full" data-testid="feed-layout">
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
