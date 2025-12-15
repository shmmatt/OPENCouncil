import type { Express, Request, Response } from "express";
import { authenticateAdmin } from "../middleware/auth";
import {
  getOverviewMetrics,
  getEngagementMetrics,
  getTownMeetingMetrics,
  getMinutesEngagementMetrics,
  getTopicMetrics,
  getTrustMetrics,
  getCostMetrics,
  getAlerts,
} from "../services/adminUsageService";

export function registerAdminUsageRoutes(app: Express) {
  // Overview metrics (At-a-Glance Health)
  app.get(
    "/api/admin/usage/overview",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const metrics = await getOverviewMetrics();
        res.json(metrics);
      } catch (error) {
        console.error("Error fetching overview metrics:", error);
        res.status(500).json({ message: "Failed to fetch overview metrics" });
      }
    }
  );

  // Engagement metrics
  app.get(
    "/api/admin/usage/engagement",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const days = parseInt(req.query.days as string) || 7;
        const metrics = await getEngagementMetrics(days);
        res.json(metrics);
      } catch (error) {
        console.error("Error fetching engagement metrics:", error);
        res.status(500).json({ message: "Failed to fetch engagement metrics" });
      }
    }
  );

  // Town Meeting template metrics (placeholder-ready)
  app.get(
    "/api/admin/usage/town-meeting",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const days = parseInt(req.query.days as string) || 7;
        const metrics = await getTownMeetingMetrics(days);
        res.json(metrics);
      } catch (error) {
        console.error("Error fetching town meeting metrics:", error);
        res.status(500).json({ message: "Failed to fetch town meeting metrics" });
      }
    }
  );

  // Recent minutes engagement metrics
  app.get(
    "/api/admin/usage/minutes",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const days = parseInt(req.query.days as string) || 7;
        const metrics = await getMinutesEngagementMetrics(days);
        res.json(metrics);
      } catch (error) {
        console.error("Error fetching minutes metrics:", error);
        res.status(500).json({ message: "Failed to fetch minutes metrics" });
      }
    }
  );

  // Topic & issue demand metrics
  app.get(
    "/api/admin/usage/topics",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const days = parseInt(req.query.days as string) || 7;
        const metrics = await getTopicMetrics(days);
        res.json(metrics);
      } catch (error) {
        console.error("Error fetching topic metrics:", error);
        res.status(500).json({ message: "Failed to fetch topic metrics" });
      }
    }
  );

  // Trust & risk signals
  app.get(
    "/api/admin/usage/trust",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const days = parseInt(req.query.days as string) || 7;
        const metrics = await getTrustMetrics(days);
        res.json(metrics);
      } catch (error) {
        console.error("Error fetching trust metrics:", error);
        res.status(500).json({ message: "Failed to fetch trust metrics" });
      }
    }
  );

  // Cost & efficiency metrics
  app.get(
    "/api/admin/usage/costs",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const days = parseInt(req.query.days as string) || 7;
        const metrics = await getCostMetrics(days);
        res.json(metrics);
      } catch (error) {
        console.error("Error fetching cost metrics:", error);
        res.status(500).json({ message: "Failed to fetch cost metrics" });
      }
    }
  );

  // Alerts panel
  app.get(
    "/api/admin/usage/alerts",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const days = parseInt(req.query.days as string) || 1;
        const alerts = await getAlerts(days);
        res.json(alerts);
      } catch (error) {
        console.error("Error fetching alerts:", error);
        res.status(500).json({ message: "Failed to fetch alerts" });
      }
    }
  );
}
