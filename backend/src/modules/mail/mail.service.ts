import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { join } from "path";
import {
  createGmailTransport,
  isTransientSmtpError,
  maskEmail,
  readGmailCredentials,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_TIMEOUTS,
  summarizeSmtpError,
} from "./mail-transport";

// Referenced via cid in email headers below; lives outside src/ so it isn't
// touched by the TS build. Resolved from process.cwd() (always the backend/
// project root, both in `nest start` and the compiled dist/ build) rather
// than __dirname, since tsc's outDir nesting under dist/ isn't guaranteed.
const LOGO_PATH = join(process.cwd(), "assets/ULPI-header.png");
const LOGO_CID = "ulpi-header";

// Credentials emails are sent in the background (nobody waits on them), so
// they can ride out a flaky network: up to 3 attempts, waiting longer before
// each retry. The OTP email is awaited by the forgot-password request itself,
// so it keeps a single attempt.
const CREDENTIALS_RETRY_DELAYS_MS = [5_000, 15_000];

export type MailSendResult ={ messageId?: string; accepted: number; rejected: number; durationMs: number };

export class MailNotConfiguredError extends Error {
  constructor() {
    super("GMAIL_USER/GMAIL_APP_PASSWORD not configured");
    this.name = "MailNotConfiguredError";
  }
}

@Injectable()
export class MailService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly sender: string | undefined;

  constructor(private readonly config: ConfigService) {
    const credentials = readGmailCredentials((key) => this.config.get<string>(key));
    this.sender = credentials?.user;
    this.transporter = credentials ? createGmailTransport(credentials) : null;

    if (credentials) {
      this.logger.log(
        `[MAILER] Email service initialized — Gmail SMTP ${SMTP_HOST}:${SMTP_PORT} (TLS), sender ${maskEmail(credentials.user)}, ` +
          `timeouts connect ${SMTP_TIMEOUTS.connectionTimeout / 1000}s / greeting ${SMTP_TIMEOUTS.greetingTimeout / 1000}s / socket ${SMTP_TIMEOUTS.socketTimeout / 1000}s`,
      );
    } else {
      this.logger.warn("[MAILER] Email service initialized WITHOUT credentials — GMAIL_USER and/or GMAIL_APP_PASSWORD missing; no emails will be sent.");
    }
  }

  get isConfigured() {
    return !!this.transporter;
  }

  // Checked once per boot, in the background — never delays startup and is
  // not repeated per email.
  onApplicationBootstrap() {
    if (!this.transporter) return;
    void this.verifyConnection();
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      this.logger.warn("[MAILER] SMTP verification skipped — mailer not configured.");
      return false;
    }
    this.logger.log(`[MAILER] SMTP verification started (${SMTP_HOST}:${SMTP_PORT})…`);
    const startedAt = Date.now();
    try {
      await this.transporter.verify();
      this.logger.log(`[MAILER] SMTP verification OK — connected and authenticated in ${Date.now() - startedAt}ms`);
      return true;
    } catch (error) {
      this.logFailure("SMTP verification", error, Date.now() - startedAt);
      return false;
    }
  }

  async sendOtpEmail(to: string, otp: string) {
    try {
      await this.deliver("password-reset OTP", {
        to,
        subject: "Your password reset code",
        text: `Your password reset code is ${otp}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
        html: `<p>Your password reset code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
      });
    } catch (error) {
      // Unconfigured mailer was always a silent no-op here (forgot-password
      // must not reveal anything); real SMTP failures still propagate.
      if (!(error instanceof MailNotConfiguredError)) throw error;
    }
  }

  async sendNewEmployeeCredentialsEmail(to: string, temporaryPassword: string, employeeName: string) {
    return this.deliver("new-employee credentials", {
      to,
      subject: "Your New Account Details and First-Time Login Instructions",
      text: `Hi ${employeeName},\n\nWelcome to Universal Leaf Philippines Inc.! Use this password to log in for the first time. You will be required to set your own password before you can continue.\n\nAccount details:\n\nUsername: ${to}\nTemporary password: ${temporaryPassword}`,
      html: `<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;"><img src="cid:${LOGO_CID}" alt="Universal Leaf Philippines, Inc." width="600" height="100" style="width:600px;height:100px;display:block;"/><div style="padding:24px 16px;"><p>Hi ${employeeName},</p><p>Welcome to Universal Leaf Philippines Inc.! Use this password to log in for the first time. You will be required to set your own password before you can continue.</p><p>Account details:</p><p>Username: <strong>${to}</strong><br/>Temporary password: <strong>${temporaryPassword}</strong></p></div></div>`,
      attachments: [
        {
          filename: "ULPI-header.png",
          path: LOGO_PATH,
          cid: LOGO_CID,
          // Without this, Gmail renders the cid image inline AND lists it
          // again as a separate downloadable attachment at the bottom.
          contentDisposition: "inline",
        },
      ],
    }, CREDENTIALS_RETRY_DELAYS_MS);
  }

  // Logs every attempt's start and outcome (never the body — it carries the
  // password/OTP) and rethrows failures so callers decide what they mean.
  // Transient failures are retried once per entry in retryDelaysMs.
  private async deliver(
    kind: string,
    options: nodemailer.SendMailOptions & { to: string },
    retryDelaysMs: number[] = [],
  ): Promise<MailSendResult> {
    const recipient = maskEmail(options.to);
    if (!this.transporter) {
      this.logger.warn(`[MAILER] Email NOT sent (${kind} → ${recipient}) — mailer not configured.`);
      throw new MailNotConfiguredError();
    }

    const maxAttempts = retryDelaysMs.length + 1;
    for (let attempt = 1; ; attempt++) {
      const attemptLabel = maxAttempts > 1 ? ` attempt ${attempt}/${maxAttempts}` : "";
      this.logger.log(`[MAILER] Email sending started (${kind} → ${recipient})${attemptLabel}`);
      const startedAt = Date.now();
      try {
        const info = await this.transporter.sendMail({ from: this.sender, ...options });
        const durationMs = Date.now() - startedAt;
        const accepted = info.accepted?.length ?? 0;
        const rejected = info.rejected?.length ?? 0;
        const smtpReply = String(info.response ?? "").split(" ").slice(0, 2).join(" ");
        if (accepted === 0) throw new Error(`SMTP server rejected the recipient (reply "${smtpReply}")`);
        this.logger.log(
          `[MAILER] Email sending successful (${kind} → ${recipient})${attemptLabel} in ${durationMs}ms — messageId ${info.messageId}, ` +
            `accepted ${accepted}, rejected ${rejected}, SMTP reply "${smtpReply}"`,
        );
        return { messageId: info.messageId, accepted, rejected, durationMs };
      } catch (error) {
        this.logFailure(`Email sending (${kind} → ${recipient})${attemptLabel}`, error, Date.now() - startedAt);
        const retryDelayMs = retryDelaysMs[attempt - 1];
        if (retryDelayMs === undefined || !isTransientSmtpError(error)) throw error;
        this.logger.warn(`[MAILER] Retrying ${kind} → ${recipient} in ${retryDelayMs / 1000}s…`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  private logFailure(what: string, error: unknown, durationMs: number) {
    const summary = summarizeSmtpError(error);
    const label = summary.timedOut ? "TIMED OUT" : "FAILED";
    this.logger.error(
      `[MAILER] ${what} ${label} after ${durationMs}ms — ${summary.name}` +
        `${summary.code ? ` code=${summary.code}` : ""}` +
        `${summary.responseCode ? ` smtp=${summary.responseCode}` : ""}` +
        `${summary.command ? ` command=${summary.command}` : ""}: ${summary.message}`,
    );
    if (summary.hint) this.logger.error(`[MAILER] Hint: ${summary.hint}`);
  }
}
