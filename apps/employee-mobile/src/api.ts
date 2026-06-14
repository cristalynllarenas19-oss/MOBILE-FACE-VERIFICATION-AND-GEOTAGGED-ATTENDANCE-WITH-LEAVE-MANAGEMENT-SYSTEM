import * as SecureStore from "expo-secure-store";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://192.168.1.14:3001/api/v1";

export type MobileUser = {
  id: string;
  email: string;
  role: string;
  employeeId?: string;
  displayName: string;
};
export type TodayAttendance = {
  status: string;
  timeInAt: string | null;
  timeOutAt: string | null;
};

export async function apiRequest<T>(path: string, options: RequestInit = {}) {
  console.log("REQUEST:", `${API_BASE_URL}${path}`);
  const token = await SecureStore.getItemAsync("accessToken");
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}

export async function login(email: string, password: string) {
  const data = await apiRequest<{ accessToken: string; refreshToken: string; user: MobileUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  await SecureStore.setItemAsync("accessToken", data.accessToken);
  await SecureStore.setItemAsync("refreshToken", data.refreshToken);
  return data.user;
}

export async function logout() {
  await SecureStore.deleteItemAsync("accessToken");
  await SecureStore.deleteItemAsync("refreshToken");
}

export async function getTodayAttendance(
  employeeId: string,
) {
  return apiRequest<TodayAttendance>(
    `/attendance/today/${employeeId}`,
  );
}