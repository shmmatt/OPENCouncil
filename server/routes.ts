import type { Express } from "express";
import { createServer, type Server } from "http";
import * as fs from "fs/promises";
import type { ActorContext } from "./auth/types";

declare module "express-serve-static-core" {
  interface Request {
    actor?: ActorContext;
    anonId?: string;
  }
}

import { registerAllRoutes } from "./routes/index";

export async function registerRoutes(app: Express): Promise<Server> {
  await fs.mkdir("uploads/blobs", { recursive: true }).catch(() => {});

  registerAllRoutes(app);

  const httpServer = createServer(app);
  return httpServer;
}
