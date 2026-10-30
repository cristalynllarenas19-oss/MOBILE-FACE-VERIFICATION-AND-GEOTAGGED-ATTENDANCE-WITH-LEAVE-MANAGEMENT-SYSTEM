import { Body, Controller, Get, Patch, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { LeaveLapseService } from "./leave-lapse.service";
import { leaveYearOf } from "./leave-year.util";

// Same permission split as the undertime settings: anyone who can read
// leave can see the value; only "leave-types:write" (ADMIN in practice) can
// change it.
@Controller("leave-settings")
export class LeaveSettingsController {
  constructor(private readonly leaveLapseService: LeaveLapseService) {}

  @Get()
  @RequirePermissions("leave:read")
  async getSettings() {
    const settings = await this.leaveLapseService.getSettings();
    return {
      ...settings,
      currentLeaveYear: leaveYearOf(new Date(), settings),
    };
  }

  @Patch()
  @RequirePermissions("leave-types:write")
  updateSettings(
    @Body()
    body: {
      lapseGraceDays?: number;
      reviewReminderHours?: number;
      resetMonth?: number;
      resetDay?: number;
    },
    @Req() request: Request,
  ) {
    const toNumber = (value: unknown) => (value === undefined ? undefined : Number(value));
    return this.leaveLapseService.updateSettings(
      {
        lapseGraceDays: toNumber(body.lapseGraceDays),
        reviewReminderHours: toNumber(body.reviewReminderHours),
        resetMonth: toNumber(body.resetMonth),
        resetDay: toNumber(body.resetDay),
      },
      getAuditContext(request),
    );
  }
}
