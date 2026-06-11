import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { apiRequest } from "../../lib/api";

type Employee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  employmentStatus: string;
  department: { name: string };
  position: { title: string };
};

export function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);

  useEffect(() => {
    apiRequest<Employee[]>("/employees").then(setEmployees).catch(() => undefined);
  }, []);

  return (
    <section className="table-card">
      <table>
        <thead>
          <tr><th>Employee No.</th><th>Name</th><th>Department</th><th>Position</th><th>Status</th></tr>
        </thead>
        <tbody>
          {employees.map((employee) => (
            <tr key={employee.id}>
              <td>{employee.employeeNo}</td>
              <td>{employee.firstName} {employee.lastName}</td>
              <td>{employee.department.name}</td>
              <td>{employee.position.title}</td>
              <td><Badge tone="success">{employee.employmentStatus}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
