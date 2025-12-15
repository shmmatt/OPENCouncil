import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Upload, Loader2, FileText, ArrowLeft, CheckCircle2, XCircle, FolderUp, BarChart3 } from "lucide-react";

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

interface SuggestedMetadata {
  category: string;
  town: string;
  board: string;
  year: string;
  notes: string;
}

interface AnalyzedFile {
  tempId: string | null;
  filename: string;
  suggestedMetadata: SuggestedMetadata;
  error?: string;
  metadata: SuggestedMetadata;
}

interface UploadResult {
  filename: string;
  id?: string;
  error?: string;
}

export default function AdminBulkUpload() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [analyzedFiles, setAnalyzedFiles] = useState<AnalyzedFile[]>([]);
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([]);

  const analyzeMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const token = localStorage.getItem("adminToken");
      const response = await fetch("/api/admin/bulk-upload/analyze", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem("adminToken");
          setLocation("/admin/login");
          throw new Error("Session expired");
        }
        const error = await response.json();
        throw new Error(error.message || "Analysis failed");
      }
      return response.json();
    },
    onSuccess: (data: { files: Array<{ tempId: string | null; filename: string; suggestedMetadata: SuggestedMetadata; error?: string }> }) => {
      const analyzed = data.files.map((f) => ({
        ...f,
        metadata: { ...f.suggestedMetadata },
      }));
      setAnalyzedFiles(analyzed);
      toast({
        title: "Analysis complete",
        description: `${data.files.length} file(s) analyzed with suggested metadata`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Analysis failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async (filesToUpload: Array<{ tempId: string; filename: string; metadata: SuggestedMetadata }>) => {
      const token = localStorage.getItem("adminToken");
      const response = await fetch("/api/admin/bulk-upload/finalize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: filesToUpload }),
      });
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem("adminToken");
          setLocation("/admin/login");
          throw new Error("Session expired");
        }
        const error = await response.json();
        throw new Error(error.message || "Upload failed");
      }
      return response.json();
    },
    onSuccess: (data: { uploaded: Array<{ filename: string; id: string }>; failed: Array<{ filename: string; error: string }> }) => {
      const results: UploadResult[] = [
        ...data.uploaded.map((u) => ({ filename: u.filename, id: u.id })),
        ...data.failed.map((f) => ({ filename: f.filename, error: f.error })),
      ];
      setUploadResults(results);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/documents"] });
      
      if (data.uploaded.length > 0) {
        toast({
          title: "Upload complete",
          description: `${data.uploaded.length} document(s) uploaded successfully${data.failed.length > 0 ? `, ${data.failed.length} failed` : ""}`,
        });
      } else {
        toast({
          title: "Upload failed",
          description: "All files failed to upload",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
      setAnalyzedFiles([]);
      setUploadResults([]);
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

  const handleMetadataChange = (index: number, field: keyof SuggestedMetadata, value: string) => {
    setAnalyzedFiles((prev) => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        metadata: {
          ...updated[index].metadata,
          [field]: value,
        },
      };
      return updated;
    });
  };

  const handleFinalize = () => {
    const validFiles = analyzedFiles
      .filter((f) => f.tempId && f.metadata.category)
      .map((f) => ({
        tempId: f.tempId!,
        filename: f.filename,
        metadata: f.metadata,
      }));

    if (validFiles.length === 0) {
      toast({
        title: "No valid files",
        description: "Please ensure all files have a category selected",
        variant: "destructive",
      });
      return;
    }

    finalizeMutation.mutate(validFiles);
  };

  const handleReset = () => {
    setFiles([]);
    setAnalyzedFiles([]);
    setUploadResults([]);
    const fileInput = document.getElementById("bulk-file-upload") as HTMLInputElement;
    if (fileInput) fileInput.value = "";
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
              <h1 className="text-xl font-semibold">Bulk Upload</h1>
              <p className="text-sm text-muted-foreground">Upload multiple documents at once</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild data-testid="link-usage">
              <Link href="/admin/usage">
                <BarChart3 className="w-4 h-4 mr-2" />
                Analytics
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
        {uploadResults.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                Upload Complete
              </CardTitle>
              <CardDescription>
                {uploadResults.filter((r) => r.id).length} document(s) uploaded successfully
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Filename</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {uploadResults.map((result, index) => (
                      <TableRow key={index}>
                        <TableCell className="font-mono text-sm">{result.filename}</TableCell>
                        <TableCell>
                          {result.id ? (
                            <span className="flex items-center gap-2 text-green-600">
                              <CheckCircle2 className="w-4 h-4" />
                              Uploaded
                            </span>
                          ) : (
                            <span className="flex items-center gap-2 text-red-600">
                              <XCircle className="w-4 h-4" />
                              {result.error || "Failed"}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex gap-3">
                <Button onClick={handleReset} data-testid="button-upload-more">
                  Upload More Documents
                </Button>
                <Button variant="outline" asChild data-testid="link-view-documents">
                  <Link href="/admin/documents">View All Documents</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : analyzedFiles.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Review Metadata</CardTitle>
              <CardDescription>
                Review and edit the suggested metadata for each file before uploading
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[200px]">Filename</TableHead>
                      <TableHead className="min-w-[150px]">Category *</TableHead>
                      <TableHead className="min-w-[120px]">Town</TableHead>
                      <TableHead className="min-w-[150px]">Board</TableHead>
                      <TableHead className="min-w-[80px]">Year</TableHead>
                      <TableHead className="min-w-[200px]">Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {analyzedFiles.map((file, index) => (
                      <TableRow key={index} data-testid={`row-analyzed-${index}`}>
                        <TableCell className="font-mono text-sm">
                          {file.filename}
                          {file.error && (
                            <p className="text-xs text-red-600 mt-1">{file.error}</p>
                          )}
                        </TableCell>
                        <TableCell>
                          <Select
                            value={file.metadata.category}
                            onValueChange={(v) => handleMetadataChange(index, "category", v)}
                          >
                            <SelectTrigger data-testid={`select-category-${index}`}>
                              <SelectValue placeholder="Select..." />
                            </SelectTrigger>
                            <SelectContent>
                              {CATEGORY_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input
                            value={file.metadata.town}
                            onChange={(e) => handleMetadataChange(index, "town", e.target.value)}
                            placeholder="Town name"
                            data-testid={`input-town-${index}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={file.metadata.board}
                            onChange={(e) => handleMetadataChange(index, "board", e.target.value)}
                            placeholder="Board/Dept"
                            data-testid={`input-board-${index}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={file.metadata.year}
                            onChange={(e) => handleMetadataChange(index, "year", e.target.value)}
                            placeholder="Year"
                            type="number"
                            data-testid={`input-year-${index}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Textarea
                            value={file.metadata.notes}
                            onChange={(e) => handleMetadataChange(index, "notes", e.target.value)}
                            placeholder="Notes"
                            rows={2}
                            className="min-w-[180px]"
                            data-testid={`input-notes-${index}`}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex gap-3">
                <Button
                  onClick={handleFinalize}
                  disabled={finalizeMutation.isPending || analyzedFiles.filter((f) => f.tempId && f.metadata.category).length === 0}
                  data-testid="button-finalize"
                >
                  {finalizeMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Uploading to Knowledge Base...
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4 mr-2" />
                      Upload to Knowledge Base ({analyzedFiles.filter((f) => f.tempId && f.metadata.category).length} files)
                    </>
                  )}
                </Button>
                <Button variant="outline" onClick={handleReset} data-testid="button-cancel">
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Select Files</CardTitle>
              <CardDescription>
                Upload multiple municipal documents at once. We'll analyze each file and suggest metadata using AI.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="bulk-file-upload">Document Files</Label>
                <Input
                  id="bulk-file-upload"
                  type="file"
                  accept=".pdf,.docx,.txt"
                  multiple
                  onChange={handleFileChange}
                  data-testid="input-files"
                />
                <p className="text-xs text-muted-foreground">
                  Supported formats: PDF, DOCX, TXT (max 100MB each). Select multiple files at once.
                </p>
              </div>

              {files.length > 0 && (
                <div className="space-y-2">
                  <Label>Selected Files ({files.length})</Label>
                  <div className="rounded-md border p-3 space-y-2 max-h-48 overflow-y-auto">
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

              <Button
                onClick={handleAnalyze}
                disabled={files.length === 0 || analyzeMutation.isPending}
                data-testid="button-analyze"
              >
                {analyzeMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Analyzing Files...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Analyze Files ({files.length})
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
