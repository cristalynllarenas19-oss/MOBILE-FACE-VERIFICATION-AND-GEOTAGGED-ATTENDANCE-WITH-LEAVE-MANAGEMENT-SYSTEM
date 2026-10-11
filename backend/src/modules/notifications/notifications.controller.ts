import { Controller, Get, Param, Patch, Query, Req } from "@nestjs/common";
import { NotificationsService, parseNotificationView } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get("me")
  findMine(@Req() request: Request, @Query("view") view?: string) {
    const userId = (request as any).user.userId;
    return this.notificationsService.findForUser(userId, parseNotificationView(view));
  }

  @Get("me/unread-count")
  unreadCount(@Req() request: Request, @Query("view") view?: string) {
    const userId = (request as any).user.userId;
    return this.notificationsService.unreadCount(userId, parseNotificationView(view));
  }

  @Patch(":id/read")
  markRead(@Param("id") id: string, @Req() request: Request) {
    const userId = (request as any).user.userId;
    return this.notificationsService.markRead(id, userId);
  }

  @Patch("read-all")
  markAllRead(@Req() request: Request, @Query("view") view?: string) {
    const userId = (request as any).user.userId;
    return this.notificationsService.markAllRead(userId, parseNotificationView(view));
  }
}
