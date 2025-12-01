import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { 
  Upload, 
  Loader2, 
  FileText, 
  ArrowLeft, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle,
  Eye,
  ThumbsUp,
  ThumbsDown,
  FolderUp,
  Clock,
  Archive,
  RefreshCw
} from "lucide-react";
import type { IngestionJobWithBlob, LogicalDocument } from "@shared/schema";

const CATEGORY_OPTIONS = [
  { label: "Budget", value: "budget" },
  { label: "Zoning", value: "zoning" },
  { label: "Meeting Minutes", value: "meeting_minutes" },
  { label: "Town Report", value: "town_report" },
  { label: "Warrant Article", value: "warrant_article" },
  { label: "Ordinance", value: "ordinance" },
  { label: "Policy", value: "policy" },
  { label: "Planning Board Docs", value: "planning_board_docs" },
  { label: "ZBA Docs", value: "zba_docs" },
  { label: "Licensing/Permits", value: "licensing_permits" },
  { label: "CIP", value: "cip" },
  { label: "Elections", value: "elections" },
  { label: "Misc / Other", value: "misc_other" },
];

function getCategoryLabel(value: string | null): string {
  if (!value) return "-";
  const option = CATEGORY_OPTIONS.find((opt) => opt.value === value);
  return option ? option.label : value;
}

function getStatusBadge(status: string) {
  switch (status) {
    case "needs_review":
      return <Badge variant="outline" className="text-yellow-600 border-yellow-600"><Clock className="w-3 h-3 mr-1" />Needs Review</Badge>;
    case "approved":
      return <Badge variant="outline" className="text-blue-600 border-blue-600"><ThumbsUp className="w-3 h-3 mr-1" />Approved</Badge>;
    case "indexed":
      return <Badge variant="outline" className="text-green-600 border-green-600"><CheckCircle2 className="w-3 h-3 mr-1" />Indexed</Badge>;
    case "rejected":
      return <Badge variant="outline" className="text-red-600 border-red-600"><XCircle className="w-3 h-3 mr-1" />Rejected</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

interface ReviewFormState {
  category: string;
  town: string;
  board: string;
  year: string;
  notes: string;
  documentLinkMode: "new" | "existing";
  documentId: string;
}

export default function AdminIngestion() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("needs_review");
  const [selectedJob, setSelectedJob] = useState<IngestionJobWithBlob | null>(null);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [formState, setFormState] = useState<ReviewFormState>({
    category: "",
    town: "",
    board: "",
    year: "",
    notes: "",
    documentLinkMode: "new",
    documentId: "",
  });

  // Fetch ingestion jobs
  const { data: jobs, isLoading: jobsLoading, refetch: refetchJobs } = useQuery<IngestionJobWithBlob[]>({
    queryKey: ["/api/admin/ingestion/jobs", activeTab],
    queryFn: async () => {
      const token = localStorage.getItem("adminToken");
      const response = await fetch(`/api/admin/ingestion/jobs?status=${activeTab}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem("adminToken");
          setLocation("/admin/login");
          throw new Error("Session expired");
        }
        throw new Error("Failed to fetch jobs");
      }
      return response.json();
    },
  });

  // Fetch existing documents for linking
  const { data: existingDocs } = useQuery<LogicalDocument[]>({
    queryKey: ["/api/admin/v2/documents"],
    queryFn: async () => {
      const token = localStorage.getItem("adminToken");
      const response = await fetch("/api/admin/v2/documents", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return [];
      return response.json();
    },
  });

  // Analyze mutation
  const analyzeMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const token = localStorage.getItem("adminToken");
      const response = await fetch("/api/admin/ingestion/analyze", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Analysis failed");
      }
      return response.json();
    },
    onSuccess: (data) => {
      setFiles([]);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ingestion/jobs"] });
      toast({
        title: "Analysis complete",
        description: `${data.jobs?.length || 0} file(s) analyzed and ready for review`,
      });
      setActiveTab("needs_review");
    },
    onError: (error: Error) => {
      toast({
        title: "Analysis failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Approve + Index mutation (combined for convenience)
  const approveAndIndexMutation = useMutation({
    mutationFn: async ({ jobId, metadata }: { jobId: string; metadata: ReviewFormState }) => {
      const token = localStorage.getItem("adminToken");
      
      // First approve
      const approveResponse = await fetch(`/api/admin/ingestion/jobs/${jobId}/approve`, {
        method: "POST",
        headers: { 
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          finalMetadata: {
            category: metadata.category,
            town: metadata.town,
            board: metadata.board,
            year: metadata.year,
            notes: metadata.notes,
          },
          documentLinkMode: metadata.documentLinkMode,
          documentId: metadata.documentId || undefined,
        }),
      });
      
      if (!approveResponse.ok) {
        const error = await approveResponse.json();
        throw new Error(error.message || "Approval failed");
      }
      
      // Then index
      const indexResponse = await fetch(`/api/admin/ingestion/jobs/${jobId}/index`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      
      if (!indexResponse.ok) {
        const error = await indexResponse.json();
        throw new Error(error.message || "Indexing failed");
      }
      
      return indexResponse.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ingestion/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/documents"] });
      setReviewDialogOpen(false);
      setSelectedJob(null);
      toast({
        title: "Document indexed",
        description: "Document has been approved and indexed to the knowledge base",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Operation failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Reject mutation
  const rejectMutation = useMutation({
    mutationFn: async ({ jobId, reason }: { jobId: string; reason?: string }) => {
      const token = localStorage.getItem("adminToken");
      const response = await fetch(`/api/admin/ingestion/jobs/${jobId}/reject`, {
        method: "POST",
        headers: { 
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Rejection failed");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ingestion/jobs"] });
      setReviewDialogOpen(false);
      setSelectedJob(null);
      toast({
        title: "Document rejected",
        description: "The document has been rejected and will not be indexed",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Rejection failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  };

  const handleAnalyze = () => {
    if (files.length === 0) return;
    
    const formData = new FormData();
    files.forEach((file) => {
      formData.append("files", file);
    });
    
    analyzeMutation.mutate(formData);
  };

  const openReviewDialog = (job: IngestionJobWithBlob) => {
    setSelectedJob(job);
    const suggested = job.suggestedMetadata as any || {};
    setFormState({
      category: suggested.category || "misc_other",
      town: suggested.town || "",
      board: suggested.board || "",
      year: suggested.year || "",
      notes: suggested.notes || "",
      documentLinkMode: "new",
      documentId: "",
    });
    setReviewDialogOpen(true);
  };

  const handleApproveAndIndex = () => {
    if (!selectedJob || !formState.category) return;
    approveAndIndexMutation.mutate({
      jobId: selectedJob.id,
      metadata: formState,
    });
  };

  const handleReject = () => {
    if (!selectedJob) return;
    rejectMutation.mutate({
      jobId: selectedJob.id,
      reason: "Rejected by admin",
    });
  };

  const getDuplicateWarningDisplay = (warning: string | null) => {
    if (!warning) return null;
    
    if (warning.startsWith("exact_duplicate:")) {
      const filename = warning.replace("exact_duplicate:", "");
      return (
        <div className="flex items-center gap-2 text-red-600 text-sm">
          <AlertTriangle className="w-4 h-4" />
          <span>Exact duplicate of: {filename}</span>
        </div>
      );
    }
    
    if (warning.startsWith("preview_match:")) {
      const filename = warning.replace("preview_match:", "");
      return (
        <div className="flex items-center gap-2 text-yellow-600 text-sm">
          <AlertTriangle className="w-4 h-4" />
          <span>Similar content to: {filename}</span>
        </div>
      );
    }
    
    return null;
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10">
              <FolderUp className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Ingestion Pipeline</h1>
              <p className="text-sm text-muted-foreground">v2 Document Management</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild data-testid="link-v2-docs">
              <Link href="/admin/documents-v2">
                <FileText className="w-4 h-4 mr-2" />
                v2 Documents
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild data-testid="link-back-documents">
              <Link href="/admin/documents">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Documents
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Upload Section */}
        <Card>
          <CardHeader>
            <CardTitle>Upload New Documents</CardTitle>
            <CardDescription>
              Upload files to analyze and queue for review. Documents will be processed with AI-suggested metadata.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ingestion-file-upload">Document Files</Label>
              <Input
                id="ingestion-file-upload"
                type="file"
                accept=".pdf,.docx,.txt"
                multiple
                onChange={handleFileChange}
                data-testid="input-files"
              />
              <p className="text-xs text-muted-foreground">
                Supported formats: PDF, DOCX, TXT (max 100MB each)
              </p>
            </div>

            {files.length > 0 && (
              <div className="space-y-2">
                <Label>Selected Files ({files.length})</Label>
                <div className="rounded-md border p-3 space-y-2 max-h-32 overflow-y-auto">
                  {files.map((file, index) => (
                    <div key={index} className="flex items-center gap-2 text-sm">
                      <FileText className="w-4 h-4 text-muted-foreground" />
                      <span className="font-mono">{file.name}</span>
                      <span className="text-muted-foreground">
                        ({(file.size / 1024 / 1024).toFixed(2)} MB)
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
          <CardFooter>
            <Button
              onClick={handleAnalyze}
              disabled={files.length === 0 || analyzeMutation.isPending}
              data-testid="button-analyze"
            >
              {analyzeMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  Analyze Files ({files.length})
                </>
              )}
            </Button>
          </CardFooter>
        </Card>

        {/* Jobs Queue Section */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle>Ingestion Queue</CardTitle>
                <CardDescription>
                  Review and approve documents before they are indexed to the knowledge base
                </CardDescription>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => refetchJobs()}
                data-testid="button-refresh"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="mb-4">
                <TabsTrigger value="needs_review" data-testid="tab-needs-review">
                  <Clock className="w-4 h-4 mr-2" />
                  Needs Review
                </TabsTrigger>
                <TabsTrigger value="approved" data-testid="tab-approved">
                  <ThumbsUp className="w-4 h-4 mr-2" />
                  Approved
                </TabsTrigger>
                <TabsTrigger value="indexed" data-testid="tab-indexed">
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Indexed
                </TabsTrigger>
                <TabsTrigger value="rejected" data-testid="tab-rejected">
                  <XCircle className="w-4 h-4 mr-2" />
                  Rejected
                </TabsTrigger>
              </TabsList>

              <TabsContent value={activeTab}>
                {jobsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  </div>
                ) : !jobs || jobs.length === 0 ? (
                  <div className="text-center py-12">
                    <Archive className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground mb-2">No jobs in this queue</p>
                    <p className="text-sm text-muted-foreground">
                      {activeTab === "needs_review" 
                        ? "Upload documents to start the ingestion process" 
                        : "Jobs will appear here as they are processed"}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Filename</TableHead>
                          <TableHead>Suggested Category</TableHead>
                          <TableHead>Suggested Town</TableHead>
                          <TableHead>Warnings</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead className="w-[100px]">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {jobs.map((job) => {
                          const suggested = job.suggestedMetadata as any || {};
                          return (
                            <TableRow key={job.id} data-testid={`row-job-${job.id}`}>
                              <TableCell className="font-mono text-sm">
                                {job.fileBlob.originalFilename}
                              </TableCell>
                              <TableCell>{getCategoryLabel(suggested.category)}</TableCell>
                              <TableCell>{suggested.town || "-"}</TableCell>
                              <TableCell>
                                {getDuplicateWarningDisplay(job.duplicateWarning)}
                              </TableCell>
                              <TableCell>{getStatusBadge(job.status)}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {new Date(job.createdAt).toLocaleDateString()}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openReviewDialog(job)}
                                  data-testid={`button-review-${job.id}`}
                                >
                                  <Eye className="w-4 h-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </main>

      {/* Review Dialog */}
      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Review Document</DialogTitle>
            <DialogDescription>
              Review and edit metadata before approving for indexing
            </DialogDescription>
          </DialogHeader>
          
          <ScrollArea className="flex-1 pr-4">
            {selectedJob && (
              <div className="space-y-6 py-4">
                {/* File Info */}
                <div className="p-4 rounded-lg bg-muted/50 space-y-2">
                  <div className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-muted-foreground" />
                    <span className="font-mono font-medium">{selectedJob.fileBlob.originalFilename}</span>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Size: {(selectedJob.fileBlob.sizeBytes / 1024 / 1024).toFixed(2)} MB | 
                    Type: {selectedJob.fileBlob.mimeType}
                  </div>
                  {getDuplicateWarningDisplay(selectedJob.duplicateWarning)}
                </div>

                {/* Preview Text */}
                {selectedJob.fileBlob.previewText && (
                  <div className="space-y-2">
                    <Label>Preview Excerpt</Label>
                    <div className="p-3 rounded-md border bg-background text-sm max-h-32 overflow-y-auto font-mono">
                      {selectedJob.fileBlob.previewText.slice(0, 500)}...
                    </div>
                  </div>
                )}

                {/* Metadata Form */}
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="review-category">Category *</Label>
                    <Select 
                      value={formState.category} 
                      onValueChange={(v) => setFormState(prev => ({ ...prev, category: v }))}
                    >
                      <SelectTrigger id="review-category" data-testid="select-review-category">
                        <SelectValue placeholder="Select category..." />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="review-town">Town</Label>
                      <Input
                        id="review-town"
                        placeholder="e.g., Manchester, statewide"
                        value={formState.town}
                        onChange={(e) => setFormState(prev => ({ ...prev, town: e.target.value }))}
                        data-testid="input-review-town"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="review-board">Board/Department</Label>
                      <Input
                        id="review-board"
                        placeholder="e.g., Planning Board"
                        value={formState.board}
                        onChange={(e) => setFormState(prev => ({ ...prev, board: e.target.value }))}
                        data-testid="input-review-board"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="review-year">Year</Label>
                    <Input
                      id="review-year"
                      placeholder="e.g., 2024"
                      value={formState.year}
                      onChange={(e) => setFormState(prev => ({ ...prev, year: e.target.value }))}
                      data-testid="input-review-year"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="review-notes">Notes</Label>
                    <Textarea
                      id="review-notes"
                      placeholder="Additional context or notes"
                      value={formState.notes}
                      onChange={(e) => setFormState(prev => ({ ...prev, notes: e.target.value }))}
                      rows={2}
                      data-testid="input-review-notes"
                    />
                  </div>

                  {/* Document Link Mode */}
                  <div className="space-y-3 pt-2 border-t">
                    <Label>Document Linking</Label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="linkMode"
                          checked={formState.documentLinkMode === "new"}
                          onChange={() => setFormState(prev => ({ ...prev, documentLinkMode: "new", documentId: "" }))}
                          className="w-4 h-4"
                          data-testid="radio-new-document"
                        />
                        <span className="text-sm">Create as new document</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="linkMode"
                          checked={formState.documentLinkMode === "existing"}
                          onChange={() => setFormState(prev => ({ ...prev, documentLinkMode: "existing" }))}
                          className="w-4 h-4"
                          data-testid="radio-existing-document"
                        />
                        <span className="text-sm">Add as new version of existing document</span>
                      </label>
                    </div>

                    {formState.documentLinkMode === "existing" && existingDocs && existingDocs.length > 0 && (
                      <Select 
                        value={formState.documentId} 
                        onValueChange={(v) => setFormState(prev => ({ ...prev, documentId: v }))}
                      >
                        <SelectTrigger data-testid="select-existing-document">
                          <SelectValue placeholder="Select existing document..." />
                        </SelectTrigger>
                        <SelectContent>
                          {existingDocs.map((doc) => (
                            <SelectItem key={doc.id} value={doc.id}>
                              {doc.canonicalTitle} ({doc.town})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            )}
          </ScrollArea>

          <DialogFooter className="gap-2 sm:gap-0">
            {selectedJob?.status === "needs_review" && (
              <>
                <Button
                  variant="destructive"
                  onClick={handleReject}
                  disabled={rejectMutation.isPending || approveAndIndexMutation.isPending}
                  data-testid="button-reject"
                >
                  {rejectMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <ThumbsDown className="w-4 h-4 mr-2" />
                  )}
                  Reject
                </Button>
                <Button
                  onClick={handleApproveAndIndex}
                  disabled={!formState.category || approveAndIndexMutation.isPending || rejectMutation.isPending}
                  data-testid="button-approve"
                >
                  {approveAndIndexMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <ThumbsUp className="w-4 h-4 mr-2" />
                      Approve & Index
                    </>
                  )}
                </Button>
              </>
            )}
            {selectedJob?.status !== "needs_review" && (
              <Button variant="outline" onClick={() => setReviewDialogOpen(false)}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
