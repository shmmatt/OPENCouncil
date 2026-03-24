import { Router } from "express";
import Stripe from "stripe";
import { requireUser } from "../auth/middleware";
import type { IdentityRequest } from "../auth/types";
import * as users from "../storage/users";

const router = Router();

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

router.post("/checkout", requireUser, async (req: IdentityRequest, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: "Stripe is not configured" });
  }

  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) {
    return res.status(503).json({ error: "Stripe price ID not configured" });
  }

  const user = req.user!;
  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/chat?stripe_success=1`,
      cancel_url: `${baseUrl}/chat?stripe_cancel=1`,
      metadata: { userId: user.id },
    };

    if (user.stripeCustomerId) {
      sessionParams.customer = user.stripeCustomerId;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    if (session.customer && !user.stripeCustomerId) {
      await users.updateUser(user.id, {
        stripeCustomerId: session.customer as string,
      });
    }

    return res.json({ url: session.url });
  } catch (error: any) {
    console.error("[Stripe] Checkout session creation failed:", error);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});

router.post("/webhook", async (req: IdentityRequest, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: "Stripe is not configured" });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(503).json({ error: "Stripe webhook secret not configured" });
  }

  const sig = req.headers["stripe-signature"] as string;
  let event: Stripe.Event;

  const rawBody = (req as any).rawBody;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    console.error("[Stripe] Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;

    if (userId && session.subscription) {
      try {
        await users.updateUser(userId, {
          isPaying: true,
          stripeSubscriptionId: session.subscription as string,
          stripeSubscriptionStatus: "active",
        });
        console.log(`[Stripe] User ${userId} upgraded to paying`);
      } catch (error) {
        console.error("[Stripe] Failed to update user after checkout:", error);
        return res.status(500).json({ error: "Failed to update user" });
      }
    }
  }

  return res.json({ received: true });
});

export default router;
