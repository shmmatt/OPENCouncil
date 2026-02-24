import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { X, Sparkles } from "lucide-react";
import type { TemplatePayload } from "@shared/schema";

interface ActiveTemplate {
  id: string;
  title: string;
  bannerText: string;
  town: string;
  generatedPayload: TemplatePayload | null;
}

export function TemplateBanner({
  onLaunch,
}: {
  onLaunch: (templateId: string, title: string) => void;
}) {
  const [dismissed, setDismissed] = useState(false);

  const { data: template } = useQuery<ActiveTemplate | null>({
    queryKey: ["/api/templates/active"],
    queryFn: async () => {
      const res = await fetch("/api/templates/active", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 60000,
  });

  if (!template || dismissed || !template.generatedPayload) return null;

  return (
    <div
      className="bg-primary text-primary-foreground px-4 py-2 flex items-center justify-between gap-3"
      data-testid="template-banner"
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Sparkles className="w-4 h-4 shrink-0" />
        <Button
          variant="secondary"
          size="sm"
          className="font-medium"
          onClick={() => onLaunch(template.id, template.title)}
          data-testid="button-launch-template"
        >
          {template.bannerText}
        </Button>
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="shrink-0 text-primary-foreground/80"
        onClick={() => setDismissed(true)}
        data-testid="button-dismiss-banner"
      >
        <X className="w-4 h-4" />
      </Button>
    </div>
  );
}
