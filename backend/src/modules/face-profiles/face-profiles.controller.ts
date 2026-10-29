import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { getAuditContext } from "../../common/utils/audit-context.util";
import { FaceProfilesService } from "./face-profiles.service";
import { UpsertFaceProfileDto } from "./dto/upsert-face-profile.dto";
import { ArchiveFaceProfileDto } from "./dto/archive-face-profile.dto";
import { CreateLivenessSessionDto, SubmitLivenessFrameDto } from "./dto/liveness-session.dto";
import { RegistrationLivenessService } from "../face-verification/registration-liveness.service";

@Controller("face-profiles")
export class FaceProfilesController {
  constructor(
    private readonly faceProfilesService: FaceProfilesService,
    private readonly liveness: RegistrationLivenessService,
  ) {}

  @Get()
  @RequirePermissions("users:write")
  findAll(@Query("includeArchived") includeArchived?: string) {
    return this.faceProfilesService.findAll(includeArchived === "true");
  }

  @Post()
  @RequirePermissions("users:write")
  create(@Body() dto: UpsertFaceProfileDto, @Req() request: Request) {
    return this.faceProfilesService.create(dto, getAuditContext(request));
  }

  // Guided-capture liveness: a session with server-chosen random steps, then
  // one key frame per step. See registration-liveness.service.ts.
  @Post("liveness-sessions")
  @RequirePermissions("users:write")
  createLivenessSession(@Body() dto: CreateLivenessSessionDto, @Req() request: Request) {
    return this.faceProfilesService.createLivenessSession(dto.employeeId, getAuditContext(request).actorUserId);
  }

  @Post("liveness-sessions/:id/frames")
  @RequirePermissions("users:write")
  submitLivenessFrame(@Param("id") id: string, @Body() dto: SubmitLivenessFrameDto, @Req() request: Request) {
    return this.liveness.submitFrame(id, dto.kind, dto.image, getAuditContext(request).actorUserId);
  }

  @Patch(":id/archive")
  @RequirePermissions("users:write")
  archive(@Param("id") id: string, @Body() dto: ArchiveFaceProfileDto, @Req() request: Request) {
    return this.faceProfilesService.archive(id, dto, getAuditContext(request));
  }

  @Delete(":id")
  @RequirePermissions("users:write")
  remove(@Param("id") id: string, @Req() request: Request) {
    return this.faceProfilesService.remove(id, getAuditContext(request));
  }
}
