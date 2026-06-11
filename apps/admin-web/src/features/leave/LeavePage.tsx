import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";

type LeaveRequest = {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: string;
  status: string;
  employee: { firstName: string; lastName: string };
  leaveType: { name: string };
};

export function LeavePage() {
  const [requests, setRequests] = useState<LeaveRequest[]>([]);

  useEffect(() => {
    apiRequest<LeaveRequest[]>("/leave-requests").then(setRequests).catch(() => undefined);
  }, []);

  return (
    <section className="table-card">
      <table>
        <thead>
          <tr><th>Employee</th><th>Leave Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id}>
              <td>{request.employee.firstName} {request.employee.lastName}</td>
              <td>{request.leaveType.name}</td>
              <td>{new Date(request.startDate).toLocaleDateString()} - {new Date(request.endDate).toLocaleDateString()}</td>
              <td>{request.totalDays}</td>
              <td><Badge tone={request.status === "APPROVED" ? "success" : request.status === "REJECTED" ? "danger" : "warning"}>{request.status}</Badge></td>
              <td><button className="outline-button">Review</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
