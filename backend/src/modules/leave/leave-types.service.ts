import { Injectable, ConflictException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class LeaveTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.leaveType.findMany({ orderBy: { name: "asc" } });
  }

  async create(dto: { name: string; defaultDays: number; requiresDocument?: boolean }) {
    const existing = await this.prisma.leaveType.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException(`Leave type "${dto.name}" already exists.`);

    return this.prisma.leaveType.create({
      data: {
        name: dto.name,
        defaultDays: dto.defaultDays,
        requiresDocument: dto.requiresDocument ?? false,
      },
    });
  }
}