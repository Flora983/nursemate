// Maya NurseMate — /api/login
// Inloggen met een code per e-mail, zodat niemand andermans e-mailadres kan gebruiken.
//
// Stap 1 { action: "send", email, lang }   → stuurt een code van 6 cijfers (alleen bij een geldig abonnement)
// Stap 2 { action: "verify", challenge, code } → geeft een toegangspas van 30 dagen terug

import crypto from "node:crypto";
import {
  isAllowedOrigin, normalizeEmail, isValidEmail, signToken, verifyToken, codeHash, safeEqual, checkSubscription,
} from "../lib/subscription.js";

const CODE_VALID_MS = 10 * 60 * 1000;            // code is 10 minuten geldig
const ACCESS_VALID_MS = 30 * 24 * 60 * 60 * 1000; // toegangspas is 30 dagen geldig
const MAX_SENDS_PER_HOUR = 5;                     // per gebruiker (IP-adres)
const MAX_VERIFIES_PER_HOUR = 20;                 // per gebruiker (IP-adres)
const MAX_TRIES_PER_CODE = 5;

// Eenvoudige tellers in het geheugen (zoals in /api/generate). Niet waterdicht,
// maar samen met de korte geldigheid maakt het raden van een code onhaalbaar.
const sendHits = new Map();
const verifyHits = new Map();
const triesPerChallenge = new Map();

function tooMany(map, key, max) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const list = (map.get(key) || []).filter(t => t > hourAgo);
  if (list.length >= max) {
    map.set(key, list);
    return true;
  }
  list.push(now);
  map.set(key, list);
  if (map.size > 5000) map.clear(); // geheugen niet laten vollopen
  return false;
}

const MAILS = {
  nl: {
    subject: "Je inlogcode voor Maya NurseMate",
    text: (code) => `Je inlogcode voor Maya NurseMate is: ${code}\n\nDeze code is 10 minuten geldig.\n\nHeb je dit niet aangevraagd? Dan mag je deze e-mail negeren.`,
  },
  fr: {
    subject: "Votre code de connexion Maya NurseMate",
    text: (code) => `Votre code de connexion Maya NurseMate est : ${code}\n\nCe code est valable 10 minutes.\n\nVous n'avez pas fait cette demande ? Vous pouvez ignorer cet e-mail.`,
  },
  en: {
    subject: "Your Maya NurseMate login code",
    text: (code) => `Your Maya NurseMate login code is: ${code}\n\nThis code is valid for 10 minutes.\n\nDidn't request this? You can ignore this email.`,
  },
};

async function sendCodeMail(to, code, lang) {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
    console.error("RESEND_API_KEY of MAIL_FROM ontbreekt in Vercel.");
    return false;
  }
  const mail = MAILS[lang] || MAILS.en;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject: mail.subject, text: mail.text(code) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.error("Resend fout:", response.status, await response.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.error("Resend niet bereikbaar:", err?.message);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // 1. Alleen verzoeken vanaf mayanurse.com
  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ ok: false, reason: "forbidden" });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  const { action } = req.body || {};

  // ─── Stap 1: code versturen ───
  if (action === "send") {
    const typedEmail = typeof req.body.email === "string" ? req.body.email.trim() : "";
    const email = normalizeEmail(typedEmail);
    if (!isValidEmail(email)) return res.status(400).json({ ok: false, reason: "bad_email" });
    if (tooMany(sendHits, ip, MAX_SENDS_PER_HOUR)) return res.status(429).json({ ok: false, reason: "too_many" });

    const expires = Date.now() + CODE_VALID_MS;
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const hash = codeHash(email, code, expires);
    if (!hash) return res.status(503).json({ ok: false, reason: "check_failed" });

    const result = await checkSubscription(email, typedEmail);
    if (result === "check_failed") return res.status(503).json({ ok: false, reason: "check_failed" });

    if (result === "ok") {
      const sent = await sendCodeMail(typedEmail, code, req.body.lang);
      if (!sent) return res.status(503).json({ ok: false, reason: "check_failed" });
    }
    // Zonder abonnement sturen we geen mail, maar het antwoord ziet er precies hetzelfde uit.
    // Zo kan niemand via Maya uitzoeken wie wel of geen klant is.
    const challenge = signToken({ t: "c", e: email, o: typedEmail, h: hash, x: expires });
    return res.status(200).json({ ok: true, challenge });
  }

  // ─── Stap 2: code controleren ───
  if (action === "verify") {
    if (tooMany(verifyHits, ip, MAX_VERIFIES_PER_HOUR)) return res.status(429).json({ ok: false, reason: "too_many" });

    const { challenge } = req.body;
    const code = typeof req.body.code === "string" ? req.body.code.replace(/\s/g, "") : "";
    const data = verifyToken(challenge, "c");
    if (!data || !/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, reason: "wrong_code" });

    // Maximaal 5 pogingen per code
    const tries = (triesPerChallenge.get(challenge) || 0) + 1;
    triesPerChallenge.set(challenge, tries);
    if (triesPerChallenge.size > 5000) triesPerChallenge.clear();
    if (tries > MAX_TRIES_PER_CODE) return res.status(400).json({ ok: false, reason: "wrong_code" });

    if (!safeEqual(codeHash(data.e, code, data.x), data.h)) {
      return res.status(400).json({ ok: false, reason: "wrong_code" });
    }
    triesPerChallenge.delete(challenge);

    const token = signToken({ t: "a", e: data.e, o: data.o, x: Date.now() + ACCESS_VALID_MS });
    if (!token) return res.status(503).json({ ok: false, reason: "check_failed" });
    return res.status(200).json({ ok: true, token, email: data.e });
  }

  return res.status(400).json({ ok: false, reason: "bad_request" });
}
