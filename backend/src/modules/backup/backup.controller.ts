import { BadRequestException, Controller, Delete, Get, Param, Post, Req, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { RequirePermissions } from "../../common/decorators/permissions.decorator";
import { BackupService } from "./backup.service";

// @types/multer isn't installed in this project; this covers just the
// fields FileInterceptor's memory storage actually populates on req.file.
type UploadedFileLike = { buffer: Buffer; originalname: string };

// Gated on audit:read — the same admin-only permission the neighboring Audit
// Logs tab uses (Supervisors never get it, see seed.ts) — rather than adding
// a dedicated backup:write permission, which would require re-seeding the
// live database's Permission/RolePermission tables just for this feature.
@Controller("backups")
@RequirePermissions("audit:read")
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Get()
  list() {
    return this.backupService.listBackups();
  }

  @Post()
  create(@Req() request: Request) {
    return this.backupService.createBackup((request as any).user?.userId);
  }

  @Get(":filename/download")
  async download(@Param("filename") filename: string, @Res() res: Response) {
    const filePath = await this.backupService.getBackupFilePath(filename);
    res.download(filePath, filename);
  }

  @Delete(":filename")
  async remove(@Param("filename") filename: string, @Req() request: Request) {
    await this.backupService.deleteBackup(filename, (request as any).user?.userId);
    return { success: true };
  }

  @Post(":filename/restore")
  restoreExisting(@Param("filename") filename: string, @Req() request: Request) {
    return this.backupService.restoreFromExisting(filename, (request as any).user?.userId);
  }

  @Post("restore-upload")
  @UseInterceptors(FileInterceptor("file"))
  restoreUpload(@UploadedFile() file: UploadedFileLike, @Req() request: Request) {
    if (!file) throw new BadRequestException("No file was uploaded.");
    return this.backupService.restoreFromUpload(file.buffer, file.originalname, (request as any).user?.userId);
  }
}
