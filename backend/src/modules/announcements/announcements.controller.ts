import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { AnnouncementsService } from "./announcements.service";
import { CreateAnnouncementDto } from "./dto/create-announcement.dto";
import { UpdateAnnouncementDto } from "./dto/update-announcement.dto";

@Controller("announcements")
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Get()
  findAll() {
    return this.announcementsService.findAll();
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
}
