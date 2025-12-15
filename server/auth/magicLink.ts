import { Router, Response } from "express";
import { z } from "zod";
import sgMail from "@sendgrid/mail";
import { storage } from "../storage";
import { generateMagicLinkToken, verifyMagicLinkToken, generateUserSessionToken } from "./tokens";
import type { IdentityRequest } from "./types";

const router = Router();

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const sendMagicLinkSchema = z.object({
  email: z.string().email(),
});

async function sendMagicLinkEmail(to: string, magicLink: string): Promise<boolean> {
  if (!process.env.SENDGRID_API_KEY) {
    console.error("[MagicLink] SENDGRID_API_KEY not configured");
    return false;
  }

  const fromEmail = process.env.SENDGRID_FROM_EMAIL || "noreply@example.com";
  
  const msg = {
    to,
    from: fromEmail,
    subject: "Your Sign-In Link",
    text: `Click this link to sign in: ${magicLink}\n\nThis link expires in 15 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">Sign In to Your Account</h2>
        <p style="color: #666; font-size: 16px;">Click the button below to sign in:</p>
        <a href="${magicLink}" style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0;">Sign In</a>
        <p style="color: #999; font-size: 14px;">Or copy and paste this link: ${magicLink}</p>
        <p style="color: #999; font-size: 12px;">This link expires in 15 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`[MagicLink] Email sent to ${to}`);
    return true;
  } catch (error: any) {
    console.error("[MagicLink] Failed to send email:", error?.response?.body || error);
    return false;
  }
}

router.post("/magic-link", async (req: IdentityRequest, res: Response) => {
  try {
    const { email } = sendMagicLinkSchema.parse(req.body);
    
    const token = generateMagicLinkToken(email);
    const magicLink = `${req.protocol}://${req.get("host")}/api/auth/verify?token=${token}`;
    
    console.log(`[MagicLink] Generated for ${email}: ${magicLink}`);
    
    const emailSent = await sendMagicLinkEmail(email, magicLink);
    
    if (!emailSent) {
      return res.status(500).json({ error: "Failed to send magic link email. Please try again." });
    }
    
    res.json({ 
      success: true, 
      message: "Check your email for the sign-in link",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    console.error("Error generating magic link:", error);
    res.status(500).json({ error: "Failed to generate magic link" });
  }
});

router.get("/verify", async (req: IdentityRequest, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      return res.status(400).json({ error: "No token provided" });
    }
    
    const payload = verifyMagicLinkToken(token);
    if (!payload) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }
    
    const { email } = payload;
    
    let identity = await storage.getUserIdentityByProviderKey("email", email);
    let user;
    
    if (identity) {
      user = await storage.getUserById(identity.userId);
      if (user) {
        await storage.updateUserLastLogin(user.id);
      }
    } else {
      user = await storage.createUser({});
      identity = await storage.createUserIdentity({
        userId: user.id,
        provider: "email",
        providerKey: email,
      });
      
      if (req.anonId) {
        await storage.linkAnonymousUserToUser(req.anonId, user.id);
      }
    }
    
    if (!user) {
      return res.status(500).json({ error: "Failed to create or retrieve user" });
    }
    
    const sessionToken = generateUserSessionToken(user.id, email);
    
    res.cookie("oc_session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
    
    res.json({ 
      success: true,
      user: {
        id: user.id,
        role: user.role,
        isPaying: user.isPaying,
      },
    });
  } catch (error) {
    console.error("Error verifying magic link:", error);
    res.status(500).json({ error: "Failed to verify magic link" });
  }
});

router.get("/me", async (req: IdentityRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  
  res.json({
    id: req.user.id,
    role: req.user.role,
    isPaying: req.user.isPaying,
    defaultTown: req.user.defaultTown,
    isMunicipalStaff: req.user.isMunicipalStaff,
  });
});

router.get("/usage", async (req: IdentityRequest, res: Response) => {
  const { getDailyCost } = await import("../llm/callLLMWithLogging");
  const { getUsageLimits } = await import("../middleware/usageLimits");
  
  const limits = getUsageLimits();
  
  let tier: "anonymous" | "free" | "paying";
  let limit: number;
  let dailyCost = 0;
  
  if (req.user) {
    tier = req.user.isPaying ? "paying" : "free";
    limit = req.user.isPaying ? limits.paying : limits.free;
    if (req.actor) {
      dailyCost = await getDailyCost(req.actor);
    }
  } else {
    tier = "anonymous";
    limit = limits.anonymous;
    if (req.actor) {
      dailyCost = await getDailyCost(req.actor);
    }
  }
  
  const usagePercent = limit > 0 
    ? Math.min(100, Math.round((dailyCost / limit) * 100))
    : 100;
  
  res.json({
    tier,
    usagePercent,
    isAuthenticated: !!req.user,
  });
});

router.post("/logout", async (req: IdentityRequest, res: Response) => {
  res.clearCookie("oc_session");
  res.json({ success: true });
});

export const authRouter = router;
