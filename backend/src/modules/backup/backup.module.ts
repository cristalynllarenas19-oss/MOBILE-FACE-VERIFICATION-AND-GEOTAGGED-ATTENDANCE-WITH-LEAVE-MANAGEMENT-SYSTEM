import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";
import { BackupController } from "./backup.controller";
import { BackupService } from "./backup.service";

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
