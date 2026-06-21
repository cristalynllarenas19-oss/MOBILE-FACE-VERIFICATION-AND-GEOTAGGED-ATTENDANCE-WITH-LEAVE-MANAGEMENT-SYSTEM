import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
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
  create(@Body() dto: UpsertFaceProfileDto) {
    return this.faceProfilesService.create(dto);
  }

  @Delete(":id")
  @RequirePermissions("users:write")
  remove(@Param("id") id: string) {
    return this.faceProfilesService.remove(id);
  }
}
