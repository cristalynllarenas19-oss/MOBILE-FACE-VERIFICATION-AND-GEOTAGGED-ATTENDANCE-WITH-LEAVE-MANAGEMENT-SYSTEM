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
}
