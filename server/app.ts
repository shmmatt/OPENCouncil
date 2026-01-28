import { type Server } from "node:http";

import express, {
  type Express,
  type Request,
  Response,
  NextFunction,
} from "express";
import cookieParser from "cookie-parser";

import { validateEnv } from "./config/env";
import { registerRoutes } from "./routes";
import { ensureAdminExists } from "./init-admin";
import { attachAnonymousIdentity, attachUserIdentity, authRouter } from "./auth";
import { startOcrWorker } from "./workers/ocrWorker";
import { generalApiLimiter } from "./middleware/rateLimiter";
import { logInfo, logError, getLogger } from "./utils/logger";

// Validate environment variables before anything else
validateEnv();

const logger = getLogger();

/**
 * @deprecated Use logInfo/logError from ./utils/logger instead
 */
export function log(message: string, source = "express") {
  logInfo(message, { source });
}

export const app = express();

// Trust proxy for accurate IP detection behind reverse proxies (Replit, Railway, etc.)
// This is required for rate limiting to work correctly in production
app.set('trust proxy', 1);

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use(attachAnonymousIdentity);
app.use(attachUserIdentity);

app.use("/api/auth", authRouter);

// Request logging middleware using pino
app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api")) {
      logger.info({
        method: req.method,
        path: reqPath,
        statusCode: res.statusCode,
        durationMs: duration,
      }, "api_request");
    }
  });

  next();
});

export default async function runApp(
  setup: (app: Express, server: Server) => Promise<void>,
) {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    // Log the error but don't throw it - that causes connection issues
    logError("server_error", { 
      statusCode: status, 
      message,
      stack: err.stack,
    });
    res.status(status).json({ message });
  });

  // Initialize admin account from environment variables
  await ensureAdminExists();
  
  // Start the OCR background worker
  startOcrWorker();

  // importantly run the final setup after setting up all the other routes so
  // the catch-all route doesn't interfere with the other routes
  await setup(app, server);

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    logInfo("server_started", { port, host: "0.0.0.0" });
  });
}
