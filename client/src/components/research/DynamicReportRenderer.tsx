import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type {
  DynamicReportPayload,
  DynamicWidget,
  SummaryTextWidget,
  StatCardWidget,
  BarChartWidget,
} from "@shared/schema";

function SummaryTextBlock({ widget }: { widget: SummaryTextWidget }) {
  return (
    <Card data-testid="widget-summary-text">
      <CardContent className="pt-6 prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {widget.content}
        </ReactMarkdown>
      </CardContent>
    </Card>
  );
}

function StatCardBlock({ widget, index }: { widget: StatCardWidget; index: number }) {
  const TrendIcon = widget.trend === "up"
    ? TrendingUp
    : widget.trend === "down"
      ? TrendingDown
      : Minus;

  const trendColor = widget.trend === "up"
    ? "text-emerald-600 dark:text-emerald-400"
    : widget.trend === "down"
      ? "text-red-600 dark:text-red-400"
      : "text-muted-foreground";

  return (
    <Card data-testid={`widget-stat-card-${index}`}>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm text-muted-foreground">{widget.label}</p>
            <div className="text-2xl font-bold mt-1">{widget.value}</div>
          </div>
          {widget.trend && (
            <div className={`${trendColor} mt-1`}>
              <TrendIcon className="w-5 h-5" />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function BarChartBlock({ widget, index }: { widget: BarChartWidget; index: number }) {
  const chartHeight = Math.max(widget.data.length * 44, 200);

  return (
    <Card data-testid={`widget-bar-chart-${index}`}>
      <CardHeader>
        <CardTitle className="text-base">{widget.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <BarChart
            data={widget.data}
            layout="vertical"
            margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
            <XAxis type="number" className="text-xs" />
            <YAxis
              type="category"
              dataKey="name"
              width={160}
              className="text-xs"
              tick={{ fontSize: 12 }}
            />
            <RechartsTooltip
              formatter={(value: number) => [value, widget.xAxisLabel]}
            />
            <Bar dataKey="value" name={widget.xAxisLabel} fill="hsl(var(--primary))" radius={[0, 4, 4, 0]}>
              {widget.data.map((_, i) => (
                <Cell key={i} fillOpacity={0.8} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function WidgetRenderer({ widget, index }: { widget: DynamicWidget; index: number }) {
  switch (widget.type) {
    case "summary_text":
      return <SummaryTextBlock widget={widget} />;
    case "stat_card":
      return <StatCardBlock widget={widget} index={index} />;
    case "bar_chart":
      return <BarChartBlock widget={widget} index={index} />;
    default:
      return null;
  }
}

export default function DynamicReportRenderer({ payload }: { payload: DynamicReportPayload }) {
  const statCards = payload.widgets.filter((w): w is StatCardWidget => w.type === "stat_card");
  const otherWidgets = payload.widgets.filter((w) => w.type !== "stat_card");

  return (
    <div className="space-y-6" data-testid="dynamic-report">
      <div>
        <h2 className="text-xl font-semibold" data-testid="text-dynamic-report-title">
          {payload.reportTitle}
        </h2>
        <Card className="mt-3">
          <CardContent className="pt-6 prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {payload.executiveSummary}
            </ReactMarkdown>
          </CardContent>
        </Card>
      </div>

      {statCards.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((widget, i) => (
            <StatCardBlock key={i} widget={widget} index={i} />
          ))}
        </div>
      )}

      {otherWidgets.map((widget, i) => (
        <WidgetRenderer key={i} widget={widget} index={i} />
      ))}
    </div>
  );
}
