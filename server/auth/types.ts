import type { Request } from "express";
import type { User, AnonymousUser } from "@shared/schema";

export interface ActorContext {
  actorType: "user" | "anon";
  userId?: string;
  anonId?: string;
  user?: User;
  anon?: AnonymousUser;
}

export interface IdentityRequest extends Request {
  actor?: ActorContext;
  anonId?: string;
  user?: User;
}
