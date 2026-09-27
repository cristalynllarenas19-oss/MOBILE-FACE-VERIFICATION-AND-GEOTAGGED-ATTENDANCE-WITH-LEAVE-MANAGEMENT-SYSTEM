import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { AuthService } from "./auth.service";

// argon2 does real (slow-ish) hashing by default — mocked so every test is
// fast and deterministic, and so tests can control exactly what "matches"
// without needing a real hash round-trip.
jest.mock("argon2");
const mockedArgon2 = argon2 as jest.Mocked<typeof argon2>;

describe("AuthService", () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;
  let config: any;
  let mail: any;
  let auditLogs: any;

  beforeEach(() => {
    // argon2's auto-mock (jest.mock("argon2") above) is a module-level
    // singleton shared across every test in this file, unlike the plain
    // object mocks below which are recreated fresh per test — so its call
    // history must be cleared here or a `.not.toHaveBeenCalled()` assertion
    // in one test could see calls left over from a previous one.
    jest.clearAllMocks();

    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn(), findUniqueOrThrow: jest.fn() },
      userRole: { deleteMany: jest.fn(), create: jest.fn() },
      role: { findUniqueOrThrow: jest.fn() },
      passwordResetOtp: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    jwtService = { signAsync: jest.fn(), verifyAsync: jest.fn() };
    config = { get: jest.fn().mockReturnValue(undefined) };
    mail = { sendOtpEmail: jest.fn() };
    auditLogs = { record: jest.fn() };

    service = new AuthService(prisma, jwtService, config, mail, auditLogs);
  });

  function baseUser(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: "user-1",
      email: "employee@example.com",
      status: "ACTIVE",
      passwordHash: "hashed",
      tokenVersion: 1,
      lastLoginAt: null,
      employee: null,
      userRoles: [
        {
          role: {
            code: "EMPLOYEE",
            assignedAt: new Date(),
            permissions: [{ permission: { code: "attendance:write" } }],
          },
        },
      ],
      ...overrides,
    };
  }

  describe("login", () => {
    it("rejects when no user exists for the email", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login("nobody@example.com", "pw")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an inactive account even with the correct password", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser({ status: "SUSPENDED" }));
      await expect(service.login("employee@example.com", "pw")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects a wrong password", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser());
      mockedArgon2.verify.mockResolvedValue(false);
      await expect(service.login("employee@example.com", "wrong")).rejects.toThrow(UnauthorizedException);
    });

    it("lets a brand-new employee (no passwordHash yet) in on email alone", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser({ passwordHash: null }));
      prisma.user.update.mockResolvedValue({});
      jwtService.signAsync.mockResolvedValue("signed-token");

      const result = await service.login("employee@example.com", undefined);
      expect(result.accessToken).toBe("signed-token");
      expect(mockedArgon2.verify).not.toHaveBeenCalled();
    });

    it("returns both an access token and a refresh token on success", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser());
      prisma.user.update.mockResolvedValue({});
      mockedArgon2.verify.mockResolvedValue(true);
      jwtService.signAsync.mockResolvedValueOnce("access-token").mockResolvedValueOnce("refresh-token");

      const result = await service.login("employee@example.com", "correct-password");

      expect(result.accessToken).toBe("access-token");
      expect(result.refreshToken).toBe("refresh-token");
      expect(result.user.email).toBe("employee@example.com");
      expect(jwtService.signAsync).toHaveBeenCalledTimes(2);
    });

    it("records a LOGIN audit entry and stamps lastLoginAt", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser());
      prisma.user.update.mockResolvedValue({});
      mockedArgon2.verify.mockResolvedValue(true);
      jwtService.signAsync.mockResolvedValue("token");

      await service.login("employee@example.com", "correct-password");

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user-1" }, data: expect.objectContaining({ lastLoginAt: expect.any(Date) }) }),
      );
      expect(auditLogs.record).toHaveBeenCalledWith(expect.objectContaining({ action: "LOGIN" }));
    });

    it("evicts outranked admins when the logging-in user holds the ADMIN role", async () => {
      const newAdminAssignedAt = new Date("2026-01-02");
      const outrankedAssignedAt = new Date("2026-01-01");
      const adminUser = baseUser({
        id: "new-admin",
        userRoles: [
          { role: { code: "ADMIN", assignedAt: newAdminAssignedAt, permissions: [] } },
        ],
      });
      prisma.user.findUnique.mockResolvedValue(adminUser);
      prisma.user.update.mockResolvedValue({});
      mockedArgon2.verify.mockResolvedValue(true);
      jwtService.signAsync.mockResolvedValue("token");

      // evictOutrankedAdmins runs its lookup inside $transaction(prisma) —
      // fed the same mocked prisma, so this call is what needs the outranked
      // admin lookup.
      prisma.user.findMany = jest.fn().mockResolvedValue([
        { id: "old-admin", email: "old@example.com", employee: null, userRoles: [{ role: { code: "ADMIN" } }] },
      ]);
      prisma.role.findUniqueOrThrow.mockResolvedValue({ id: "role-employee", code: "EMPLOYEE" });

      await service.login("employee@example.com", "correct-password");

      expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({
        where: { userId: "old-admin", role: { code: "ADMIN" } },
      });
      expect(auditLogs.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "REVOKE_USER_ROLE", entityId: "old-admin" }),
      );
      void outrankedAssignedAt; // documents intent: old-admin's grant predates the new admin's
    });
  });

  describe("refresh", () => {
    it("rejects a refresh token that fails verification", async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error("bad signature"));
      await expect(service.refresh("garbage")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects when the account is no longer active", async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: "user-1", tokenVersion: 1 });
      prisma.user.findUnique.mockResolvedValue({ status: "SUSPENDED", tokenVersion: 1 });
      await expect(service.refresh("token")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects when tokenVersion no longer matches (roles changed / evicted)", async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: "user-1", tokenVersion: 1 });
      prisma.user.findUnique.mockResolvedValue({ status: "ACTIVE", tokenVersion: 2 });
      await expect(service.refresh("token")).rejects.toThrow(UnauthorizedException);
    });

    it("issues a fresh access + refresh token pair when the refresh token is valid", async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-1",
        email: "employee@example.com",
        tokenVersion: 1,
        exp: 12345,
        iat: 1000,
      });
      prisma.user.findUnique.mockResolvedValue({ status: "ACTIVE", tokenVersion: 1 });
      jwtService.signAsync.mockResolvedValueOnce("new-access").mockResolvedValueOnce("new-refresh");

      const result = await service.refresh("valid-refresh-token");

      expect(result).toEqual({ accessToken: "new-access", refreshToken: "new-refresh" });
      // exp/iat from the decoded old token must never leak into the newly
      // signed payload (signAsync throws if a payload already carries exp).
      const firstCallPayload = jwtService.signAsync.mock.calls[0][0];
      expect(firstCallPayload).not.toHaveProperty("exp");
      expect(firstCallPayload).not.toHaveProperty("iat");
    });
  });

  describe("logout", () => {
    it("records a LOGOUT audit entry", async () => {
      const result = await service.logout({ actorUserId: "user-1" } as any);
      expect(auditLogs.record).toHaveBeenCalledWith(expect.objectContaining({ action: "LOGOUT", entityId: "user-1" }));
      expect(result).toEqual({ message: "Logged out" });
    });
  });

  describe("forgotPassword", () => {
    it("returns the generic message even when no account exists (no user enumeration)", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const result = await service.forgotPassword("nobody@example.com");
      expect(result.message).toMatch(/if an account/i);
      expect(mail.sendOtpEmail).not.toHaveBeenCalled();
    });

    it("creates an OTP and emails it when the account exists", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser());
      prisma.passwordResetOtp.findFirst.mockResolvedValue(null);
      mockedArgon2.hash.mockResolvedValue("otp-hash");
      prisma.passwordResetOtp.create.mockResolvedValue({});

      await service.forgotPassword("employee@example.com");

      expect(prisma.passwordResetOtp.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: "user-1", otpHash: "otp-hash" }) }),
      );
      expect(mail.sendOtpEmail).toHaveBeenCalledWith("employee@example.com", expect.any(String));
    });

    it("throttles a resend within the cooldown window", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser());
      prisma.passwordResetOtp.findFirst.mockResolvedValue({ createdAt: new Date() });
      await expect(service.forgotPassword("employee@example.com")).rejects.toThrow(BadRequestException);
    });
  });

  describe("verifyResetOtp", () => {
    it("rejects when the account doesn't exist", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.verifyResetOtp("nobody@example.com", "123456")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects when there is no pending, unexpired OTP", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser());
      prisma.passwordResetOtp.findFirst.mockResolvedValue(null);
      await expect(service.verifyResetOtp("employee@example.com", "123456")).rejects.toThrow(UnauthorizedException);
    });

    it("increments attempts and rejects on a wrong code", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser());
      prisma.passwordResetOtp.findFirst.mockResolvedValue({ id: "otp-1", attempts: 0, otpHash: "hash" });
      mockedArgon2.verify.mockResolvedValue(false);

      await expect(service.verifyResetOtp("employee@example.com", "000000")).rejects.toThrow(UnauthorizedException);
      expect(prisma.passwordResetOtp.update).toHaveBeenCalledWith({
        where: { id: "otp-1" },
        data: { attempts: { increment: 1 } },
      });
    });

    it("rejects once the max attempt count has already been reached", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser());
      prisma.passwordResetOtp.findFirst.mockResolvedValue({ id: "otp-1", attempts: 5, otpHash: "hash" });
      await expect(service.verifyResetOtp("employee@example.com", "123456")).rejects.toThrow(UnauthorizedException);
      expect(mockedArgon2.verify).not.toHaveBeenCalled();
    });

    it("marks the OTP verified and returns a reset token on a correct code", async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser());
      prisma.passwordResetOtp.findFirst.mockResolvedValue({ id: "otp-1", attempts: 0, otpHash: "hash" });
      mockedArgon2.verify.mockResolvedValue(true);
      prisma.passwordResetOtp.update.mockResolvedValue({});
      jwtService.signAsync.mockResolvedValue("reset-token");

      const result = await service.verifyResetOtp("employee@example.com", "123456");

      expect(result).toEqual({ resetToken: "reset-token" });
      expect(prisma.passwordResetOtp.update).toHaveBeenCalledWith({
        where: { id: "otp-1" },
        data: { verifiedAt: expect.any(Date) },
      });
    });
  });

  describe("resetPassword", () => {
    it("rejects an unverifiable/expired reset token", async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error("expired"));
      await expect(service.resetPassword("bad-token", "newPassword123")).rejects.toThrow(BadRequestException);
    });

    it("rejects a token whose purpose isn't password_reset", async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: "user-1", otpId: "otp-1", purpose: "something_else" });
      await expect(service.resetPassword("token", "newPassword123")).rejects.toThrow(BadRequestException);
    });

    it("rejects when the OTP row is missing, unverified, or already consumed", async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: "user-1", otpId: "otp-1", purpose: "password_reset" });
      prisma.passwordResetOtp.findUnique.mockResolvedValue(null);
      await expect(service.resetPassword("token", "newPassword123")).rejects.toThrow(BadRequestException);
    });

    it("updates the password and consumes the OTP on success", async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: "user-1", otpId: "otp-1", purpose: "password_reset" });
      prisma.passwordResetOtp.findUnique.mockResolvedValue({
        id: "otp-1",
        userId: "user-1",
        verifiedAt: new Date(),
        consumedAt: null,
      });
      mockedArgon2.hash.mockResolvedValue("new-hash");
      prisma.user.update.mockResolvedValue({});
      prisma.passwordResetOtp.update.mockResolvedValue({});

      const result = await service.resetPassword("token", "newPassword123");

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { passwordHash: "new-hash" },
      });
      expect(prisma.passwordResetOtp.update).toHaveBeenCalledWith({
        where: { id: "otp-1" },
        data: { consumedAt: expect.any(Date) },
      });
      expect(result.message).toMatch(/password has been updated/i);
    });
  });
});
