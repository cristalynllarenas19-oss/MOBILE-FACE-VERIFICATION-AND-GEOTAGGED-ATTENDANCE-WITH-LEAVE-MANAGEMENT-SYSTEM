import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";

const CONNECT_RETRY_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 3000;

// Neon's compute also suspends mid-session, not just at boot: a query issued
// right as it wakes back up can land on a connection the server already
// closed (P1017), even though the pooler accepted it. Safe to retry only for
// read-only calls, since a write that actually reached the server before the
// close would otherwise risk executing twice.
export async function withPrismaRetry<T>(query: () => Promise<T>, attempts = 2): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await query();
    } catch (error) {
      const isStaleConnection =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P1017";
      if (!isStaleConnection || attempt === attempts) throw error;
    }
  }
  /* istanbul ignore next -- unreachable, loop always returns or throws */
  throw new Error("unreachable");
}

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
