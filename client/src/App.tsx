import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import AdminLogin from "@/pages/admin-login";
import AdminDocuments from "@/pages/admin-documents";
import AdminBulkUpload from "@/pages/admin-bulk-upload";
import AdminIngestion from "@/pages/admin-ingestion";
import AdminDocumentsV2 from "@/pages/admin-documents-v2";
import AdminRecentMinutes from "@/pages/admin-recent-minutes";
import AdminUsageDashboard from "@/pages/admin-usage";
import AdminChatAnalytics from "@/pages/admin-chat-analytics";
import Chat from "@/pages/chat";

function Router() {
  return (
    <Switch>
      <Route path="/" component={() => <Redirect to="/chat" />} />
      <Route path="/chat" component={Chat} />
      <Route path="/admin/login" component={AdminLogin} />
      <Route path="/admin/documents" component={AdminDocuments} />
      <Route path="/admin/bulk-upload" component={AdminBulkUpload} />
      <Route path="/admin/ingestion" component={AdminIngestion} />
      <Route path="/admin/documents-v2" component={AdminDocumentsV2} />
      <Route path="/admin/recent-minutes" component={AdminRecentMinutes} />
      <Route path="/admin/usage" component={AdminUsageDashboard} />
      <Route path="/admin/chat-analytics" component={AdminChatAnalytics} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
