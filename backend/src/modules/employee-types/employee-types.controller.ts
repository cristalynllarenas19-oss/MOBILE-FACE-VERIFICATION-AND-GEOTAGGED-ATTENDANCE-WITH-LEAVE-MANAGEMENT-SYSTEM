import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { EmployeeTypesService } from "./employee-types.service";

type EmployeeTypeBody = { name?: string; description?: string | null; entitledToLeave?: boolean };

@Controller("employee-types")
export class EmployeeTypesController {
  constructor(private readonly employeeTypesService: EmployeeTypesService) {}

  // Active types only, unless ?includeArchived=true.
  @Get()
  findAll(@Query("includeArchived") includeArchived?: string) {
    return this.employeeTypesService.findAll(includeArchived === "true");
  }

  @Post()
  @RequirePermissions("employee-types:write")
  create(@Body() dto: EmployeeTypeBody, @Req() request: Request) {
    return this.employeeTypesService.create(dto, (request as any).user?.userId);
  }

  @Patch(":id")
  @RequirePermissions("employee-types:write")
  update(@Param("id") id: string, @Body() dto: EmployeeTypeBody, @Req() request: Request) {
    return this.employeeTypesService.update(id, dto, (request as any).user?.userId);
  }

  @Patch(":id/status")
  @RequirePermissions("employee-types:write")
  setStatus(@Param("id") id: string, @Body() dto: { isActive: boolean }, @Req() request: Request) {
    return this.employeeTypesService.setStatus(id, dto.isActive, (request as any).user?.userId);
  }
}
