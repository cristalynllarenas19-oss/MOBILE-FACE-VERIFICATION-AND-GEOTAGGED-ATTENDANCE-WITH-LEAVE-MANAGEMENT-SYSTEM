import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { Public } from "../../common/decorators/public.decorator";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";

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

  @Get("me")
  me(@Req() request: Request) {
    return { user: (request as any).user ?? null };
  }
}
