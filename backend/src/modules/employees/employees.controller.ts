import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { getSupervisorDepartmentScope } from "../../common/utils/supervisor-scope.util";
import { CreateEmployeeDto, UpdateEmployeeDto } from "./dto/create-employee.dto";
import { EmployeesService } from "./employees.service";

@Controller("employees")
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  findAll(@Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.employeesService.findAll(departmentId);
  }

  // Must stay before the ":id"-shaped routes below — Nest matches routes by
  // registration order and ":id" would otherwise swallow the literal "me".
  @Get("me")
  findMe(@Req() request: Request) {
    const employeeId = (request as any).user.employeeId;
    return this.employeesService.findMe(employeeId);
  }

  // Candidates for the "Supervisor" field on Add/Edit Employee. Gated on
  // employees:write (not :read) since it's only ever consulted from that
  // write flow — a scoped Supervisor is forced to their own department, same
  // as findAll above.
  @Get("supervisors")
  @RequirePermissions("employees:write")
  findSupervisors(@Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.employeesService.findSupervisors(departmentId);
  }

  @Patch("me/photo")
  updateMyPhoto(
    @Req() request: Request,
    @Body() body: { profilePhotoData: string; profilePhotoMimeType: string },
  ) {
    const employeeId = (request as any).user.employeeId;
    return this.employeesService.updateMyPhoto(employeeId, body.profilePhotoData, body.profilePhotoMimeType);
  }

  // Employee accepts the face-data consent from FaceConsentScreen on mobile.
  // Unblocks Face Registration on the admin side — see FaceRegistrationPage.
  @Post("me/consent")
  acceptFaceConsent(@Req() request: Request) {
    const employeeId = (request as any).user.employeeId;
    return this.employeesService.acceptFaceConsent(employeeId);
  }

  @Post()
  @RequirePermissions("employees:write")
  create(@Body() dto: CreateEmployeeDto, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.employeesService.create(dto, getAuditContext(request), departmentId);
  }

  @Patch(":id")
  @RequirePermissions("employees:write")
  update(@Param("id") id: string, @Body() dto: UpdateEmployeeDto, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.employeesService.update(id, dto, getAuditContext(request), departmentId);
  }

  @Patch(":id/archive")
  @RequirePermissions("employees:write")
  archive(@Param("id") id: string, @Body() dto: { reason?: string; archiveType?: string }, @Req() request: Request) {
    const departmentId = getSupervisorDepartmentScope((request as any).user);
    return this.employeesService.archive(id, dto, getAuditContext(request), departmentId);
  }
}
