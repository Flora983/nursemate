// Maya NurseMate — /api/generate
// Beveiligde versie: alleen eigen website, limiet per gebruiker, begrensde lengte,
// en alleen voor gebruikers met een geldig abonnement (Stripe).

import { verifyToken, checkSubscription } from "../lib/subscription.js";

const ALLOWED_ORIGINS = [
  "https://mayanurse.com",
  "https://www.mayanurse.com",
];

const MAX_REQUESTS_PER_HOUR = 30;   // per gebruiker (IP-adres)
const MAX_TOKENS_CAP = 1500;        // maximale lengte van het antwoord
const MAX_INPUT_CHARS = 12000;      // maximale lengte van alle tekst samen
const MAX_MESSAGES = 20;            // maximaal aantal berichten per verzoek

// Eenvoudige teller in het geheugen. Niet waterdicht (Vercel start soms
// nieuwe servers op), maar houdt het meeste misbruik tegen.
const hits = new Map();

function tooManyRequests(ip) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => t > hourAgo);
  if (list.length >= MAX_REQUESTS_PER_HOUR) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear(); // geheugen niet laten vollopen
  return false;
}

function errorReply(res, status, text, extra) {
  // Zelfde formaat als een normaal antwoord, zodat de app het kan tonen
  return res.status(status).json({ content: [{ type: "text", text }], error: true, ...extra });
}

const ACCESS_MESSAGES = {
  login:
    "Log in om Maya te gebruiken. / Connectez-vous pour utiliser Maya. / Please log in to use Maya.",
  inactive:
    "Geen actief abonnement gevonden. / Aucun abonnement actif trouvé. / No active subscription found.",
  check_failed:
    "Je abonnement kon even niet gecontroleerd worden. Probeer het zo opnieuw. / Impossible de vérifier votre abonnement pour le moment. Réessayez. / Your subscription could not be checked right now. Please try again.",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // 1. Alleen verzoeken vanaf mayanurse.com
  const origin = req.headers.origin || "";
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return errorReply(res, 403, "Toegang geweigerd.");
  }

  // 2. Limiet per gebruiker
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (tooManyRequests(ip)) {
    return errorReply(
      res,
      429,
      "Je hebt het maximum aantal verslagen voor dit uur bereikt. Probeer het later opnieuw. / Limite atteinte, réessayez plus tard. / Limit reached, please try again later."
    );
  }

  // 3. Controle van de inhoud
  const { system, messages, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return errorReply(res, 400, "Ongeldig verzoek.");
  }

  const openaiMessages = [];
  if (typeof system === "string" && system) {
    openaiMessages.push({ role: "system", content: system });
  }
  for (const m of messages) {
    if (!m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string") {
      return errorReply(res, 400, "Ongeldig verzoek.");
    }
    openaiMessages.push({ role: m.role, content: m.content });
  }

  const totalChars = openaiMessages.reduce((n, m) => n + m.content.length, 0);
  if (totalChars > MAX_INPUT_CHARS) {
    return errorReply(res, 413, "De tekst is te lang. Maak je verslag wat korter.");
  }

  const tokens = Math.min(Number(max_tokens) || 1000, MAX_TOKENS_CAP);

  // 4. Geldig abonnement? Zonder geldige toegangspas + abonnement wordt OpenAI niet aangeroepen.
  //    De toegangspas krijg je pas na het inloggen met een code per e-mail (/api/login).
  const access = verifyToken(req.body?.auth_token, "a");
  if (!access) {
    return errorReply(res, 401, ACCESS_MESSAGES.login, { license: "login" });
  }
  const subscription = await checkSubscription(access.e, access.o);
  if (subscription !== "ok") {
    const reason = subscription === "none" ? "inactive" : "check_failed";
    return errorReply(res, reason === "inactive" ? 403 : 503, ACCESS_MESSAGES[reason], { license: reason });
  }

  // 5. Vraag aan OpenAI
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: tokens,
        messages: openaiMessages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI error:", response.status, data?.error?.message);
      return errorReply(res, 502, "Maya is even niet bereikbaar. Probeer het zo opnieuw.");
    }

    // Vertaal OpenAI response naar Anthropic formaat (zoals de app verwacht)
    const text = data.choices?.[0]?.message?.content || "Error loading response.";
    return res.status(200).json({ content: [{ type: "text", text }] });
  } catch (err) {
    console.error("Server error:", err);
    return errorReply(res, 500, "Er ging iets mis. Probeer het zo opnieuw.");
  }
}
