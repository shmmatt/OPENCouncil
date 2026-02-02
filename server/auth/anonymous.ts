import { Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { storage } from "../storage";
import type { IdentityRequest } from "./types";

const ANON_COOKIE_NAME = "oc_anon_id";
const ANON_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year

export async function attachAnonymousIdentity(
  req: IdentityRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let anonId = req.cookies?.[ANON_COOKIE_NAME];
    
    if (anonId) {
      const existingAnon = await storage.getAnonymousUserById(anonId);
      if (existingAnon) {
        await storage.updateAnonymousUserLastSeen(anonId);
        req.anonId = anonId;
        
        if (!req.actor) {
          req.actor = {
            actorType: "anon",
            anonId,
            anon: existingAnon,
          };
        }
        return next();
      }
    }
    
    anonId = uuidv4();
    const anon = await storage.createAnonymousUser({ id: anonId });
    
    res.cookie(ANON_COOKIE_NAME, anonId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: ANON_COOKIE_MAX_AGE,
    });
    
    req.anonId = anonId;
    if (!req.actor) {
      req.actor = {
        actorType: "anon",
        anonId,
        anon,
      };
    }
    
    next();
  } catch (error) {
    console.error("Error in attachAnonymousIdentity:", error);
    next();
  }
}
