// Maya NurseMate — /api/checkout
// Maakt een Stripe-betaalpagina (Checkout Session) voor het abonnement:
// Managed Payments (Stripe als merchant of record) + 7 dagen gratis proefperiode.
// De prijs komt uit de Vercel-omgevingsvariabele STRIPE_PRICE_ID.

import { isAllowedOrigin, normalizeEmail, isValidEmail, stripePost } from "../lib/subscription.js";

const TRIAL_DAYS = 7;
const MAX_CHECKOUTS_PER_HOUR = 10; // per gebruiker (IP-adres)

const hits = new Map();

function tooManyRequests(ip) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => t > hourAgo);
  if (list.length >= MAX_CHECKOUTS_PER_HOUR) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear(); // geheugen niet laten vollopen
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // 1. Alleen verzoeken vanaf mayanurse.com
  const origin = req.headers.origin || "";
  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ ok: false, reason: "forbidden" });
  }

  // 2. Limiet per gebruiker
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (tooManyRequests(ip)) return res.status(429).json({ ok: false, reason: "too_many" });

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    console.error("STRIPE_SECRET_KEY of STRIPE_PRICE_ID ontbreekt in Vercel.");
    return res.status(503).json({ ok: false, reason: "check_failed" });
  }

  const params = {
    "mode": "subscription",
    "line_items[0][price]": process.env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    "managed_payments[enabled]": "true",
    "subscription_data[trial_period_days]": String(TRIAL_DAYS),
    "success_url": `${origin}/app.html?abonnement=ok`,
    "cancel_url": `${origin}/app.html`,
  };

  // Taal van de betaalpagina = taal van de app
  const lang = req.body?.lang;
  if (["nl", "fr", "en"].includes(lang)) params.locale = lang;

  // E-mailadres alvast invullen, zodat het zeker hetzelfde is als bij het inloggen
  const typedEmail = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (typedEmail && isValidEmail(normalizeEmail(typedEmail))) params.customer_email = typedEmail;

  try {
    const session = await stripePost("checkout/sessions", params);
    return res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Stripe Checkout mislukt:", err?.message);
    return res.status(503).json({ ok: false, reason: "check_failed" });
  }
}
