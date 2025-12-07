import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  RefreshCw,
  Trash2,
  CheckSquare,
  Link2,
  Plus
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

interface JobMetadataEdits {
  category: string;
  town: string;
  board: string;
  year: string;
  documentLinkMode: "new" | "existing";
  documentId: string;
  // Minutes-specific fields
  isMinutes: boolean;
  meetingDate: string;
  meetingType: string;
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

function JobDetailsPopover({ job }: { job: IngestionJobWithBlob }) {
  const getDuplicateWarningDisplay = (warning: string | null) => {
    if (!warning) return null;
    
    if (warning.startsWith("exact_duplicate:")) {
      const filename = warning.replace("exact_duplicate:", "");
      return (
        <div className="flex items-center gap-2 text-red-600 text-sm p-2 rounded bg-red-50 dark:bg-red-950">
          <AlertTriangle className="w-4 h-4" />
          <span>Exact duplicate of: {filename}</span>
        </div>
      );
    }
    
    if (warning.startsWith("preview_match:")) {
      const filename = warning.replace("preview_match:", "");
      return (
        <div className="flex items-center gap-2 text-yellow-600 text-sm p-2 rounded bg-yellow-50 dark:bg-yellow-950">
          <AlertTriangle className="w-4 h-4" />
          <span>Similar content to: {filename}</span>
        </div>
      );
    }
    
    return null;
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" title="View Details" data-testid={`button-details-${job.id}`}>
          <Eye className="w-4 h-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96" align="end">
        <div className="space-y-4">
          <div>
            <h4 className="font-medium mb-1">File Information</h4>
            <div className="text-sm text-muted-foreground space-y-1">
              <div className="font-mono break-all">{job.fileBlob.originalFilename}</div>
              <div>Size: {(job.fileBlob.sizeBytes / 1024 / 1024).toFixed(2)} MB</div>
              <div>Type: {job.fileBlob.mimeType}</div>
            </div>
          </div>
          
          {job.duplicateWarning && (
            <div>
              <h4 className="font-medium mb-1">Warnings</h4>
              {getDuplicateWarningDisplay(job.duplicateWarning)}
            </div>
          )}
          
          {job.fileBlob.previewText && (
            <div>
              <h4 className="font-medium mb-1">Preview Text</h4>
              <ScrollArea className="h-32 w-full rounded border p-2">
                <pre className="text-xs whitespace-pre-wrap font-mono">
                  {job.fileBlob.previewText.slice(0, 1000)}
                  {job.fileBlob.previewText.length > 1000 && "..."}
                </pre>
              </ScrollArea>
            </div>
          )}
          
          <div>
            <h4 className="font-medium mb-1">AI Suggested Metadata</h4>
            <div className="text-sm text-muted-foreground">
              {(() => {
                const suggested = job.suggestedMetadata as any || {};
                return (
                  <div className="space-y-1">
                    <div>Category: {CATEGORY_OPTIONS.find(o => o.value === suggested.category)?.label || suggested.category || "-"}</div>
                    <div>Town: {suggested.town || "-"}</div>
                    <div>Board: {suggested.board || "-"}</div>
                    <div>Year: {suggested.year || "-"}</div>
                    {suggested.isMinutes && (
                      <>
                        <div className="font-medium text-primary mt-2">Minutes Detected</div>
                        <div>Meeting Date: {suggested.meetingDate || "-"}</div>
                        <div>Meeting Type: {suggested.meetingType || "-"}</div>
                        {suggested.rawDateText && <div>Raw Date: {suggested.rawDateText}</div>}
                      </>
                    )}
                    {suggested.notes && <div>Notes: {suggested.notes}</div>}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function getDefaultMetadataForJob(job: IngestionJobWithBlob): JobMetadataEdits {
  const suggested = job.suggestedMetadata as any || {};
  return {
    category: suggested.category || "misc_other",
    town: suggested.town || "",
    board: suggested.board || "",
    year: suggested.year || "",
    documentLinkMode: "new",
    documentId: "",
    isMinutes: suggested.isMinutes || false,
    meetingDate: suggested.meetingDate || "",
    meetingType: suggested.meetingType || "",
  };
}

function validateJobMetadata(metadata: JobMetadataEdits): { valid: boolean; error?: string } {
  if (!metadata.category || metadata.category.trim() === "") {
    return { valid: false, error: "Category is required" };
  }
  if (metadata.documentLinkMode === "existing" && !metadata.documentId) {
    return { valid: false, error: "Must select a document when linking to existing" };
  }
  return { valid: true };
}

export default function AdminIngestion() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("needs_review");
  const [files, setFiles] = useState<File[]>([]);
  
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set());
  const [jobEdits, setJobEdits] = useState<Record<string, JobMetadataEdits>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

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

  const getJobMetadata = useCallback((job: IngestionJobWithBlob): JobMetadataEdits => {
    if (jobEdits[job.id]) {
      return jobEdits[job.id];
    }
    return getDefaultMetadataForJob(job);
  }, [jobEdits]);

  const updateJobEdit = useCallback((jobId: string, field: keyof JobMetadataEdits, value: string | boolean) => {
    setJobEdits(prev => {
      const existingJob = jobs?.find(j => j.id === jobId);
      const current = prev[jobId] || (existingJob ? getDefaultMetadataForJob(existingJob) : {
        category: "misc_other",
        town: "",
        board: "",
        year: "",
        documentLinkMode: "new" as const,
        documentId: "",
        isMinutes: false,
        meetingDate: "",
        meetingType: "",
      });
      return {
        ...prev,
        [jobId]: {
          ...current,
          [field]: value,
        },
      };
    });
    setValidationErrors(prev => {
      const { [jobId]: _, ...rest } = prev;
      return rest;
    });
  }, [jobs]);

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

  const approveAndIndexMutation = useMutation({
    mutationFn: async ({ jobId, metadata }: { jobId: string; metadata: JobMetadataEdits }) => {
      const token = localStorage.getItem("adminToken");
      
      const approveResponse = await fetch(`/api/admin/ingestion/jobs/${jobId}/approve`, {
        method: "POST",
        headers: { 
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          finalMetadata: {
            category: metadata.isMinutes ? "meeting_minutes" : metadata.category,
            town: metadata.town,
            board: metadata.board,
            year: metadata.year,
            notes: "",
            isMinutes: metadata.isMinutes,
            meetingDate: metadata.meetingDate || null,
            meetingType: metadata.meetingType || null,
          },
          documentLinkMode: metadata.documentLinkMode,
          documentId: metadata.documentLinkMode === "existing" ? metadata.documentId : undefined,
        }),
      });
      
      if (!approveResponse.ok) {
        const error = await approveResponse.json();
        throw new Error(error.message || "Approval failed");
      }
      
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
      queryClient.invalidateQueries({ queryKey: ["/api/admin/v2/documents"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Operation failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const bulkApproveMutation = useMutation({
    mutationFn: async (jobIds: string[]) => {
      const token = localStorage.getItem("adminToken");
      const results = [];
      
      for (const jobId of jobIds) {
        try {
          const job = jobs?.find(j => j.id === jobId);
          if (!job) continue;
          
          const metadata = getJobMetadata(job);
          
          const approveResponse = await fetch(`/api/admin/ingestion/jobs/${jobId}/approve`, {
            method: "POST",
            headers: { 
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              finalMetadata: {
                category: metadata.isMinutes ? "meeting_minutes" : metadata.category,
                town: metadata.town,
                board: metadata.board,
                year: metadata.year,
                notes: "",
                isMinutes: metadata.isMinutes,
                meetingDate: metadata.meetingDate || null,
                meetingType: metadata.meetingType || null,
              },
              documentLinkMode: metadata.documentLinkMode,
              documentId: metadata.documentLinkMode === "existing" ? metadata.documentId : undefined,
            }),
          });
          
          if (!approveResponse.ok) {
            const error = await approveResponse.json();
            results.push({ jobId, success: false, error: error.message });
            continue;
          }
          
          const indexResponse = await fetch(`/api/admin/ingestion/jobs/${jobId}/index`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
          
          if (!indexResponse.ok) {
            const error = await indexResponse.json();
            results.push({ jobId, success: false, error: error.message });
            continue;
          }
          
          results.push({ jobId, success: true });
        } catch (err) {
          results.push({ jobId, success: false, error: String(err) });
        }
      }
      
      return results;
    },
    onSuccess: (results) => {
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ingestion/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/v2/documents"] });
      setSelectedJobs(new Set());
      setJobEdits({});
      
      if (failCount === 0) {
        toast({
          title: "Bulk approve complete",
          description: `Successfully approved and indexed ${successCount} document(s)`,
        });
      } else {
        toast({
          title: "Bulk approve partially complete",
          description: `${successCount} succeeded, ${failCount} failed`,
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Bulk approve failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const bulkRejectMutation = useMutation({
    mutationFn: async (jobIds: string[]) => {
      const token = localStorage.getItem("adminToken");
      const results = [];
      
      for (const jobId of jobIds) {
        try {
          const response = await fetch(`/api/admin/ingestion/jobs/${jobId}/reject`, {
            method: "POST",
            headers: { 
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ reason: "Bulk rejected by admin" }),
          });
          
          if (!response.ok) {
            const error = await response.json();
            results.push({ jobId, success: false, error: error.message });
            continue;
          }
          
          results.push({ jobId, success: true });
        } catch (err) {
          results.push({ jobId, success: false, error: String(err) });
        }
      }
      
      return results;
    },
    onSuccess: (results) => {
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ingestion/jobs"] });
      setSelectedJobs(new Set());
      
      if (failCount === 0) {
        toast({
          title: "Bulk reject complete",
          description: `Rejected ${successCount} document(s)`,
        });
      } else {
        toast({
          title: "Bulk reject partially complete",
          description: `${successCount} rejected, ${failCount} failed`,
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Bulk reject failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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

  const toggleJobSelection = (jobId: string) => {
    setSelectedJobs(prev => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!jobs) return;
    const needsReviewJobs = jobs.filter(j => j.status === "needs_review");
    if (selectedJobs.size === needsReviewJobs.length) {
      setSelectedJobs(new Set());
    } else {
      setSelectedJobs(new Set(needsReviewJobs.map(j => j.id)));
    }
  };

  const handleBulkApprove = () => {
    if (selectedJobs.size === 0 || !jobs) return;
    
    const errors: Record<string, string> = {};
    const validJobIds: string[] = [];
    const selectedArray = Array.from(selectedJobs);
    
    for (let i = 0; i < selectedArray.length; i++) {
      const jobId = selectedArray[i];
      const job = jobs.find(j => j.id === jobId);
      if (!job) continue;
      
      const metadata = getJobMetadata(job);
      const validation = validateJobMetadata(metadata);
      
      if (!validation.valid) {
        errors[jobId] = validation.error || "Invalid metadata";
      } else {
        validJobIds.push(jobId);
      }
    }
    
    if (Object.keys(errors).length > 0) {
      setValidationErrors(prev => ({ ...prev, ...errors }));
      toast({
        title: "Validation failed",
        description: `${Object.keys(errors).length} job(s) have invalid metadata. Fix errors before approving.`,
        variant: "destructive",
      });
      return;
    }
    
    bulkApproveMutation.mutate(validJobIds);
  };

  const handleBulkReject = () => {
    if (selectedJobs.size === 0) return;
    bulkRejectMutation.mutate(Array.from(selectedJobs));
  };

  const handleSingleApprove = (job: IngestionJobWithBlob) => {
    const metadata = getJobMetadata(job);
    const validation = validateJobMetadata(metadata);
    
    if (!validation.valid) {
      setValidationErrors(prev => ({ ...prev, [job.id]: validation.error || "Invalid metadata" }));
      toast({
        title: "Validation failed",
        description: validation.error || "Invalid metadata",
        variant: "destructive",
      });
      return;
    }
    
    approveAndIndexMutation.mutate({ jobId: job.id, metadata });
  };

  const handleSingleReject = (jobId: string) => {
    rejectMutation.mutate({ jobId, reason: "Rejected by admin" });
  };

  const getDuplicateWarningBadge = (warning: string | null) => {
    if (!warning) return null;
    
    if (warning.startsWith("exact_duplicate:")) {
      return (
        <Badge variant="outline" className="text-red-600 border-red-600 text-xs">
          <AlertTriangle className="w-3 h-3 mr-1" />
          Duplicate
        </Badge>
      );
    }
    
    if (warning.startsWith("preview_match:")) {
      return (
        <Badge variant="outline" className="text-yellow-600 border-yellow-600 text-xs">
          <AlertTriangle className="w-3 h-3 mr-1" />
          Similar
        </Badge>
      );
    }
    
    return null;
  };

  const needsReviewCount = jobs?.filter(j => j.status === "needs_review").length || 0;
  const isBulkOperating = bulkApproveMutation.isPending || bulkRejectMutation.isPending;

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

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle>Ingestion Queue</CardTitle>
                <CardDescription>
                  Edit metadata inline, link to existing documents, and use bulk actions to approve or reject
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
            <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); setSelectedJobs(new Set()); }}>
              <TabsList className="mb-4">
                <TabsTrigger value="needs_review" data-testid="tab-needs-review">
                  <Clock className="w-4 h-4 mr-2" />
                  Needs Review ({needsReviewCount})
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

              {activeTab === "needs_review" && jobs && jobs.length > 0 && (
                <div className="mb-4 p-3 rounded-lg bg-muted/50 flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id="select-all"
                      checked={selectedJobs.size === jobs.filter(j => j.status === "needs_review").length && jobs.filter(j => j.status === "needs_review").length > 0}
                      onCheckedChange={toggleSelectAll}
                      data-testid="checkbox-select-all"
                    />
                    <Label htmlFor="select-all" className="text-sm cursor-pointer">
                      {selectedJobs.size > 0 
                        ? `${selectedJobs.size} selected` 
                        : "Select all"}
                    </Label>
                  </div>
                  
                  {selectedJobs.size > 0 && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={handleBulkApprove}
                        disabled={isBulkOperating}
                        data-testid="button-bulk-approve"
                      >
                        {bulkApproveMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <CheckSquare className="w-4 h-4 mr-2" />
                        )}
                        Approve Selected ({selectedJobs.size})
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={handleBulkReject}
                        disabled={isBulkOperating}
                        data-testid="button-bulk-reject"
                      >
                        {bulkRejectMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4 mr-2" />
                        )}
                        Reject Selected
                      </Button>
                    </div>
                  )}
                </div>
              )}

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
                  <ScrollArea className="h-[500px]">
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {activeTab === "needs_review" && (
                              <TableHead className="w-[40px]"></TableHead>
                            )}
                            <TableHead className="min-w-[180px]">Filename</TableHead>
                            <TableHead className="min-w-[140px]">Category</TableHead>
                            <TableHead className="min-w-[100px]">Town</TableHead>
                            <TableHead className="min-w-[100px]">Board</TableHead>
                            <TableHead className="min-w-[70px]">Year</TableHead>
                            {activeTab === "needs_review" && (
                              <TableHead className="min-w-[160px]">Link To</TableHead>
                            )}
                            <TableHead>Warnings</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="w-[120px]">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {jobs.map((job) => {
                            const metadata = getJobMetadata(job);
                            const isNeedsReview = job.status === "needs_review";
                            const isSelected = selectedJobs.has(job.id);
                            const isOperating = approveAndIndexMutation.isPending || rejectMutation.isPending;
                            const hasError = !!validationErrors[job.id];
                            
                            return (
                              <TableRow 
                                key={job.id} 
                                data-testid={`row-job-${job.id}`}
                                className={`${isSelected ? "bg-muted/50" : ""} ${hasError ? "bg-red-50 dark:bg-red-950/20" : ""}`}
                              >
                                {activeTab === "needs_review" && (
                                  <TableCell>
                                    <Checkbox
                                      checked={isSelected}
                                      onCheckedChange={() => toggleJobSelection(job.id)}
                                      data-testid={`checkbox-job-${job.id}`}
                                    />
                                  </TableCell>
                                )}
                                <TableCell className="font-mono text-sm max-w-[180px] truncate" title={job.fileBlob.originalFilename}>
                                  {job.fileBlob.originalFilename}
                                </TableCell>
                                <TableCell>
                                  <div className="space-y-1">
                                    {isNeedsReview ? (
                                      <Select
                                        value={metadata.category}
                                        onValueChange={(v) => {
                                          updateJobEdit(job.id, "category", v);
                                          if (v === "meeting_minutes") {
                                            updateJobEdit(job.id, "isMinutes", true);
                                          } else {
                                            updateJobEdit(job.id, "isMinutes", false);
                                          }
                                        }}
                                      >
                                        <SelectTrigger className="h-8 text-xs" data-testid={`select-category-${job.id}`}>
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {CATEGORY_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                              {option.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    ) : (
                                      <span className="text-sm">{CATEGORY_OPTIONS.find(o => o.value === metadata.category)?.label || metadata.category}</span>
                                    )}
                                    {(metadata.isMinutes || metadata.category === "meeting_minutes") && isNeedsReview && (
                                      <div className="space-y-1">
                                        <div className="flex items-center gap-2">
                                          <Input
                                            value={metadata.meetingDate}
                                            onChange={(e) => updateJobEdit(job.id, "meetingDate", e.target.value)}
                                            placeholder="YYYY-MM-DD"
                                            className="h-7 text-xs flex-1"
                                            data-testid={`input-meetingdate-${job.id}`}
                                          />
                                        </div>
                                        <Select
                                          value={metadata.meetingType || "regular"}
                                          onValueChange={(v) => updateJobEdit(job.id, "meetingType", v)}
                                        >
                                          <SelectTrigger className="h-7 text-xs" data-testid={`select-meetingtype-${job.id}`}>
                                            <SelectValue placeholder="Meeting type" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="regular">Regular Meeting</SelectItem>
                                            <SelectItem value="special">Special Meeting</SelectItem>
                                            <SelectItem value="work_session">Work Session</SelectItem>
                                          </SelectContent>
                                        </Select>
                                      </div>
                                    )}
                                    {(metadata.isMinutes || metadata.category === "meeting_minutes") && !isNeedsReview && (
                                      <div className="text-xs text-muted-foreground">
                                        {metadata.meetingDate && <span>Date: {metadata.meetingDate}</span>}
                                        {metadata.meetingType && <span className="ml-2">({metadata.meetingType})</span>}
                                      </div>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  {isNeedsReview ? (
                                    <Input
                                      value={metadata.town}
                                      onChange={(e) => updateJobEdit(job.id, "town", e.target.value)}
                                      placeholder="Town..."
                                      className="h-8 text-xs"
                                      data-testid={`input-town-${job.id}`}
                                    />
                                  ) : (
                                    <span className="text-sm">{metadata.town || "-"}</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {isNeedsReview ? (
                                    <Input
                                      value={metadata.board}
                                      onChange={(e) => updateJobEdit(job.id, "board", e.target.value)}
                                      placeholder="Board..."
                                      className="h-8 text-xs"
                                      data-testid={`input-board-${job.id}`}
                                    />
                                  ) : (
                                    <span className="text-sm">{metadata.board || "-"}</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {isNeedsReview ? (
                                    <Input
                                      value={metadata.year}
                                      onChange={(e) => updateJobEdit(job.id, "year", e.target.value)}
                                      placeholder="Year"
                                      className="h-8 text-xs w-16"
                                      data-testid={`input-year-${job.id}`}
                                    />
                                  ) : (
                                    <span className="text-sm">{metadata.year || "-"}</span>
                                  )}
                                </TableCell>
                                {activeTab === "needs_review" && (
                                  <TableCell>
                                    <Select
                                      value={metadata.documentLinkMode === "existing" && metadata.documentId ? metadata.documentId : "__new__"}
                                      onValueChange={(v) => {
                                        if (v === "__new__") {
                                          updateJobEdit(job.id, "documentLinkMode", "new");
                                          updateJobEdit(job.id, "documentId", "");
                                        } else {
                                          updateJobEdit(job.id, "documentLinkMode", "existing");
                                          updateJobEdit(job.id, "documentId", v);
                                        }
                                      }}
                                    >
                                      <SelectTrigger className="h-8 text-xs" data-testid={`select-link-${job.id}`}>
                                        <SelectValue placeholder="New Document" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__new__">
                                          <span className="flex items-center gap-1">
                                            <Plus className="w-3 h-3" />
                                            New Document
                                          </span>
                                        </SelectItem>
                                        {existingDocs && existingDocs.length > 0 && (
                                          <>
                                            <SelectItem value="__divider__" disabled>
                                              ── Link to existing ──
                                            </SelectItem>
                                            {existingDocs.map((doc) => (
                                              <SelectItem key={doc.id} value={doc.id}>
                                                <span className="flex items-center gap-1">
                                                  <Link2 className="w-3 h-3" />
                                                  {doc.canonicalTitle.slice(0, 25)}{doc.canonicalTitle.length > 25 ? "..." : ""}
                                                </span>
                                              </SelectItem>
                                            ))}
                                          </>
                                        )}
                                      </SelectContent>
                                    </Select>
                                  </TableCell>
                                )}
                                <TableCell>
                                  {getDuplicateWarningBadge(job.duplicateWarning)}
                                </TableCell>
                                <TableCell>{getStatusBadge(job.status)}</TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1">
                                    <JobDetailsPopover job={job} />
                                    {isNeedsReview && (
                                      <>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          onClick={() => handleSingleApprove(job)}
                                          disabled={isOperating || isBulkOperating}
                                          title="Approve and Index"
                                          data-testid={`button-approve-${job.id}`}
                                        >
                                          <ThumbsUp className="w-4 h-4 text-green-600" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          onClick={() => handleSingleReject(job.id)}
                                          disabled={isOperating || isBulkOperating}
                                          title="Reject"
                                          data-testid={`button-reject-${job.id}`}
                                        >
                                          <ThumbsDown className="w-4 h-4 text-red-600" />
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </ScrollArea>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
