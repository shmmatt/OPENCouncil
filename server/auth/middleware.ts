import { Response, NextFunction } from "express";
import { storage } from "../storage";
import { verifyUserSessionToken } from "./tokens";
import type { IdentityRequest } from "./types";

const SESSION_COOKIE_NAME = "oc_session";

export async function attachUserIdentity(
  req: IdentityRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
    
    if (!sessionToken) {
      return next();
    }
    
    const payload = verifyUserSessionToken(sessionToken);
    if (!payload) {
      res.clearCookie(SESSION_COOKIE_NAME);
      return next();
    }
    
    const user = await storage.getUserById(payload.userId);
    if (!user) {
      res.clearCookie(SESSION_COOKIE_NAME);
      return next();
    }
    
    req.user = user;
    req.actor = {
      actorType: "user",
      userId: user.id,
      user,
      anonId: req.anonId,
      anon: req.actor?.anon,
    };
    
    next();
  } catch (error) {
    console.error("Error in attachUserIdentity:", error);
    next();
  }
}

export function requireUser(
  req: IdentityRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: IdentityRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    
    next();
  };
}
