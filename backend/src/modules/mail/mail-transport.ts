import * as nodemailer from "nodemailer";

// Shared by MailService and scripts/mail-verify.ts so the standalone SMTP
// check exercises exactly the transport the running backend uses.

export const SMTP_HOST = "smtp.gmail.com";
export const SMTP_PORT = 465;

// Nodemailer's own defaults are 2 min to connect and 10 min of socket
// silence — on a network that silently drops SMTP traffic (common on campus
// and office Wi-Fi) a send would hang that long before failing. These keep
// every failure mode bounded to seconds.
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
};

export type GmailCredentials = { user: string; pass: string };

// Google displays App Passwords as "abcd efgh ijkl mnop"; strip the spaces
// (and stray quotes/whitespace from .env editing) so a pasted copy works.
export function readGmailCredentials(get: (key: string) => string | undefined): GmailCredentials | null {
  const user = get("GMAIL_USER")?.trim();
  const pass = get("GMAIL_APP_PASSWORD")?.replace(/\s+/g, "");
  return user && pass ? { user, pass } : null;
}

export function createGmailTransport({ user, pass }: GmailCredentials) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user, pass },
    // Reuses an already-authenticated connection instead of paying DNS + TCP
    // + TLS + AUTH (several seconds to Gmail) on every single email.
    // Nodemailer reopens it transparently after Gmail drops an idle one.
    pool: true,
    maxConnections: 2,
    ...SMTP_TIMEOUTS,
  });
}

// "juan.delacruz@gmail.com" -> "ju***@gmail.com"
export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);

export type SmtpErrorSummary = {
  name: string;
  code?: string;
  responseCode?: number;
  command?: string;
  timedOut: boolean;
  message: string;
  hint?: string;
};

// Never includes the error's `response`/`message` verbatim beyond the first
// line, and strips anything address-shaped — SMTP errors can echo the
// login user back.
export function summarizeSmtpError(error: unknown): SmtpErrorSummary {
  const err = (error ?? {}) as { name?: string; code?: string; responseCode?: number; command?: string; message?: string };
  const message = String(err.message ?? error)
    .split("\n")[0]
    .replace(/[^\s<>]+@[^\s<>]+/g, "<address>")
    .slice(0, 200);
  const timedOut = (!!err.code && TIMEOUT_CODES.has(err.code)) || /timed? ?out/i.test(message);

  let hint: string | undefined;
  if (err.responseCode === 534) {
    hint = "Google is blocking this sign-in as suspicious (not a wrong password) — sign in to the sender account in a browser, approve any \"Was this you?\" alert under Security → Recent security activity, then retry in a few minutes.";
  } else if (err.code === "EAUTH" || err.responseCode === 535) {
    hint = "Gmail rejected the login — check GMAIL_USER and that GMAIL_APP_PASSWORD is a current App Password (2-Step Verification must be on).";
  } else if (timedOut || err.code === "ECONNECTION" || err.code === "ESOCKET") {
    hint = `Could not reach ${SMTP_HOST}:${SMTP_PORT} — the network may be blocking outgoing SMTP. Try another network (e.g. mobile hotspot).`;
  } else if (err.code === "EDNS") {
    hint = `Could not resolve ${SMTP_HOST} — check the internet connection.`;
  }

  return { name: err.name ?? "Error", code: err.code, responseCode: err.responseCode, command: err.command, timedOut, message, hint };
}
