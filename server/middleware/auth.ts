import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}

const JWT_SECRET = process.env.JWT_SECRET;

export interface AuthRequest extends Request {
  adminEmail?: string;
}

export function authenticateAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string };
    
    req.adminEmail = decoded.email;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
}

export function generateToken(email: string): string {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: "7d" });
}
