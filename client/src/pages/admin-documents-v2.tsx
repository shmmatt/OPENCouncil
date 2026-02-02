import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { 
  Loader2, 
  FileText, 
  ArrowLeft, 
  CheckCircle2, 
  History,
  GitBranch,
  Clock,
  Eye
} from "lucide-react";
import type { LogicalDocument, LogicalDocumentWithVersions } from "@shared/schema";

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

export default function AdminDocumentsV2() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);

  const { data: documents, isLoading: docsLoading } = useQuery<LogicalDocument[]>({
    queryKey: ["/api/admin/v2/documents"],
    queryFn: async () => {
      const token = localStorage.getItem("adminToken");
      const response = await fetch("/api/admin/v2/documents", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem("adminToken");
          setLocation("/admin/login");
          throw new Error("Session expired");
        }
        throw new Error("Failed to fetch documents");
      }
      return response.json();
    },
  });

  const { data: selectedDoc, isLoading: selectedDocLoading } = useQuery<LogicalDocumentWithVersions>({
    queryKey: ["/api/admin/v2/documents", selectedDocId],
    queryFn: async () => {
      const token = localStorage.getItem("adminToken");
      const response = await fetch(`/api/admin/v2/documents/${selectedDocId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error("Failed to fetch document details");
      }
      return response.json();
    },
    enabled: !!selectedDocId && versionDialogOpen,
  });

  const openVersionDialog = (docId: string) => {
    setSelectedDocId(docId);
    setVersionDialogOpen(true);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10">
              <GitBranch className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">v2 Documents</h1>
              <p className="text-sm text-muted-foreground">Versioned Document Management</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild data-testid="link-ingestion">
              <Link href="/admin/ingestion">
                <GitBranch className="w-4 h-4 mr-2" />
                Ingestion Pipeline
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild data-testid="link-back-documents">
              <Link href="/admin/documents">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Legacy Documents
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Logical Documents</CardTitle>
            <CardDescription>
              View documents with version history. Each document can have multiple versions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {docsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : !documents || documents.length === 0 ? (
              <div className="text-center py-12">
                <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground mb-2">No v2 documents yet</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Use the Ingestion Pipeline to upload and approve documents
                </p>
                <Button asChild>
                  <Link href="/admin/ingestion">Go to Ingestion Pipeline</Link>
                </Button>
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Town</TableHead>
                      <TableHead>Board</TableHead>
                      <TableHead>Current Version</TableHead>
                      <TableHead>Last Updated</TableHead>
                      <TableHead className="w-[100px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {documents.map((doc) => (
                      <TableRow key={doc.id} data-testid={`row-doc-${doc.id}`}>
                        <TableCell className="font-medium">
                          {doc.canonicalTitle}
                        </TableCell>
                        <TableCell>{getCategoryLabel(doc.category)}</TableCell>
                        <TableCell>{doc.town || "-"}</TableCell>
                        <TableCell>{doc.board || "-"}</TableCell>
                        <TableCell>
                          {doc.currentVersionId ? (
                            <Badge variant="outline" className="text-green-600 border-green-600">
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              Active
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-yellow-600 border-yellow-600">
                              <Clock className="w-3 h-3 mr-1" />
                              No version
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(doc.updatedAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openVersionDialog(doc.id)}
                            data-testid={`button-versions-${doc.id}`}
                          >
                            <History className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Version History Dialog */}
      <Dialog open={versionDialogOpen} onOpenChange={setVersionDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Version History</DialogTitle>
            <DialogDescription>
              {selectedDoc?.canonicalTitle || "Loading..."}
            </DialogDescription>
          </DialogHeader>
          
          <ScrollArea className="flex-1">
            {selectedDocLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : selectedDoc ? (
              <div className="space-y-4 py-4">
                {/* Document Info */}
                <div className="p-4 rounded-lg bg-muted/50 space-y-2">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Category:</span>{" "}
                      <span className="font-medium">{getCategoryLabel(selectedDoc.category)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Town:</span>{" "}
                      <span className="font-medium">{selectedDoc.town}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Board:</span>{" "}
                      <span className="font-medium">{selectedDoc.board || "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Created:</span>{" "}
                      <span className="font-medium">{new Date(selectedDoc.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>

                {/* Versions List */}
                <div className="space-y-2">
                  <h4 className="font-medium">Versions ({selectedDoc.versions?.length || 0})</h4>
                  
                  {!selectedDoc.versions || selectedDoc.versions.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4">No versions indexed yet</p>
                  ) : (
                    <div className="space-y-2">
                      {selectedDoc.versions.map((version, index) => (
                        <div 
                          key={version.id} 
                          className={`p-4 rounded-lg border ${version.isCurrent ? 'border-green-500 bg-green-50 dark:bg-green-950' : ''}`}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm">{version.fileBlob.originalFilename}</span>
                                {version.isCurrent && (
                                  <Badge className="bg-green-600">Current</Badge>
                                )}
                              </div>
                              <div className="text-sm text-muted-foreground">
                                {version.year && <span>Year: {version.year} | </span>}
                                Size: {(version.fileBlob.sizeBytes / 1024 / 1024).toFixed(2)} MB
                              </div>
                              {version.notes && (
                                <p className="text-sm text-muted-foreground">{version.notes}</p>
                              )}
                              <p className="text-xs text-muted-foreground">
                                Indexed: {new Date(version.createdAt).toLocaleString()}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {version.supersedesVersionId && (
                                <Badge variant="outline" className="text-xs">
                                  Supersedes previous
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-center py-8 text-muted-foreground">Document not found</p>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
