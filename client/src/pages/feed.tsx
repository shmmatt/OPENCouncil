import TownFeedComponent from "@/components/TownFeed";

export default function FeedPage() {
  const handleQuestionClick = (
    question: string,
    feedItemId?: string,
    templateId?: string
  ) => {
    const params = new URLSearchParams();
    params.set("q", question);
    if (feedItemId) params.set("feedId", feedItemId);
    if (templateId) params.set("templateId", templateId);
    window.location.href = `/chat?${params.toString()}`;
  };

  return (
    <div className="min-h-screen bg-background">
      <TownFeedComponent onQuestionClick={handleQuestionClick} />
    </div>
  );
}
