import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  FileText,
  Tag,
  X,
  Plus,
  Lightbulb,
  AlertCircle,
  CheckCircle,
  Loader2,
  Building2,
  Mail,
} from "lucide-react";
import type { UserKeyword } from "@shared/schema";

// ============================================================
// Auth Gate - Sign-in overlay for anonymous users
// ============================================================

function MagicLinkForm() {
  const [email, setEmail] = useState("");
  const { requestMagicLink, isSendingMagicLink, magicLinkSuccess, magicLinkError, resetMagicLink } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    try {
      await requestMagicLink(email);
    } catch {}
  };

  if (magicLinkSuccess) {
    return (
      <div className="flex flex-col items-center gap-4 py-4">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
          <CheckCircle className="w-6 h-6 text-primary" />
        </div>
        <div className="text-center">
          <p className="font-medium">Check your email</p>
          <p className="text-sm text-muted-foreground mt-1">We sent a sign-in link to {email}</p>
        </div>
        <Button variant="ghost" onClick={() => { resetMagicLink(); setEmail(""); }} data-testid="button-try-different-email">
          Try a different email
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="dashboard-email">Email address</Label>
        <Input
          id="dashboard-email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isSendingMagicLink}
          data-testid="input-dashboard-email"
        />
      </div>
      {magicLinkError && (
        <p className="text-sm text-destructive">Failed to send link. Please try again.</p>
      )}
      <Button type="submit" className="w-full" disabled={!email.trim() || isSendingMagicLink} data-testid="button-dashboard-send-link">
        {isSendingMagicLink ? (
          <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending...</>
        ) : (
          <><Mail className="w-4 h-4 mr-2" />Send sign-in link</>
        )}
      </Button>
    </form>
  );
}

// ============================================================
// New Docs Widget
// ============================================================

interface RecentDoc {
  id: string;
  canonicalTitle: string;
  town: string;
  category: string;
  updatedAt: string;
}

function NewDocsWidget({ enabled }: { enabled: boolean }) {
  const { data, isLoading } = useQuery<{ docs: RecentDoc[]; towns: string[] }>({
    queryKey: ["/api/dashboard/new-docs"],
    enabled,
  });

  const updatePrefMutation = useMutation({
    mutationFn: async (towns: string[]) => {
      await apiRequest("PUT", "/api/feed/user/preferences", { preferredTowns: towns });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/new-docs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/feed/user/preferences"] });
    },
  });

  const [townInput, setTownInput] = useState("");
  const towns = data?.towns ?? [];
  const docs = data?.docs ?? [];

  const addTown = () => {
    const trimmed = townInput.trim();
    if (!trimmed || towns.includes(trimmed)) return;
    updatePrefMutation.mutate([...towns, trimmed]);
    setTownInput("");
  };

  const removeTown = (town: string) => {
    updatePrefMutation.mutate(towns.filter((t) => t !== town));
  };

  const formatCategory = (cat: string) => cat.replace(/_/g, " ");

  return (
    <Card data-testid="widget-new-docs">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <FileText className="w-4 h-4 text-primary" />
          New &amp; Updated Documents
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Following towns</p>
          <div className="flex flex-wrap gap-2">
            {towns.map((town) => (
              <Badge key={town} variant="secondary" className="flex items-center gap-1 pr-1" data-testid={`badge-town-${town}`}>
                {town}
                <button
                  onClick={() => removeTown(town)}
                  className="ml-1 text-muted-foreground hover:text-foreground"
                  data-testid={`button-remove-town-${town}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            ))}
            {towns.length === 0 && (
              <span className="text-sm text-muted-foreground">No towns selected</span>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Add a town..."
              value={townInput}
              onChange={(e) => setTownInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTown()}
              className="text-sm"
              data-testid="input-add-town"
            />
            <Button size="default" onClick={addTown} disabled={updatePrefMutation.isPending} data-testid="button-add-town">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))
          ) : docs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              {towns.length === 0
                ? "Add towns above to see recent documents."
                : "No recent documents found for your towns."}
            </p>
          ) : (
            docs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-start justify-between gap-2 py-2 border-b last:border-0"
                data-testid={`doc-item-${doc.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{doc.canonicalTitle}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-muted-foreground">{doc.town}</span>
                    <span className="text-xs text-muted-foreground">&middot;</span>
                    <span className="text-xs text-muted-foreground">{formatCategory(doc.category)}</span>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(doc.updatedAt).toLocaleDateString()}
                </span>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Keywords Widget
// ============================================================

interface KeywordMatchDoc {
  id: string;
  canonicalTitle: string;
  town: string;
  category: string;
  updatedAt: string;
}

function KeywordsWidget({ enabled }: { enabled: boolean }) {
  const [newKeyword, setNewKeyword] = useState("");

  const { data: kwData, isLoading: kwLoading } = useQuery<{ keywords: UserKeyword[] }>({
    queryKey: ["/api/dashboard/keywords"],
    enabled,
  });

  const { data: matchData, isLoading: matchLoading } = useQuery<{ docs: KeywordMatchDoc[] }>({
    queryKey: ["/api/dashboard/keywords/matches"],
    enabled,
  });

  const addMutation = useMutation({
    mutationFn: async (keyword: string) => {
      await apiRequest("POST", "/api/dashboard/keywords", { keyword });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/keywords"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/keywords/matches"] });
      setNewKeyword("");
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/dashboard/keywords/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/keywords"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/keywords/matches"] });
    },
  });

  const keywords = kwData?.keywords ?? [];
  const matches = matchData?.docs ?? [];

  const addKeyword = () => {
    const trimmed = newKeyword.trim();
    if (!trimmed) return;
    addMutation.mutate(trimmed);
  };

  const formatCategory = (cat: string) => cat.replace(/_/g, " ");

  return (
    <Card data-testid="widget-keywords">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Tag className="w-4 h-4 text-primary" />
          Keyword Alerts
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Your keywords</p>
          <div className="flex flex-wrap gap-2">
            {kwLoading ? (
              <Skeleton className="h-6 w-24" />
            ) : keywords.length === 0 ? (
              <span className="text-sm text-muted-foreground">No keywords added</span>
            ) : (
              keywords.map((kw) => (
                <Badge key={kw.id} variant="outline" className="flex items-center gap-1 pr-1" data-testid={`badge-keyword-${kw.id}`}>
                  {kw.keyword}
                  <button
                    onClick={() => removeMutation.mutate(kw.id)}
                    className="ml-1 text-muted-foreground hover:text-foreground"
                    data-testid={`button-remove-keyword-${kw.id}`}
                    disabled={removeMutation.isPending}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. zoning, budget, warrant..."
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addKeyword()}
              className="text-sm"
              data-testid="input-add-keyword"
            />
            <Button size="default" onClick={addKeyword} disabled={addMutation.isPending} data-testid="button-add-keyword">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {keywords.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Matching documents</p>
            {matchLoading ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)
            ) : matches.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No matching documents found.</p>
            ) : (
              matches.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-start justify-between gap-2 py-2 border-b last:border-0"
                  data-testid={`keyword-match-${doc.id}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{doc.canonicalTitle}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">{doc.town}</span>
                      <span className="text-xs text-muted-foreground">&middot;</span>
                      <span className="text-xs text-muted-foreground">{formatCategory(doc.category)}</span>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(doc.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Suggest a Feature Widget
// ============================================================

function SuggestFeatureWidget() {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submitMutation = useMutation({
    mutationFn: async (featureText: string) => {
      await apiRequest("POST", "/api/dashboard/feature-requests", { text: featureText });
    },
    onSuccess: () => {
      setSubmitted(true);
      setText("");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    submitMutation.mutate(text.trim());
  };

  return (
    <Card data-testid="widget-suggest-feature">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Lightbulb className="w-4 h-4 text-primary" />
          Suggest a Feature
        </CardTitle>
      </CardHeader>
      <CardContent>
        {submitted ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle className="w-5 h-5 text-primary" />
            </div>
            <p className="font-medium text-sm">Thanks for your suggestion!</p>
            <p className="text-xs text-muted-foreground">We review all feature requests regularly.</p>
            <Button variant="ghost" size="sm" onClick={() => setSubmitted(false)} data-testid="button-suggest-another-feature">
              Submit another
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <Textarea
              placeholder="What feature would make OPENCouncil more useful for you?"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="resize-none text-sm"
              rows={4}
              data-testid="textarea-feature-request"
            />
            <Button
              type="submit"
              className="w-full"
              disabled={!text.trim() || submitMutation.isPending}
              data-testid="button-submit-feature-request"
            >
              {submitMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Submitting...</>
              ) : (
                "Submit Feature Request"
              )}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Suggest a Missing Document Widget
// ============================================================

function SuggestMissingDocWidget() {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submitMutation = useMutation({
    mutationFn: async (suggestionText: string) => {
      await apiRequest("POST", "/api/dashboard/missing-doc-suggestions", { text: suggestionText });
    },
    onSuccess: () => {
      setSubmitted(true);
      setText("");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    submitMutation.mutate(text.trim());
  };

  return (
    <Card data-testid="widget-missing-doc">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <AlertCircle className="w-4 h-4 text-primary" />
          Suggest a Missing Document
        </CardTitle>
      </CardHeader>
      <CardContent>
        {submitted ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle className="w-5 h-5 text-primary" />
            </div>
            <p className="font-medium text-sm">Thanks for the tip!</p>
            <p className="text-xs text-muted-foreground">We'll look into adding this document.</p>
            <Button variant="ghost" size="sm" onClick={() => setSubmitted(false)} data-testid="button-suggest-another-doc">
              Submit another
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <Textarea
              placeholder="Describe a document you believe should be in OPENCouncil but isn't (e.g., 'Conway 2023 capital improvement plan')."
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="resize-none text-sm"
              rows={4}
              data-testid="textarea-missing-doc"
            />
            <Button
              type="submit"
              className="w-full"
              disabled={!text.trim() || submitMutation.isPending}
              data-testid="button-submit-missing-doc"
            >
              {submitMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Submitting...</>
              ) : (
                "Submit Suggestion"
              )}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Anonymous Overlay
// ============================================================

function AnonOverlay() {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center">
      <Card className="w-full max-w-sm mx-4 shadow-lg" data-testid="card-anon-gate">
        <CardHeader className="text-center pb-3">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <Building2 className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-lg">Your Personalized Dashboard</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Sign in or create a free account to track documents, set keyword alerts, and submit feedback.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="w-full" data-testid="button-anon-sign-in">
                <Mail className="w-4 h-4 mr-2" />
                Sign in / Create Account
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Sign in to OPENCouncil</DialogTitle>
                <DialogDescription>
                  Get your personalized dashboard with document tracking, keyword alerts, and more.
                </DialogDescription>
              </DialogHeader>
              <MagicLinkForm />
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Dashboard Page
// ============================================================

export default function Dashboard() {
  const { usage } = useAuth();
  const isAuthenticated = usage?.isAuthenticated ?? false;

  return (
    <div className="h-full overflow-y-auto">
      <div className="relative max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold font-headline" data-testid="heading-dashboard">My Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Track what matters to you in your town&apos;s public record.
          </p>
        </div>

        <div className={`relative ${!isAuthenticated ? "select-none" : ""}`}>
          {!isAuthenticated && (
            <>
              <div
                className="absolute inset-0 z-[5] rounded-lg"
                style={{ backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
              />
              <AnonOverlay />
            </>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="md:col-span-2">
              <NewDocsWidget enabled={isAuthenticated} />
            </div>
            <div className="md:col-span-2">
              <KeywordsWidget enabled={isAuthenticated} />
            </div>
            <SuggestFeatureWidget />
            <SuggestMissingDocWidget />
          </div>
        </div>
      </div>
    </div>
  );
}
