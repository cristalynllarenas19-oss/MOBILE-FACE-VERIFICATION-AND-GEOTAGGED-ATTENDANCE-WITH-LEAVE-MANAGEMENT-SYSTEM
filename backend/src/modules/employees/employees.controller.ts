import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { CreateEmployeeDto, UpdateEmployeeDto } from "./dto/create-employee.dto";
import { EmployeesService } from "./employees.service";

@Controller("employees")
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  findAll() {
    return this.employeesService.findAll();
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
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employeesService.update(id, dto);
  }

  @Patch(":id/archive")
  archive(@Param("id") id: string, @Body() dto: { reason?: string; archiveType?: string }) {
    return this.employeesService.archive(id, dto);
  }
}
