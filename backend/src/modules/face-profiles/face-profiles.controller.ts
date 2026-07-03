import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { FaceProfilesService } from "./face-profiles.service";
import { UpsertFaceProfileDto } from "./dto/upsert-face-profile.dto";

@Controller("face-profiles")
export class FaceProfilesController {
  constructor(private readonly faceProfilesService: FaceProfilesService) {}

  @Get()
  @RequirePermissions("users:write")
  findAll() {
    return this.faceProfilesService.findAll();
  }

  @Post()
  @RequirePermissions("users:write")
  create(@Body() dto: UpsertFaceProfileDto, @Req() request: Request) {
    return this.faceProfilesService.create(dto, getAuditContext(request));
  }

  @Delete(":id")
  @RequirePermissions("users:write")
  remove(@Param("id") id: string, @Req() request: Request) {
    return this.faceProfilesService.remove(id, getAuditContext(request));
  }
}
