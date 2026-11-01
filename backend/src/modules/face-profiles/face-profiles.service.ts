import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";
import { UpsertFaceProfileDto } from "./dto/upsert-face-profile.dto";
import { ArchiveFaceProfileDto } from "./dto/archive-face-profile.dto";
import { RegistrationLivenessService } from "../face-verification/registration-liveness.service";

@Injectable()
export class FaceProfilesService {
  private readonly logger = new Logger(FaceProfilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly liveness: RegistrationLivenessService,
  ) {}

  async findAll(includeArchived = false) {
    const profiles = await this.prisma.faceProfile.findMany({
      where: includeArchived ? {} : { isArchived: false },
      include: {
        employee: {
          include: { department: true, position: true, user: true, supervisor: true },
        },
      },
      orderBy: { enrolledAt: "desc" },
    });
    if (!includeArchived) return profiles;

    // One row per employee: the active profile, or else the most recently
    // archived one, so an archived face still lists its employee.
    const activeEmployeeIds = new Set(profiles.filter((p) => !p.isArchived).map((p) => p.employeeId));
    const seenArchived = new Set<string>();
    return profiles
      .filter((p) => {
        if (!p.isArchived) return true;
        if (activeEmployeeIds.has(p.employeeId) || seenArchived.has(p.employeeId)) return false;
        seenArchived.add(p.employeeId);
        return true;
      })
      // Archived face data stays in the database but is never sent out.
      .map((p) => (p.isArchived ? { ...p, referenceImageData: null, descriptors: null } : p));
  }

  async create(dto: UpsertFaceProfileDto, context: AuditLogContext = {}) {
    if (!dto.employeeId.trim()) {
      throw new BadRequestException("Employee is required.");
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
    });

    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }

    // Face data is never stored without the employee's recorded consent
    // (accepted on the mobile app's consent screen). The admin screen already
    // blocks this; enforcing it here means no other client can skip it.
    // Grandfathered employees (requiresFaceConsent = false) are exempt.
    if (employee.requiresFaceConsent && !employee.faceConsentAcceptedAt) {
      throw new BadRequestException(
        "This employee has not accepted the face-data consent yet. They must accept it on the mobile app before their face can be registered.",
      );
    }

    // The photo and face signature come only from a liveness session the
    // server itself verified for this employee — never from the request — so
    // skipping the guided capture, or sending any other photo, is refused.
    const verified = this.liveness.getVerified(dto.livenessSessionId, employee.id, context.actorUserId);
    const referenceImageData = verified.image;
    const descriptors = [verified.descriptor];

    // An employee keeps at most one active profile: re-registering replaces
    // the existing photo/descriptors in place. Archived profiles stay behind
    // as history, so a fresh row is created after an archive.
    const existing = await this.prisma.faceProfile.findFirst({
      where: { employeeId: employee.id, isArchived: false },
    });

    if (existing) {
      const updated = await this.prisma.faceProfile.update({
        where: { id: existing.id },
        data: {
          referenceImageData: referenceImageData as any,
          descriptors: descriptors as any,
          enrollmentStatus: "ACTIVE",
          enrolledAt: new Date(),
        } as any,
        include: {
          employee: {
            include: { department: true, position: true, user: true, supervisor: true },
          },
        },
      });

      await this.auditLogs.record({
        ...context,
        action: "RE_REGISTER_FACE",
        module: "Face Verification",
        entityType: "FaceProfile",
        entityId: updated.id,
        description: `Re-registered face profile for ${updated.employee.firstName} ${updated.employee.lastName}.`,
        oldValues: { enrolledAt: existing.enrolledAt },
        newValues: { employeeId: updated.employeeId, enrollmentStatus: updated.enrollmentStatus },
      });

      this.liveness.consume(dto.livenessSessionId);
      this.keepStoredDescriptor(updated, verified.image);
      return updated;
    }

    const created = await this.prisma.faceProfile.create({
      data: {
        employeeId: employee.id,
        referenceImageData: referenceImageData as any,
        descriptors: descriptors as any,
        enrollmentStatus: "ACTIVE",
        enrolledAt: new Date(),
      } as any,
      include: {
        employee: {
          include: { department: true, position: true, user: true, supervisor: true },
        },
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "REGISTER_FACE",
      module: "Face Verification",
      entityType: "FaceProfile",
      entityId: created.id,
      description: `Registered face profile for ${created.employee.firstName} ${created.employee.lastName}.`,
      newValues: { employeeId: created.employeeId, enrollmentStatus: created.enrollmentStatus },
    });

    this.liveness.consume(dto.livenessSessionId);
    this.keepStoredDescriptor(created, verified.image);
    return created;
  }

  // Swaps in the attendance-style descriptor after the save, so registering
  // doesn't wait for it; it starts a moment later as it holds up the server
  // while it runs, and the save's response has to get out first. Matched on
  // enrolledAt too: if the face was re-registered in the meantime, this older
  // capture leaves the newer one alone.
  private keepStoredDescriptor(profile: { id: string; enrolledAt: Date | null }, image: string) {
    setTimeout(() => {
      void this.liveness
        .storedDescriptor(image)
        .then((descriptor) =>
          descriptor
            ? this.prisma.faceProfile.updateMany({
                where: { id: profile.id, enrolledAt: profile.enrolledAt },
                data: { descriptors: [descriptor] as any },
              })
            : undefined,
        )
        .catch((error) => this.logger.warn(`Stored descriptor not updated: ${error instanceof Error ? error.message : String(error)}`));
    }, 1000);
  }

  async createLivenessSession(employeeId: string, actorUserId?: string) {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) {
      throw new NotFoundException("Employee not found.");
    }
    return this.liveness.createSession(employee.id, actorUserId);
  }

  async archive(id: string, dto: ArchiveFaceProfileDto, context: AuditLogContext = {}) {
    const profile = await this.prisma.faceProfile.findUnique({
      where: { id },
      include: { employee: true },
    });
    if (!profile) {
      throw new NotFoundException("Face profile not found.");
    }

    const archived = await this.prisma.faceProfile.update({
      where: { id },
      data: { isArchived: true },
      include: {
        employee: {
          include: { department: true, position: true, user: true, supervisor: true },
        },
      },
    });

    await this.auditLogs.record({
      ...context,
      action: "ARCHIVE_FACE_PROFILE",
      module: "Face Verification",
      entityType: "FaceProfile",
      entityId: id,
      description: `Archived face profile for ${profile.employee.firstName} ${profile.employee.lastName}.`,
      oldValues: { isArchived: profile.isArchived },
      newValues: { isArchived: true, reason: dto.reason?.trim() || "No reason provided" },
    });

    return archived;
  }

  async remove(id: string, context: AuditLogContext = {}) {
    const profile = await this.prisma.faceProfile.findUnique({
      where: { id },
      include: { employee: true },
    });
    if (!profile) {
      throw new NotFoundException("Face profile not found.");
    }
    const removed = await this.prisma.faceProfile.delete({ where: { id } });
    await this.auditLogs.record({
      ...context,
      action: "DELETE_FACE_PROFILE",
      module: "Face Verification",
      entityType: "FaceProfile",
      entityId: id,
      description: `Deleted face profile for ${profile.employee.firstName} ${profile.employee.lastName}.`,
      oldValues: { employeeId: profile.employeeId, enrollmentStatus: profile.enrollmentStatus },
    });
    return removed;
  }
}
