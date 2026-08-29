import { Injectable, BadRequestException, ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditLogContext, AuditLogsService } from "../audit-logs/audit-logs.service";

// Present only for a Supervisor (never for ADMIN — see getSupervisorDepartmentScope).
// When set, every write below is confined to this department: the location
// being touched must belong to it or be shared (departmentId null), it can
// never be moved to another department, every employeeId being assigned must
// belong to it, and only this department's slice of a roster is ever replaced.
export type DepartmentScope = { departmentId?: string };

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
export class GeolocationService {
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

    return this.scopeLocationEmployees(updated, scope.departmentId);
  }

  async removeLocation(id: string, context: AuditLogContext = {}, scope: DepartmentScope = {}) {
    const before = await this.prisma.workLocation.findUnique({ where: { id } });

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
        await this.assertEmployeeAvailable(tx, employeeId, locationId);
        await tx.workLocationEmployee.create({
          data: { workLocationId: locationId, employeeId },
        });
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

    return this.scopeLocationEmployees(updated, scope.departmentId);
  }

  // Auto-assigns a Fixed-mode employee to whichever geotagged area is
  // currently the active Office (type: "OFFICE") — never a hardcoded name,
  // so renaming/replacing the Office area needs no code change. Prefers an
  // Office area scoped to the employee's own department, falling back to a
  // shared/global one (departmentId null), same precedence findAllLocations
  // and assertWithinDepartmentScope already use elsewhere in this file.
  // Called by EmployeesService on hire and on a mode switch into Fixed —
  // not exposed as an endpoint, since it's system-triggered, not a manual
  // Supervisor action (see addEmployee for that).
  async assignDefaultOfficeLocation(employeeId: string, employeeDepartmentId: string, context: AuditLogContext = {}) {
    const officeLocation =
      (await this.prisma.workLocation.findFirst({
        where: { type: "OFFICE", isActive: true, departmentId: employeeDepartmentId },
        orderBy: { name: "asc" },
      })) ??
      (await this.prisma.workLocation.findFirst({
        where: { type: "OFFICE", isActive: true, departmentId: null },
        orderBy: { name: "asc" },
      }));

    // No Office area configured yet — non-blocking, same as the Standard
    // Shift lookup in EmployeesService.create() when none exists.
    if (!officeLocation) return null;

    await this.prisma.$transaction(async (tx) => {
      // A Fixed employee holds exactly one assignment — clear any stale ones
      // (leftover Field-site assignments from before a mode switch, or a
      // previous Office area that's since been archived/replaced) before
      // attaching the current one. Idempotent: safe even if already correct.
      await tx.workLocationEmployee.deleteMany({ where: { employeeId } });
      await tx.workLocationEmployee.create({ data: { workLocationId: officeLocation.id, employeeId } });
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

  async getLocationForEmployee(employeeId: string) {
    if (await this.hasJoinTable()) {
      return this.prisma.workLocation.findFirst({
        where: { isActive: true, employees: { some: { employeeId } } },
        include: { employees: { include: { employee: true } } },
      });
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
      await this.assertEmployeeAvailable(tx, employeeId, locationId, restrictToDepartmentId);
      await tx.workLocationEmployee.create({
        data: { workLocationId: locationId, employeeId },
      });
    }
  }

  private async assertEmployeeAvailable(
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

    // Field technicians are allowed to be assigned to many sites at once —
    // only FIXED employees are restricted to a single geotagged area.
    if (employee?.attendanceMode === "FIELD") {
      return;
    }

    const existingAssignment = await tx.workLocationEmployee.findFirst({
      where: { employeeId, NOT: { workLocationId: locationId } },
    });

    if (existingAssignment) {
      throw new BadRequestException(
        "This employee is already assigned to another geotagged area. Please unassign them from their current area before assigning them to a new one.",
      );
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
