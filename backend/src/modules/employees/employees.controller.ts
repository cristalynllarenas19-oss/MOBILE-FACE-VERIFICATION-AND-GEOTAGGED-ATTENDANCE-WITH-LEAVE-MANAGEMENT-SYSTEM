import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { CreateEmployeeDto, UpdateEmployeeDto } from "./dto/create-employee.dto";
import { EmployeesService } from "./employees.service";

@Controller("employees")
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  findAll(@Req() request: Request) {
    const user = (request as any).user;
    const departmentId = user.role === "SUPERVISOR" ? user.departmentId : undefined;
    return this.employeesService.findAll(departmentId);
  }

  // Must stay before the ":id"-shaped routes below — Nest matches routes by
  // registration order and ":id" would otherwise swallow the literal "me".
  // View-only: employees cannot self-edit their profile, so there is no PATCH "me".
  @Get("me")
  findMe(@Req() request: Request) {
    const employeeId = (request as any).user.employeeId;
    return this.employeesService.findMe(employeeId);
  }

  @Post()
  @RequirePermissions("employees:write")
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Patch(":id")
  @RequirePermissions("employees:write")
  update(@Param("id") id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employeesService.update(id, dto);
  }

  @Patch(":id/archive")
  @RequirePermissions("employees:write")
  archive(@Param("id") id: string, @Body() dto: { reason?: string; archiveType?: string }) {
    return this.employeesService.archive(id, dto);
  }
}
