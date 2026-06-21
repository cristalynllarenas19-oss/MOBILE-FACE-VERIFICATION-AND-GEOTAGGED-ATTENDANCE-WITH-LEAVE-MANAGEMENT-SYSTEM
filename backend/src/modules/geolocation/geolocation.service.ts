import { Injectable, BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

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
  constructor(private readonly prisma: PrismaService) {}

  async findAllLocations() {
    if (await this.hasJoinTable()) {
      try {
        return await this.prisma.workLocation.findMany({
          include: {
            employees: {
              include: { employee: { include: { department: true, position: true } } },
            },
          },
          orderBy: { name: "asc" },
        });
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
    assignAllEmployees?: boolean;
  }) {
    const joinTableAvailable = await this.hasJoinTable();
    return this.prisma.$transaction(async (tx) => {
      const workLocation = await tx.workLocation.create({
        data: {
          name: data.name,
          latitude: data.latitude,
          longitude: data.longitude,
          radiusMeters: data.radiusMeters,
          allowedAccuracyMeters: data.allowedAccuracyMeters ?? 50,
          isActive: true,
        },
      });

      await this.replaceAssignments(
        tx,
        workLocation.id,
        await this.resolveEmployeeIds(tx, data),
        joinTableAvailable,
      );

      return this.loadLocationById(tx, workLocation.id, joinTableAvailable);
    });
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
      assignAllEmployees?: boolean;
    },
  ) {
    const joinTableAvailable = await this.hasJoinTable();
    return this.prisma.$transaction(async (tx) => {
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
        },
      });

      if (data.employeeIds !== undefined || data.assignAllEmployees !== undefined) {
        await this.replaceAssignments(tx, id, await this.resolveEmployeeIds(tx, data), joinTableAvailable);
      }

      return this.loadLocationById(tx, id, joinTableAvailable);
    });
  }

  async removeLocation(id: string) {
    return this.prisma.workLocation.delete({
      where: { id },
    });
  }

  async addEmployee(locationId: string, employeeId: string) {
    const joinTableAvailable = await this.hasJoinTable();
    return this.prisma.$transaction(async (tx) => {
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
  }

  async removeEmployee(locationId: string, employeeId: string) {
    const joinTableAvailable = await this.hasJoinTable();
    return this.prisma.$transaction(async (tx) => {
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

  private async replaceAssignments(
    tx: Prisma.TransactionClient,
    locationId: string,
    employeeIds: string[],
    joinTableAvailable: boolean,
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

    await tx.workLocationEmployee.deleteMany({ where: { workLocationId: locationId } });

    for (const employeeId of uniqueEmployeeIds) {
      await this.assertEmployeeAvailable(tx, employeeId, locationId);
      await tx.workLocationEmployee.create({
        data: { workLocationId: locationId, employeeId },
      });
    }
  }

  private async assertEmployeeAvailable(
    tx: Prisma.TransactionClient,
    employeeId: string,
    locationId: string,
  ) {
    const existingAssignment = await tx.workLocationEmployee.findFirst({
      where: { employeeId, NOT: { workLocationId: locationId } },
    });

    if (existingAssignment) {
      throw new BadRequestException(
        "This employee is already assigned to another geotagged area. Please unassign them from their current area before assigning them to a new one.",
      );
    }
  }

  private async resolveEmployeeIds(
    tx: Prisma.TransactionClient,
    data: { employeeIds?: string[]; assignAllEmployees?: boolean },
  ) {
    if (data.assignAllEmployees) {
      const employees = await tx.employee.findMany({
        select: { id: true },
        orderBy: { lastName: "asc" },
      });

      return employees.map((employee) => employee.id);
    }

    return data.employeeIds ?? [];
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
}
