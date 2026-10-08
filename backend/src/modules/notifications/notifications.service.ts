import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

export type NotifyPayload = {
  title: string;
  message: string;
  type?: string;
  entityId?: string;
};

// Only Announcement notifications expire — every other type (leave,
// attendance, regularization, ...) is kept indefinitely. Same literal
// AnnouncementsService stamps on the rows it creates.
const ANNOUNCEMENT_NOTIFICATION_TYPE = "ANNOUNCEMENT";
const ANNOUNCEMENT_RETENTION_DAYS = 7;

function announcementCutoff() {
  return new Date(Date.now() - ANNOUNCEMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

// An announcement's Notification rows are created in the same request that
// publishes it, so the row's createdAt is the announcement's publication
// date — reading the notification never moves it. `type: null` is spelled
// out because a SQL `<>` comparison silently drops untyped rows.
// Expiry only hides the row from its recipient; it is never deleted, since
// AnnouncementsService computes the admin's delivered/viewed counts and
// recipient list from these same rows.
function notExpiredFilter() {
  return {
    OR: [
      { type: null },
      { type: { not: ANNOUNCEMENT_NOTIFICATION_TYPE } },
      { createdAt: { gte: announcementCutoff() } },
    ],
  };
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notifyUsers(userIds: string[], payload: NotifyPayload) {
    const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
    if (uniqueUserIds.length === 0) return;

    await this.prisma.notification.createMany({
      data: uniqueUserIds.map((userId) => ({
        userId,
        title: payload.title,
        message: payload.message,
        type: payload.type,
        entityId: payload.entityId,
      })),
    });
  }

  findForUser(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId, ...notExpiredFilter() },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null, ...notExpiredFilter() },
    });
    return { count };
  }

  markRead(id: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
  }

  // Skips expired announcements the user can no longer see, so "Mark all
  // read" can't inflate an old announcement's viewed count.
  markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...notExpiredFilter() },
      data: { readAt: new Date() },
    });
  }

  async adminUserIds() {
    const admins = await this.prisma.user.findMany({
      where: {
        status: "ACTIVE",
        userRoles: { some: { role: { code: "ADMIN" } } },
      },
      select: { id: true },
    });
    return admins.map((admin) => admin.id);
  }

  async userHasRole(userId: string | null | undefined, roleCode: "ADMIN" | "SUPERVISOR" | "EMPLOYEE") {
    if (!userId) return false;
    const match = await this.prisma.user.findFirst({
      where: { id: userId, userRoles: { some: { role: { code: roleCode } } } },
      select: { id: true },
    });
    return Boolean(match);
  }
}
