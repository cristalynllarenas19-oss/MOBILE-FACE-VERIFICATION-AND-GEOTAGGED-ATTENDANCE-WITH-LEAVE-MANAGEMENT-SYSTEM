import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { join } from "path";

// Referenced via cid in email headers below; lives outside src/ so it isn't
// touched by the TS build. Resolved from process.cwd() (always the backend/
// project root, both in `nest start` and the compiled dist/ build) rather
// than __dirname, since tsc's outDir nesting under dist/ isn't guaranteed.
const LOGO_PATH = join(process.cwd(), "assets/ULPI-header.png");
const LOGO_CID = "ulpi-header";

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null;

  constructor(private readonly config: ConfigService) {
    const user = this.config.get<string>("GMAIL_USER");
    const pass = this.config.get<string>("GMAIL_APP_PASSWORD");

    this.transporter =
      user && pass
        ? nodemailer.createTransport({
            service: "gmail",
            auth: { user, pass },
          })
        : null;
  }

  async sendOtpEmail(to: string, otp: string) {
    if (!this.transporter) {
      this.logger.warn(
        `GMAIL_USER/GMAIL_APP_PASSWORD not configured. Password reset OTP for ${to} is: ${otp}`,
      );
      return;
    }

    await this.transporter.sendMail({
      from: this.config.get<string>("GMAIL_USER"),
      to,
      subject: "Your password reset code",
      text: `Your password reset code is ${otp}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
      html: `<p>Your password reset code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
    });
  }

  async sendNewEmployeeCredentialsEmail(to: string, temporaryPassword: string, employeeName: string) {
    if (!this.transporter) {
      this.logger.warn(
        `GMAIL_USER/GMAIL_APP_PASSWORD not configured. Temporary password for ${to} is: ${temporaryPassword}`,
      );
      return;
    }

    await this.transporter.sendMail({
      from: this.config.get<string>("GMAIL_USER"),
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
    });
  }
}
