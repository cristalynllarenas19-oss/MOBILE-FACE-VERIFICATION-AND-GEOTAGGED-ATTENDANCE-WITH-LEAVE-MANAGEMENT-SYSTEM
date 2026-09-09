import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";

export type NotifyPayload = {
  title: string;
  message: string;
  type?: string;
  entityId?: string;
};

const RETENTION_DAYS = 7;

function retentionCutoff() {
  return new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

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
      where: { userId, createdAt: { gte: retentionCutoff() } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null, createdAt: { gte: retentionCutoff() } },
    });
    return { count };
  }

  // Rows past the retention window are hidden from findForUser/unreadCount
  // immediately via the createdAt filter above; this daily sweep is just
  // what actually reclaims the storage.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpired() {
    const { count } = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: retentionCutoff() } },
    });
    if (count > 0) this.logger.log(`Purged ${count} notification(s) older than ${RETENTION_DAYS} days.`);
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

  async userHasRole(userId: string | null | undefined, roleCode: "ADMIN" | "SUPERVISOR" | "EMPLOYEE") {
    if (!userId) return false;
    const match = await this.prisma.user.findFirst({
      where: { id: userId, userRoles: { some: { role: { code: roleCode } } } },
      select: { id: true },
    });
    return Boolean(match);
  }
}
