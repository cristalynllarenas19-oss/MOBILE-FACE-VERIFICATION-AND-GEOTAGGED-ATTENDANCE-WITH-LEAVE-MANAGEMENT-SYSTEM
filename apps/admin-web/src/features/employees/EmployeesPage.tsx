import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [formData, setFormData] = useState({
    employeeNo: "",
    firstName: "",
    lastName: "",
    departmentId: "",
    positionId: "",
    employmentStatus: "ACTIVE",
  });

  useEffect(() => {
    fetchEmployees();
  }, []);

  const fetchEmployees = () => {
    apiRequest<Employee[]>("/employees").then(setEmployees).catch(() => undefined);
  };

  const handleAddEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest("/employees", "POST", formData);
      setShowAddModal(false);
      setFormData({
        employeeNo: "",
        firstName: "",
        lastName: "",
        departmentId: "",
        positionId: "",
        employmentStatus: "ACTIVE",
      });
      fetchEmployees();
    } catch (error) {
      console.error("Failed to add employee:", error);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const activeCount = employees.filter(
    (emp) => emp.employmentStatus === "ACTIVE"
  ).length;

  return (
    <>
      <div className="employees-header">
        <div className="employees-header-content">
          <h2>Employee Management</h2>
          <p>Manage employee records and information</p>
        </div>
        <button
          className="btn-add-employee"
          onClick={() => setShowAddModal(true)}
        >
          <Plus size={18} />
          <span>Add Employee</span>
        </button>
      </div>

      <div className="filter-tabs">
        <button className="active">All Employees ({employees.length})</button>
        <button>Active ({activeCount})</button>
        <button>Inactive ({employees.length - activeCount})</button>
      </div>

      <section className="table-card">
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
            {employees.map((employee) => (
              <tr key={employee.id}>
                <td>{employee.employeeNo}</td>
                <td>{employee.firstName} {employee.lastName}</td>
                <td>{employee.department.name}</td>
                <td>{employee.position.title}</td>
                <td>
                  <Badge
                    tone={
                      employee.employmentStatus === "ACTIVE"
                        ? "success"
                        : "danger"
                    }
                  >
                    {employee.employmentStatus}
                  </Badge>
                </td>
                <td>
                  <button className="btn-edit">Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Add Employee Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add New Employee</h3>
              <button
                className="modal-close"
                onClick={() => setShowAddModal(false)}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleAddEmployee} className="modal-form">
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="employeeNo">Employee No. *</label>
                  <input
                    id="employeeNo"
                    name="employeeNo"
                    type="text"
                    placeholder="e.g., EMP-001"
                    value={formData.employeeNo}
                    onChange={handleInputChange}
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="firstName">First Name *</label>
                  <input
                    id="firstName"
                    name="firstName"
                    type="text"
                    placeholder="First name"
                    value={formData.firstName}
                    onChange={handleInputChange}
                    required
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="lastName">Last Name *</label>
                  <input
                    id="lastName"
                    name="lastName"
                    type="text"
                    placeholder="Last name"
                    value={formData.lastName}
                    onChange={handleInputChange}
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="employmentStatus">Status *</label>
                  <select
                    id="employmentStatus"
                    name="employmentStatus"
                    value={formData.employmentStatus}
                    onChange={handleInputChange}
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                    <option value="ON_LEAVE">On Leave</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="departmentId">Department *</label>
                  <select
                    id="departmentId"
                    name="departmentId"
                    value={formData.departmentId}
                    onChange={handleInputChange}
                    required
                  >
                    <option value="">Select Department</option>
                    <option value="1">IT</option>
                    <option value="2">HR</option>
                    <option value="3">Finance</option>
                    <option value="4">Operations</option>
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="positionId">Position *</label>
                  <select
                    id="positionId"
                    name="positionId"
                    value={formData.positionId}
                    onChange={handleInputChange}
                    required
                  >
                    <option value="">Select Position</option>
                    <option value="1">Manager</option>
                    <option value="2">Developer</option>
                    <option value="3">Coordinator</option>
                    <option value="4">Analyst</option>
                  </select>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowAddModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Add Employee
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
