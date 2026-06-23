import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { Public } from "../../common/decorators/public.decorator";
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
  login(@Body() dto: LoginDto) {
  console.log("LOGIN REQUEST RECEIVED");
  console.log(dto);

  return this.authService.login(dto.email, dto.password);
}

  @Public()
  @Post("refresh")
  refresh() {
    return { message: "Refresh token endpoint is ready for secure cookie/mobile token integration." };
  }

  @Public()
  @Post("logout")
  logout() {
    return { message: "Logged out" };
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
