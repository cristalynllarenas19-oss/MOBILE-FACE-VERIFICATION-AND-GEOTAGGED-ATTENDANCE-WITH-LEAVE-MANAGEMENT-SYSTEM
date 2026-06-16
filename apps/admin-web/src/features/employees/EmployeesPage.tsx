import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api";
import "./EmployeesPage.css";

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
  const [departmentFilter, setDepartmentFilter] = useState<string>("ALL");

  useEffect(() => {
    apiRequest<Employee[]>("/employees").then(setEmployees).catch(() => undefined);
  }, []);

  const departments = Array.from(new Set(employees.map((e) => e.department.name))).sort();

  const visibleEmployees = employees.filter((e) =>
    departmentFilter === "ALL" || e.department.name === departmentFilter
  );

  return (
    <>
      <div className="employees-toolbar">
        <div className="filter-tabs">
          <button
            className={departmentFilter === "ALL" ? "active" : ""}
            onClick={() => setDepartmentFilter("ALL")}
          >
            All Employees ({employees.length})
          </button>

          <select
            className="department-select"
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
          >
            <option value="ALL">All Departments</option>
            {departments.map((dept) => (
              <option key={dept} value={dept}>
                {dept}
              </option>
            ))}
          </select>
        </div>

        <button className="btn-add">+ Add Employee</button>
      </div>

      <section className="employees-table-card">
        <table>
          <thead>
            <tr>
              <th>Employee No.</th>
              <th>Name</th>
              <th>Department</th>
              <th>Position</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleEmployees.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty-state">
                  No employees found.
                </td>
              </tr>
            ) : (
              visibleEmployees.map((employee) => (
                <tr key={employee.id}>
                  <td data-label="Employee No.">{employee.employeeNo}</td>
                  <td data-label="Name">
                    {employee.firstName} {employee.lastName}
                  </td>
                  <td data-label="Department">{employee.department.name}</td>
                  <td data-label="Position">{employee.position.title}</td>
                  <td data-label="Status" className="employee-status-cell">
                    <span
                      className={`status-badge ${
                        employee.employmentStatus === "REGULAR" ? "active" : "inactive"
                      }`}
                    >
                      {employee.employmentStatus}
                    </span>
                  </td>
                  <td data-label="Action" className="action-cell">
                    <button className="btn-action btn-view">View</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}