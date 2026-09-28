import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { PositionsService } from "./positions.service";

type PositionBody = { title?: string; departmentScope?: string; departmentIds?: string[] };

// Managing positions is org-structure config, same as departments — gated on
// the existing departments:write (Admin-only) permission.
@Controller("positions")
export class PositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  // Active positions offered in one department — feeds Add Employee's
  // Position dropdown. Must come before ":id" routes.
  @Get("available")
  findAvailable(@Query("departmentId") departmentId?: string) {
    if (!departmentId) throw new BadRequestException("departmentId is required.");
    return this.positionsService.findAvailableForDepartment(departmentId);
  }

  @Get()
  findAll() {
    return this.positionsService.findAll();
  }

  @Post()
  @RequirePermissions("departments:write")
  create(@Body() dto: PositionBody, @Req() request: Request) {
    return this.positionsService.create(dto, (request as any).user?.userId);
  }

  @Patch(":id")
  @RequirePermissions("departments:write")
  update(@Param("id") id: string, @Body() dto: PositionBody, @Req() request: Request) {
    return this.positionsService.update(id, dto, (request as any).user?.userId);
  }

  @Patch(":id/status")
  @RequirePermissions("departments:write")
  setStatus(@Param("id") id: string, @Body() dto: { isActive: boolean }, @Req() request: Request) {
    return this.positionsService.setStatus(id, dto.isActive, (request as any).user?.userId);
  }
}
