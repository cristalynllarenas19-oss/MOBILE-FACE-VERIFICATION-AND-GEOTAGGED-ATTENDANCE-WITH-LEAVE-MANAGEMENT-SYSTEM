const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('employees','leave_types','leave_balances','leave_requests','work_locations','attendance_records')
    AND column_name IN ('sex','hire_date','applicable_statuses','requires_admin_grant','default_days','work_location_id','time_in_at','time_out_at','lunch_out_at','lunch_in_at')
    ORDER BY table_name, column_name;
  `);
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
}).finally(() => prisma.$disconnect());
