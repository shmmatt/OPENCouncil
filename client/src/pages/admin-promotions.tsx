import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
} from "lucide-react";
import type { TownFeedItem, Promotion, PromotionContentMatrix } from "@shared/schema";

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
  const [selectedFeedItemId, setSelectedFeedItemId] = useState<string | null>(null);
  const [editedMatrix, setEditedMatrix] = useState<PromotionContentMatrix | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const { data: feedItems, isLoading: feedLoading } = useQuery<TownFeedItem[]>({
    queryKey: ["/api/admin/content/feed-items?status=published"],
  });

  const { data: promotion, isLoading: promoLoading } = useQuery<Promotion | null>({
    queryKey: ["/api/admin/promotions/by-feed-item", selectedFeedItemId],
    enabled: !!selectedFeedItemId,
    queryFn: async () => {
      if (!selectedFeedItemId) return null;
      try {
        const res = await fetch(`/api/admin/promotions/by-feed-item/${selectedFeedItemId}`, {
          credentials: "include",
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("Failed to fetch promotion");
        return await res.json();
      } catch {
        return null;
      }
    },
  });

  const generateMutation = useMutation({
    mutationFn: async (feedItemId: string) => {
      const res = await apiRequest("POST", `/api/admin/promotions/generate/${feedItemId}`);
      return await res.json();
    },
    onSuccess: (data: Promotion) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/promotions/by-feed-item", selectedFeedItemId] });
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
      const res = await apiRequest("PATCH", `/api/admin/promotions/${promotion.id}`, {
        contentMatrix: editedMatrix,
      });
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/promotions/by-feed-item", selectedFeedItemId] });
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

  const handleSelectFeedItem = (id: string) => {
    setSelectedFeedItemId(id);
    setEditedMatrix(null);
  };

  const currentPromoMatrix = editedMatrix || promotion?.contentMatrix || null;

  const selectedItem = feedItems?.find(item => item.id === selectedFeedItemId);

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
          <div className="lg:col-span-1">
            <Card>
              <CardHeader>
                <CardTitle className="text-base" data-testid="text-feed-items-title">Published Feed Items</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {feedLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
                  </div>
                ) : !feedItems?.length ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-no-items">
                    No published feed items found. Generate and publish content first.
                  </p>
                ) : (
                  feedItems.map(item => (
                    <button
                      key={item.id}
                      onClick={() => handleSelectFeedItem(item.id)}
                      className={`w-full text-left p-3 rounded-md border transition-colors ${
                        selectedFeedItemId === item.id
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
                )}
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-2 space-y-6">
            {!selectedFeedItemId ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Megaphone className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-muted-foreground" data-testid="text-select-prompt">
                    Select a published feed item from the left to generate promotion assets.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
                    <div>
                      <CardTitle className="text-base" data-testid="text-selected-title">
                        {selectedItem?.title || "Selected Feed Item"}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        {selectedItem?.town} &middot; {selectedItem && new Date(selectedItem.updatedAt).toLocaleDateString()}
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
                        onClick={() => generateMutation.mutate(selectedFeedItemId)}
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
