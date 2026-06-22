import { Controller, Get, Param, Patch, Req } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get("me")
  findMine(@Req() request: Request) {
    const userId = (request as any).user.userId;
    return this.notificationsService.findForUser(userId);
  }

  @Get("me/unread-count")
  unreadCount(@Req() request: Request) {
    const userId = (request as any).user.userId;
    return this.notificationsService.unreadCount(userId);
  }

  @Patch(":id/read")
  markRead(@Param("id") id: string, @Req() request: Request) {
    const userId = (request as any).user.userId;
    return this.notificationsService.markRead(id, userId);
  }

  @Patch("read-all")
  markAllRead(@Req() request: Request) {
    const userId = (request as any).user.userId;
    return this.notificationsService.markAllRead(userId);
  }
}
