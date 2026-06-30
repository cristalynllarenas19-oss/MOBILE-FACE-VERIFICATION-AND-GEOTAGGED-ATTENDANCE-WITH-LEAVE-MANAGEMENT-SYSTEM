const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3001/api/v1";

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  employeeId?: string;
  departmentId?: string;
  department?: string;
  displayName: string;
  attendanceMode?: "FIXED" | "FIELD";
};

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
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function login(email: string, password: string) {
  const data = await apiRequest<{ accessToken: string; refreshToken: string; user: AuthUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
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
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("authUser");
}

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
