// Maya NurseMate — abonnement controleren via Stripe + ondertekende toegangspassen.
// Gedeeld door /api/login en /api/generate. Geen database nodig.

import crypto from "node:crypto";

// Websites die Maya's server mogen gebruiken.
// Het voorbeeldadres van Vercel werkt alleen in de voorbeeldversie (VERCEL_ENV = "preview"),
// nooit in de live-versie op mayanurse.com.
const PREVIEW_ORIGIN = "https://nursemate-git-abonnement-lemonsqueezy-flora983s-projects.vercel.app";
export const ALLOWED_ORIGINS = [
  "https://mayanurse.com",
  "https://www.mayanurse.com",
  ...(process.env.VERCEL_ENV === "preview" ? [PREVIEW_ORIGIN] : []),
];

// Statussen die toegang geven:
// - trialing: gratis proefperiode
// - active: betaald abonnement
// - past_due: betaling mislukt maar Stripe probeert nog opnieuw (niemand midden in een dienst blokkeren)
// Geen toegang bij: canceled, unpaid, incomplete, incomplete_expired, paused.
const ACCESS_STATUSES = ["trialing", "active", "past_due"];

const SUBSCRIPTION_CACHE_MS = 5 * 60 * 1000;
const subscriptionCache = new Map(); // e-mailadres -> tijdstip tot wanneer goedgekeurd

export function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── Ondertekende passen ───
// Een pas is "inhoud.handtekening". Alleen de server kent AUTH_SECRET,
// dus niemand kan zelf een geldige pas maken of de inhoud aanpassen.

function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    console.error("AUTH_SECRET ontbreekt in Vercel of is te kort (minstens 32 tekens).");
    return null;
  }
  return secret;
}

function hmac(secret, text) {
  return crypto.createHmac("sha256", secret).update(text).digest("base64url");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Geeft null terug als AUTH_SECRET ontbreekt
export function signToken(data) {
  const secret = getSecret();
  if (!secret) return null;
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  return body + "." + hmac(secret, body);
}

// Geeft de inhoud terug, of null als de pas vervalst, beschadigd of verlopen is
export function verifyToken(token, expectedType) {
  const secret = getSecret();
  if (!secret || typeof token !== "string" || token.length > 2000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(sig, hmac(secret, body))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data || data.t !== expectedType || typeof data.x !== "number" || data.x < Date.now()) return null;
  return data;
}

// Vingerafdruk van een inlogcode. De code zelf staat nergens in de pas.
export function codeHash(email, code, expires) {
  const secret = getSecret();
  return secret ? hmac(secret, `code:${email}:${code}:${expires}`) : null;
}

export { safeEqual };

// ─── Stripe ───
// Vaste API-versie: Managed Payments vraagt minstens deze versie, en zo hangt
// Maya niet af van de standaardversie die in het Stripe-account ingesteld staat.
const STRIPE_VERSION = "2026-04-22.dahlia";

async function stripeRequest(method, path, params) {
  const query = new URLSearchParams(params).toString();
  const url = "https://api.stripe.com/v1/" + path + (method === "GET" ? "?" + query : "");
  const response = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method === "POST" ? { body: query } : {}),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`Stripe ${response.status}: ${data?.error?.message || "onbekende fout"}`);
  }
  return response.json();
}

const stripeGet = (path, params) => stripeRequest("GET", path, params);
export const stripePost = (path, params) => stripeRequest("POST", path, params);

// Hoort dit abonnementsonderdeel bij Maya? Op basis van de prijs (STRIPE_PRICE_ID),
// of — als je later een tweede prijs toevoegt, bv. per jaar — op basis van het product.
function isMayaItem(item) {
  const priceId = process.env.STRIPE_PRICE_ID;
  const productId = process.env.STRIPE_PRODUCT_ID;
  return item?.price?.id === priceId || (!!productId && item?.price?.product === productId);
}

// Geeft terug: "ok", "none" (geen geldig abonnement) of "check_failed" (storing).
// Stripe zoekt hoofdlettergevoelig ("Anna@..." ≠ "anna@..."), daarom zoeken we
// met het adres in kleine letters én zoals de gebruiker het intypte.
export async function checkSubscription(email, typedEmail) {
  const now = Date.now();
  if ((subscriptionCache.get(email) || 0) > now) return "ok";
  const variants = [...new Set([email, typeof typedEmail === "string" ? typedEmail.trim() : ""])].filter(Boolean);

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    console.error("STRIPE_SECRET_KEY of STRIPE_PRICE_ID ontbreekt in Vercel.");
    return "check_failed";
  }

  try {
    const customers = [];
    for (const variant of variants) {
      const found = await stripeGet("customers", { email: variant, limit: "100" });
      customers.push(...(found.data || []));
    }
    for (const customer of customers) {
      const subs = await stripeGet("subscriptions", { customer: customer.id, status: "all", limit: "100" });
      const hasAccess = (subs.data || []).some(
        (sub) =>
          ACCESS_STATUSES.includes(sub.status) &&
          (sub.items?.data || []).some(isMayaItem)
      );
      if (hasAccess) {
        subscriptionCache.set(email, now + SUBSCRIPTION_CACHE_MS);
        if (subscriptionCache.size > 5000) subscriptionCache.clear(); // geheugen niet laten vollopen
        return "ok";
      }
    }
    return "none";
  } catch (err) {
    console.error("Stripe-controle mislukt:", err?.message);
    return "check_failed";
  }
}
