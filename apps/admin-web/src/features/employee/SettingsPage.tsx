/**
 * SettingsPage — employee self-service settings
 *
 * Mirrors employee-mobile SettingsScreen + ViewProfileScreen + ChangePasswordScreen:
 *  • Profile card with avatar (base64 photo or initials), name, email,
 *    contact, department, position — from /employees/me
 *  • Menu rows: My Profile, Change Password
 *  • Inline sections instead of navigation pushes
 */

import { CSSProperties, FormEvent, ReactNode, useEffect, useState } from "react";
import { ChevronRight, Eye, EyeOff, Lock, User } from "lucide-react";
import { EmployeeProfile, getMyProfile, changePassword } from "./api";
import type { AuthUser } from "../../lib/api";

type Props   = { user: AuthUser };
type Section = "menu" | "profile" | "password";

function initials(p: EmployeeProfile) {
  return `${p.firstName?.[0] ?? ""}${p.lastName?.[0] ?? ""}`.toUpperCase();
}

function avatarUri(p: EmployeeProfile) {
  if (!p.profilePhotoData) return null;
  return `data:${p.profilePhotoMimeType ?? "image/jpeg"};base64,${p.profilePhotoData}`;
}

export function SettingsPage({ user }: Props) {
  const [profile,   setProfile]   = useState<EmployeeProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [section,   setSection]   = useState<Section>("menu");

  // password form state
  const [currPwd,     setCurrPwd]     = useState("");
  const [newPwd,      setNewPwd]      = useState("");
  const [confirmPwd,  setConfirmPwd]  = useState("");
  const [showCurr,    setShowCurr]    = useState(false);
  const [showNew,     setShowNew]     = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwdStatus,   setPwdStatus]   = useState<{ ok: boolean; msg: string } | null>(null);
  const [isSaving,    setIsSaving]    = useState(false);

  useEffect(() => {
    getMyProfile()
      .then(setProfile)
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setPwdStatus(null);
    if (!newPwd || !currPwd) {
      setPwdStatus({ ok: false, msg: "All fields are required." });
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdStatus({ ok: false, msg: "New password and confirmation do not match." });
      return;
    }
    if (newPwd.length < 6) {
      setPwdStatus({ ok: false, msg: "New password must be at least 6 characters." });
      return;
    }
    setIsSaving(true);
    try {
      await changePassword(currPwd, newPwd);
      setPwdStatus({ ok: true, msg: "Password changed successfully." });
      setCurrPwd(""); setNewPwd(""); setConfirmPwd("");
    } catch (err: any) {
      setPwdStatus({ ok: false, msg: err?.message ?? "Failed to change password. Check your current password." });
    } finally {
      setIsSaving(false);
    }
  }

  const uri = profile ? avatarUri(profile) : null;

  return (
    <div style={{ maxWidth: 520, margin: "0 auto" }}>

      {/* Header row with back button when in a sub-section */}
      {section !== "menu" && (
        <button onClick={() => { setSection("menu"); setPwdStatus(null); }} style={backBtn}>
          ← Back
        </button>
      )}

      <h2 style={{ color: "#062B59", fontSize: 18, fontWeight: 900, marginBottom: 16 }}>
        {section === "menu"     ? "Settings"         :
         section === "profile"  ? "My Profile"       :
                                  "Change Password"}
      </h2>

      {/* ── Profile card (always visible in menu) ─────────────────────────── */}
      {section === "menu" && (
        <div style={profileCard}>
          {uri ? (
            <img src={uri} alt="avatar"
              style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover" }} />
          ) : (
            <div style={avatarPlaceholder}>
              {isLoading ? "…" : (profile ? initials(profile) : (user.displayName?.[0] ?? "?"))}
            </div>
          )}
          <div>
            <p style={{ color: "#062B59", fontSize: 16, fontWeight: 800, margin: 0 }}>
              {isLoading ? "Loading…" : (profile ? `${profile.firstName} ${profile.lastName}` : user.displayName)}
            </p>
            <p style={{ color: "#64748B", fontSize: 12, margin: "2px 0 0" }}>
              {isLoading ? "" : (profile?.user.email ?? "")}
            </p>
          </div>
        </div>
      )}

      {/* ── MENU ──────────────────────────────────────────────────────────── */}
      {section === "menu" && (
        <div style={menuCard}>
          <MenuRow
            icon={<User size={16} color="#1680D8" />}
            label="My Profile"
            onPress={() => setSection("profile")}
          />
          <div style={{ height: 1, background: "#EDF3F8" }} />
          <MenuRow
            icon={<Lock size={16} color="#1680D8" />}
            label="Change Password"
            onPress={() => setSection("password")}
          />
        </div>
      )}

      {/* ── PROFILE ───────────────────────────────────────────────────────── */}
      {section === "profile" && (
        <div>
          {isLoading && <p style={{ color: "#64748B", textAlign: "center", padding: 32 }}>Loading…</p>}
          {!isLoading && !profile && (
            <p style={{ color: "#EF4444", textAlign: "center", padding: 32 }}>Could not load profile.</p>
          )}
          {profile && (
            <>
              {/* Avatar */}
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
                {uri ? (
                  <img src={uri} alt="avatar"
                    style={{ width: 90, height: 90, borderRadius: "50%", objectFit: "cover", border: "3px solid #1680D8" }} />
                ) : (
                  <div style={{ ...avatarPlaceholder, width: 90, height: 90, fontSize: 30 }}>
                    {initials(profile)}
                  </div>
                )}
              </div>

              {/* Detail rows */}
              <div style={detailCard}>
                {[
                  ["First Name",   profile.firstName],
                  ["Last Name",    profile.lastName],
                  ["Email",        profile.user.email],
                  ["Contact",      profile.contactNumber ?? "—"],
                  ["Department",   profile.department.name],
                  ["Position",     profile.position.title],
                ].map(([label, value]) => (
                  <div key={label} style={detailRow}>
                    <span style={{ color: "#94A3B8", fontSize: 11, fontWeight: 600 }}>{label}</span>
                    <span style={{ color: "#062B59", fontSize: 14, fontWeight: 600 }}>{value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── CHANGE PASSWORD ───────────────────────────────────────────────── */}
      {section === "password" && (
        <form onSubmit={handleChangePassword}>
          <div style={formCard}>
            <PwdField
              label="Current Password"
              value={currPwd}
              onChange={setCurrPwd}
              show={showCurr}
              onToggle={() => setShowCurr((v) => !v)}
            />
            <div style={{ height: 1, background: "#EDF3F8" }} />
            <PwdField
              label="New Password"
              value={newPwd}
              onChange={setNewPwd}
              show={showNew}
              onToggle={() => setShowNew((v) => !v)}
            />
            <div style={{ height: 1, background: "#EDF3F8" }} />
            <PwdField
              label="Confirm New Password"
              value={confirmPwd}
              onChange={setConfirmPwd}
              show={showConfirm}
              onToggle={() => setShowConfirm((v) => !v)}
            />
          </div>

          {pwdStatus && (
            <p style={{
              fontSize: 13, fontWeight: 600, textAlign: "center",
              color: pwdStatus.ok ? "#17A34A" : "#DC2626",
              marginBottom: 12,
            }}>
              {pwdStatus.msg}
            </p>
          )}

          <button
            type="submit"
            disabled={isSaving}
            style={{
              display: "block", width: "100%", height: 48,
              borderRadius: 14, border: "none",
              background: isSaving ? "#94A3B8" : "#1680D8",
              color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
            }}
          >
            {isSaving ? "Saving…" : "Change Password"}
          </button>
        </form>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function MenuRow({ icon, label, onPress }: { icon: ReactNode; label: string; onPress: () => void }) {
  return (
    <button onClick={onPress} style={menuRow}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center",
        width: 34, height: 34, background: "#EFF6FF", borderRadius: 10 }}>
        {icon}
      </span>
      <span style={{ flex: 1, color: "#062B59", fontSize: 14, fontWeight: 600 }}>{label}</span>
      <ChevronRight size={16} color="#94A3B8" />
    </button>
  );
}

function PwdField({
  label, value, onChange, show, onToggle,
}: {
  label: string; value: string;
  onChange: (v: string) => void;
  show: boolean; onToggle: () => void;
}) {
  return (
    <div style={{ padding: "10px 14px" }}>
      <p style={{ color: "#94A3B8", fontSize: 11, fontWeight: 600, margin: "0 0 5px" }}>{label}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          style={{
            flex: 1, border: "none", outline: "none",
            fontSize: 14, color: "#062B59", background: "transparent",
          }}
        />
        <button type="button" onClick={onToggle}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex" }}>
          {show ? <EyeOff size={16} color="#94A3B8" /> : <Eye size={16} color="#94A3B8" />}
        </button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const backBtn: CSSProperties = {
  background: "none", border: "none", cursor: "pointer",
  color: "#1680D8", fontSize: 14, fontWeight: 700,
  padding: 0, marginBottom: 12,
};
const profileCard: CSSProperties = {
  display: "flex", alignItems: "center", gap: 14,
  background: "#EFF6FF", borderRadius: 16, padding: "14px 16px", marginBottom: 20,
};
const avatarPlaceholder: CSSProperties = {
  width: 56, height: 56, borderRadius: "50%",
  background: "#1680D8", color: "#fff",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: 20, fontWeight: 800, flexShrink: 0,
};
const menuCard: CSSProperties = {
  background: "#fff", border: "1px solid #DBE5EF",
  borderRadius: 16, overflow: "hidden",
};
const menuRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 12,
  width: "100%", padding: "12px 16px",
  background: "none", border: "none", cursor: "pointer",
  textAlign: "left",
};
const detailCard: CSSProperties = {
  background: "#fff", border: "1px solid #DBE5EF",
  borderRadius: 16, overflow: "hidden",
};
const detailRow: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 2,
  padding: "10px 16px", borderBottom: "1px solid #EDF3F8",
};
const formCard: CSSProperties = {
  background: "#fff", border: "1px solid #DBE5EF",
  borderRadius: 16, overflow: "hidden", marginBottom: 16,
};
