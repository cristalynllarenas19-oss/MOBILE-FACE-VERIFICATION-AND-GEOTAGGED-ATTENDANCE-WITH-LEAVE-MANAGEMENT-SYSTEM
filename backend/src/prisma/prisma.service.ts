import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

const CONNECT_RETRY_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 3000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    // The DB is Neon serverless Postgres — its compute suspends after
    // inactivity and can take a few seconds to wake on the first connection,
    // which a single $connect() at boot can lose the race against (P1001).
    // Retry with a fixed delay rather than failing the whole app on a
    // transient cold-start.
    for (let attempt = 1; attempt <= CONNECT_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (error) {
        if (attempt === CONNECT_RETRY_ATTEMPTS) throw error;
        this.logger.warn(
          `Database connection attempt ${attempt}/${CONNECT_RETRY_ATTEMPTS} failed, retrying in ${CONNECT_RETRY_DELAY_MS}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
