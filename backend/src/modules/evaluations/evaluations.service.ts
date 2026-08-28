import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { isDateWithinLeaveRange } from "../../common/utils/on-leave.util";
import { isDayOff } from "../../common/utils/schedule.util";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { dedupeToLatestVisitPerEmployeeDay } from "../attendance/attendance-dedup.util";
import { NotificationsService } from "../notifications/notifications.service";
import { SaveEvaluationDraftDto, SubmitEvaluationDto } from "./dto/evaluation.dto";

// Mirrors EmployeesService's own PROBATION_MILESTONE_NOTIFICATION_TYPE/MONTHS
// pair — kept as a separate constant here (not imported) because that pair is
// private to EmployeesService and this check targets a different recipient
// (the assigned Supervisor, not Admin) via its own notification type, so the
// two milestone checks stay independent and neither can suppress the other.
const EVALUATION_REQUIRED_NOTIFICATION_TYPE = "SUPERVISOR_EVALUATION_REQUIRED";
const EVALUATION_OUTCOME_NOTIFICATION_TYPE = "EVALUATION_CONVERSION_OUTCOME";
const PROBATION_MILESTONE_MONTHS = 6;

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
      where: { employmentStatus: "PROBATIONARY", hireDate: { lte: cutoff }, supervisorId: { not: null } },
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
        message: `${employee.firstName} ${employee.lastName} has completed six (6) months of probationary employment. Please complete their performance evaluation.`,
        type: EVALUATION_REQUIRED_NOTIFICATION_TYPE,
        entityId: employee.id,
      });
    }
  }

  private async assertOwnership(employeeId: string, supervisorEmployeeId: string) {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { id: true, supervisorId: true, firstName: true, lastName: true },
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
    const leaveDaysUsed = leaveRequests.reduce((sum, r) => sum + Number(r.totalDays), 0);

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
      leaveDaysUsed,
      attendanceRating,
      attendanceRatingLabel,
    };
  }

  // Admin-view: the most recent SUBMITTED evaluation for this employee, with
  // the evaluating Supervisor's name attached. Drafts are never returned here
  // — a Supervisor's in-progress evaluation stays private to them until they
  // actually submit, same as they're never expected to "notify Admin" before
  // then.
  findLatestSubmitted(employeeId: string) {
    return this.prisma.probationaryEvaluation.findFirst({
      where: { employeeId, status: "SUBMITTED" },
      orderBy: { submittedAt: "desc" },
      include: { supervisor: { select: { firstName: true, lastName: true, department: { select: { name: true } } } } },
    });
  }

  async findForSupervisor(employeeId: string, supervisorEmployeeId: string) {
    await this.assertOwnership(employeeId, supervisorEmployeeId);
    return this.prisma.probationaryEvaluation.findUnique({
      where: { employeeId_supervisorId: { employeeId, supervisorId: supervisorEmployeeId } },
    });
  }

  async saveDraft(employeeId: string, supervisorEmployeeId: string, dto: SaveEvaluationDraftDto) {
    await this.assertOwnership(employeeId, supervisorEmployeeId);

    const existing = await this.prisma.probationaryEvaluation.findUnique({
      where: { employeeId_supervisorId: { employeeId, supervisorId: supervisorEmployeeId } },
    });
    if (existing?.status === "SUBMITTED") {
      throw new BadRequestException("This evaluation has already been submitted and can no longer be edited.");
    }

    return this.prisma.probationaryEvaluation.upsert({
      where: { employeeId_supervisorId: { employeeId, supervisorId: supervisorEmployeeId } },
      update: { ...dto },
      create: { employeeId, supervisorId: supervisorEmployeeId, ...dto },
    });
  }

  async submit(
    employeeId: string,
    supervisorEmployeeId: string,
    dto: SubmitEvaluationDto,
    context: AuditLogContext = {},
  ) {
    const employee = await this.assertOwnership(employeeId, supervisorEmployeeId);

    const existing = await this.prisma.probationaryEvaluation.findUnique({
      where: { employeeId_supervisorId: { employeeId, supervisorId: supervisorEmployeeId } },
    });
    if (existing?.status === "SUBMITTED") {
      throw new BadRequestException("This evaluation has already been submitted.");
    }

    const submitted = await this.prisma.probationaryEvaluation.upsert({
      where: { employeeId_supervisorId: { employeeId, supervisorId: supervisorEmployeeId } },
      update: { ...dto, status: "SUBMITTED", submittedAt: new Date() },
      create: { employeeId, supervisorId: supervisorEmployeeId, ...dto, status: "SUBMITTED", submittedAt: new Date() },
    });

    await this.auditLogs.record({
      ...context,
      action: "SUBMIT_PROBATIONARY_EVALUATION",
      module: "Evaluations",
      entityType: "ProbationaryEvaluation",
      entityId: submitted.id,
      description: `Submitted probationary evaluation for ${employee.firstName} ${employee.lastName}.`,
      newValues: { recommendation: submitted.recommendation, overallRating: submitted.overallRating },
    });

    return submitted;
  }

  // Called from EmployeesService.update() when Admin changes a Probationary
  // employee's employmentStatus — the evaluating Supervisor's copy of the
  // outcome. Deliberately does not touch, replace, or duplicate the existing
  // Admin-facing PROBATION_REGULARIZATION_DUE notification/trigger; this is a
  // separate notification type to a separate recipient.
  async notifyOutcome(employee: { id: string; firstName: string; lastName: string; employmentStatus: string }) {
    if (employee.employmentStatus !== "REGULAR" && employee.employmentStatus !== "SEPARATED") return;

    const evaluation = await this.prisma.probationaryEvaluation.findFirst({
      where: { employeeId: employee.id, status: "SUBMITTED" },
      orderBy: { submittedAt: "desc" },
      select: { supervisor: { select: { userId: true } } },
    });
    if (!evaluation?.supervisor?.userId) return;

    const outcomeLabel =
      employee.employmentStatus === "REGULAR"
        ? "converted to Regular status"
        : "separated rather than converted to Regular";

    await this.notifications.notifyUsers([evaluation.supervisor.userId], {
      title: "Evaluation Outcome",
      message: `${employee.firstName} ${employee.lastName} has been ${outcomeLabel} following your submitted evaluation.`,
      type: EVALUATION_OUTCOME_NOTIFICATION_TYPE,
      entityId: employee.id,
    });
  }
}
