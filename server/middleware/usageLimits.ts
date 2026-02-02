import { Response, NextFunction } from "express";
import { getDailyCost } from "../llm/callLLMWithLogging";
import type { IdentityRequest } from "../auth/types";

const DAILY_LIMIT_ANON = 0.10; // $0.10 per day for anonymous users
const DAILY_LIMIT_FREE_USER = 0.50; // $0.50 per day for free users
const DAILY_LIMIT_PAYING_USER = 10.00; // $10.00 per day for paying users

export async function checkUsageLimits(
  req: IdentityRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const actor = req.actor;
    
    if (!actor) {
      return next();
    }
    
    const dailyCost = await getDailyCost(actor);
    
    let limit: number;
    let tierName: string;
    
    if (actor.actorType === "user" && actor.user) {
      if (actor.user.isPaying) {
        limit = DAILY_LIMIT_PAYING_USER;
        tierName = "paying";
      } else {
        limit = DAILY_LIMIT_FREE_USER;
        tierName = "free";
      }
    } else {
      limit = DAILY_LIMIT_ANON;
      tierName = "anonymous";
    }
    
    if (dailyCost >= limit) {
      res.status(429).json({
        error: "Daily usage limit exceeded",
        message: `You've reached your daily limit for ${tierName} users. ${
          tierName === "anonymous" 
            ? "Sign up for a free account to get more usage."
            : tierName === "free"
            ? "Upgrade to a paid plan for more usage."
            : "Your limit will reset tomorrow."
        }`,
        dailyCost,
        limit,
        tier: tierName,
      });
      return;
    }
    
    next();
  } catch (error) {
    console.error("Error checking usage limits:", error);
    next();
  }
}

export function getUsageLimits() {
  return {
    anonymous: DAILY_LIMIT_ANON,
    free: DAILY_LIMIT_FREE_USER,
    paying: DAILY_LIMIT_PAYING_USER,
  };
}
