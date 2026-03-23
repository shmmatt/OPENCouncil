import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Bell, Search, Plus, Newspaper, FileText, MessageSquare, LayoutDashboard } from "lucide-react";
import { ChatSidebarPanel } from "@/components/ChatSidebarPanel";
import { UserStatusBar } from "@/components/user-status-bar";

const navItems = [
  { title: "News", url: "/feed", icon: Newspaper },
  { title: "Documents", url: "/documents", icon: FileText },
  { title: "Chat", url: "/chat", icon: MessageSquare },
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
];

const topNavItems = [
  { label: "News", href: "/feed" },
  { label: "Documents", href: "/documents" },
  { label: "Chat", href: "/chat" },
  { label: "Dashboard", href: "/dashboard" },
];

function CivicAppSidebar() {
  const [location] = useLocation();
  const isChatPage = location.startsWith("/chat");

  return (
    <Sidebar>
      <SidebarHeader className="px-4 pt-5 pb-3 border-b border-sidebar-border">
        <h2 className="text-sm font-bold font-headline text-primary tracking-tight">OPENCouncil</h2>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mt-0.5">Official Ledger</p>
      </SidebarHeader>
      <SidebarContent className="pt-2">
        {isChatPage ? (
          <ChatSidebarPanel />
        ) : (
          <SidebarMenu>
            {navItems.map((item) => {
              const isActive = location.startsWith(item.url);
              return (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={isActive} data-testid={`sidenav-${item.title.toLowerCase()}`}>
                    <Link href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        )}
      </SidebarContent>
      {!isChatPage && (
        <SidebarFooter className="p-4 border-t border-sidebar-border">
          <Button className="w-full font-headline font-semibold" data-testid="button-post-update">
            <Plus className="w-4 h-4 mr-2" />
            Post Update
          </Button>
        </SidebarFooter>
      )}
    </Sidebar>
  );
}

export function CivicLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const sidebarStyle = {
    "--sidebar-width": "15rem",
    "--sidebar-width-icon": "3.5rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <CivicAppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between gap-2 px-4 h-14 border-b bg-card sticky top-0 z-[999] flex-wrap">
            <div className="flex items-center gap-3">
              <SidebarTrigger data-testid="button-sidebar-trigger" />
              <Link href="/" className="text-base font-black font-headline uppercase tracking-widest text-primary hidden sm:block select-none hover:opacity-80 transition-opacity">
                OPENCOUNCIL
              </Link>
              <nav className="hidden lg:flex items-center gap-0.5 ml-2">
                {topNavItems.map((item) => {
                  const isActive = location.startsWith(item.href);
                  return (
                    <Link key={item.label} href={item.href}>
                      <button
                        className={`relative px-3 py-1.5 text-sm font-semibold font-headline rounded-md transition-colors ${
                          isActive
                            ? "text-primary"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        data-testid={`topnav-${item.label.toLowerCase()}`}
                      >
                        {item.label}
                        {isActive && (
                          <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-primary rounded-full" />
                        )}
                      </button>
                    </Link>
                  );
                })}
              </nav>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="hidden lg:flex items-center gap-2 bg-muted rounded-md px-3 py-1.5 border border-border">
                <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                <input
                  type="search"
                  placeholder="Search records..."
                  className="bg-transparent text-sm outline-none w-40 placeholder:text-muted-foreground"
                  data-testid="input-global-search"
                />
              </div>
              <Button variant="ghost" size="icon" data-testid="button-notifications">
                <Bell className="w-4 h-4" />
              </Button>
              <UserStatusBar />
            </div>
          </header>
          <main className="flex-1 overflow-hidden min-h-0">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
