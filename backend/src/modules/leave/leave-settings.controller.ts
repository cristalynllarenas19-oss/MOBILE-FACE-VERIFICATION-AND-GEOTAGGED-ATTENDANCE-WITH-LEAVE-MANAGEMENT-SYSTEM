import { Body, Controller, Get, Patch, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { LeaveLapseService } from "./leave-lapse.service";

// Same permission split as the undertime settings: anyone who can read
// leave can see the value; only "leave-types:write" (ADMIN in practice) can
// change it.
@Controller("leave-settings")
export class LeaveSettingsController {
  constructor(private readonly leaveLapseService: LeaveLapseService) {}

  @Get()
  @RequirePermissions("leave:read")
  getSettings() {
    return this.leaveLapseService.getSettings();
  }

  @Patch()
  @RequirePermissions("leave-types:write")
  updateSettings(@Body() body: { lapseGraceDays?: number; reviewReminderHours?: number }, @Req() request: Request) {
    return this.leaveLapseService.updateSettings(
      {
        lapseGraceDays: body.lapseGraceDays === undefined ? undefined : Number(body.lapseGraceDays),
        reviewReminderHours: body.reviewReminderHours === undefined ? undefined : Number(body.reviewReminderHours),
      },
      getAuditContext(request),
    );
  }
}
