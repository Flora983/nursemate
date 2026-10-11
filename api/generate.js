// Maya NurseMate — /api/generate
// Beveiligde versie: alleen eigen website, limiet per gebruiker, begrensde lengte.

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

// ─── Abonnement: licentiecode controleren bij Lemon Squeezy ───
// Een goedgekeurde code wordt 5 minuten onthouden, zodat niet elke aanvraag
// Lemon Squeezy opnieuw vraagt (limiet: 60 controles per minuut).
// Afgekeurde codes worden niet onthouden: wie net betaald heeft, kan meteen verder.
const LICENSE_CACHE_MS = 5 * 60 * 1000;
const licenseCache = new Map(); // code -> tijdstip tot wanneer ze goedgekeurd blijft

const LICENSE_MESSAGES = {
  missing:
    "Vul je licentiecode in om Maya te gebruiken. / Saisissez votre code de licence pour utiliser Maya. / Enter your license key to use Maya.",
  invalid:
    "Deze licentiecode is niet geldig. / Ce code de licence n'est pas valide. / This license key is not valid.",
  expired:
    "Je abonnement is verlopen. / Votre abonnement a expiré. / Your subscription has expired.",
  check_failed:
    "Je abonnement kon even niet gecontroleerd worden. Probeer het zo opnieuw. / Impossible de vérifier votre abonnement pour le moment. Réessayez. / Your subscription could not be checked right now. Please try again.",
};

// Geeft terug: "ok", "invalid", "expired" of "check_failed"
async function checkLicense(key) {
  const now = Date.now();
  if ((licenseCache.get(key) || 0) > now) return "ok";

  const storeId = process.env.LEMON_STORE_ID;
  const productId = process.env.LEMON_PRODUCT_ID;
  if (!storeId || !productId) {
    console.error("LEMON_STORE_ID of LEMON_PRODUCT_ID ontbreekt in Vercel.");
    return "check_failed";
  }

  let response, data;
  try {
    response = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ license_key: key }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    data = await response.json();
  } catch (err) {
    console.error("Lemon Squeezy niet bereikbaar:", err?.message);
    return "check_failed";
  }

  // Storing of drukte bij Lemon Squeezy: niet de schuld van de gebruiker
  if (response.status === 429 || response.status >= 500) {
    console.error("Lemon Squeezy fout:", response.status);
    return "check_failed";
  }

  const lk = data?.license_key;
  const meta = data?.meta;

  // Code hoort niet bij jouw winkel of product: altijd weigeren
  if (lk && meta && (String(meta.store_id) !== String(storeId) || String(meta.product_id) !== String(productId))) {
    return "invalid";
  }
  if (lk?.status === "expired" || (lk?.expires_at && Date.parse(lk.expires_at) < now)) {
    return "expired";
  }
  // "active" = in gebruik, "inactive" = geldig maar nog nooit geactiveerd. Beide zijn goed.
  // "disabled" (handmatig uitgezet) of een onbekende code = niet goed.
  if (data?.valid !== true || !meta || !["active", "inactive"].includes(lk?.status)) {
    return "invalid";
  }

  licenseCache.set(key, now + LICENSE_CACHE_MS);
  if (licenseCache.size > 5000) licenseCache.clear(); // geheugen niet laten vollopen
  return "ok";
}

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

  // 4. Geldig abonnement? Zonder geldige licentiecode wordt OpenAI niet aangeroepen.
  const licenseKey = typeof req.body?.license_key === "string" ? req.body.license_key.trim() : "";
  if (!licenseKey || licenseKey.length > 100) {
    return errorReply(res, 401, LICENSE_MESSAGES.missing, { license: "missing" });
  }
  const licenseResult = await checkLicense(licenseKey);
  if (licenseResult !== "ok") {
    const status = licenseResult === "check_failed" ? 503 : 403;
    return errorReply(res, status, LICENSE_MESSAGES[licenseResult], { license: licenseResult });
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
