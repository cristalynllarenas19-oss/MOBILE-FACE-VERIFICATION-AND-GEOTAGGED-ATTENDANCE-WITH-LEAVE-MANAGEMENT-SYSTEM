import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateDefaultViewDto } from "./dto/update-default-view.dto";
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

  @Post()
  create(@Body() dto: CreateUserDto, @Req() request: Request) {
    return this.usersService.create(dto, getAuditContext(request));
  }

  @Patch(":id/status")
  updateStatus(@Param("id") id: string, @Body("status") status: "ACTIVE" | "INACTIVE" | "LOCKED", @Req() request: Request) {
    return this.usersService.updateStatus(id, status, getAuditContext(request));
  }

  @Patch(":id/default-view")
  updateDefaultView(@Param("id") id: string, @Body() dto: UpdateDefaultViewDto, @Req() request: Request) {
    const requesterId = (request as any).user.userId;
    return this.usersService.updateDefaultView(id, dto.defaultView, requesterId, getAuditContext(request));
  }
}
