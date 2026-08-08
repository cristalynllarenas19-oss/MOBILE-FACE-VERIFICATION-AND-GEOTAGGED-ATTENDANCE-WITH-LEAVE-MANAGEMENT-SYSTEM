import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

// Semi-monthly cutoff dates undertime may be filed on, and the per-employee
// monthly cap — fixed by HR policy rather than admin-configurable, since
// nothing else in this schema exposes a global, admin-tunable settings value
// (every other configurable rule lives on a specific model like LeaveType or
// Shift). Revisit as a DB-driven setting if HR asks to change these later.
const FILING_DAYS_OF_MONTH = [8, 23];
const MAX_FILINGS_PER_MONTH = 3;

function toDateOnly(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function monthRange(reference: Date) {
  const start = new Date(reference.getFullYear(), reference.getMonth(), 1);
  const end = new Date(reference.getFullYear(), reference.getMonth() + 1, 1);
  return { start, end };
}

@Injectable()
export class UndertimeService {
  constructor(private readonly prisma: PrismaService) {}

  // Filtering by filingDate within the current calendar month (rather than a
  // stored counter) is what makes the monthly cap reset automatically at the
  // start of the next month — there's nothing to manually zero out.
  private async countThisMonth(employeeId: string, reference: Date) {
    const { start, end } = monthRange(reference);
    return this.prisma.undertimeFiling.count({
      where: { employeeId, filingDate: { gte: start, lt: end } },
    });
  }

  // Tells the frontend whether filing is currently allowed and why not, so
  // the UI never has to hardcode the 8th/23rd or the 3-per-month cap itself —
  // it just reflects whatever this returns.
  async getEligibility(employeeId: string) {
    const today = new Date();
    const filingDate = toDateOnly(today);
    const isFilingDay = FILING_DAYS_OF_MONTH.includes(today.getDate());

    const [filedThisMonth, filedToday] = await Promise.all([
      this.countThisMonth(employeeId, today),
      this.prisma.undertimeFiling.findFirst({ where: { employeeId, filingDate } }),
    ]);

    const remaining = Math.max(0, MAX_FILINGS_PER_MONTH - filedThisMonth);
    const alreadyFiledToday = Boolean(filedToday);

    return {
      isFilingDay,
      filingDaysOfMonth: FILING_DAYS_OF_MONTH,
      maxFilingsPerMonth: MAX_FILINGS_PER_MONTH,
      filedThisMonth,
      remaining,
      alreadyFiledToday,
      eligible: isFilingDay && remaining > 0 && !alreadyFiledToday,
    };
  }

  async file(employeeId: string, reason?: string) {
    const today = new Date();

    if (!FILING_DAYS_OF_MONTH.includes(today.getDate())) {
      throw new BadRequestException(
        `Undertime can only be filed on the ${FILING_DAYS_OF_MONTH.join(" or ")} of the month.`,
      );
    }

    const filingDate = toDateOnly(today);

    const alreadyFiledToday = await this.prisma.undertimeFiling.findFirst({
      where: { employeeId, filingDate },
    });
    if (alreadyFiledToday) {
      throw new BadRequestException("You have already filed undertime today.");
    }

    const filedThisMonth = await this.countThisMonth(employeeId, today);
    if (filedThisMonth >= MAX_FILINGS_PER_MONTH) {
      throw new BadRequestException(
        `You have reached the maximum of ${MAX_FILINGS_PER_MONTH} undertime filings for this month.`,
      );
    }

    return this.prisma.undertimeFiling.create({
      data: { employeeId, filingDate, reason: reason?.trim() || undefined },
    });
  }

  async findAll(employeeId?: string, departmentId?: string) {
    return this.prisma.undertimeFiling.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        ...(departmentId ? { employee: { departmentId } } : {}),
      },
      include: {
        employee: { select: { firstName: true, lastName: true, department: { select: { name: true } } } },
      },
      orderBy: { filingDate: "desc" },
    });
  }
}
