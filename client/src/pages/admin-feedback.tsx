import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Lightbulb, AlertCircle, Link } from "lucide-react";
import type { FeatureRequest, MissingDocSuggestion } from "@shared/schema";

interface FeedbackData {
  featureRequests: FeatureRequest[];
  missingDocSuggestions: MissingDocSuggestion[];
}

export default function AdminFeedback() {
  const { data, isLoading, error } = useQuery<FeedbackData>({
    queryKey: ["/api/dashboard/admin/feedback"],
  });

  const formatDate = (d: string | Date) =>
    new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold" data-testid="heading-admin-feedback">User Feedback</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Feature requests and missing document suggestions submitted by users.
            </p>
          </div>
          <a href="/admin/document-gaps" className="text-sm text-muted-foreground hover:underline">
            &larr; Back to Admin
          </a>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              Failed to load feedback. Make sure you are signed in as an admin.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card data-testid="card-feature-requests">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Lightbulb className="w-4 h-4 text-primary" />
                  Feature Requests
                  <Badge variant="secondary" className="ml-auto">
                    {data?.featureRequests.length ?? 0}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {!data?.featureRequests.length ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No feature requests yet.</p>
                ) : (
                  data.featureRequests.map((req) => (
                    <div
                      key={req.id}
                      className="p-3 rounded-md bg-muted/40 space-y-1"
                      data-testid={`feature-request-${req.id}`}
                    >
                      <p className="text-sm">{req.text}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{formatDate(req.createdAt)}</span>
                        <span className="text-xs text-muted-foreground">&middot;</span>
                        <span className="text-xs text-muted-foreground font-mono truncate max-w-[120px]">{req.userId}</span>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card data-testid="card-missing-docs">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <AlertCircle className="w-4 h-4 text-primary" />
                  Missing Doc Suggestions
                  <Badge variant="secondary" className="ml-auto">
                    {data?.missingDocSuggestions.length ?? 0}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {!data?.missingDocSuggestions.length ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No suggestions yet.</p>
                ) : (
                  data.missingDocSuggestions.map((sug) => (
                    <div
                      key={sug.id}
                      className="p-3 rounded-md bg-muted/40 space-y-1"
                      data-testid={`missing-doc-${sug.id}`}
                    >
                      <p className="text-sm">{sug.text}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{formatDate(sug.createdAt)}</span>
                        <span className="text-xs text-muted-foreground">&middot;</span>
                        <span className="text-xs text-muted-foreground font-mono truncate max-w-[120px]">{sug.userId}</span>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
