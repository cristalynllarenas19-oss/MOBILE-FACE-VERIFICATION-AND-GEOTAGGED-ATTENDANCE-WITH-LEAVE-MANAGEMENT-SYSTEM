import { Injectable } from "@nestjs/common";
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
    return this.prisma.workLocation.findMany({
      include: { employee: true },
      orderBy: { name: "asc" },
    });
  }

  async createLocation(data: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    employeeId?: string;
  }) {
    return this.prisma.workLocation.create({
      data: {
        name: data.name,
        latitude: data.latitude,
        longitude: data.longitude,
        radiusMeters: data.radiusMeters,
        allowedAccuracyMeters: 50, // Default generous accuracy for mobile GPS
        isActive: true,
        employeeId: data.employeeId || null,
      },
      include: { employee: true },
    });
  }

  async removeLocation(id: string) {
    return this.prisma.workLocation.delete({
      where: { id },
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
