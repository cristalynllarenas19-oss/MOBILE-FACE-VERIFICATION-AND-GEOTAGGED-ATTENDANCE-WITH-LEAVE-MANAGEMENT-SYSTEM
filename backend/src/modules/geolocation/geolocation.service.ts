import { Injectable, BadRequestException, ForbiddenException, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";

// Present only for a Supervisor (never for ADMIN — see getSupervisorDepartmentScope).
// When set, every write below is confined to this department: the location
// being touched must belong to it or be shared (departmentId null), it can
// never be moved to another department, every employeeId being assigned must
// belong to it, and only this department's slice of a roster is ever replaced.
export type DepartmentScope = { departmentId?: string };

// The company default area every new hire starts in (see
// assignDefaultOfficeLocation). Matched by name — WorkLocation has no
// isDefault column; admin-web's isDefaultOfficeLocation uses the same name.
const DEFAULT_OFFICE_LOCATION_NAME = "Universal Leaf Philippines Inc. - Agoo";

export type GeofenceInput = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  siteLatitude: number;
  siteLongitude: number;
  radiusMeters: number;
  allowedAccuracyMeters: number;
};

@Injectable()
export class GeolocationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GeolocationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAllLocations(departmentId?: string) {
    if (await this.hasJoinTable()) {
      try {
        const locations = await this.prisma.workLocation.findMany({
          include: {
            department: true,
            employees: {
              include: { employee: { include: { department: true, position: true } } },
            },
          },
          orderBy: { name: "asc" },
        });

        if (!departmentId) {
          return locations;
        }

        // A Supervisor only sees areas explicitly owned by their own department,
        // plus areas with no department (departmentId null — e.g. a shared HQ
        // "Global Zone"), which stay visible to everyone. Areas owned by any
        // other department are fully hidden, regardless of who's assigned to
        // them. The employee list is additionally trimmed to their department
        // as defense in depth.
        return locations
          .filter((location) => location.departmentId === null || location.departmentId === departmentId)
          .map((location) => ({
            ...location,
            employees: location.employees.filter(
              (entry) => entry.employee.departmentId === departmentId,
            ),
          }));
      } catch (error) {
        if (!this.isMissingJoinTableError(error)) {
          throw error;
        }
      }
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
        radius_meters: Prisma.Decimal;
        allowed_accuracy_meters: Prisma.Decimal;
        is_active: boolean;
        employee_id: string | null;
      }>
    >`
      SELECT id, name, latitude, longitude, radius_meters, allowed_accuracy_meters, is_active, employee_id
      FROM work_locations
      ORDER BY name ASC
    `;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      latitude: row.latitude,
      longitude: row.longitude,
      radiusMeters: row.radius_meters,
      allowedAccuracyMeters: row.allowed_accuracy_meters,
      isActive: row.is_active,
      employees: [],
      employeeId: row.employee_id,
    }));
  }

  async createLocation(data: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    allowedAccuracyMeters?: number;
    employeeIds?: string[];
    departmentId?: string | null;
    type?: "OFFICE" | "FIELD";
  }, context: AuditLogContext = {}, scope: DepartmentScope = {}) {
    const joinTableAvailable = await this.hasJoinTable();
    // A Supervisor's new area is always auto-associated with their own
    // department, regardless of what (if anything) was submitted — an Admin's
    // choice (or none, i.e. a shared/global area) is respected as-is.
    const departmentId = scope.departmentId ?? data.departmentId ?? null;

    const created = await this.prisma.$transaction(async (tx) => {
      const workLocation = await tx.workLocation.create({
        data: {
          name: data.name,
          latitude: data.latitude,
          longitude: data.longitude,
          radiusMeters: data.radiusMeters,
          allowedAccuracyMeters: data.allowedAccuracyMeters ?? 50,
          isActive: true,
          departmentId,
          type: data.type ?? "OFFICE",
        },
      });

      await this.replaceAssignments(
        tx,
        workLocation.id,
        data.employeeIds ?? [],
        joinTableAvailable,
        scope.departmentId,
      );
      if (joinTableAvailable) await this.assertFieldAreaRoster(tx, workLocation.id);

      return this.loadLocationById(tx, workLocation.id, joinTableAvailable);
    });

    await this.auditLogs.record({
      ...context,
      action: "CREATE_WORK_LOCATION",
      module: "Geotagging",
      entityType: "WorkLocation",
      entityId: created.id,
      description: `Created geotagged area ${created.name}.`,
      newValues: { ...data, employeeIds: data.employeeIds ?? [] },
    });

    await this.syncAttendanceModes(data.employeeIds ?? [], context);

    return created;
  }

  async updateLocation(
    id: string,
    data: {
      name?: string;
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
      allowedAccuracyMeters?: number;
      isActive?: boolean;
      employeeIds?: string[];
      departmentId?: string | null;
      type?: "OFFICE" | "FIELD";
    },
    context: AuditLogContext = {},
    scope: DepartmentScope = {},
  ) {
    const joinTableAvailable = await this.hasJoinTable();
    const before = await this.prisma.workLocation.findUnique({ where: { id }, include: { employees: true } });

    if (scope.departmentId) {
      // A shared area (departmentId null) is visible to every department, so a
      // Supervisor may manage their own department's assignments on it — but an
      // area owned by another department stays fully off-limits.
      if (!before || (before.departmentId !== null && before.departmentId !== scope.departmentId)) {
        throw new ForbiddenException("You can only manage geotagged areas in your own department.");
      }
      if (data.departmentId !== undefined && data.departmentId !== before.departmentId) {
        throw new ForbiddenException("You cannot move a geotagged area to another department.");
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.workLocation.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.latitude !== undefined ? { latitude: data.latitude } : {}),
          ...(data.longitude !== undefined ? { longitude: data.longitude } : {}),
          ...(data.radiusMeters !== undefined ? { radiusMeters: data.radiusMeters } : {}),
          ...(data.allowedAccuracyMeters !== undefined
            ? { allowedAccuracyMeters: data.allowedAccuracyMeters }
            : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          // Never touched for a scoped Supervisor — the department-ownership
          // guard above already rejects any attempt to change it.
          ...(!scope.departmentId && data.departmentId !== undefined ? { departmentId: data.departmentId } : {}),
          ...(data.type !== undefined ? { type: data.type } : {}),
        },
      });

      if (data.employeeIds !== undefined) {
        await this.replaceAssignments(tx, id, data.employeeIds, joinTableAvailable, scope.departmentId);
      }
      if (joinTableAvailable) await this.assertFieldAreaRoster(tx, id);

      return this.loadLocationById(tx, id, joinTableAvailable);
    });

    await this.auditLogs.record({
      ...context,
      action: data.isActive === false ? "DEACTIVATE_WORK_LOCATION" : data.isActive === true ? "ACTIVATE_WORK_LOCATION" : "UPDATE_WORK_LOCATION",
      module: "Geotagging",
      entityType: "WorkLocation",
      entityId: id,
      description: `Updated geotagged area ${updated.name}.`,
      oldValues: before ? {
        name: before.name,
        latitude: before.latitude,
        longitude: before.longitude,
        radiusMeters: before.radiusMeters,
        allowedAccuracyMeters: before.allowedAccuracyMeters,
        isActive: before.isActive,
        type: before.type,
        employeeIds: before.employees?.map((entry) => entry.employeeId),
      } : null,
      newValues: { ...data },
    });

    const currentIds = new Set<string>(
      ((updated as any).employees ?? []).map((entry: { employeeId: string }) => entry.employeeId),
    );
    if (before && before.name !== DEFAULT_OFFICE_LOCATION_NAME) {
      await this.returnToDefaultAreaIfUnassigned(
        before.employees.map((entry) => entry.employeeId).filter((employeeId) => !currentIds.has(employeeId)),
        context,
      );
    }

    // Both the previous and the current roster — a type or active change
    // affects everyone still assigned, and anyone just removed may no longer
    // have a Field area left.
    await this.syncAttendanceModes(
      [
        ...(before?.employees ?? []).map((entry) => entry.employeeId),
        ...((updated as any).employees ?? []).map((entry: { employeeId: string }) => entry.employeeId),
      ],
      context,
    );

    return this.scopeLocationEmployees(updated, scope.departmentId);
  }

  async removeLocation(id: string, context: AuditLogContext = {}, scope: DepartmentScope = {}) {
    const before = await this.prisma.workLocation.findUnique({ where: { id }, include: { employees: true } });

    if (scope.departmentId && (!before || before.departmentId !== scope.departmentId)) {
      throw new ForbiddenException("You can only manage geotagged areas in your own department.");
    }

    const removed = await this.prisma.workLocation.delete({
      where: { id },
    });

    await this.auditLogs.record({
      ...context,
      action: "DELETE_WORK_LOCATION",
      module: "Geotagging",
      entityType: "WorkLocation",
      entityId: id,
      description: `Deleted geotagged area ${before?.name ?? id}.`,
      oldValues: before ? { name: before.name, isActive: before.isActive } : null,
    });

    const formerIds = (before?.employees ?? []).map((entry) => entry.employeeId);
    if (before && before.name !== DEFAULT_OFFICE_LOCATION_NAME) {
      await this.returnToDefaultAreaIfUnassigned(formerIds, context);
    }
    await this.syncAttendanceModes(formerIds, context);

    return removed;
  }

  async addEmployee(
    locationId: string,
    employeeId: string,
    context: AuditLogContext = {},
    scope: DepartmentScope = {},
  ) {
    const joinTableAvailable = await this.hasJoinTable();
    await this.assertWithinDepartmentScope(locationId, employeeId, scope);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (joinTableAvailable) {
        await this.claimEmployeeForArea(tx, employeeId, locationId);
        await tx.workLocationEmployee.create({
          data: { workLocationId: locationId, employeeId },
        });
        await this.assertFieldAreaRoster(tx, locationId);
      } else {
        const existingAssignment = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM work_locations
          WHERE employee_id = ${employeeId} AND id <> ${locationId}
          LIMIT 1
        `;

        if (existingAssignment.length > 0) {
          throw new BadRequestException(
            "This employee is already assigned to another geotagged area. Please unassign them from their current area before assigning them to a new one.",
          );
        }

        await tx.$executeRaw`
          UPDATE work_locations
          SET employee_id = ${employeeId}
          WHERE id = ${locationId}
        `;
      }

      return this.loadLocationById(tx, locationId, joinTableAvailable);
    });

    await this.auditLogs.record({
      ...context,
      action: "ASSIGN_WORK_LOCATION_EMPLOYEE",
      module: "Geotagging",
      entityType: "WorkLocationEmployee",
      entityId: locationId,
      description: `Assigned employee to geotagged area ${updated.name}.`,
      newValues: { locationId, employeeId },
    });

    await this.syncAttendanceModes([employeeId], context);

    return this.scopeLocationEmployees(updated, scope.departmentId);
  }

  async removeEmployee(
    locationId: string,
    employeeId: string,
    context: AuditLogContext = {},
    scope: DepartmentScope = {},
  ) {
    const joinTableAvailable = await this.hasJoinTable();
    await this.assertWithinDepartmentScope(locationId, employeeId, scope);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (joinTableAvailable) {
        const [location, employee] = await Promise.all([
          tx.workLocation.findUnique({ where: { id: locationId }, select: { name: true } }),
          tx.employee.findUnique({ where: { id: employeeId }, select: { employmentStatus: true } }),
        ]);
        if (location?.name === DEFAULT_OFFICE_LOCATION_NAME && employee?.employmentStatus !== "SEPARATED") {
          throw new BadRequestException(
            `Every employee stays in ${DEFAULT_OFFICE_LOCATION_NAME}, the default area, so they can't be unassigned from it.`,
          );
        }
        await tx.workLocationEmployee.deleteMany({
          where: { workLocationId: locationId, employeeId },
        });
      } else {
        const location = await tx.workLocation.findUniqueOrThrow({ where: { id: locationId } });
        if ((location as any).employeeId === employeeId) {
          await tx.$executeRaw`
            UPDATE work_locations
            SET employee_id = NULL
            WHERE id = ${locationId}
          `;
        }
      }

      return this.loadLocationById(tx, locationId, joinTableAvailable);
    });

    await this.auditLogs.record({
      ...context,
      action: "UNASSIGN_WORK_LOCATION_EMPLOYEE",
      module: "Geotagging",
      entityType: "WorkLocationEmployee",
      entityId: locationId,
      description: `Removed employee assignment from geotagged area ${updated.name}.`,
      oldValues: { locationId, employeeId },
    });

    if (updated.name !== DEFAULT_OFFICE_LOCATION_NAME) {
      await this.returnToDefaultAreaIfUnassigned([employeeId], context);
    }
    await this.syncAttendanceModes([employeeId], context);

    return this.scopeLocationEmployees(updated, scope.departmentId);
  }

  // Puts an employee (every new hire, field technicians included) in the
  // company default area — "Universal Leaf Philippines Inc. - Agoo" (shown as
  // DEFAULT in Geotagging) — and nowhere else. Every other area, including
  // one made for a specific department, only gets employees an admin assigns
  // by hand. Only adds; any other area they're in is kept. Called by
  // EmployeesService on hire — not exposed as an endpoint, since it's
  // system-triggered, not a manual Supervisor action (see addEmployee for that).
  async assignDefaultOfficeLocation(employeeId: string, context: AuditLogContext = {}) {
    const officeLocation = await this.prisma.workLocation.findFirst({
      where: { isActive: true, name: DEFAULT_OFFICE_LOCATION_NAME },
    });

    // Default area missing or deactivated — non-blocking, same as the
    // Standard Shift lookup in EmployeesService.create() when none exists;
    // the new hire is then assigned manually in Geotagging.
    if (!officeLocation) return null;

    await this.prisma.workLocationEmployee.createMany({
      data: [{ workLocationId: officeLocation.id, employeeId }],
      skipDuplicates: true,
    });

    await this.auditLogs.record({
      ...context,
      action: "AUTO_ASSIGN_WORK_LOCATION",
      module: "Geotagging",
      entityType: "WorkLocationEmployee",
      entityId: officeLocation.id,
      description: `Auto-assigned employee to Office geotagged area ${officeLocation.name}.`,
      newValues: { employeeId, workLocationId: officeLocation.id },
    });

    return officeLocation;
  }

  // The one area a Fixed employee's attendance is checked against. Everyone
  // keeps the default area alongside at most one other (see
  // claimEmployeeForArea), so with a GPS position this is whichever of their
  // areas they're actually at (nearest geofence edge) — they can clock in at
  // either. Without one, their own specific area wins over the default.
  async getLocationForEmployee(employeeId: string, position?: { latitude: number; longitude: number }) {
    if (await this.hasJoinTable()) {
      const locations = await this.prisma.workLocation.findMany({
        where: { isActive: true, employees: { some: { employeeId } } },
        include: { employees: { include: { employee: true } } },
        orderBy: { name: "asc" },
      });
      if (locations.length <= 1) return locations[0] ?? null;

      if (position) {
        const outsideBy = (location: (typeof locations)[number]) =>
          this.distanceInMeters(position.latitude, position.longitude, Number(location.latitude), Number(location.longitude)) -
          Number(location.radiusMeters);
        return locations.reduce((best, location) => (outsideBy(location) < outsideBy(best) ? location : best));
      }
      return locations.find((location) => location.name !== DEFAULT_OFFICE_LOCATION_NAME) ?? locations[0];
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
        radius_meters: Prisma.Decimal;
        allowed_accuracy_meters: Prisma.Decimal;
        is_active: boolean;
        employee_id: string | null;
      }>
    >`
      SELECT id, name, latitude, longitude, radius_meters, allowed_accuracy_meters, is_active, employee_id
      FROM work_locations
      WHERE is_active = true AND employee_id = ${employeeId}
      LIMIT 1
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      latitude: row.latitude,
      longitude: row.longitude,
      radiusMeters: row.radius_meters,
      allowedAccuracyMeters: row.allowed_accuracy_meters,
      isActive: row.is_active,
      employees: [],
      employeeId: row.employee_id,
    };
  }

  async getLocationsForEmployee(employeeId: string) {
    if (await this.hasJoinTable()) {
      return this.prisma.workLocation.findMany({
        where: { isActive: true, employees: { some: { employeeId } } },
        orderBy: { name: "asc" },
      });
    }

    // The pre-join-table schema only ever supported a single employee_id
    // column on work_locations, which by construction cannot represent
    // multi-site assignment — field technicians require the join table.
    return [];
  }

  async findLocationForFieldVisit(employeeId: string, workLocationId?: string) {
    if (!workLocationId) return null;
    return this.prisma.workLocation.findFirst({
      where: { id: workLocationId, isActive: true, employees: { some: { employeeId } } },
    });
  }

  async getLocationById(id?: string | null) {
    if (!id) return null;
    return this.prisma.workLocation.findUnique({ where: { id } });
  }

  // Mirrors findAllLocations' trimming on a single location: a scoped
  // Supervisor's responses only ever list their own department's employees,
  // so the client's roster stays consistent between load and save.
  private scopeLocationEmployees<T extends { employees?: Array<{ employee?: { departmentId?: string | null } | null }> }>(
    location: T,
    departmentId?: string,
  ): T {
    if (!departmentId || !Array.isArray(location?.employees)) {
      return location;
    }
    return {
      ...location,
      employees: location.employees.filter((entry) => entry.employee?.departmentId === departmentId),
    };
  }

  // Rejects any attempt by a scoped Supervisor to touch a location or
  // employee outside their own department — used by the single add/remove
  // endpoints (createLocation/updateLocation enforce the same rule inline,
  // since they also need to check the *location* before any employeeId).
  private async assertWithinDepartmentScope(
    locationId: string,
    employeeId: string,
    scope: DepartmentScope,
  ) {
    if (!scope.departmentId) return;

    const [location, employee] = await Promise.all([
      this.prisma.workLocation.findUnique({ where: { id: locationId }, select: { departmentId: true } }),
      this.prisma.employee.findUnique({ where: { id: employeeId }, select: { departmentId: true } }),
    ]);

    // Shared areas (departmentId null) are manageable by any department's
    // Supervisor — but only for employees of their own department (below).
    if (!location || (location.departmentId !== null && location.departmentId !== scope.departmentId)) {
      throw new ForbiddenException("You can only manage geotagged areas in your own department.");
    }
    if (!employee || employee.departmentId !== scope.departmentId) {
      throw new ForbiddenException("You can only assign employees from your own department.");
    }
  }

  // An employee's attendance mode follows the areas they're assigned to:
  // any active Field-classified area makes them FIELD (Start/End Visit,
  // several visits a day); Office areas only make them FIXED (Time In/Out on
  // their shift). The default area doesn't count — every employee, field
  // technicians included, is in it — so the mode is left alone when that's
  // the only active area they have (or they have none at all). This is
  // the only thing that decides an employee's mode — called after every
  // geotag change here, after EmployeesService create/update, after a
  // department mode change, and once for everyone at startup (see
  // onApplicationBootstrap). Omit employeeIds to sync every employee.
  // Returns the new mode of each employee that changed.
  async syncAttendanceModes(employeeIds?: Iterable<string>, context: AuditLogContext = {}) {
    const changed = new Map<string, "FIELD" | "FIXED">();
    if (!(await this.hasJoinTable())) return changed;

    const employees = await this.prisma.employee.findMany({
      where: employeeIds ? { id: { in: [...new Set(employeeIds)] } } : undefined,
      select: {
        id: true,
        attendanceMode: true,
        firstName: true,
        lastName: true,
        workLocations: {
          where: { workLocation: { isActive: true, NOT: { name: DEFAULT_OFFICE_LOCATION_NAME } } },
          select: { workLocation: { select: { type: true } } },
        },
      },
    });

    for (const employee of employees) {
      if (employee.workLocations.length === 0) continue;

      const mode = employee.workLocations.some((entry) => entry.workLocation.type === "FIELD") ? "FIELD" : "FIXED";
      if (mode === employee.attendanceMode) continue;

      const employeeId = employee.id;
      await this.prisma.employee.update({ where: { id: employeeId }, data: { attendanceMode: mode } });
      changed.set(employeeId, mode);

      await this.auditLogs.record({
        ...context,
        action: "AUTO_UPDATE_ATTENDANCE_MODE",
        module: "Geotagging",
        entityType: "Employee",
        entityId: employeeId,
        description: `Set ${employee.firstName} ${employee.lastName}'s attendance mode to ${mode === "FIELD" ? "Field" : "Fixed"} to match their assigned geotagged area.`,
        oldValues: { attendanceMode: employee.attendanceMode },
        newValues: { attendanceMode: mode },
      });
    }

    return changed;
  }

  // Brings every existing employee in line with their assigned areas once
  // per boot — covers anyone assigned before this rule existed, or changed
  // directly in the DB. Never blocks startup: a failure is only logged, and
  // the next geotag/employee change re-syncs whoever it touches anyway.
  async onApplicationBootstrap() {
    try {
      await this.ensureEveryoneInDefaultArea();
    } catch (error) {
      this.logger.error("Failed to add employees to the default area at startup", error instanceof Error ? error.stack : undefined);
    }
    try {
      const changed = await this.syncAttendanceModes();
      if (changed.size > 0) {
        this.logger.log(`Synced attendance mode to assigned area for ${changed.size} employee(s).`);
      }
    } catch (error) {
      this.logger.error("Failed to sync attendance modes at startup", error instanceof Error ? error.stack : undefined);
    }
  }

  // Every active employee belongs to the default area (new hires are put
  // there by assignDefaultOfficeLocation); this adds anyone who isn't —
  // e.g. hired back when new hires went to their department's own area, or
  // changed directly in the DB. Only adds, never removes; idempotent. Field
  // technicians included — the default area never changes anyone's mode
  // (see syncAttendanceModes).
  private async ensureEveryoneInDefaultArea() {
    if (!(await this.hasJoinTable())) return;
    const defaultArea = await this.prisma.workLocation.findFirst({
      where: { isActive: true, name: DEFAULT_OFFICE_LOCATION_NAME },
      select: { id: true },
    });
    if (!defaultArea) return;

    const missing = await this.prisma.employee.findMany({
      where: {
        employmentStatus: { not: "SEPARATED" },
        workLocations: { none: { workLocationId: defaultArea.id } },
      },
      select: { id: true },
    });
    if (missing.length === 0) return;

    await this.prisma.workLocationEmployee.createMany({
      data: missing.map(({ id }) => ({ workLocationId: defaultArea.id, employeeId: id })),
      skipDuplicates: true,
    });
    this.logger.log(`Added ${missing.length} employee(s) to the default area ${DEFAULT_OFFICE_LOCATION_NAME}.`);
  }

  // Only employees whose department allows field work (attendance mode FIELD
  // or BOTH) may be on a Field-classified area — a FIXED department is
  // office-only. Checked against the area's final roster inside the same
  // transaction as the change, so it also covers an area being switched from
  // Office to Field with such employees already on it.
  private async assertFieldAreaRoster(tx: Prisma.TransactionClient, locationId: string) {
    const location = await tx.workLocation.findUnique({ where: { id: locationId }, select: { type: true } });
    if (location?.type !== "FIELD") return;

    const blocked = await tx.workLocationEmployee.findMany({
      where: { workLocationId: locationId, employee: { department: { attendanceMode: "FIXED" } } },
      select: { employee: { select: { firstName: true, lastName: true, department: { select: { name: true } } } } },
    });
    if (blocked.length === 0) return;

    const names = blocked
      .map(({ employee }) => `${employee.firstName} ${employee.lastName} (${employee.department.name})`)
      .join(", ");
    throw new BadRequestException(
      `Only employees in a Field or Both department can be assigned to a field area. Not allowed: ${names}.`,
    );
  }

  private async replaceAssignments(
    tx: Prisma.TransactionClient,
    locationId: string,
    employeeIds: string[],
    joinTableAvailable: boolean,
    restrictToDepartmentId?: string,
  ) {
    const uniqueEmployeeIds = [...new Set(employeeIds.filter(Boolean))];

    if (!joinTableAvailable) {
      const currentAssignment = uniqueEmployeeIds[0] ?? null;
      if (currentAssignment) {
        const existingAssignment = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM work_locations
          WHERE employee_id = ${currentAssignment} AND id <> ${locationId}
          LIMIT 1
        `;

        if (existingAssignment.length > 0) {
          throw new BadRequestException(
            "This employee is already assigned to another geotagged area. Please unassign them from their current area before assigning them to a new one.",
          );
        }
      }

      await tx.$executeRaw`
        UPDATE work_locations
        SET employee_id = ${currentAssignment}
        WHERE id = ${locationId}
      `;
      return;
    }

    // No active employee can be taken out of the default area (archived ones
    // may be — the admin page doesn't even list them).
    const location = await tx.workLocation.findUnique({ where: { id: locationId }, select: { name: true } });
    if (location?.name === DEFAULT_OFFICE_LOCATION_NAME) {
      const dropped = await tx.workLocationEmployee.findMany({
        where: {
          workLocationId: locationId,
          employeeId: { notIn: uniqueEmployeeIds },
          employee: {
            employmentStatus: { not: "SEPARATED" },
            ...(restrictToDepartmentId ? { departmentId: restrictToDepartmentId } : {}),
          },
        },
        select: { employee: { select: { firstName: true, lastName: true } } },
      });
      if (dropped.length > 0) {
        throw new BadRequestException(
          `Every employee stays in ${DEFAULT_OFFICE_LOCATION_NAME}, the default area — it can't be removed for: ${dropped
            .map(({ employee }) => `${employee.firstName} ${employee.lastName}`)
            .join(", ")}.`,
        );
      }
    }

    // A scoped Supervisor only ever sees (and submits) their own department's
    // slice of an area's roster — so only that slice is replaced, leaving
    // other departments' assignments on a shared area untouched.
    await tx.workLocationEmployee.deleteMany({
      where: {
        workLocationId: locationId,
        ...(restrictToDepartmentId ? { employee: { departmentId: restrictToDepartmentId } } : {}),
      },
    });

    for (const employeeId of uniqueEmployeeIds) {
      await this.claimEmployeeForArea(tx, employeeId, locationId, restrictToDepartmentId);
      await tx.workLocationEmployee.create({
        data: { workLocationId: locationId, employeeId },
      });
    }
  }

  // Every employee is in the default area and always keeps it. On top of
  // that they may be given one other area, but only while the default is the
  // only one they're in — anyone already in some other area must be
  // unassigned from it first. Joining the default area itself is never
  // blocked. Field technicians are the exception: they may hold several
  // field sites at once.
  private async claimEmployeeForArea(
    tx: Prisma.TransactionClient,
    employeeId: string,
    locationId: string,
    restrictToDepartmentId?: string,
  ) {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { attendanceMode: true, departmentId: true },
    });

    if (restrictToDepartmentId && employee?.departmentId !== restrictToDepartmentId) {
      throw new ForbiddenException("You can only assign employees from your own department.");
    }

    const target = await tx.workLocation.findUnique({ where: { id: locationId }, select: { name: true } });
    if (employee?.attendanceMode !== "FIELD" && target?.name !== DEFAULT_OFFICE_LOCATION_NAME) {
      const existingAssignment = await tx.workLocationEmployee.findFirst({
        where: {
          employeeId,
          NOT: [{ workLocationId: locationId }, { workLocation: { name: DEFAULT_OFFICE_LOCATION_NAME } }],
        },
        select: { workLocation: { select: { name: true } } },
      });

      if (existingAssignment) {
        throw new BadRequestException(
          `This employee is already assigned to ${existingAssignment.workLocation.name}. Only employees assigned to ${DEFAULT_OFFICE_LOCATION_NAME} alone can be assigned to another area — unassign them from ${existingAssignment.workLocation.name} first.`,
        );
      }
    }
  }

  // Safety net for the everyone-in-the-default-area rule: an employee left
  // with no area at all (e.g. one that slipped out of the default before this
  // rule) goes back to the default rather than nowhere to clock in.
  private async returnToDefaultAreaIfUnassigned(employeeIds: string[], context: AuditLogContext) {
    if (employeeIds.length === 0 || !(await this.hasJoinTable())) return;
    const stranded = await this.prisma.employee.findMany({
      where: {
        id: { in: [...new Set(employeeIds)] },
        employmentStatus: { not: "SEPARATED" },
        workLocations: { none: {} },
      },
      select: { id: true },
    });
    for (const { id } of stranded) {
      await this.assignDefaultOfficeLocation(id, context);
    }
  }

  private async hasJoinTable() {
    const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'work_location_employees'
      ) AS "exists"
    `;

    return rows[0]?.exists ?? false;
  }

  private isMissingJoinTableError(error: unknown) {
    return error instanceof Error && error.message.includes("work_location_employees");
  }

  private async loadLocationById(
    tx: Prisma.TransactionClient,
    id: string,
    joinTableAvailable: boolean,
  ) {
    if (joinTableAvailable) {
      try {
        return await tx.workLocation.findUniqueOrThrow({
          where: { id },
          include: {
            department: true,
            employees: {
              include: { employee: { include: { department: true, position: true } } },
            },
          },
        });
      } catch (error) {
        if (!this.isMissingJoinTableError(error)) {
          throw error;
        }
      }
    }

    return tx.$queryRaw<
      Array<{
        id: string;
        name: string;
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
        radius_meters: Prisma.Decimal;
        allowed_accuracy_meters: Prisma.Decimal;
        is_active: boolean;
        employee_id: string | null;
      }>
    >`
      SELECT id, name, latitude, longitude, radius_meters, allowed_accuracy_meters, is_active, employee_id
      FROM work_locations
      WHERE id = ${id}
      LIMIT 1
    `.then((rows) => {
      const row = rows[0];
      if (!row) {
        throw new Error("Work location not found");
      }

      return {
        id: row.id,
        name: row.name,
        latitude: row.latitude,
        longitude: row.longitude,
        radiusMeters: row.radius_meters,
        allowedAccuracyMeters: row.allowed_accuracy_meters,
        isActive: row.is_active,
        employees: [],
        employeeId: row.employee_id,
      };
    });
  }

  validateGeofence(input: GeofenceInput) {
    const distanceMeters = this.distanceInMeters(
      input.latitude,
      input.longitude,
      input.siteLatitude,
      input.siteLongitude,
    );
    const accuracyAccepted = input.accuracyMeters <= input.allowedAccuracyMeters;
    const insideGeofence = distanceMeters <= input.radiusMeters;

    return {
      approved: accuracyAccepted && insideGeofence,
      distanceMeters,
      accuracyAccepted,
      insideGeofence,
      reason: !accuracyAccepted
        ? "GPS accuracy is too low"
        : !insideGeofence
          ? "Employee is outside the approved work location"
          : null,
    };
  }

  private distanceInMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
    const earthRadiusMeters = 6371000;
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Resolves one address for a submitted lat/lon and is what attendance.
  // service.ts stores on the AttendanceLog row (see the address column's
  // schema comment). Doing this once, server-side, at submission time is
  // what makes mobile's and web's DTR viewers show the same address for the
  // same log — each used to independently re-geocode the stored
  // coordinates through a different provider (the device's native geocoder
  // on mobile, Nominatim on web) purely for display, which could legitimately
  // disagree on the same coordinates. Never throws: a failed/slow geocode
  // must not block an otherwise-valid attendance submission, so callers get
  // null and can fall back to formatted coordinates.
  async reverseGeocode(latitude: number, longitude: number): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
        {
          headers: {
            "Accept-Language": "en",
            // Required by Nominatim's usage policy for non-browser clients.
            "User-Agent": "UniversalLeafHRIS/1.0 (attendance geocoding)",
          },
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);
      const data = (await res.json()) as { display_name?: string };
      return data.display_name ?? null;
    } catch {
      return null;
    }
  }
}
