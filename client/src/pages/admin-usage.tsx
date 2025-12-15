import { useQuery } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  ArrowLeft, 
  Users, 
  MessageSquare, 
  DollarSign, 
  TrendingUp,
  AlertTriangle,
  BarChart3,
  FileText,
  Target,
  Shield,
  Zap
} from "lucide-react";

interface OverviewMetrics {
  dau24h: number;
  wau7d: number;
  sessions24h: number;
  sessions7d: number;
  questions24h: number;
  questions7d: number;
  totalCost24h: number;
  totalCost7d: number;
  topTownByQuestions: { town: string; count: number } | null;
}

interface EngagementMetrics {
  sessionsPerDay: { date: string; count: number }[];
  avgMessagesPerSession: number;
  medianMessagesPerSession: number;
  questionsPerTown: { town: string; count: number }[];
  anonymousUsagePercent: number;
  loggedInUsagePercent: number;
}

interface TownMeetingMetrics {
  templateOpens: number;
  followupClickPercent: number;
  avgFollowupsPerUser: number;
  topFollowupPrompts: { prompt: string; count: number }[];
  templateVsFreeChat: { template: number; freeChat: number };
  hasData: boolean;
}

interface MinutesEngagementMetrics {
  askClicks: number;
  viewClicks: number;
  engagementByBoard: { board: string; askClicks: number; viewClicks: number }[];
}

interface TopicMetrics {
  topTopicsWeekly: { topic: string; count: number }[];
  topTopicsByTown: { town: string; topics: { topic: string; count: number }[] }[];
}

interface TrustMetrics {
  noDocFoundRate: number;
  scopeMismatchRate: number;
  citationRate: number;
}

interface CostMetrics {
  costPerDay: { date: string; cost: number }[];
  costByModel: { model: string; cost: number }[];
  costByTown: { town: string; cost: number }[];
  avgCostPerQuestion: number;
  medianCostPerQuestion: number;
  costPerUsefulSession: number;
}

interface AlertItem {
  type: "no_doc_rate" | "daily_cost" | "scope_mismatch";
  message: string;
  value: number;
  threshold: number;
}

function MetricCard({ 
  title, 
  value, 
  subtitle, 
  icon: Icon 
}: { 
  title: string; 
  value: string | number; 
  subtitle?: string; 
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`metric-${title.toLowerCase().replace(/\s+/g, '-')}`}>
          {value}
        </div>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function OverviewSection({ data }: { data: OverviewMetrics | undefined }) {
  if (!data) return <LoadingSkeleton />;
  
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
      <MetricCard 
        title="Daily Active Users" 
        value={data.dau24h} 
        subtitle={`${data.wau7d} weekly`} 
        icon={Users} 
      />
      <MetricCard 
        title="Sessions (24h)" 
        value={data.sessions24h} 
        subtitle={`${data.sessions7d} in 7 days`} 
        icon={MessageSquare} 
      />
      <MetricCard 
        title="Questions (24h)" 
        value={data.questions24h} 
        subtitle={`${data.questions7d} in 7 days`} 
        icon={MessageSquare} 
      />
      <MetricCard 
        title="LLM Cost (24h)" 
        value={`$${data.totalCost24h.toFixed(2)}`} 
        subtitle={`$${data.totalCost7d.toFixed(2)} in 7 days`} 
        icon={DollarSign} 
      />
      <MetricCard 
        title="Top Town" 
        value={data.topTownByQuestions?.town || "N/A"} 
        subtitle={data.topTownByQuestions ? `${data.topTownByQuestions.count} questions` : "No data"} 
        icon={TrendingUp} 
      />
    </div>
  );
}

function EngagementSection({ data }: { data: EngagementMetrics | undefined }) {
  if (!data) return <LoadingSkeleton />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard 
          title="Avg Messages/Session" 
          value={data.avgMessagesPerSession.toFixed(1)} 
          subtitle={`Median: ${data.medianMessagesPerSession.toFixed(1)}`} 
          icon={BarChart3} 
        />
        <MetricCard 
          title="Anonymous Usage" 
          value={`${data.anonymousUsagePercent.toFixed(1)}%`} 
          subtitle={`${data.loggedInUsagePercent.toFixed(1)}% logged in`} 
          icon={Users} 
        />
      </div>
      
      {data.sessionsPerDay.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Sessions Per Day</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-1 h-20">
              {data.sessionsPerDay.map((day, i) => {
                const max = Math.max(...data.sessionsPerDay.map(d => d.count), 1);
                const height = (day.count / max) * 100;
                return (
                  <div 
                    key={i} 
                    className="flex-1 bg-primary rounded-t"
                    style={{ height: `${Math.max(height, 4)}%` }}
                    title={`${day.date}: ${day.count} sessions`}
                  />
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {data.questionsPerTown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Questions by Town</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.questionsPerTown.map((town, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="text-sm">{town.town}</span>
                  <Badge variant="secondary">{town.count}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TownMeetingSection({ data }: { data: TownMeetingMetrics | undefined }) {
  if (!data) return <LoadingSkeleton />;

  if (!data.hasData) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No Town Meeting Data Yet</h3>
          <p className="text-sm text-muted-foreground">
            Town Meeting template metrics will appear here once the feature is launched and users begin interacting with templates.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard 
          title="Template Opens" 
          value={data.templateOpens} 
          icon={FileText} 
        />
        <MetricCard 
          title="Follow-up Click %" 
          value={`${data.followupClickPercent.toFixed(1)}%`} 
          icon={Target} 
        />
        <MetricCard 
          title="Avg Follow-ups/User" 
          value={data.avgFollowupsPerUser.toFixed(1)} 
          icon={TrendingUp} 
        />
        <MetricCard 
          title="Template vs Free Chat" 
          value={`${data.templateVsFreeChat.template} / ${data.templateVsFreeChat.freeChat}`} 
          icon={BarChart3} 
        />
      </div>

      {data.topFollowupPrompts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Top Follow-up Prompts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.topFollowupPrompts.map((prompt, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="text-sm truncate max-w-[300px]">{prompt.prompt}</span>
                  <Badge variant="secondary">{prompt.count}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MinutesSection({ data }: { data: MinutesEngagementMetrics | undefined }) {
  if (!data) return <LoadingSkeleton />;

  const hasData = data.askClicks > 0 || data.viewClicks > 0;

  if (!hasData) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground">
            No minutes engagement data yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard 
          title="Ask About This Meeting" 
          value={data.askClicks} 
          icon={MessageSquare} 
        />
        <MetricCard 
          title="View Minutes" 
          value={data.viewClicks} 
          icon={FileText} 
        />
      </div>

      {data.engagementByBoard.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Engagement by Board</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.engagementByBoard.map((board, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="text-sm">{board.board}</span>
                  <div className="flex gap-2">
                    <Badge variant="outline">{board.askClicks} asks</Badge>
                    <Badge variant="secondary">{board.viewClicks} views</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TopicsSection({ data }: { data: TopicMetrics | undefined }) {
  if (!data) return <LoadingSkeleton />;

  const hasData = data.topTopicsWeekly.length > 0;

  if (!hasData) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Target className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground">
            No topic data available yet. Topics will appear as users ask more questions.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Top Topics (Weekly)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {data.topTopicsWeekly.map((topic, i) => (
              <div key={i} className="flex items-center justify-between">
                <span className="text-sm truncate max-w-[200px]">{topic.topic}</span>
                <Badge variant="secondary">{topic.count}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {data.topTopicsByTown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Topics by Town</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {data.topTopicsByTown.slice(0, 3).map((townData, i) => (
                <div key={i}>
                  <p className="text-sm font-medium mb-1">{townData.town}</p>
                  <div className="flex flex-wrap gap-1">
                    {townData.topics.slice(0, 3).map((topic, j) => (
                      <Badge key={j} variant="outline" className="text-xs">
                        {topic.topic} ({topic.count})
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TrustSection({ data }: { data: TrustMetrics | undefined }) {
  if (!data) return <LoadingSkeleton />;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <MetricCard 
        title="No Doc Found Rate" 
        value={`${data.noDocFoundRate.toFixed(1)}%`} 
        subtitle="% of answers without docs"
        icon={Shield} 
      />
      <MetricCard 
        title="Scope Mismatch Rate" 
        value={`${data.scopeMismatchRate.toFixed(1)}%`} 
        subtitle="Local/statewide confusion"
        icon={AlertTriangle} 
      />
      <MetricCard 
        title="Citation Rate" 
        value={`${data.citationRate.toFixed(1)}%`} 
        subtitle="Answers with document citations"
        icon={FileText} 
      />
    </div>
  );
}

function CostSection({ data }: { data: CostMetrics | undefined }) {
  if (!data) return <LoadingSkeleton />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard 
          title="Avg Cost/Question" 
          value={`$${data.avgCostPerQuestion.toFixed(4)}`} 
          subtitle={`Median: $${data.medianCostPerQuestion.toFixed(4)}`}
          icon={DollarSign} 
        />
        <MetricCard 
          title="Cost/Useful Session" 
          value={`$${data.costPerUsefulSession.toFixed(4)}`} 
          subtitle="Sessions with ≥3 messages"
          icon={Zap} 
        />
      </div>

      {data.costPerDay.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Daily Cost Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-1 h-20">
              {data.costPerDay.map((day, i) => {
                const max = Math.max(...data.costPerDay.map(d => d.cost), 0.01);
                const height = (day.cost / max) * 100;
                return (
                  <div 
                    key={i} 
                    className="flex-1 bg-primary rounded-t"
                    style={{ height: `${Math.max(height, 4)}%` }}
                    title={`${day.date}: $${day.cost.toFixed(4)}`}
                  />
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {data.costByModel.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Cost by Model</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {data.costByModel.map((model, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-sm truncate max-w-[180px]">{model.model}</span>
                    <Badge variant="secondary">${model.cost.toFixed(4)}</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {data.costByTown.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Cost by Town</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {data.costByTown.map((town, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-sm">{town.town}</span>
                    <Badge variant="secondary">${town.cost.toFixed(4)}</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function AlertsSection({ data }: { data: AlertItem[] | undefined }) {
  if (!data) return <LoadingSkeleton />;

  if (data.length === 0) {
    return (
      <Card className="border-green-200 dark:border-green-900">
        <CardContent className="py-4">
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
            <Shield className="h-5 w-5" />
            <span className="font-medium">All systems healthy - no alerts</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {data.map((alert, i) => (
        <Card key={i} className="border-amber-200 dark:border-amber-900">
          <CardContent className="py-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5" />
              <div>
                <p className="font-medium text-amber-600 dark:text-amber-400">{alert.message}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AdminUsageDashboard() {
  const [days, setDays] = useState<string>("7");
  const [, setLocation] = useLocation();
  const token = localStorage.getItem("adminToken");

  const fetchWithAuth = useCallback(async (url: string) => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      localStorage.removeItem("adminToken");
      setLocation("/admin/login");
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      throw new Error(`Failed to fetch: ${res.statusText}`);
    }
    return res.json();
  }, [token, setLocation]);

  const overviewQuery = useQuery<OverviewMetrics>({
    queryKey: [`/api/admin/usage/overview`],
    queryFn: () => fetchWithAuth(`/api/admin/usage/overview`),
    enabled: !!token,
  });

  const engagementQuery = useQuery<EngagementMetrics>({
    queryKey: [`/api/admin/usage/engagement`, days],
    queryFn: () => fetchWithAuth(`/api/admin/usage/engagement?days=${days}`),
    enabled: !!token,
  });

  const townMeetingQuery = useQuery<TownMeetingMetrics>({
    queryKey: [`/api/admin/usage/town-meeting`, days],
    queryFn: () => fetchWithAuth(`/api/admin/usage/town-meeting?days=${days}`),
    enabled: !!token,
  });

  const minutesQuery = useQuery<MinutesEngagementMetrics>({
    queryKey: [`/api/admin/usage/minutes`, days],
    queryFn: () => fetchWithAuth(`/api/admin/usage/minutes?days=${days}`),
    enabled: !!token,
  });

  const topicsQuery = useQuery<TopicMetrics>({
    queryKey: [`/api/admin/usage/topics`, days],
    queryFn: () => fetchWithAuth(`/api/admin/usage/topics?days=${days}`),
    enabled: !!token,
  });

  const trustQuery = useQuery<TrustMetrics>({
    queryKey: [`/api/admin/usage/trust`, days],
    queryFn: () => fetchWithAuth(`/api/admin/usage/trust?days=${days}`),
    enabled: !!token,
  });

  const costQuery = useQuery<CostMetrics>({
    queryKey: [`/api/admin/usage/costs`, days],
    queryFn: () => fetchWithAuth(`/api/admin/usage/costs?days=${days}`),
    enabled: !!token,
  });

  const alertsQuery = useQuery<AlertItem[]>({
    queryKey: [`/api/admin/usage/alerts`],
    queryFn: () => fetchWithAuth(`/api/admin/usage/alerts`),
    enabled: !!token,
  });

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-96">
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground mb-4">Admin authentication required</p>
            <Link href="/admin/login">
              <Button data-testid="button-login">Go to Login</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-6 px-4 max-w-7xl">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link href="/admin/documents">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">Usage & Analytics Dashboard</h1>
              <p className="text-sm text-muted-foreground">Internal metrics for Town Meeting decision-making</p>
            </div>
          </div>
          
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-32" data-testid="select-date-range">
              <SelectValue placeholder="Date range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24h</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-8">
          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Alerts
            </h2>
            <AlertsSection data={alertsQuery.data} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Zap className="h-5 w-5" />
              At-a-Glance Health
            </h2>
            <OverviewSection data={overviewQuery.data} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Usage & Engagement
            </h2>
            <EngagementSection data={engagementQuery.data} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Town Meeting Template Performance
            </h2>
            <TownMeetingSection data={townMeetingQuery.data} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Recent Minutes Engagement
            </h2>
            <MinutesSection data={minutesQuery.data} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Target className="h-5 w-5" />
              Topic & Issue Demand
            </h2>
            <TopicsSection data={topicsQuery.data} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Trust & Risk Signals
            </h2>
            <TrustSection data={trustQuery.data} />
          </section>

          <Separator />

          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Cost & Efficiency
            </h2>
            <CostSection data={costQuery.data} />
          </section>
        </div>
      </div>
    </div>
  );
}
