export type Tab =
  | "attendance"
  | "leave"
  | "dtr"
  | "workarea"
  | "settings";

export type SupervisorTab =
  | "dashboard"
  | "team"
  | "leave"
  | "attendance"
  | "more";

export type Portal = "employee" | "supervisor";

// Live, continuously-recomputed status of whether the employee's current GPS
// position falls within (the radius of) any of their assigned work
// locations — "checking" while a fix is pending, "unavailable" when location
// permission is denied or nothing is assigned yet to compare against.
export type GeofenceStatus = "checking" | "inside" | "outside" | "unavailable";