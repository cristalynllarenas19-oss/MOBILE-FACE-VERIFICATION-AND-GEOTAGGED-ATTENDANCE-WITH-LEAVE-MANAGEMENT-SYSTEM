import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { CreateUserDto } from "./dto/create-user.dto";
import { NotificationPreferencesDto } from "./dto/notification-preferences.dto";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  // Must stay before the ":id"-shaped routes below — Nest matches routes by
  // registration order and a bare ":id" route would otherwise swallow "me".
  @Patch("me/password")
  changePassword(@Req() request: Request, @Body() dto: ChangePasswordDto) {
    const userId = (request as any).user.userId;
    return this.usersService.changePassword(userId, dto.currentPassword, dto.newPassword);
  }

  @Get("me/notification-preferences")
  getNotificationPreferences(@Req() request: Request) {
    const userId = (request as any).user.userId;
    return this.usersService.getNotificationPreferences(userId);
  }

  @Patch("me/notification-preferences")
  updateNotificationPreferences(@Req() request: Request, @Body() dto: NotificationPreferencesDto) {
    const userId = (request as any).user.userId;
    return this.usersService.updateNotificationPreferences(userId, dto);
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(":id/status")
  updateStatus(@Param("id") id: string, @Body("status") status: "ACTIVE" | "INACTIVE" | "LOCKED") {
    return this.usersService.updateStatus(id, status);
  }
}
