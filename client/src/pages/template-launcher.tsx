import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";

export default function TemplateLauncher() {
  const { slug } = useParams<{ slug: string }>();
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;

    async function launch() {
      try {
        const templateRes = await fetch(`/api/templates/by-slug/${slug}`, {
          credentials: "include",
        });
        if (!templateRes.ok) {
          setError("Template not found. This link may be invalid or expired.");
          return;
        }
        const template = await templateRes.json();

        const sessionRes = await apiRequest("POST", "/api/chat/sessions", {
          title: template.title,
          templateId: template.id,
        });
        const session = await sessionRes.json();

        setLocation(`/chat?session=${session.id}`);
      } catch (err) {
        console.error("Template launch error:", err);
        setError("Something went wrong. Please try again.");
      }
    }

    launch();
  }, [slug, setLocation]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen" data-testid="template-error">
        <div className="text-center space-y-4 max-w-md px-4">
          <h2 className="text-xl font-semibold">Unable to Load Template</h2>
          <p className="text-muted-foreground">{error}</p>
          <a
            href="/chat"
            className="inline-block text-primary underline hover-elevate"
            data-testid="link-back-to-chat"
          >
            Go to chat
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-screen" data-testid="template-loading">
      <div className="text-center space-y-3">
        <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading template...</p>
      </div>
    </div>
  );
}
