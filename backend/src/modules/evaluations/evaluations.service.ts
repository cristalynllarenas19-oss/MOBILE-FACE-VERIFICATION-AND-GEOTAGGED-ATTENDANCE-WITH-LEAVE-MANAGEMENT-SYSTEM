import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { isDateWithinLeaveRange } from "../../common/utils/on-leave.util";
import { isDayOff } from "../../common/utils/schedule.util";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { dedupeToLatestVisitPerEmployeeDay } from "../attendance/attendance-dedup.util";
import { NotificationsService } from "../notifications/notifications.service";
import { RegularizationDecision, RegularizationDecisionDto, RegularizationRemarksDto } from "./dto/evaluation.dto";

// Mirrors EmployeesService's own PROBATION_MILESTONE_NOTIFICATION_TYPE/MONTHS
// pair — kept as a separate constant here (not imported) because that pair is
// private to EmployeesService and this check targets a different recipient
// (the assigned Supervisor, not Admin) via its own notification type, so the
// two milestone checks stay independent and neither can suppress the other.
const EVALUATION_REQUIRED_NOTIFICATION_TYPE = "SUPERVISOR_EVALUATION_REQUIRED";
const EVALUATION_OUTCOME_NOTIFICATION_TYPE = "EVALUATION_CONVERSION_OUTCOME";
// Sent to Admin once the Supervisor has made their recommendation.
const SUPERVISOR_RECOMMENDATION_NOTIFICATION_TYPE = "SUPERVISOR_REGULARIZATION_RECOMMENDATION";
const PROBATION_MILESTONE_MONTHS = 6;
// Same pair EmployeesService keeps privately: what each probationary status
// converts to. Anything not listed here is not on probation.
const REGULARIZATION_TARGET_STATUS: Record<string, string> = {
  PROBATIONARY: "REGULAR",
  PROBATIONARY_SEASONAL: "PERMANENT_SEASONAL",
};

@Injectable()
export class EvaluationsService {
  private readonly logger = new Logger(EvaluationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // Runs hourly (six-month-precision milestone, unlike the per-minute
  // Announcements scheduler which has to hit an exact publish time) —
  // notifies the assigned Supervisor, once, the same idempotent-via-
  // Notification-table pattern EmployeesService.checkProbationaryMilestones
  // already uses for its own Admin-facing notification. An employee with no
  // assigned Supervisor is out of scope for this check entirely — the
  // existing Admin notification already covers every probationary employee
  // regardless of Supervisor assignment.
  @Cron(CronExpression.EVERY_HOUR)
  async checkEvaluationsDue() {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - PROBATION_MILESTONE_MONTHS);

    const dueEmployees = await this.prisma.employee.findMany({
      where: {
        employmentStatus: { in: ["PROBATIONARY", "PROBATIONARY_SEASONAL"] },
        hireDate: { lte: cutoff },
        supervisorId: { not: null },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        supervisor: { select: { userId: true } },
      },
    });
    if (dueEmployees.length === 0) return;

    const alreadyNotified = await this.prisma.notification.findMany({
      where: {
        type: EVALUATION_REQUIRED_NOTIFICATION_TYPE,
        entityId: { in: dueEmployees.map((e) => e.id) },
      },
      select: { entityId: true },
    });
    const notifiedIds = new Set(alreadyNotified.map((n) => n.entityId));

    for (const employee of dueEmployees.filter((e) => !notifiedIds.has(e.id))) {
      if (!employee.supervisor?.userId) continue;
      await this.notifications.notifyUsers([employee.supervisor.userId], {
        title: "Probationary Evaluation Required",
        message: `${employee.firstName} ${employee.lastName} has completed six (6) months of probationary employment. Please review their record and recommend whether to regularize them.`,
        type: EVALUATION_REQUIRED_NOTIFICATION_TYPE,
        entityId: employee.id,
      });
    }
  }

  private async assertOwnership(employeeId: string, supervisorEmployeeId: string) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { id: true, supervisorId: true, firstName: true, lastName: true, employmentStatus: true },
    });
    if (employee.supervisorId !== supervisorEmployeeId) {
      throw new ForbiddenException("You can only evaluate members of your own team.");
    }
    return employee;
  }

  // Admin-view companion to findLatestSubmitted — an auto-generated
  // attendance/punctuality summary over the employee's whole tenure to date
  // (hireDate..today), independent of whether an evaluation has been
  // submitted. No existing function in this codebase computes a working-days
  // count over an arbitrary range (DashboardService's no-show reconstruction
  // only ever loops one calendar month), so this reimplements that same
  // per-day schedule-resolution pattern (see dashboard.service.ts) generalized
  // to a range. "Today" is excluded from the working-day denominator unless a
  // record already exists for it — the day isn't over yet, so it can't be
  // fairly counted as an absence.
  //
  // attendanceRating is an HR-unconfirmed default scoring formula (this
  // system has no existing 1-5 attendance score to reuse) — flagged here so
  // it's easy to find and adjust once HR specifies real weights.
  async computeAttendanceSummary(employeeId: string) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { hireDate: true },
    });

    const today = new Date();
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const from = new Date(employee.hireDate.getFullYear(), employee.hireDate.getMonth(), employee.hireDate.getDate());

    const [schedules, records, leaveRequests] = await Promise.all([
      this.prisma.employeeSchedule.findMany({
        where: { employeeId, startsOn: { lte: to } },
        select: { startsOn: true, endsOn: true, workingDays: true },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { employeeId, attendanceDate: { gte: from, lte: to } },
        select: { employeeId: true, attendanceDate: true, timeInAt: true, status: true, undertimeMinutes: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: { employeeId, status: "APPROVED", startDate: { lte: to }, endDate: { gte: from } },
        select: { startDate: true, endDate: true, totalDays: true },
      }),
    ]);

    const recordsByDay = new Map(
      dedupeToLatestVisitPerEmployeeDay(records).map((r) => [r.attendanceDate.toDateString(), r]),
    );

    // Same "resolve the assignment active on day X" rule used consistently
    // elsewhere (dashboard.service.ts, attendance.service.ts): most recent
    // startsOn whose range covers the day, so a mid-tenure schedule change is
    // honored day-by-day rather than only ever consulting the current one.
    function scheduleForDay(day: Date) {
      let match: (typeof schedules)[number] | null = null;
      for (const s of schedules) {
        if (s.startsOn <= day && (!s.endsOn || s.endsOn >= day)) {
          if (!match || s.startsOn > match.startsOn) match = s;
        }
      }
      return match;
    }

    let totalWorkingDays = 0;
    let daysPresent = 0;
    let lateOccurrences = 0;
    let undertimeOccurrences = 0;
    let absences = 0;

    for (const cursor = new Date(from); cursor <= to; cursor.setDate(cursor.getDate() + 1)) {
      const day = new Date(cursor);
      if (isDayOff(day)) continue;

      const schedule = scheduleForDay(day);
      const isWorkingDay = schedule ? schedule.workingDays.includes(day.getDay()) : true;
      if (!isWorkingDay) continue;

      const record = recordsByDay.get(day.toDateString());
      if (day.getTime() === to.getTime() && !record) continue;

      totalWorkingDays++;
      if (record) {
        if (record.status === "PRESENT" || record.status === "LATE") daysPresent++;
        if (record.status === "LATE") lateOccurrences++;
        if (Number(record.undertimeMinutes) > 0) undertimeOccurrences++;
        continue;
      }

      const onLeave = leaveRequests.some((r) => isDateWithinLeaveRange(day, r));
      if (!onLeave) absences++;
    }

    const absentRate = totalWorkingDays > 0 ? absences / totalWorkingDays : 0;
    const lateRate = totalWorkingDays > 0 ? lateOccurrences / totalWorkingDays : 0;
    const undertimeRate = totalWorkingDays > 0 ? undertimeOccurrences / totalWorkingDays : 0;
    const rawRating = 5 - absentRate * 3 - lateRate * 1.5 - undertimeRate * 1;
    const attendanceRating = Math.max(1, Math.min(5, Math.round(rawRating * 10) / 10));
    const attendanceRatingLabel =
      attendanceRating >= 4.5 ? "Excellent" : attendanceRating >= 3.5 ? "Good" : attendanceRating >= 2.5 ? "Fair" : "Needs Improvement";

    return {
      totalWorkingDays,
      daysPresent,
      absences,
      lateOccurrences,
      undertimeOccurrences,
      attendanceRating,
      attendanceRatingLabel,
    };
  }

  // Everything the Regularization Review screen shows: the employee's own
  // record, their attendance over the probation so far, and the Supervisor's
  // recommendation once there is one. An Admin may open any employee; a
  // Supervisor only a member of their own team.
  async findReview(employeeId: string, viewer: { employeeId?: string; roles: string[] }) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: {
        id: true,
        employeeNo: true,
        firstName: true,
        lastName: true,
        hireDate: true,
        employmentStatus: true,
        supervisorId: true,
        user: { select: { email: true } },
        department: { select: { name: true } },
        position: { select: { title: true } },
        employeeType: { select: { name: true } },
        supervisor: { select: { firstName: true, lastName: true } },
      },
    });

    const isAdmin = viewer.roles.includes("ADMIN");
    if (!isAdmin && employee.supervisorId !== viewer.employeeId) {
      throw new ForbiddenException("You can only review members of your own team.");
    }

    const [attendance, evaluation] = await Promise.all([
      this.computeAttendanceSummary(employeeId),
      this.prisma.probationaryEvaluation.findFirst({
        where: { employeeId, status: "SUBMITTED" },
        orderBy: { submittedAt: "desc" },
        include: { supervisor: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    return {
      viewerRole: isAdmin ? ("ADMIN" as const) : ("SUPERVISOR" as const),
      employee: {
        id: employee.id,
        employeeNo: employee.employeeNo,
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.user?.email ?? null,
        department: employee.department?.name ?? null,
        position: employee.position?.title ?? null,
        employeeType: employee.employeeType?.name ?? null,
        supervisorName: employee.supervisor ? `${employee.supervisor.firstName} ${employee.supervisor.lastName}` : null,
        hireDate: employee.hireDate,
        employmentStatus: employee.employmentStatus,
      },
      // Null once the employee is no longer on probation — nothing left to decide.
      targetStatus: REGULARIZATION_TARGET_STATUS[employee.employmentStatus] ?? null,
      attendance,
      recommendation: evaluation
        ? {
            decision: evaluation.recommendation === "READY_FOR_CONVERSION" ? ("APPROVE" as const) : ("REJECT" as const),
            remarks: evaluation.comments,
            decidedAt: evaluation.submittedAt,
            supervisorName: `${evaluation.supervisor.firstName} ${evaluation.supervisor.lastName}`,
          }
        : null,
    };
  }

  // The Supervisor's Approve / Reject. It is only a recommendation: it never
  // touches Employee.employmentStatus — the Admin's own Approve
  // (EmployeesService.update) remains the only path off probation.
  async recommend(
    employeeId: string,
    supervisorEmployeeId: string,
    dto: RegularizationDecisionDto,
    context: AuditLogContext = {},
  ) {
    const employee = await this.assertOwnership(employeeId, supervisorEmployeeId);
    if (!REGULARIZATION_TARGET_STATUS[employee.employmentStatus]) {
      throw new BadRequestException("This employee is no longer on probation.");
    }

    const key = { employeeId_supervisorId: { employeeId, supervisorId: supervisorEmployeeId } };
    const existing = await this.prisma.probationaryEvaluation.findUnique({ where: key });
    if (existing?.status === "SUBMITTED") {
      throw new BadRequestException("You have already submitted your recommendation for this employee.");
    }

    const approved = dto.decision === RegularizationDecision.APPROVE;
    const remarks = dto.remarks?.trim() || null;
    const data = {
      recommendation: approved ? ("READY_FOR_CONVERSION" as const) : ("NOT_RECOMMENDED" as const),
      comments: remarks,
      status: "SUBMITTED" as const,
      submittedAt: new Date(),
    };
    const saved = await this.prisma.probationaryEvaluation.upsert({
      where: key,
      update: data,
      create: { employeeId, supervisorId: supervisorEmployeeId, ...data },
    });

    const name = `${employee.firstName} ${employee.lastName}`;
    await this.auditLogs.record({
      ...context,
      action: "RECOMMEND_REGULARIZATION",
      module: "Evaluations",
      entityType: "ProbationaryEvaluation",
      entityId: saved.id,
      description: `Recommended ${approved ? "approving" : "rejecting"} the regularization of ${name}.`,
      newValues: { recommendation: saved.recommendation, remarks },
    });

    await this.notifications.notifyUsers(await this.notifications.adminUserIds(), {
      title: approved ? "Regularization Recommended" : "Regularization Not Recommended",
      message: `${name}'s supervisor ${approved ? "recommends approving" : "recommends rejecting"} their regularization.${remarks ? ` Remarks: ${remarks}` : ""} Please review and decide.`,
      type: SUPERVISOR_RECOMMENDATION_NOTIFICATION_TYPE,
      entityId: employeeId,
    });

    return saved;
  }

  // The Admin's Reject: the employee simply stays on probation, so there is
  // no status to change — the decision is kept in the audit log and the
  // Supervisor is told. (The Admin's Approve goes through
  // EmployeesService.update, which calls notifyOutcome below.)
  async rejectRegularization(employeeId: string, dto: RegularizationRemarksDto, context: AuditLogContext = {}) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employmentStatus: true,
        supervisor: { select: { userId: true } },
      },
    });
    if (!REGULARIZATION_TARGET_STATUS[employee.employmentStatus]) {
      throw new BadRequestException("This employee is no longer on probation.");
    }

    const name = `${employee.firstName} ${employee.lastName}`;
    const remarks = dto.remarks?.trim() || null;
    await this.auditLogs.record({
      ...context,
      action: "REJECT_REGULARIZATION",
      module: "Evaluations",
      entityType: "Employee",
      entityId: employee.id,
      description: `Rejected the regularization of ${name}; they remain on probation.`,
      newValues: { remarks },
    });

    if (employee.supervisor?.userId) {
      await this.notifications.notifyUsers([employee.supervisor.userId], {
        title: "Regularization Outcome",
        message: `${name}'s regularization was not approved; they remain on probationary status.${remarks ? ` Remarks: ${remarks}` : ""}`,
        type: EVALUATION_OUTCOME_NOTIFICATION_TYPE,
        entityId: employee.id,
      });
    }

    return { employeeId: employee.id, employmentStatus: employee.employmentStatus };
  }

  // Called from EmployeesService.update() when Admin changes a Probationary
  // employee's employmentStatus — the evaluating Supervisor's copy of the
  // outcome. Deliberately does not touch, replace, or duplicate the existing
  // Admin-facing PROBATION_REGULARIZATION_DUE notification/trigger; this is a
  // separate notification type to a separate recipient.
  async notifyOutcome(employee: { id: string; firstName: string; lastName: string; employmentStatus: string }) {
    if (
      employee.employmentStatus !== "REGULAR" &&
      employee.employmentStatus !== "PERMANENT_SEASONAL" &&
      employee.employmentStatus !== "SEPARATED"
    )
      return;

    const evaluation = await this.prisma.probationaryEvaluation.findFirst({
      where: { employeeId: employee.id, status: "SUBMITTED" },
      orderBy: { submittedAt: "desc" },
      select: { supervisor: { select: { userId: true } } },
    });
    if (!evaluation?.supervisor?.userId) return;

    const outcomeLabel =
      employee.employmentStatus === "REGULAR"
        ? "converted to Regular status"
        : employee.employmentStatus === "PERMANENT_SEASONAL"
          ? "converted to Permanent Seasonal status"
          : "separated rather than converted";

    await this.notifications.notifyUsers([evaluation.supervisor.userId], {
      title: "Evaluation Outcome",
      message: `${employee.firstName} ${employee.lastName} has been ${outcomeLabel} following your recommendation.`,
      type: EVALUATION_OUTCOME_NOTIFICATION_TYPE,
      entityId: employee.id,
    });
  }
}
