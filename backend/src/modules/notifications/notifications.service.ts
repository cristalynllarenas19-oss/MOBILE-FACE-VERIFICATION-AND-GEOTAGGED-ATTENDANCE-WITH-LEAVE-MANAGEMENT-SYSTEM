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

// One account can wear two hats: a Supervisor (or Admin) who reviews the
// team, and the same person as an employee with leave and attendance of
// their own. Each portal asks for its own half of the inbox so a
// supervisor who switches to their employee profile sees only what is
// about them, and the team's requests stay in the supervisor portal.
export type NotificationView = "reviewer" | "personal";

// Sent to whoever has to act on someone else's request — never to the
// person the notification is about. Every other type (and any untyped row)
// is addressed to the employee personally.
const REVIEWER_NOTIFICATION_TYPES = [
  "LEAVE_SUBMITTED",
  "LEAVE_RESUBMITTED",
  "LEAVE_CANCELLATION_REQUESTED",
  "LEAVE_DECISION_OVERDUE",
  "UNDERTIME_SUBMITTED",
  "ATTENDANCE_FLAGGED",
  "FACE_MISMATCH_STREAK",
  "PROBATION_REGULARIZATION_DUE",
  "SUPERVISOR_EVALUATION_REQUIRED",
  "SUPERVISOR_REGULARIZATION_RECOMMENDATION",
  "EVALUATION_CONVERSION_OUTCOME",
  "CREDENTIALS_EMAIL_FAILED",
];

// Company announcements are for the person whichever portal they are in,
// so they appear in both.
const SHARED_NOTIFICATION_TYPES = [ANNOUNCEMENT_NOTIFICATION_TYPE];

export function parseNotificationView(value?: string): NotificationView | undefined {
  return value === "reviewer" || value === "personal" ? value : undefined;
}

// No view = the whole inbox, which is what a caller that predates the two
// portals (and an account with only one role) still gets.
function viewFilter(view?: NotificationView) {
  if (view === "reviewer") {
    return { type: { in: [...REVIEWER_NOTIFICATION_TYPES, ...SHARED_NOTIFICATION_TYPES] } };
  }
  if (view === "personal") {
    // `type: null` is spelled out because SQL's NOT IN silently drops
    // untyped rows.
    return { OR: [{ type: null }, { type: { notIn: REVIEWER_NOTIFICATION_TYPES } }] };
  }
  return {};
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

  findForUser(userId: string, view?: NotificationView) {
    return this.prisma.notification.findMany({
      where: { userId, AND: [notExpiredFilter(), viewFilter(view)] },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async unreadCount(userId: string, view?: NotificationView) {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null, AND: [notExpiredFilter(), viewFilter(view)] },
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
  markAllRead(userId: string, view?: NotificationView) {
    return this.prisma.notification.updateMany({
      where: { userId, readAt: null, AND: [notExpiredFilter(), viewFilter(view)] },
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

  // Who reviews an employee's own filing (leave, undertime, cancellation):
  // a regular employee's goes to their direct supervisor; a supervisor has no
  // supervisor above them, and an employee with no supervisor assigned would
  // otherwise notify nobody, so both route to HR/Admin instead. The filer is
  // never notified about their own filing.
  async filingReviewerIds(filerUserId: string | null | undefined, supervisorUserId: string | null | undefined) {
    const filerIsSupervisor = await this.userHasRole(filerUserId, "SUPERVISOR");
    const candidateIds = !filerIsSupervisor && supervisorUserId ? [supervisorUserId] : await this.adminUserIds();
    return candidateIds.filter((id) => id !== filerUserId);
  }

  async userHasRole(userId: string | null | undefined, roleCode: "ADMIN" | "SUPERVISOR" | "EMPLOYEE") {
    if (!userId) return false;
    const match = await this.prisma.user.findFirst({
      where: {
        id: userId,
        userRoles: { some: { role: { code: roleCode } } },
        // A deactivated account keeps its role row but not the role's access.
        ...(roleCode !== "EMPLOYEE" ? { status: "ACTIVE" as const } : {}),
      },
      select: { id: true },
    });
    return Boolean(match);
  }
}
