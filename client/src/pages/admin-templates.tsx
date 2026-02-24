import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Plus,
  Loader2,
  Sparkles,
  Trash2,
  Edit,
  Eye,
  FileText,
  DollarSign,
  HelpCircle,
  CheckCircle2,
  X,
} from "lucide-react";
import { NH_TOWNS } from "@shared/schema";
import type { ChatTemplate, LogicalDocument, TemplatePayload, TemplateSection } from "@shared/schema";

function adminFetch(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem("adminToken");
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

function PayloadPreview({ payload }: { payload: TemplatePayload }) {
  return (
    <div className="space-y-4" data-testid="payload-preview">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{payload.summary}</p>
      </div>

      <Separator />

      <div>
        <h4 className="text-sm font-medium mb-2">Sections ({payload.sections.length})</h4>
        <Accordion type="multiple" className="w-full">
          {payload.sections.map((section, idx) => (
            <AccordionItem key={idx} value={`section-${idx}`}>
              <AccordionTrigger className="text-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span>{section.title}</span>
                  {section.budgetAmount && (
                    <Badge variant="secondary">
                      <DollarSign className="w-3 h-3 mr-1" />
                      {section.budgetAmount}
                    </Badge>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-3 pl-2">
                  <p className="text-sm text-muted-foreground">{section.description}</p>
                  <div className="flex flex-wrap gap-2">
                    {section.suggestedQuestions.map((q, qIdx) => (
                      <Badge
                        key={qIdx}
                        variant="outline"
                        className="cursor-default text-xs py-1"
                      >
                        <HelpCircle className="w-3 h-3 mr-1 shrink-0" />
                        {q}
                      </Badge>
                    ))}
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>

      <Separator />

      <div>
        <h4 className="text-sm font-medium mb-2">High-Level Questions</h4>
        <div className="flex flex-wrap gap-2">
          {payload.highLevelQuestions.map((q, idx) => (
            <Badge key={idx} variant="outline" className="cursor-default text-xs py-1">
              <Sparkles className="w-3 h-3 mr-1 shrink-0" />
              {q}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

function TemplateForm({
  template,
  onClose,
}: {
  template?: ChatTemplate;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [title, setTitle] = useState(template?.title || "");
  const [slug, setSlug] = useState(template?.slug || "");
  const [bannerText, setBannerText] = useState(template?.bannerText || "");
  const [town, setTown] = useState(template?.town || "");
  const [isActive, setIsActive] = useState(template?.isActive || false);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>(
    (template?.targetDocumentIds as string[]) || []
  );
  const [payload, setPayload] = useState<TemplatePayload | null>(
    (template?.generatedPayload as TemplatePayload) || null
  );
  const [payloadJson, setPayloadJson] = useState(
    payload ? JSON.stringify(payload, null, 2) : ""
  );
  const [viewMode, setViewMode] = useState<"preview" | "json">("preview");
  const [docSearchQuery, setDocSearchQuery] = useState("");

  const { data: logicalDocs, isLoading: docsLoading } = useQuery<LogicalDocument[]>({
    queryKey: ["/api/admin/v2/documents"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/v2/documents");
      if (res.status === 401) {
        setLocation("/admin/login");
        throw new Error("Unauthorized");
      }
      return res.json();
    },
  });

  const filteredDocs = (logicalDocs || []).filter((doc) => {
    const matchesTown = !town || doc.town === town;
    const matchesSearch =
      !docSearchQuery ||
      doc.canonicalTitle.toLowerCase().includes(docSearchQuery.toLowerCase());
    return matchesTown && matchesSearch;
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      let finalPayload = payload;
      if (viewMode === "json" && payloadJson.trim()) {
        try {
          finalPayload = JSON.parse(payloadJson);
        } catch {
          throw new Error("Invalid JSON in payload editor");
        }
      }

      const body = {
        title,
        slug: slug || null,
        bannerText,
        town,
        targetDocumentIds: selectedDocIds,
        generatedPayload: finalPayload,
        isActive,
      };

      if (template) {
        await adminFetch(`/api/admin/templates/${template.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      } else {
        const res = await adminFetch("/api/admin/templates", {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error("Failed to create template");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/templates"] });
      toast({ title: template ? "Template updated" : "Template created" });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!template) {
        const res = await adminFetch("/api/admin/templates", {
          method: "POST",
          body: JSON.stringify({
            title,
            bannerText,
            town,
            targetDocumentIds: selectedDocIds,
          }),
        });
        if (!res.ok) throw new Error("Failed to save template before generating");
        const created = await res.json();
        const genRes = await adminFetch(
          `/api/admin/templates/${created.id}/generate`,
          { method: "POST" }
        );
        if (!genRes.ok) throw new Error("Failed to generate summary");
        return { ...(await genRes.json()), templateId: created.id };
      } else {
        await adminFetch(`/api/admin/templates/${template.id}`, {
          method: "PUT",
          body: JSON.stringify({ targetDocumentIds: selectedDocIds }),
        });
        const genRes = await adminFetch(
          `/api/admin/templates/${template.id}/generate`,
          { method: "POST" }
        );
        if (!genRes.ok) throw new Error("Failed to generate summary");
        return { ...(await genRes.json()), templateId: template.id };
      }
    },
    onSuccess: (data) => {
      setPayload(data.payload);
      setPayloadJson(JSON.stringify(data.payload, null, 2));
      queryClient.invalidateQueries({ queryKey: ["/api/admin/templates"] });
      toast({ title: "Summary generated successfully" });
    },
    onError: (err: Error) => {
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleDoc = (docId: string) => {
    setSelectedDocIds((prev) =>
      prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId]
    );
  };

  const canGenerate = selectedDocIds.length > 0 && title && town;
  const canSave = title && bannerText && town && selectedDocIds.length > 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="template-title">Template Title</Label>
          <Input
            id="template-title"
            data-testid="input-template-title"
            placeholder="e.g., 2025 Town Warrant Decoder"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="banner-text">Banner Button Text</Label>
          <Input
            id="banner-text"
            data-testid="input-banner-text"
            placeholder="e.g., Explore the 2025 Town Warrant"
            value={bannerText}
            onChange={(e) => setBannerText(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="template-slug">URL Slug (shareable link)</Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground whitespace-nowrap">/chat/t/</span>
          <Input
            id="template-slug"
            data-testid="input-template-slug"
            placeholder="e.g., warrant-2025"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-"))}
          />
        </div>
        {slug && (
          <p className="text-xs text-muted-foreground">
            Share this link: {window.location.origin}/chat/t/{slug}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Town</Label>
          <Select value={town} onValueChange={setTown}>
            <SelectTrigger data-testid="select-town">
              <SelectValue placeholder="Select town" />
            </SelectTrigger>
            <SelectContent>
              {NH_TOWNS.filter((t) => t !== "statewide").map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="active-toggle"
              data-testid="switch-active"
              checked={isActive}
              onCheckedChange={setIsActive}
            />
            <Label htmlFor="active-toggle">Active (visible to public)</Label>
          </div>
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label>Target Documents</Label>
        <Input
          data-testid="input-doc-search"
          placeholder="Search documents..."
          value={docSearchQuery}
          onChange={(e) => setDocSearchQuery(e.target.value)}
        />
        {selectedDocIds.length > 0 && (
          <div className="flex flex-wrap gap-1 py-1">
            {selectedDocIds.map((docId) => {
              const doc = logicalDocs?.find((d) => d.id === docId);
              return (
                <Badge key={docId} variant="secondary" className="gap-1">
                  <FileText className="w-3 h-3" />
                  <span className="max-w-[200px] truncate">{doc?.canonicalTitle || docId}</span>
                  <button onClick={() => toggleDoc(docId)} className="ml-1">
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}
        <ScrollArea className="h-[200px] border rounded-md">
          {docsLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filteredDocs.map((doc) => (
                <button
                  key={doc.id}
                  data-testid={`doc-option-${doc.id}`}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2 hover-elevate ${
                    selectedDocIds.includes(doc.id)
                      ? "bg-primary/10 font-medium"
                      : ""
                  }`}
                  onClick={() => toggleDoc(doc.id)}
                >
                  {selectedDocIds.includes(doc.id) ? (
                    <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                  ) : (
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="truncate">{doc.canonicalTitle}</span>
                  <Badge variant="outline" className="ml-auto shrink-0 text-xs">
                    {doc.town}
                  </Badge>
                </button>
              ))}
              {filteredDocs.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No documents found{town ? ` for ${town}` : ""}
                </p>
              )}
            </div>
          )}
        </ScrollArea>
      </div>

      <Separator />

      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Generated Summary</h3>
            {payload && (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={viewMode === "preview" ? "default" : "outline"}
                  onClick={() => setViewMode("preview")}
                  data-testid="button-view-preview"
                >
                  <Eye className="w-3 h-3 mr-1" />
                  Preview
                </Button>
                <Button
                  size="sm"
                  variant={viewMode === "json" ? "default" : "outline"}
                  onClick={() => setViewMode("json")}
                  data-testid="button-view-json"
                >
                  <Edit className="w-3 h-3 mr-1" />
                  Edit JSON
                </Button>
              </div>
            )}
          </div>
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={!canGenerate || generateMutation.isPending}
            data-testid="button-generate-summary"
          >
            {generateMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-2" />
            )}
            {generateMutation.isPending ? "Generating..." : "Generate Summary"}
          </Button>
        </div>

        {payload ? (
          viewMode === "preview" ? (
            <Card>
              <CardContent className="pt-4">
                <PayloadPreview payload={payload} />
              </CardContent>
            </Card>
          ) : (
            <Textarea
              data-testid="textarea-payload-json"
              value={payloadJson}
              onChange={(e) => setPayloadJson(e.target.value)}
              className="font-mono text-xs min-h-[400px]"
            />
          )
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">
                Select documents and click "Generate Summary" to create the interactive chat template.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onClose} data-testid="button-cancel">
          Cancel
        </Button>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={!canSave || saveMutation.isPending}
          data-testid="button-save-template"
        >
          {saveMutation.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <CheckCircle2 className="w-4 h-4 mr-2" />
          )}
          {template ? "Update Template" : "Save Template"}
        </Button>
      </div>
    </div>
  );
}

export default function AdminTemplates() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [editingTemplate, setEditingTemplate] = useState<ChatTemplate | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const token = localStorage.getItem("adminToken");
  useEffect(() => {
    if (!token) setLocation("/admin/login");
  }, [token, setLocation]);

  const { data: templates, isLoading } = useQuery<ChatTemplate[]>({
    queryKey: ["/api/admin/templates"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/templates");
      if (res.status === 401) {
        localStorage.removeItem("adminToken");
        setLocation("/admin/login");
        throw new Error("Unauthorized");
      }
      return res.json();
    },
    enabled: !!token,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await adminFetch(`/api/admin/templates/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/templates"] });
      toast({ title: "Template deleted" });
    },
  });

  if (isCreating || editingTemplate) {
    return (
      <div className="min-h-screen bg-background p-4 md:p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setIsCreating(false);
                setEditingTemplate(null);
              }}
              data-testid="button-back-from-form"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="text-xl font-semibold">
              {editingTemplate ? "Edit Template" : "New Template"}
            </h1>
          </div>
          <TemplateForm
            template={editingTemplate || undefined}
            onClose={() => {
              setIsCreating(false);
              setEditingTemplate(null);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLocation("/admin/ingestion")}
              data-testid="button-back"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="text-xl font-semibold">Document Chat Templates</h1>
              <p className="text-sm text-muted-foreground">
                Create guided chat experiences from municipal documents
              </p>
            </div>
          </div>
          <Button onClick={() => setIsCreating(true)} data-testid="button-new-template">
            <Plus className="w-4 h-4 mr-2" />
            New Template
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : templates && templates.length > 0 ? (
          <div className="space-y-3">
            {templates.map((t) => (
              <Card key={t.id} data-testid={`template-card-${t.id}`}>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <CardTitle className="text-base truncate">{t.title}</CardTitle>
                    {t.isActive && (
                      <Badge variant="default" className="shrink-0">Active</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setEditingTemplate(t)}
                      data-testid={`button-edit-${t.id}`}
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteMutation.mutate(t.id)}
                      data-testid={`button-delete-${t.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                    <span>{t.town}</span>
                    <span>{(t.targetDocumentIds as string[])?.length || 0} documents</span>
                    <span>Banner: &ldquo;{t.bannerText}&rdquo;</span>
                    {t.slug && (
                      <Badge variant="outline" className="text-xs font-mono">
                        /chat/t/{t.slug}
                      </Badge>
                    )}
                    {t.generatedPayload ? (
                      <Badge variant="outline" className="text-xs">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        Summary generated
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        No summary yet
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Sparkles className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
              <h3 className="text-lg font-medium mb-1">No templates yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Create your first document chat template to help citizens explore municipal documents.
              </p>
              <Button onClick={() => setIsCreating(true)} data-testid="button-create-first">
                <Plus className="w-4 h-4 mr-2" />
                Create Template
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
