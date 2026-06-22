import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

export type NotifyPayload = {
  title: string;
  message: string;
  type?: string;
  entityId?: string;
};

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
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { count };
  }

  markRead(id: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
  }

  markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, readAt: null },
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
}
