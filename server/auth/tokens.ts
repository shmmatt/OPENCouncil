import jwt from "jsonwebtoken";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export interface MagicLinkPayload {
  email: string;
  type: "magic_link";
  exp: number;
}

export interface UserTokenPayload {
  userId: string;
  email?: string;
  type: "user_session";
}

export function generateMagicLinkToken(email: string): string {
  const payload: MagicLinkPayload = {
    email,
    type: "magic_link",
    exp: Math.floor(Date.now() / 1000) + 15 * 60, // 15 min expiry
  };
  return jwt.sign(payload, JWT_SECRET);
}

export function verifyMagicLinkToken(token: string): MagicLinkPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as MagicLinkPayload;
    if (decoded.type !== "magic_link") {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function generateUserSessionToken(userId: string, email?: string): string {
  const payload: UserTokenPayload = {
    userId,
    email,
    type: "user_session",
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyUserSessionToken(token: string): UserTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as UserTokenPayload;
    if (decoded.type !== "user_session") {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function generateRequestId(): string {
  return crypto.randomUUID();
}
