import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";

type AttendanceRecord = {
  id: string;
  timeInAt?: string;
  status: string;
  employee: { firstName: string; lastName: string; department: { name: string } };
  logs: { distanceFromSiteMeters: string; faceSimilarityScore?: string; verificationStatus: string }[];
};

export function AttendancePage() {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);

  useEffect(() => {
    apiRequest<AttendanceRecord[]>("/attendance").then(setRecords).catch(() => undefined);
  }, []);

  return (
    <section className="table-card">
      <table>
        <thead>
          <tr><th>Employee</th><th>Time In</th><th>Location</th><th>Face Score</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const latestLog = record.logs[0];
            return (
              <tr key={record.id}>
                <td>{record.employee.firstName} {record.employee.lastName}</td>
                <td>{record.timeInAt ? new Date(record.timeInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Pending"}</td>
                <td>{latestLog ? `${Math.round(Number(latestLog.distanceFromSiteMeters))}m from site` : "No log"}</td>
                <td>{latestLog?.faceSimilarityScore ? `${latestLog.faceSimilarityScore}%` : "N/A"}</td>
                <td><Badge tone={record.status === "PRESENT" ? "success" : "warning"}>{record.status}</Badge></td>
                <td><button className="outline-button">View</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
