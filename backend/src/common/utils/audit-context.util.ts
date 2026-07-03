import type { AuditLogContext } from "../../modules/audit-logs/audit-logs.service";

export function getAuditContext(request: Request): AuditLogContext {
  const req = request as any;
  const forwardedFor = req.headers?.["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(",")[0];

  return {
    actorUserId: req.user?.userId,
    actorRole: req.user?.role,
    ipAddress: forwardedIp?.trim() || req.ip || req.socket?.remoteAddress,
    userAgent: req.headers?.["user-agent"],
  };
}
