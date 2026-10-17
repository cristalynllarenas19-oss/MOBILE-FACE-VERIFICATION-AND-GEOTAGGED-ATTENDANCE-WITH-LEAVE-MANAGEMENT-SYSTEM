// Standalone Gmail SMTP check, independent of adding an employee. Uses the
// exact transport MailService uses (src/modules/mail/mail-transport.ts).
//
//   npm run mail:verify -w backend                          -> connect + log in only, sends nothing
//   npm run mail:verify -w backend -- --send-test you@x.com -> also sends one plain test email
//
// Never prints GMAIL_USER / GMAIL_APP_PASSWORD. Development only.
import "dotenv/config";
import {
  createGmailTransport,
  maskEmail,
  readGmailCredentials,
  SMTP_HOST,
  SMTP_PORT,
  summarizeSmtpError,
} from "../src/modules/mail/mail-transport";

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("[MAILER] mail:verify is a development tool and is disabled when NODE_ENV=production.");
    process.exit(1);
  }

  console.log(`[MAILER] GMAIL_USER: ${process.env.GMAIL_USER ? "set" : "MISSING"}`);
  console.log(`[MAILER] GMAIL_APP_PASSWORD: ${process.env.GMAIL_APP_PASSWORD ? "set" : "MISSING"}`);
  const credentials = readGmailCredentials((key) => process.env[key]);
  if (!credentials) process.exit(1);
  if (credentials.pass.length !== 16) {
    console.warn(`[MAILER] Warning: App Password is ${credentials.pass.length} characters after removing spaces (Gmail App Passwords are 16).`);
  }

  const transport = createGmailTransport(credentials);
  console.log(`[MAILER] Verifying ${SMTP_HOST}:${SMTP_PORT} as ${maskEmail(credentials.user)}…`);
  let startedAt = Date.now();
  try {
    await transport.verify();
    console.log(`[MAILER] SMTP verification OK — connected and authenticated in ${Date.now() - startedAt}ms`);
  } catch (error) {
    const summary = summarizeSmtpError(error);
    console.error(`[MAILER] SMTP verification ${summary.timedOut ? "TIMED OUT" : "FAILED"} after ${Date.now() - startedAt}ms`, summary);
    process.exit(1);
  }

  const flag = process.argv.indexOf("--send-test");
  if (flag === -1) return;
  const to = process.argv[flag + 1];
  if (!to) {
    console.error("[MAILER] --send-test needs a recipient address.");
    process.exit(1);
  }

  startedAt = Date.now();
  try {
    const info = await transport.sendMail({
      from: credentials.user,
      to,
      subject: "ULPI Attendance System — SMTP test",
      text: "This is a test email from the attendance system backend. No action is needed.",
    });
    console.log(
      `[MAILER] Test email accepted in ${Date.now() - startedAt}ms → ${maskEmail(to)} — messageId ${info.messageId}, accepted ${info.accepted.length}, rejected ${info.rejected.length}`,
    );
  } catch (error) {
    const summary = summarizeSmtpError(error);
    console.error(`[MAILER] Test email ${summary.timedOut ? "TIMED OUT" : "FAILED"} after ${Date.now() - startedAt}ms`, summary);
    process.exit(1);
  }
}

void main();
