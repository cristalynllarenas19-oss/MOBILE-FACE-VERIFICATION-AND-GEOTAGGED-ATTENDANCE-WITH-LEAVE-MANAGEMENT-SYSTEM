import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { AnnouncementsService } from "./announcements.service";
import { CreateAnnouncementDto } from "./dto/create-announcement.dto";
import { UpdateAnnouncementDto } from "./dto/update-announcement.dto";

@Controller("announcements")
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Get()
  findAll(@Query("archived") archived?: string) {
    return this.announcementsService.findAll(archived === "true");
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.announcementsService.findOne(id);
  }

  @Post()
  @RequirePermissions("announcements:write")
  create(@Body() dto: CreateAnnouncementDto, @Req() request: Request) {
    return this.announcementsService.create(dto, (request as any).user?.userId);
  }

  @Patch(":id")
  @RequirePermissions("announcements:write")
  update(@Param("id") id: string, @Body() dto: UpdateAnnouncementDto, @Req() request: Request) {
    return this.announcementsService.update(id, dto, (request as any).user?.userId);
  }

  @Delete(":id")
  @RequirePermissions("announcements:write")
  remove(@Param("id") id: string) {
    return this.announcementsService.remove(id);
  }

  @Patch(":id/archive")
  @RequirePermissions("announcements:write")
  archive(@Param("id") id: string) {
    return this.announcementsService.archive(id);
  }

  @Patch(":id/unarchive")
  @RequirePermissions("announcements:write")
  unarchive(@Param("id") id: string) {
    return this.announcementsService.unarchive(id);
  }
}
