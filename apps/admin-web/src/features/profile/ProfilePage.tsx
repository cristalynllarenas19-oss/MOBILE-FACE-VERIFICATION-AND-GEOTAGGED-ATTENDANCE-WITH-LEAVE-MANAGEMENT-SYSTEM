import { useEffect, useState } from "react";
import { Briefcase, Building2, CalendarDays, IdCard, Mail, ShieldCheck } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { apiRequest } from "../../lib/api";
import "./ProfilePage.css";

type MyProfile = {
  employeeNo: string;
  firstName: string;
  lastName: string;
  hireDate?: string;
  employmentStatus: string;
  user?: { email: string } | null;
  department: { name: string };
  position: { title: string };
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function ProfilePage() {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest<MyProfile>("/employees/me")
      .then(setProfile)
      .catch(() => setError("Unable to load your profile."));
  }, []);

  if (error) {
    return <div className="profile-page-error">{error}</div>;
  }

  if (!profile) {
    return <div className="profile-page-loading">Loading profile...</div>;
  }

  const fullName = `${profile.firstName} ${profile.lastName}`;

  return (
    <div className="profile-page">
      <Card className="profile-card">
        <div className="profile-card-header">
          <div className="profile-avatar-large">{getInitials(fullName)}</div>
          <div>
            <h2>{fullName}</h2>
            <p>{profile.position.title}</p>
          </div>
        </div>

        <div className="profile-detail-grid">
          <div className="profile-detail-item">
            <IdCard size={16} />
            <div>
              <span className="profile-detail-label">Employee No.</span>
              <span className="profile-detail-value">{profile.employeeNo}</span>
            </div>
          </div>

          <div className="profile-detail-item">
            <Mail size={16} />
            <div>
              <span className="profile-detail-label">Email</span>
              <span className="profile-detail-value">{profile.user?.email ?? "Unassigned"}</span>
            </div>
          </div>

          <div className="profile-detail-item">
            <Building2 size={16} />
            <div>
              <span className="profile-detail-label">Department</span>
              <span className="profile-detail-value">{profile.department.name}</span>
            </div>
          </div>

          <div className="profile-detail-item">
            <Briefcase size={16} />
            <div>
              <span className="profile-detail-label">Position</span>
              <span className="profile-detail-value">{profile.position.title}</span>
            </div>
          </div>

          <div className="profile-detail-item">
            <CalendarDays size={16} />
            <div>
              <span className="profile-detail-label">Hire Date</span>
              <span className="profile-detail-value">
                {profile.hireDate ? new Date(profile.hireDate).toLocaleDateString() : "—"}
              </span>
            </div>
          </div>

          <div className="profile-detail-item">
            <ShieldCheck size={16} />
            <div>
              <span className="profile-detail-label">Employment Status</span>
              <span className="profile-detail-value">{profile.employmentStatus}</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
