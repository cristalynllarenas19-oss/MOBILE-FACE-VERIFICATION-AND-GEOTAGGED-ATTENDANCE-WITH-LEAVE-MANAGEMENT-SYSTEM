import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Announcement, AnnouncementStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CreateAnnouncementDto } from "./dto/create-announcement.dto";
import { UpdateAnnouncementDto } from "./dto/update-announcement.dto";

const ANNOUNCEMENT_NOTIFICATION_TYPE = "ANNOUNCEMENT";

@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // Same exclusion EmployeesService.findSupervisors already uses — an
  // announcement is never delivered to a SEPARATED employee's account.
  // Also excludes the sender's own account — an admin who also carries an
  // Employee record (e.g. HR staff) shouldn't get notified about the
  // announcement they just sent themselves.
  //
  // All three scopes empty/false = every active employee. Otherwise the
  // recipient set is the UNION of the three (department member, has the
  // SUPERVISOR role, or explicitly picked) via a single OR clause.
  private async resolveTargetEmployees(
    targetDepartmentIds: string[],
    targetSupervisorsOnly: boolean,
    targetEmployeeIds: string[],
    actorUserId?: string,
  ) {
    const isUnscoped = targetDepartmentIds.length === 0 && !targetSupervisorsOnly && targetEmployeeIds.length === 0;

    return this.prisma.employee.findMany({
      where: {
        employmentStatus: { not: "SEPARATED" },
        ...(actorUserId ? { userId: { not: actorUserId } } : {}),
        ...(isUnscoped
          ? {}
          : {
              OR: [
                ...(targetDepartmentIds.length ? [{ departmentId: { in: targetDepartmentIds } }] : []),
                ...(targetSupervisorsOnly
                  ? [{ user: { userRoles: { some: { role: { code: "SUPERVISOR" as const } } } } }]
                  : []),
                ...(targetEmployeeIds.length ? [{ id: { in: targetEmployeeIds } }] : []),
              ] satisfies Prisma.EmployeeWhereInput["OR"],
            }),
      },
      select: { userId: true },
    });
  }

  // Resolves recipients, fires notifications, and stamps publishedAt — the
  // shared tail end of both an immediate "Publish Now" and the scheduler
  // publishing a due SCHEDULED announcement.
  private async publish(announcement: Announcement, actorUserId?: string) {
    const recipients = await this.resolveTargetEmployees(
      announcement.targetDepartmentIds,
      announcement.targetSupervisorsOnly,
      announcement.targetEmployeeIds,
      actorUserId,
    );

    const published = await this.prisma.announcement.update({
      where: { id: announcement.id },
      data: { status: AnnouncementStatus.PUBLISHED, publishedAt: new Date() },
    });

    // Reuses the same per-user Notification pipe every other notification in
    // this system already goes through (leave approvals, probation
    // reminders) — no separate delivery system. One row per recipient gives
    // delivery (row exists) and read tracking (readAt) for free.
    await this.notifications.notifyUsers(
      recipients.map((employee) => employee.userId),
      {
        title: published.title,
        message: published.message,
        type: ANNOUNCEMENT_NOTIFICATION_TYPE,
        entityId: published.id,
      },
    );

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: "PUBLISH_ANNOUNCEMENT",
        entityType: "Announcement",
        entityId: published.id,
        newValues: {
          title: published.title,
          targetDepartmentIds: published.targetDepartmentIds,
          recipientCount: recipients.length,
        },
      },
    });

    return { ...published, recipientCount: recipients.length };
  }

  async create(dto: CreateAnnouncementDto, actorUserId?: string) {
    const status = dto.status ?? AnnouncementStatus.PUBLISHED;
    if (status === AnnouncementStatus.SCHEDULED && !dto.scheduledAt) {
      throw new BadRequestException("scheduledAt is required to schedule an announcement.");
    }
    if (dto.scheduledAt && new Date(dto.scheduledAt).getTime() <= Date.now()) {
      throw new BadRequestException("scheduledAt must be in the future.");
    }

    const announcement = await this.prisma.announcement.create({
      data: {
        title: dto.title.trim(),
        message: dto.message.trim(),
        status: status === AnnouncementStatus.PUBLISHED ? AnnouncementStatus.DRAFT : status,
        scheduledAt: status === AnnouncementStatus.SCHEDULED ? new Date(dto.scheduledAt!) : null,
        targetDepartmentIds: dto.targetDepartmentIds ?? [],
        targetSupervisorsOnly: dto.targetSupervisorsOnly ?? false,
        targetEmployeeIds: dto.targetEmployeeIds ?? [],
        createdByUserId: actorUserId,
      },
    });

    if (status === AnnouncementStatus.PUBLISHED) {
      return this.publish(announcement, actorUserId);
    }

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: status === AnnouncementStatus.SCHEDULED ? "SCHEDULE_ANNOUNCEMENT" : "SAVE_ANNOUNCEMENT_DRAFT",
        entityType: "Announcement",
        entityId: announcement.id,
        newValues: { title: announcement.title, status: announcement.status, scheduledAt: announcement.scheduledAt },
      },
    });

    const previewRecipients = await this.resolveTargetEmployees(
      announcement.targetDepartmentIds,
      announcement.targetSupervisorsOnly,
      announcement.targetEmployeeIds,
      actorUserId,
    );
    return { ...announcement, recipientCount: previewRecipients.length };
  }

  async update(id: string, dto: UpdateAnnouncementDto, actorUserId?: string) {
    const existing = await this.prisma.announcement.findUniqueOrThrow({ where: { id } });
    if (existing.status === AnnouncementStatus.PUBLISHED) {
      throw new ForbiddenException("Published announcements can no longer be edited.");
    }

    const nextStatus = dto.status ?? existing.status;
    if (nextStatus === AnnouncementStatus.SCHEDULED) {
      const scheduledAt = dto.scheduledAt ?? existing.scheduledAt?.toISOString();
      if (!scheduledAt) throw new BadRequestException("scheduledAt is required to schedule an announcement.");
      if (new Date(scheduledAt).getTime() <= Date.now()) {
        throw new BadRequestException("scheduledAt must be in the future.");
      }
    }

    const updated = await this.prisma.announcement.update({
      where: { id },
      data: {
        title: dto.title !== undefined ? dto.title.trim() : undefined,
        message: dto.message !== undefined ? dto.message.trim() : undefined,
        // Left as its current DRAFT/SCHEDULED value when the target is
        // PUBLISHED — publish() below overwrites it (and stamps
        // publishedAt) once recipients are resolved.
        status: nextStatus === AnnouncementStatus.PUBLISHED ? undefined : nextStatus,
        scheduledAt: nextStatus === AnnouncementStatus.SCHEDULED ? new Date(dto.scheduledAt ?? existing.scheduledAt!) : null,
        targetDepartmentIds: dto.targetDepartmentIds,
        targetSupervisorsOnly: dto.targetSupervisorsOnly,
        targetEmployeeIds: dto.targetEmployeeIds,
      },
    });

    if (nextStatus === AnnouncementStatus.PUBLISHED) {
      return this.publish(updated, actorUserId);
    }

    const previewRecipients = await this.resolveTargetEmployees(
      updated.targetDepartmentIds,
      updated.targetSupervisorsOnly,
      updated.targetEmployeeIds,
      actorUserId,
    );
    return { ...updated, recipientCount: previewRecipients.length };
  }

  async remove(id: string) {
    const existing = await this.prisma.announcement.findUniqueOrThrow({ where: { id } });
    if (existing.status === AnnouncementStatus.PUBLISHED) {
      throw new ForbiddenException("Published announcements can no longer be deleted.");
    }
    await this.prisma.announcement.delete({ where: { id } });
    return { success: true };
  }

  async archive(id: string) {
    await this.prisma.announcement.update({ where: { id }, data: { archivedAt: new Date() } });
    return { success: true };
  }

  async unarchive(id: string) {
    await this.prisma.announcement.update({ where: { id }, data: { archivedAt: null } });
    return { success: true };
  }

  // Runs every minute, publishing whatever SCHEDULED announcements are due.
  // Sequential (not Promise.all) so one bad recipient-resolution doesn't
  // interleave partial notifyUsers calls with the next announcement.
  @Cron(CronExpression.EVERY_MINUTE)
  async publishDueScheduled() {
    const due = await this.prisma.announcement.findMany({
      where: { status: AnnouncementStatus.SCHEDULED, scheduledAt: { lte: new Date() } },
    });
    for (const announcement of due) {
      try {
        await this.publish(announcement);
      } catch (error) {
        this.logger.error(`Failed to publish scheduled announcement ${announcement.id}`, error as Error);
      }
    }
  }

  async findAll(archived = false) {
    const announcements = await this.prisma.announcement.findMany({
      where: archived ? { archivedAt: { not: null } } : { archivedAt: null },
      orderBy: { createdAt: "desc" },
      include: { createdBy: { include: { employee: true } } },
    });
    if (announcements.length === 0) return [];

    const publishedIds = announcements
      .filter((a) => a.status === AnnouncementStatus.PUBLISHED)
      .map((a) => a.id);

    // "Delivered" and "targeted" are the same number by construction — the
    // Notification rows above are created synchronously in the same request
    // that publishes the Announcement, so there's no async transport that can
    // partially fail (unlike email/push). "Viewed" is a second groupBy on
    // the same rows filtered to readAt IS NOT NULL. Drafts/scheduled items
    // have no Notification rows yet, so their counts are resolved live below.
    const [totalCounts, viewedCounts] = publishedIds.length
      ? await Promise.all([
          this.prisma.notification.groupBy({
            by: ["entityId"],
            where: { type: ANNOUNCEMENT_NOTIFICATION_TYPE, entityId: { in: publishedIds } },
            _count: { _all: true },
          }),
          this.prisma.notification.groupBy({
            by: ["entityId"],
            where: {
              type: ANNOUNCEMENT_NOTIFICATION_TYPE,
              entityId: { in: publishedIds },
              readAt: { not: null },
            },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const totalByAnnouncement = new Map(totalCounts.map((row) => [row.entityId, row._count._all]));
    const viewedByAnnouncement = new Map(viewedCounts.map((row) => [row.entityId, row._count._all]));

    return Promise.all(
      announcements.map(async (announcement) => {
        if (announcement.status !== AnnouncementStatus.PUBLISHED) {
          const previewRecipients = await this.resolveTargetEmployees(
            announcement.targetDepartmentIds,
            announcement.targetSupervisorsOnly,
            announcement.targetEmployeeIds,
            announcement.createdByUserId ?? undefined,
          );
          return {
            ...announcement,
            recipientCount: previewRecipients.length,
            deliveredCount: 0,
            viewedCount: 0,
            notViewedCount: 0,
          };
        }

        const recipientCount = totalByAnnouncement.get(announcement.id) ?? 0;
        const viewedCount = viewedByAnnouncement.get(announcement.id) ?? 0;
        return {
          ...announcement,
          recipientCount,
          deliveredCount: recipientCount,
          viewedCount,
          notViewedCount: recipientCount - viewedCount,
        };
      }),
    );
  }

  async findOne(id: string) {
    const announcement = await this.prisma.announcement.findUniqueOrThrow({
      where: { id },
      include: { createdBy: { include: { employee: true } } },
    });

    if (announcement.status !== AnnouncementStatus.PUBLISHED) {
      const previewRecipients = await this.resolveTargetEmployees(
        announcement.targetDepartmentIds,
        announcement.targetSupervisorsOnly,
        announcement.targetEmployeeIds,
        announcement.createdByUserId ?? undefined,
      );
      return {
        ...announcement,
        recipientCount: previewRecipients.length,
        deliveredCount: 0,
        viewedCount: 0,
        notViewedCount: 0,
        recipients: [],
      };
    }

    const notified = await this.prisma.notification.findMany({
      where: { type: ANNOUNCEMENT_NOTIFICATION_TYPE, entityId: id },
      select: { userId: true, readAt: true },
    });

    const employees = await this.prisma.employee.findMany({
      where: { userId: { in: notified.map((n) => n.userId) } },
      select: { userId: true, firstName: true, lastName: true, department: { select: { name: true } } },
    });
    const employeeByUserId = new Map(employees.map((employee) => [employee.userId, employee]));

    const recipients = notified.map((row) => {
      const employee = employeeByUserId.get(row.userId);
      return {
        firstName: employee?.firstName ?? "Unknown",
        lastName: employee?.lastName ?? "Employee",
        department: employee?.department.name ?? "Unknown",
        viewedAt: row.readAt,
      };
    });

    const viewedCount = recipients.filter((r) => r.viewedAt).length;

    return {
      ...announcement,
      recipientCount: recipients.length,
      deliveredCount: recipients.length,
      viewedCount,
      notViewedCount: recipients.length - viewedCount,
      recipients,
    };
  }
}
