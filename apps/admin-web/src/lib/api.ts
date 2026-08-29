import { clearDataCache } from "./dataCache";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3001/api/v1";

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  roles: string[];
  permissions: string[];
  adminPermissions?: string[];
  employeeId?: string;
  departmentId?: string;
  department?: string;
  displayName: string;
  attendanceMode?: string;
  defaultView?: "ADMIN" | "EMPLOYEE" | null;
  // Shared with employee-mobile: set on the Employee record, not per-platform,
  // so accepting on one client (e.g. mobile) satisfies it everywhere.
  requiresFaceConsent?: boolean;
  faceConsentAcceptedAt?: string | null;
};

export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired");
    this.name = "SessionExpiredError";
  }
}

let _onSessionExpired: (() => void) | null = null;
export function setOnSessionExpired(cb: () => void) { _onSessionExpired = cb; }

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("accessToken");
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      _onSessionExpired?.();
      throw new SessionExpiredError();
    }
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  // Nest's Express adapter treats a controller returning `null` the same as
  // `undefined` and sends a completely empty body (not the literal string
  // "null") — response.json() throws "Unexpected end of input" on that, so
  // an empty-but-ok body is read as text first and treated as `null`. Mirrors
  // employee-mobile/src/api.ts's apiRequest, which already handles this.
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function login(email: string, password: string) {
  const data = await apiRequest<{ accessToken: string; user: AuthUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  // A different account may have logged in in this browser — never let it
  // see the previous account's cached data.
  clearDataCache();
  localStorage.setItem("accessToken", data.accessToken);
  localStorage.setItem("authUser", JSON.stringify(data.user));
  return data.user;
}

export function getStoredUser() {
  const raw = localStorage.getItem("authUser");
  return raw ? (JSON.parse(raw) as AuthUser) : null;
}

export function logout() {
  const token = localStorage.getItem("accessToken");
  if (token) {
    fetch(`${API_BASE_URL}/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    }).catch(() => undefined);
  }
  localStorage.removeItem("accessToken");
  localStorage.removeItem("authUser");
  clearDataCache();
}

export const acceptFaceConsent = () =>
  apiRequest<{ faceConsentAcceptedAt: string }>("/employees/me/consent", { method: "POST" });

export const updateDefaultView = (userId: string, defaultView: "ADMIN" | "EMPLOYEE") =>
  apiRequest<{ id: string; defaultView: "ADMIN" | "EMPLOYEE" }>(`/users/${userId}/default-view`, {
    method: "PATCH",
    body: JSON.stringify({ defaultView }),
  });

export const forgotPassword = (email: string) =>
  apiRequest<{ message: string }>("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });

export const verifyResetOtp = (email: string, otp: string) =>
  apiRequest<{ resetToken: string }>("/auth/reset-password/verify-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp }),
  });

export const resetPassword = (resetToken: string, newPassword: string) =>
  apiRequest<{ message: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ resetToken, newPassword }),
  });
