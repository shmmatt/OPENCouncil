import { sql, eq, and, gte, lte, desc, count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

// Use lazy initialization to share connection with storage
let _db: ReturnType<typeof drizzle> | null = null;
function getDb() {
  if (!_db) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _db = drizzle({ client: pool, schema });
  }
  return _db;
}

// Types for dashboard metrics
export interface DateRange {
  startDate: Date;
  endDate: Date;
}

export interface OverviewMetrics {
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

export interface EngagementMetrics {
  sessionsPerDay: { date: string; count: number }[];
  avgMessagesPerSession: number;
  medianMessagesPerSession: number;
  questionsPerTown: { town: string; count: number }[];
  anonymousUsagePercent: number;
  loggedInUsagePercent: number;
}

export interface TownMeetingMetrics {
  templateOpens: number;
  followupClickPercent: number;
  avgFollowupsPerUser: number;
  topFollowupPrompts: { prompt: string; count: number }[];
  templateVsFreeChat: { template: number; freeChat: number };
  hasData: boolean;
}

export interface MinutesEngagementMetrics {
  askClicks: number;
  viewClicks: number;
  engagementByBoard: { board: string; askClicks: number; viewClicks: number }[];
}

export interface TopicMetrics {
  topTopicsWeekly: { topic: string; count: number }[];
  topTopicsByTown: { town: string; topics: { topic: string; count: number }[] }[];
}

export interface TrustMetrics {
  noDocFoundRate: number;
  scopeMismatchRate: number;
  citationRate: number;
}

export interface CostMetrics {
  costPerDay: { date: string; cost: number }[];
  costByModel: { model: string; cost: number }[];
  costByTown: { town: string; cost: number }[];
  avgCostPerQuestion: number;
  medianCostPerQuestion: number;
  costPerUsefulSession: number;
}

export interface AlertItem {
  type: "no_doc_rate" | "daily_cost" | "scope_mismatch";
  message: string;
  value: number;
  threshold: number;
}

// Helper to get date ranges
function getLast24Hours(): DateRange {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
  return { startDate, endDate };
}

function getLast7Days(): DateRange {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { startDate, endDate };
}

function getDateRange(days: number = 7): DateRange {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  return { startDate, endDate };
}

// ============================================================
// OVERVIEW METRICS
// ============================================================

export async function getOverviewMetrics(): Promise<OverviewMetrics> {
  const db = getDb();
  const range24h = getLast24Hours();
  const range7d = getLast7Days();

  // DAU - Distinct active users/anons in last 24h
  const dau24hResult = await db.execute(sql`
    SELECT COUNT(DISTINCT COALESCE(user_id, anon_id)) as count
    FROM chat_sessions
    WHERE created_at >= ${range24h.startDate} AND created_at <= ${range24h.endDate}
  `);
  const dau24h = Number(dau24hResult.rows[0]?.count || 0);

  // WAU - Distinct active users/anons in last 7d
  const wau7dResult = await db.execute(sql`
    SELECT COUNT(DISTINCT COALESCE(user_id, anon_id)) as count
    FROM chat_sessions
    WHERE created_at >= ${range7d.startDate} AND created_at <= ${range7d.endDate}
  `);
  const wau7d = Number(wau7dResult.rows[0]?.count || 0);

  // Sessions created 24h
  const sessions24hResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM chat_sessions
    WHERE created_at >= ${range24h.startDate} AND created_at <= ${range24h.endDate}
  `);
  const sessions24h = Number(sessions24hResult.rows[0]?.count || 0);

  // Sessions created 7d
  const sessions7dResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM chat_sessions
    WHERE created_at >= ${range7d.startDate} AND created_at <= ${range7d.endDate}
  `);
  const sessions7d = Number(sessions7dResult.rows[0]?.count || 0);

  // Questions asked (user messages) 24h
  const questions24hResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM chat_messages cm
    JOIN chat_sessions cs ON cm.session_id = cs.id
    WHERE cm.role = 'user' 
    AND cm.created_at >= ${range24h.startDate} AND cm.created_at <= ${range24h.endDate}
  `);
  const questions24h = Number(questions24hResult.rows[0]?.count || 0);

  // Questions asked 7d
  const questions7dResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM chat_messages cm
    JOIN chat_sessions cs ON cm.session_id = cs.id
    WHERE cm.role = 'user' 
    AND cm.created_at >= ${range7d.startDate} AND cm.created_at <= ${range7d.endDate}
  `);
  const questions7d = Number(questions7dResult.rows[0]?.count || 0);

  // Total LLM cost 24h
  const cost24hResult = await db.execute(sql`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM llm_cost_logs
    WHERE created_at >= ${range24h.startDate} AND created_at <= ${range24h.endDate}
  `);
  const totalCost24h = Number(cost24hResult.rows[0]?.total || 0);

  // Total LLM cost 7d
  const cost7dResult = await db.execute(sql`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM llm_cost_logs
    WHERE created_at >= ${range7d.startDate} AND created_at <= ${range7d.endDate}
  `);
  const totalCost7d = Number(cost7dResult.rows[0]?.total || 0);

  // Top town by questions
  const topTownResult = await db.execute(sql`
    SELECT cs.town_preference as town, COUNT(*) as count
    FROM chat_messages cm
    JOIN chat_sessions cs ON cm.session_id = cs.id
    WHERE cm.role = 'user'
    AND cs.town_preference IS NOT NULL AND cs.town_preference != ''
    AND cm.created_at >= ${range7d.startDate}
    GROUP BY cs.town_preference
    ORDER BY count DESC
    LIMIT 1
  `);
  const topTownByQuestions = topTownResult.rows[0] 
    ? { town: String(topTownResult.rows[0].town), count: Number(topTownResult.rows[0].count) }
    : null;

  return {
    dau24h,
    wau7d,
    sessions24h,
    sessions7d,
    questions24h,
    questions7d,
    totalCost24h,
    totalCost7d,
    topTownByQuestions,
  };
}

// ============================================================
// ENGAGEMENT METRICS
// ============================================================

export async function getEngagementMetrics(days: number = 7): Promise<EngagementMetrics> {
  const db = getDb();
  const range = getDateRange(days);

  // Sessions per day
  const sessionsPerDayResult = await db.execute(sql`
    SELECT DATE(created_at) as date, COUNT(*) as count
    FROM chat_sessions
    WHERE created_at >= ${range.startDate} AND created_at <= ${range.endDate}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  const sessionsPerDay = sessionsPerDayResult.rows.map(row => ({
    date: String(row.date),
    count: Number(row.count),
  }));

  // Avg messages per session
  const avgMessagesResult = await db.execute(sql`
    SELECT AVG(msg_count) as avg_count
    FROM (
      SELECT session_id, COUNT(*) as msg_count
      FROM chat_messages
      WHERE created_at >= ${range.startDate}
      GROUP BY session_id
    ) subq
  `);
  const avgMessagesPerSession = Number(avgMessagesResult.rows[0]?.avg_count || 0);

  // Median messages per session (using percentile_cont)
  const medianMessagesResult = await db.execute(sql`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY msg_count) as median
    FROM (
      SELECT session_id, COUNT(*) as msg_count
      FROM chat_messages
      WHERE created_at >= ${range.startDate}
      GROUP BY session_id
    ) subq
  `);
  const medianMessagesPerSession = Number(medianMessagesResult.rows[0]?.median || 0);

  // Questions per town
  const questionsPerTownResult = await db.execute(sql`
    SELECT cs.town_preference as town, COUNT(*) as count
    FROM chat_messages cm
    JOIN chat_sessions cs ON cm.session_id = cs.id
    WHERE cm.role = 'user'
    AND cs.town_preference IS NOT NULL AND cs.town_preference != ''
    AND cm.created_at >= ${range.startDate}
    GROUP BY cs.town_preference
    ORDER BY count DESC
    LIMIT 10
  `);
  const questionsPerTown = questionsPerTownResult.rows.map(row => ({
    town: String(row.town),
    count: Number(row.count),
  }));

  // Anonymous vs logged-in usage
  const usageBreakdownResult = await db.execute(sql`
    SELECT 
      COUNT(CASE WHEN user_id IS NULL THEN 1 END) as anonymous_count,
      COUNT(CASE WHEN user_id IS NOT NULL THEN 1 END) as logged_in_count,
      COUNT(*) as total
    FROM chat_sessions
    WHERE created_at >= ${range.startDate}
  `);
  const total = Number(usageBreakdownResult.rows[0]?.total || 1);
  const anonymousUsagePercent = (Number(usageBreakdownResult.rows[0]?.anonymous_count || 0) / total) * 100;
  const loggedInUsagePercent = (Number(usageBreakdownResult.rows[0]?.logged_in_count || 0) / total) * 100;

  return {
    sessionsPerDay,
    avgMessagesPerSession,
    medianMessagesPerSession,
    questionsPerTown,
    anonymousUsagePercent,
    loggedInUsagePercent,
  };
}

// ============================================================
// TOWN MEETING TEMPLATE METRICS (PLACEHOLDER)
// ============================================================

export async function getTownMeetingMetrics(days: number = 7): Promise<TownMeetingMetrics> {
  const db = getDb();
  const range = getDateRange(days);

  // Town Meeting Template feature is NOT YET IMPLEMENTED
  // Return placeholder response - hasData: false triggers the UI placeholder
  // When the feature is implemented, remove this early return and use the queries below
  
  // Check if we have any town meeting template events
  const templateEventsResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM events
    WHERE event_type = 'town_meeting_template_opened'
    AND created_at >= ${range.startDate}
  `);
  const templateOpens = Number(templateEventsResult.rows[0]?.count || 0);

  // If no events exist, return placeholder response (feature not implemented)
  if (templateOpens === 0) {
    return {
      templateOpens: 0,
      followupClickPercent: 0,
      avgFollowupsPerUser: 0,
      topFollowupPrompts: [],
      templateVsFreeChat: { template: 0, freeChat: 0 },
      hasData: false, // This tells the UI to show "No data yet" placeholder
    };
  }

  // Count followup clicks
  const followupClicksResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM events
    WHERE event_type = 'town_meeting_followup_clicked'
    AND created_at >= ${range.startDate}
  `);
  const followupClicks = Number(followupClicksResult.rows[0]?.count || 0);

  // Users who clicked at least one followup
  const usersWithFollowupResult = await db.execute(sql`
    SELECT COUNT(DISTINCT COALESCE(user_id, anon_id)) as count
    FROM events
    WHERE event_type = 'town_meeting_followup_clicked'
    AND created_at >= ${range.startDate}
  `);
  const usersWithFollowup = Number(usersWithFollowupResult.rows[0]?.count || 0);

  // Total users who opened template
  const totalTemplateUsersResult = await db.execute(sql`
    SELECT COUNT(DISTINCT COALESCE(user_id, anon_id)) as count
    FROM events
    WHERE event_type = 'town_meeting_template_opened'
    AND created_at >= ${range.startDate}
  `);
  const totalTemplateUsers = Number(totalTemplateUsersResult.rows[0]?.count || 1);

  const followupClickPercent = (usersWithFollowup / totalTemplateUsers) * 100;
  const avgFollowupsPerUser = usersWithFollowup > 0 ? followupClicks / usersWithFollowup : 0;

  // Top followup prompts
  const topFollowupsResult = await db.execute(sql`
    SELECT metadata->>'prompt' as prompt, COUNT(*) as count
    FROM events
    WHERE event_type = 'town_meeting_followup_clicked'
    AND created_at >= ${range.startDate}
    AND metadata->>'prompt' IS NOT NULL
    GROUP BY metadata->>'prompt'
    ORDER BY count DESC
    LIMIT 5
  `);
  const topFollowupPrompts = topFollowupsResult.rows.map(row => ({
    prompt: String(row.prompt),
    count: Number(row.count),
  }));

  // Sessions from template vs free chat
  const templateSessionsResult = await db.execute(sql`
    SELECT COUNT(DISTINCT session_id) as count
    FROM events
    WHERE event_type = 'town_meeting_template_opened'
    AND session_id IS NOT NULL
    AND created_at >= ${range.startDate}
  `);
  const templateSessions = Number(templateSessionsResult.rows[0]?.count || 0);

  const totalSessionsResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM chat_sessions
    WHERE created_at >= ${range.startDate}
  `);
  const totalSessions = Number(totalSessionsResult.rows[0]?.count || 0);
  const freeChatSessions = totalSessions - templateSessions;

  return {
    templateOpens,
    followupClickPercent,
    avgFollowupsPerUser,
    topFollowupPrompts,
    templateVsFreeChat: { template: templateSessions, freeChat: freeChatSessions },
    hasData: true,
  };
}

// ============================================================
// MINUTES ENGAGEMENT METRICS
// ============================================================

export async function getMinutesEngagementMetrics(days: number = 7): Promise<MinutesEngagementMetrics> {
  const db = getDb();
  const range = getDateRange(days);

  // Ask clicks
  const askClicksResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM events
    WHERE event_type = 'recent_minutes_ask_clicked'
    AND created_at >= ${range.startDate}
  `);
  const askClicks = Number(askClicksResult.rows[0]?.count || 0);

  // View clicks
  const viewClicksResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM events
    WHERE event_type = 'recent_minutes_view_clicked'
    AND created_at >= ${range.startDate}
  `);
  const viewClicks = Number(viewClicksResult.rows[0]?.count || 0);

  // Engagement by board
  const engagementByBoardResult = await db.execute(sql`
    SELECT 
      board,
      COUNT(CASE WHEN event_type = 'recent_minutes_ask_clicked' THEN 1 END) as ask_clicks,
      COUNT(CASE WHEN event_type = 'recent_minutes_view_clicked' THEN 1 END) as view_clicks
    FROM events
    WHERE event_type IN ('recent_minutes_ask_clicked', 'recent_minutes_view_clicked')
    AND board IS NOT NULL
    AND created_at >= ${range.startDate}
    GROUP BY board
    ORDER BY (ask_clicks + view_clicks) DESC
    LIMIT 10
  `);
  const engagementByBoard = engagementByBoardResult.rows.map(row => ({
    board: String(row.board || "Unknown"),
    askClicks: Number(row.ask_clicks || 0),
    viewClicks: Number(row.view_clicks || 0),
  }));

  return {
    askClicks,
    viewClicks,
    engagementByBoard,
  };
}

// ============================================================
// TOPIC METRICS
// ============================================================

export async function getTopicMetrics(days: number = 7): Promise<TopicMetrics> {
  const db = getDb();
  const range = getDateRange(days);

  // Top topics weekly (using events.topic)
  const topTopicsResult = await db.execute(sql`
    SELECT topic, COUNT(*) as count
    FROM events
    WHERE topic IS NOT NULL AND topic != ''
    AND created_at >= ${range.startDate}
    GROUP BY topic
    ORDER BY count DESC
    LIMIT 5
  `);
  const topTopicsWeekly = topTopicsResult.rows.map(row => ({
    topic: String(row.topic),
    count: Number(row.count),
  }));

  // Top topics by town
  const topTopicsByTownResult = await db.execute(sql`
    SELECT town, topic, COUNT(*) as count
    FROM events
    WHERE topic IS NOT NULL AND topic != ''
    AND town IS NOT NULL AND town != ''
    AND created_at >= ${range.startDate}
    GROUP BY town, topic
    ORDER BY town, count DESC
  `);
  
  // Group by town
  const townTopicsMap: Record<string, { topic: string; count: number }[]> = {};
  for (const row of topTopicsByTownResult.rows) {
    const town = String(row.town);
    if (!townTopicsMap[town]) {
      townTopicsMap[town] = [];
    }
    if (townTopicsMap[town].length < 5) {
      townTopicsMap[town].push({
        topic: String(row.topic),
        count: Number(row.count),
      });
    }
  }
  const topTopicsByTown = Object.entries(townTopicsMap).map(([town, topics]) => ({
    town,
    topics,
  }));

  return {
    topTopicsWeekly,
    topTopicsByTown,
  };
}

// ============================================================
// TRUST & RISK METRICS
// ============================================================

export async function getTrustMetrics(days: number = 7): Promise<TrustMetrics> {
  const db = getDb();
  const range = getDateRange(days);

  // Get total assistant messages to calculate rates
  const totalMessagesResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM chat_messages
    WHERE role = 'assistant'
    AND created_at >= ${range.startDate}
  `);
  const totalMessages = Number(totalMessagesResult.rows[0]?.count || 1);

  // Citation rate (messages with citations) - this works with existing data
  const citedMessagesResult = await db.execute(sql`
    SELECT COUNT(*) as count
    FROM chat_messages
    WHERE role = 'assistant'
    AND citations IS NOT NULL AND citations != ''
    AND created_at >= ${range.startDate}
  `);
  const citedMessages = Number(citedMessagesResult.rows[0]?.count || 0);
  const citationRate = (citedMessages / totalMessages) * 100;

  // No doc found rate - derived from messages without citations (approximation)
  // In a real implementation, this would come from structured signals in the chat pipeline
  const noDocFoundRate = 100 - citationRate;

  // Scope mismatch rate - placeholder until pipeline logs this event
  // Would be calculated from actual scope_mismatch events when implemented
  const scopeMismatchRate = 0;

  return {
    noDocFoundRate,
    scopeMismatchRate,
    citationRate,
  };
}

// ============================================================
// COST METRICS
// ============================================================

export async function getCostMetrics(days: number = 7): Promise<CostMetrics> {
  const db = getDb();
  const range = getDateRange(days);

  // Cost per day
  const costPerDayResult = await db.execute(sql`
    SELECT DATE(created_at) as date, COALESCE(SUM(cost_usd), 0) as cost
    FROM llm_cost_logs
    WHERE created_at >= ${range.startDate}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  const costPerDay = costPerDayResult.rows.map(row => ({
    date: String(row.date),
    cost: Number(row.cost),
  }));

  // Cost by model
  const costByModelResult = await db.execute(sql`
    SELECT model, COALESCE(SUM(cost_usd), 0) as cost
    FROM llm_cost_logs
    WHERE created_at >= ${range.startDate}
    GROUP BY model
    ORDER BY cost DESC
  `);
  const costByModel = costByModelResult.rows.map(row => ({
    model: String(row.model),
    cost: Number(row.cost),
  }));

  // Cost by town (via session)
  const costByTownResult = await db.execute(sql`
    SELECT cs.town_preference as town, COALESCE(SUM(l.cost_usd), 0) as cost
    FROM llm_cost_logs l
    JOIN chat_sessions cs ON l.session_id = cs.id
    WHERE l.created_at >= ${range.startDate}
    AND cs.town_preference IS NOT NULL AND cs.town_preference != ''
    GROUP BY cs.town_preference
    ORDER BY cost DESC
    LIMIT 10
  `);
  const costByTown = costByTownResult.rows.map(row => ({
    town: String(row.town),
    cost: Number(row.cost),
  }));

  // Avg cost per question
  const avgCostResult = await db.execute(sql`
    SELECT AVG(cost_usd) as avg_cost
    FROM llm_cost_logs
    WHERE stage = 'synthesis'
    AND created_at >= ${range.startDate}
  `);
  const avgCostPerQuestion = Number(avgCostResult.rows[0]?.avg_cost || 0);

  // Median cost per question
  const medianCostResult = await db.execute(sql`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cost_usd) as median
    FROM llm_cost_logs
    WHERE stage = 'synthesis'
    AND created_at >= ${range.startDate}
  `);
  const medianCostPerQuestion = Number(medianCostResult.rows[0]?.median || 0);

  // Cost per useful session (>=3 messages OR followup clicked OR template used)
  const usefulSessionsResult = await db.execute(sql`
    SELECT COUNT(DISTINCT s.id) as count
    FROM chat_sessions s
    LEFT JOIN (
      SELECT session_id, COUNT(*) as msg_count
      FROM chat_messages
      GROUP BY session_id
    ) m ON s.id = m.session_id
    LEFT JOIN (
      SELECT DISTINCT session_id
      FROM events
      WHERE event_type IN ('town_meeting_followup_clicked', 'town_meeting_template_opened')
    ) e ON s.id = e.session_id
    WHERE s.created_at >= ${range.startDate}
    AND (m.msg_count >= 3 OR e.session_id IS NOT NULL)
  `);
  const usefulSessions = Number(usefulSessionsResult.rows[0]?.count || 1);

  const totalCostResult = await db.execute(sql`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM llm_cost_logs
    WHERE created_at >= ${range.startDate}
  `);
  const totalCost = Number(totalCostResult.rows[0]?.total || 0);
  const costPerUsefulSession = totalCost / usefulSessions;

  return {
    costPerDay,
    costByModel,
    costByTown,
    avgCostPerQuestion,
    medianCostPerQuestion,
    costPerUsefulSession,
  };
}

// ============================================================
// ALERTS
// ============================================================

const THRESHOLDS = {
  noDocRate: 30, // 30%
  dailyCost: 10, // $10
  scopeMismatch: 20, // 20%
};

export async function getAlerts(days: number = 1): Promise<AlertItem[]> {
  const db = getDb();
  const alerts: AlertItem[] = [];
  const range = getDateRange(days);

  // Check daily cost - this is the most reliable metric from llm_cost_logs
  const costResult = await db.execute(sql`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM llm_cost_logs
    WHERE created_at >= ${range.startDate}
  `);
  const dailyCost = Number(costResult.rows[0]?.total || 0);
  if (dailyCost > THRESHOLDS.dailyCost) {
    alerts.push({
      type: "daily_cost",
      message: `Daily LLM cost is $${dailyCost.toFixed(2)}, exceeding $${THRESHOLDS.dailyCost} threshold`,
      value: dailyCost,
      threshold: THRESHOLDS.dailyCost,
    });
  }

  // Note: no_doc_rate and scope_mismatch alerts are disabled until 
  // the chat pipeline logs these events properly
  // When implemented, uncomment and use real event data

  return alerts;
}
