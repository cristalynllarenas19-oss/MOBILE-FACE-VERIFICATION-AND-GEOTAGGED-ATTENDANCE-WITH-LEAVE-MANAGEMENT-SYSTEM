import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";

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

  async sendNewEmployeeCredentialsEmail(to: string, temporaryPassword: string) {
    if (!this.transporter) {
      this.logger.warn(
        `GMAIL_USER/GMAIL_APP_PASSWORD not configured. Temporary password for ${to} is: ${temporaryPassword}`,
      );
      return;
    }

    await this.transporter.sendMail({
      from: this.config.get<string>("GMAIL_USER"),
      to,
      subject: "Your account has been created",
      text: `An account has been created for you.\n\nEmail: ${to}\nTemporary password: ${temporaryPassword}\n\nUse this password to log in for the first time. You will be required to set your own password before you can continue.`,
      html: `<p>An account has been created for you.</p><p>Email: <strong>${to}</strong><br/>Temporary password: <strong>${temporaryPassword}</strong></p><p>Use this password to log in for the first time. You will be required to set your own password before you can continue.</p>`,
    });
  }
}
