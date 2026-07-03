import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { FaceProfilesController } from "./face-profiles.controller";
import { FaceProfilesService } from "./face-profiles.service";

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [FaceProfilesController],
  providers: [FaceProfilesService],
})
export class FaceProfilesModule {}
