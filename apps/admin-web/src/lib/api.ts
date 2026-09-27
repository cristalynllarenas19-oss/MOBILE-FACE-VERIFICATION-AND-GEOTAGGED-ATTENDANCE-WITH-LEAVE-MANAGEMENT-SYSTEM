import { clearDataCache } from "./dataCache";

export const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3001/api/v1";

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

let refreshPromise: Promise<string | null> | null = null;

// Mirrors employee-mobile/src/api.ts's refreshAccessToken: a single in-flight
// refresh shared by every caller that races into a 401 at once, so a page
// with several concurrent requests doesn't fire off several refresh calls
// for the same expired token.
async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = localStorage.getItem("refreshToken");
    if (!refreshToken) return null;

    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return null;

      const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
      if (!data.accessToken || !data.refreshToken) return null;

      localStorage.setItem("accessToken", data.accessToken);
      localStorage.setItem("refreshToken", data.refreshToken);
      return data.accessToken;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function rawRequest(path: string, options: RequestInit, token: string | null) {
  return fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("accessToken");
  let response = await rawRequest(path, options, token);

  // A 401 on anything but the refresh call itself gets one silent
  // refresh-and-retry — only once, so an invalid/revoked refresh token still
  // falls through to the session-expired handling below instead of looping.
  if (response.status === 401 && path !== "/auth/refresh") {
    const newToken = await refreshAccessToken();
    if (newToken) {
      response = await rawRequest(path, options, newToken);
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem("accessToken");
      localStorage.removeItem("refreshToken");
      localStorage.removeItem("authUser");
      clearDataCache();
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
  const data = await apiRequest<{ accessToken: string; refreshToken: string; user: AuthUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  // A different account may have logged in in this browser — never let it
  // see the previous account's cached data.
  clearDataCache();
  localStorage.setItem("accessToken", data.accessToken);
  localStorage.setItem("refreshToken", data.refreshToken);
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
  localStorage.removeItem("refreshToken");
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
