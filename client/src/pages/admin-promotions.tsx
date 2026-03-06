import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Megaphone,
  FileText,
  BarChart3,
  LogOut,
  Loader2,
  Copy,
  Check,
  Save,
  Sparkles,
  Link as LinkIcon,
  Newspaper,
  BookOpen,
} from "lucide-react";
import type { TownFeedItem, Promotion, PromotionContentMatrix } from "@shared/schema";

type ChatTemplate = {
  id: string;
  title: string;
  slug: string | null;
  town: string;
  bannerText: string;
  generatedPayload: any;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type SourceTab = "feedItems" | "templates";

type SelectedSource = {
  type: "feedItem" | "template";
  id: string;
  title: string;
  town: string;
  updatedAt: string;
};

function adminFetch(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem("adminToken");
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

const CONTENT_FIELDS: { key: keyof PromotionContentMatrix; label: string; category: string }[] = [
  { key: "facebookPost", label: "Facebook Post", category: "Social Media" },
  { key: "instagramCaption", label: "Instagram Caption", category: "Social Media" },
  { key: "emailSubject", label: "Email Subject", category: "Email" },
  { key: "emailBody", label: "Email Body", category: "Email" },
  { key: "tiktokScript", label: "TikTok Script", category: "Video" },
  { key: "youtubeShortScript", label: "YouTube Short Script", category: "Video" },
  { key: "reelsScript", label: "Reels Script", category: "Video" },
];

export default function AdminPromotions() {
  const { toast } = useToast();
  const [sourceTab, setSourceTab] = useState<SourceTab>("feedItems");
  const [selectedSource, setSelectedSource] = useState<SelectedSource | null>(null);
  const [editedMatrix, setEditedMatrix] = useState<PromotionContentMatrix | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("adminToken");
    if (!token) {
      window.location.href = "/admin/login";
    }
  }, []);

  const { data: feedItems, isLoading: feedLoading } = useQuery<TownFeedItem[]>({
    queryKey: ["admin-promotions-feed-items"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/content/feed-items?status=published");
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem("adminToken");
          window.location.href = "/admin/login";
          return [];
        }
        throw new Error("Failed to fetch feed items");
      }
      return res.json();
    },
  });

  const { data: templates, isLoading: templatesLoading } = useQuery<ChatTemplate[]>({
    queryKey: ["admin-promotions-templates"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/templates");
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem("adminToken");
          window.location.href = "/admin/login";
          return [];
        }
        throw new Error("Failed to fetch templates");
      }
      return res.json();
    },
  });

  const promoQueryKey = selectedSource
    ? selectedSource.type === "feedItem"
      ? ["admin-promotions-promo", "feed", selectedSource.id]
      : ["admin-promotions-promo", "template", selectedSource.id]
    : ["admin-promotions-promo", "none"];

  const { data: promotion, isLoading: promoLoading } = useQuery<Promotion | null>({
    queryKey: promoQueryKey,
    enabled: !!selectedSource,
    queryFn: async () => {
      if (!selectedSource) return null;
      const endpoint = selectedSource.type === "feedItem"
        ? `/api/admin/promotions/by-feed-item/${selectedSource.id}`
        : `/api/admin/promotions/by-template/${selectedSource.id}`;
      const res = await adminFetch(endpoint);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch promotion");
      return res.json();
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSource) throw new Error("No source selected");
      const endpoint = selectedSource.type === "feedItem"
        ? `/api/admin/promotions/generate/${selectedSource.id}`
        : `/api/admin/promotions/generate-from-template/${selectedSource.id}`;
      const res = await adminFetch(endpoint, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Generation failed" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: (data: Promotion) => {
      queryClient.invalidateQueries({ queryKey: promoQueryKey });
      setEditedMatrix(data.contentMatrix || null);
      toast({ title: "Promotion assets generated" });
    },
    onError: (error: Error) => {
      toast({ title: "Generation failed", description: error.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!promotion || !editedMatrix) return;
      const res = await adminFetch(`/api/admin/promotions/${promotion.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentMatrix: editedMatrix }),
      });
      if (!res.ok) throw new Error("Save failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: promoQueryKey });
      toast({ title: "Changes saved" });
    },
    onError: (error: Error) => {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const handleFieldChange = useCallback((key: keyof PromotionContentMatrix, value: string) => {
    setEditedMatrix(prev => prev ? { ...prev, [key]: value } : null);
  }, []);

  const handleCopyUrl = useCallback(async (url: string) => {
    const fullUrl = `${window.location.origin}${url}`;
    await navigator.clipboard.writeText(fullUrl);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("adminToken");
    window.location.href = "/admin/login";
  };

  const handleSelectSource = (source: SelectedSource) => {
    setSelectedSource(source);
    setEditedMatrix(null);
  };

  const currentPromoMatrix = editedMatrix || promotion?.contentMatrix || null;

  const templatesWithPayload = templates?.filter(t => t.generatedPayload && t.slug) || [];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10">
              <Megaphone className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold" data-testid="text-page-title">OPENCouncil Admin</h1>
              <p className="text-sm text-muted-foreground">Promotions Hub</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" asChild data-testid="link-content">
              <Link href="/admin/content">
                <Sparkles className="w-4 h-4 mr-2" />
                Content
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-documents">
              <Link href="/admin/documents">
                <FileText className="w-4 h-4 mr-2" />
                Documents
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-testid="link-usage">
              <Link href="/admin/usage">
                <BarChart3 className="w-4 h-4 mr-2" />
                Analytics
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout} data-testid="button-logout">
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex gap-1">
                  <Button
                    variant={sourceTab === "feedItems" ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setSourceTab("feedItems")}
                    data-testid="tab-feed-items"
                  >
                    <Newspaper className="w-4 h-4 mr-1.5" />
                    Feed Items
                  </Button>
                  <Button
                    variant={sourceTab === "templates" ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setSourceTab("templates")}
                    data-testid="tab-templates"
                  >
                    <BookOpen className="w-4 h-4 mr-1.5" />
                    Templates
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {sourceTab === "feedItems" ? (
                  feedLoading ? (
                    <div className="space-y-2">
                      {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
                    </div>
                  ) : !feedItems?.length ? (
                    <p className="text-sm text-muted-foreground" data-testid="text-no-feed-items">
                      No published feed items found.
                    </p>
                  ) : (
                    feedItems.map(item => (
                      <button
                        key={item.id}
                        onClick={() => handleSelectSource({
                          type: "feedItem",
                          id: item.id,
                          title: item.title,
                          town: item.town,
                          updatedAt: item.updatedAt as any,
                        })}
                        className={`w-full text-left p-3 rounded-md border transition-colors ${
                          selectedSource?.type === "feedItem" && selectedSource.id === item.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover-elevate"
                        }`}
                        data-testid={`button-feed-item-${item.id}`}
                      >
                        <p className="text-sm font-medium line-clamp-2">{item.title}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="secondary" className="text-xs">{item.town}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(item.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                      </button>
                    ))
                  )
                ) : (
                  templatesLoading ? (
                    <div className="space-y-2">
                      {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
                    </div>
                  ) : !templatesWithPayload.length ? (
                    <p className="text-sm text-muted-foreground" data-testid="text-no-templates">
                      No templates with generated content found.
                    </p>
                  ) : (
                    templatesWithPayload.map(template => (
                      <button
                        key={template.id}
                        onClick={() => handleSelectSource({
                          type: "template",
                          id: template.id,
                          title: template.title,
                          town: template.town,
                          updatedAt: template.updatedAt,
                        })}
                        className={`w-full text-left p-3 rounded-md border transition-colors ${
                          selectedSource?.type === "template" && selectedSource.id === template.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover-elevate"
                        }`}
                        data-testid={`button-template-${template.id}`}
                      >
                        <p className="text-sm font-medium line-clamp-2">{template.title}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="secondary" className="text-xs">{template.town}</Badge>
                          {template.isActive && <Badge variant="default" className="text-xs">Active</Badge>}
                          <span className="text-xs text-muted-foreground">
                            {new Date(template.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                      </button>
                    ))
                  )
                )}
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-2 space-y-6">
            {!selectedSource ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Megaphone className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-muted-foreground" data-testid="text-select-prompt">
                    Select a feed item or template from the left to generate promotion assets.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
                    <div>
                      <CardTitle className="text-base" data-testid="text-selected-title">
                        {selectedSource.title}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        {selectedSource.town} &middot; {new Date(selectedSource.updatedAt).toLocaleDateString()}
                        &middot; <span className="capitalize">{selectedSource.type === "feedItem" ? "Feed Item" : "Template"}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {currentPromoMatrix && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => saveMutation.mutate()}
                          disabled={saveMutation.isPending || !editedMatrix}
                          data-testid="button-save"
                        >
                          {saveMutation.isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Save className="w-4 h-4 mr-2" />
                          )}
                          Save Edits
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={() => generateMutation.mutate()}
                        disabled={generateMutation.isPending}
                        data-testid="button-generate"
                      >
                        {generateMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Sparkles className="w-4 h-4 mr-2" />
                        )}
                        {currentPromoMatrix ? "Regenerate" : "Generate Promo Assets"}
                      </Button>
                    </div>
                  </CardHeader>
                </Card>

                {promoLoading ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 w-full" />)}
                  </div>
                ) : generateMutation.isPending ? (
                  <Card>
                    <CardContent className="py-12 text-center">
                      <Loader2 className="w-8 h-8 mx-auto animate-spin text-primary mb-3" />
                      <p className="text-muted-foreground" data-testid="text-generating">
                        Generating promotion assets with parallel AI calls...
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Text matrix + video matrix running simultaneously
                      </p>
                    </CardContent>
                  </Card>
                ) : currentPromoMatrix ? (
                  <>
                    {["Social Media", "Email", "Video"].map(category => (
                      <Card key={category}>
                        <CardHeader>
                          <CardTitle className="text-base" data-testid={`text-category-${category.toLowerCase().replace(" ", "-")}`}>
                            {category}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          {CONTENT_FIELDS.filter(f => f.category === category).map(field => (
                            <div key={field.key} className="space-y-1.5">
                              <Label htmlFor={field.key} data-testid={`label-${field.key}`}>
                                {field.label}
                              </Label>
                              <Textarea
                                id={field.key}
                                value={currentPromoMatrix[field.key] || ""}
                                onChange={e => {
                                  if (!editedMatrix && promotion?.contentMatrix) {
                                    setEditedMatrix({ ...promotion.contentMatrix });
                                  }
                                  handleFieldChange(field.key, e.target.value);
                                }}
                                rows={field.key === "emailBody" || field.key.includes("Script") ? 8 : 4}
                                className="font-mono text-sm"
                                data-testid={`textarea-${field.key}`}
                              />
                            </div>
                          ))}
                        </CardContent>
                      </Card>
                    ))}

                    {promotion?.deepLinks && (promotion.deepLinks as any[]).length > 0 && (
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base flex items-center gap-2">
                            <LinkIcon className="w-4 h-4" />
                            Deep Links
                          </CardTitle>
                          <p className="text-sm text-muted-foreground">
                            Share these links on social media to drop users directly into a pre-populated chat session.
                          </p>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          {(promotion.deepLinks as { question: string; url: string }[]).map((link, idx) => (
                            <div
                              key={idx}
                              className="flex items-start gap-3 p-3 rounded-md border"
                              data-testid={`deep-link-${idx}`}
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium" data-testid={`text-question-${idx}`}>
                                  {link.question}
                                </p>
                                <p className="text-xs text-muted-foreground mt-0.5 truncate" data-testid={`text-url-${idx}`}>
                                  {window.location.origin}{link.url}
                                </p>
                              </div>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => handleCopyUrl(link.url)}
                                data-testid={`button-copy-${idx}`}
                              >
                                {copiedUrl === link.url ? (
                                  <Check className="w-4 h-4 text-green-600" />
                                ) : (
                                  <Copy className="w-4 h-4" />
                                )}
                              </Button>
                            </div>
                          ))}
                        </CardContent>
                      </Card>
                    )}
                  </>
                ) : (
                  <Card>
                    <CardContent className="py-12 text-center">
                      <Sparkles className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                      <p className="text-muted-foreground" data-testid="text-no-promo">
                        No promotion assets yet. Click "Generate Promo Assets" to create social media content and deep links.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
