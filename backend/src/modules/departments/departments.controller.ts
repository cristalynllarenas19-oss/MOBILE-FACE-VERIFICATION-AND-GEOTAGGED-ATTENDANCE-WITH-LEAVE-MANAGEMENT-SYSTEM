import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { DepartmentsService } from "./departments.service";

@Controller("departments")
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get("attendance-modes")
  findAttendanceModes() {
    return this.departmentsService.findAttendanceModes();
  }

  @Get()
  findAll() {
    return this.departmentsService.findAll();
  }

  @Post()
  @RequirePermissions("departments:write")
  create(@Body() dto: { name: string; attendanceMode?: string }, @Req() request: Request) {
    return this.departmentsService.create(dto, (request as any).user?.userId);
  }

  @Patch(":id")
  @RequirePermissions("departments:write")
  update(
    @Param("id") id: string,
    @Body() dto: { name?: string; attendanceMode?: string },
    @Req() request: Request,
  ) {
    return this.departmentsService.update(id, dto, (request as any).user?.userId);
  }

  @Patch(":id/status")
  @RequirePermissions("departments:write")
  setStatus(@Param("id") id: string, @Body() dto: { isActive: boolean }, @Req() request: Request) {
    return this.departmentsService.setStatus(id, dto.isActive, (request as any).user?.userId);
  }
}
