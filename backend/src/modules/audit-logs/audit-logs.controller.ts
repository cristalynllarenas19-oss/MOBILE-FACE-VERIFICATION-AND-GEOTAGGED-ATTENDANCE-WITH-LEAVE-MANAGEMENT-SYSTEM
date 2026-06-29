import { Controller, Get, Query } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { AuditLogsService } from "./audit-logs.service";

@Controller("audit-logs")
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  @RequirePermissions("reports:read")
  findAll(
    @Query("action") action?: string,
    @Query("entityType") entityType?: string,
    @Query("module") module?: string,
    @Query("actorUserId") actorUserId?: string,
    @Query("search") search?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.auditLogsService.findAll({
      action,
      entityType,
      module,
      actorUserId,
      search,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get("export")
  @RequirePermissions("reports:read")
  findForExport(
    @Query("action") action?: string,
    @Query("entityType") entityType?: string,
    @Query("module") module?: string,
    @Query("actorUserId") actorUserId?: string,
    @Query("search") search?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.auditLogsService.findForExport({ action, entityType, module, actorUserId, search, from, to });
  }
}
