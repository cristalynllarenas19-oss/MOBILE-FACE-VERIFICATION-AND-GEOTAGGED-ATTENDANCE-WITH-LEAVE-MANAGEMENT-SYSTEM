import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { Public } from "../../common/decorators/public.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { AuthService } from "./auth.service";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { LoginDto } from "./dto/login.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { VerifyResetOtpDto } from "./dto/verify-reset-otp.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("login")
  login(@Body() dto: LoginDto, @Req() request: Request) {
    return this.authService.login(dto.email, dto.password, getAuditContext(request));
  }

  @Public()
  @Post("refresh")
  refresh() {
    return { message: "Refresh token endpoint is ready for secure cookie/mobile token integration." };
  }

  @Post("logout")
  logout(@Req() request: Request) {
    return this.authService.logout(getAuditContext(request));
  }

  @Public()
  @Post("forgot-password")
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Public()
  @Post("reset-password/verify-otp")
  verifyResetOtp(@Body() dto: VerifyResetOtpDto) {
    return this.authService.verifyResetOtp(dto.email, dto.otp);
  }

  @Public()
  @Post("reset-password")
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.resetToken, dto.newPassword);
  }

  @Get("me")
  me(@Req() request: Request) {
    return { user: (request as any).user ?? null };
  }
}
