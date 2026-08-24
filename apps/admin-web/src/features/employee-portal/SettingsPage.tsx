import { CSSProperties, FormEvent, ReactNode, useRef, useState } from "react";
import {
  ArrowLeft, Briefcase, Building2, Camera, ChevronRight,
  Eye, EyeOff, Lock, Mail, Phone, User,
} from "lucide-react";
import { EmployeeProfile, getMyProfile, changePassword, updateMyPhoto } from "./api";
import { AuthUser, updateDefaultView } from "../../lib/api";
import { CACHE_KEYS, useCachedData } from "../../lib/dataCache";
import "./EmployeePortal.css";

type Props   = { user: AuthUser; onDefaultViewChange: (view: "ADMIN" | "EMPLOYEE") => void };
type Section = "menu" | "profile" | "password";

// ── Design tokens ────────────────────────────────────────────────────────────
// Matched to the reference mock: deep navy headings/icons/button, soft gray
// labels, hairline borders, no bright accent color.
const COLORS = {
  navy:         "#0a1f44", // titles, back arrow, row icons, primary button
  navyText:     "#0a1f44", // bold values
  labelGray:    "#94a3b8", // row labels, field-less captions
  subtitleGray: "#64748b", // subtitle / footnote text
  border:       "#dbe5ef", // card + input borders
  divider:      "#eef2f6", // row separators
  success:      "#17A34A",
  error:        "#DC2626",
  disabled:     "#94a3b8",
  white:        "#FFFFFF",
} as const;

function avatarUri(p: EmployeeProfile) {
  if (!p.profilePhotoData) return null;
  return `data:${p.profilePhotoMimeType ?? "image/jpeg"};base64,${p.profilePhotoData}`;
}

export function SettingsPage({ user, onDefaultViewChange }: Props) {
  // Same cache key as AttendancePage, so a photo change here is reflected
  // there instantly on the next visit without a refetch.
  const { data: profile, isLoading, setData: setProfile } = useCachedData<EmployeeProfile>(
    CACHE_KEYS.myProfile,
    getMyProfile,
  );
  const [section,   setSection]   = useState<Section>("menu");

  // default view preference (multi-role accounts only)
  const [defaultView, setDefaultView] = useState(user.defaultView);
  const [dvStatus,    setDvStatus]    = useState<{ ok: boolean; msg: string } | null>(null);
  const [dvSaving,    setDvSaving]    = useState(false);

  // password form state
  const [currPwd,     setCurrPwd]     = useState("");
  const [newPwd,      setNewPwd]      = useState("");
  const [confirmPwd,  setConfirmPwd]  = useState("");
  const [showCurr,    setShowCurr]    = useState(false);
  const [showNew,     setShowNew]     = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwdStatus,   setPwdStatus]   = useState<{ ok: boolean; msg: string } | null>(null);
  const [isSaving,    setIsSaving]    = useState(false);

  // photo upload state
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoStatus, setPhotoStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);

  const [hoveredRow, setHoveredRow] = useState<"profile" | "password" | null>(null);
  const [backHover, setBackHover] = useState(false);

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setPhotoStatus({ ok: false, msg: "Photo must be under 5 MB." });
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      const mimeType = dataUrl.match(/data:([^;]+)/)?.[1] ?? "image/jpeg";
      const base64 = dataUrl.split(",")[1];
      setIsUploadingPhoto(true);
      setPhotoStatus(null);
      try {
        const updated = await updateMyPhoto(base64, mimeType);
        setProfile(updated);
        setPhotoStatus({ ok: true, msg: "Photo updated successfully." });
      } catch {
        setPhotoStatus({ ok: false, msg: "Failed to upload photo. Please try again." });
      } finally {
        setIsUploadingPhoto(false);
        e.target.value = "";
      }
    };
    reader.readAsDataURL(file);
  }

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

  async function handleSetDefaultView(view: "ADMIN" | "EMPLOYEE") {
    setDvSaving(true);
    setDvStatus(null);
    try {
      await updateDefaultView(user.id, view);
      setDefaultView(view);
      onDefaultViewChange(view);
      setDvStatus({ ok: true, msg: "Default view updated." });
    } catch (err: any) {
      setDvStatus({ ok: false, msg: err?.message ?? "Failed to update default view." });
    } finally {
      setDvSaving(false);
    }
  }

  const uri = profile ? avatarUri(profile) : null;

  return (
    <div className="emp-form-page">

      {section !== "menu" && (
        <button
          onClick={() => { setSection("menu"); setPwdStatus(null); setPhotoStatus(null); }}
          onMouseEnter={() => setBackHover(true)}
          onMouseLeave={() => setBackHover(false)}
          style={{ ...backBtn, opacity: backHover ? 0.6 : 1 }}
          aria-label="Back"
        >
          <ArrowLeft size={24} color={COLORS.navy} strokeWidth={2.25} />
        </button>
      )}

      <h2 style={pageTitle}>
        {section === "menu"     ? "Settings"         :
         section === "profile"  ? "My Profile"       :
                                  "Change Password"}
      </h2>

      {section === "password" && (
        <p style={pageSubtitle}>Enter your current password and change a new one.</p>
      )}

      {/* ── Profile summary card (menu view) ────────────────────────────── */}
      {section === "menu" && (
        <div style={profileCard}>
          {uri ? (
            <img src={uri} alt="avatar" style={avatarImg(56)} />
          ) : (
            <div style={avatarPlaceholder(56)}>
              <User size={22} color={COLORS.white} strokeWidth={1.75} />
            </div>
          )}
          <div>
            <p style={profileName}>
              {isLoading ? "Loading…" : (profile ? `${profile.firstName} ${profile.lastName}` : user.displayName)}
            </p>
            <p style={profileEmail}>
              {isLoading ? "" : (profile?.user.email ?? "")}
            </p>
          </div>
        </div>
      )}

      {/* ── MENU ─────────────────────────────────────────────────────────── */}
      {section === "menu" && (
        <div style={menuCard}>
          <MenuRow
            icon={<User size={18} color={COLORS.navy} strokeWidth={1.9} />}
            label="My Profile"
            hovered={hoveredRow === "profile"}
            onHover={(v) => setHoveredRow(v ? "profile" : null)}
            onPress={() => setSection("profile")}
          />
          <div style={dividerLine} />
          <MenuRow
            icon={<Lock size={18} color={COLORS.navy} strokeWidth={1.9} />}
            label="Change Password"
            hovered={hoveredRow === "password"}
            onHover={(v) => setHoveredRow(v ? "password" : null)}
            onPress={() => setSection("password")}
          />
          {user.roles.length > 1 && (
            <>
              <div style={dividerLine} />
              <div style={{ padding: "14px 16px" }}>
                <p style={defaultViewLabel}>Default view after login</p>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => handleSetDefaultView("ADMIN")}
                    disabled={dvSaving}
                    style={segmentBtn(defaultView === "ADMIN")}
                  >
                    Admin dashboard
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetDefaultView("EMPLOYEE")}
                    disabled={dvSaving}
                    style={segmentBtn(defaultView === "EMPLOYEE")}
                  >
                    My attendance
                  </button>
                </div>
                {dvStatus && (
                  <p style={{ ...statusText, marginTop: 8, color: dvStatus.ok ? COLORS.success : COLORS.error }}>
                    {dvStatus.msg}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── PROFILE ──────────────────────────────────────────────────────── */}
      {section === "profile" && (
        <div>
          {isLoading && <p style={centerNote}>Loading…</p>}
          {!isLoading && !profile && (
            <p style={{ ...centerNote, color: COLORS.error }}>Could not load profile.</p>
          )}
          {profile && (
            <>
              <div style={avatarBlock}>
                <div style={{ position: "relative", display: "inline-block" }}>
                  {uri ? (
                    <img src={uri} alt="avatar" style={avatarImg(96)} />
                  ) : (
                    <div style={avatarPlaceholder(96)}>
                      <User size={38} color={COLORS.white} strokeWidth={1.75} />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => photoInputRef.current?.click()}
                    disabled={isUploadingPhoto}
                    title="Change profile photo"
                    style={cameraBtn(isUploadingPhoto)}
                  >
                    <Camera size={13} color={COLORS.white} />
                  </button>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={handlePhotoChange}
                  />
                </div>
                {photoStatus && (
                  <p style={{ ...statusText, color: photoStatus.ok ? COLORS.success : COLORS.error }}>
                    {photoStatus.msg}
                  </p>
                )}
                {isUploadingPhoto && (
                  <p style={{ fontSize: 12, color: COLORS.subtitleGray, margin: 0 }}>Uploading…</p>
                )}
              </div>

              <div style={detailCard}>
                {[
                  [<User key="i" size={20} color={COLORS.navy} strokeWidth={1.75} />, "Full Name",      `${profile.firstName} ${profile.lastName}`],
                  [<Mail key="i" size={20} color={COLORS.navy} strokeWidth={1.75} />, "Email Address",  profile.user.email],
                  [<Phone key="i" size={20} color={COLORS.navy} strokeWidth={1.75} />, "Contact Number", profile.contactNumber ?? "Not provided"],
                  [<Building2 key="i" size={20} color={COLORS.navy} strokeWidth={1.75} />, "Department", profile.department.name],
                  [<Briefcase key="i" size={20} color={COLORS.navy} strokeWidth={1.75} />, "Position",   profile.position.title],
                ].map(([icon, label, value], i, arr) => (
                  <div key={label as string} style={i === arr.length - 1 ? { ...detailRow, borderBottom: "none" } : detailRow}>
                    <span style={detailIconWrap}>{icon}</span>
                    <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={detailLabel}>{label}</span>
                      <span style={detailValue}>{value}</span>
                    </span>
                  </div>
                ))}
              </div>

              <p style={footerNote}>
                Profile information is managed by HR. Contact HR/Admin if any details need to be updated.
              </p>
            </>
          )}
        </div>
      )}

      {/* ── CHANGE PASSWORD ─────────────────────────────────────────────── */}
      {section === "password" && (
        <form onSubmit={handleChangePassword}>
          <PwdField
            label="Current Password"
            value={currPwd}
            onChange={setCurrPwd}
            show={showCurr}
            onToggle={() => setShowCurr((v) => !v)}
          />
          <PwdField
            label="New Password"
            value={newPwd}
            onChange={setNewPwd}
            show={showNew}
            onToggle={() => setShowNew((v) => !v)}
          />
          <PwdField
            label="Confirm New Password"
            value={confirmPwd}
            onChange={setConfirmPwd}
            show={showConfirm}
            onToggle={() => setShowConfirm((v) => !v)}
          />

          {pwdStatus && (
            <p style={{
              ...statusText,
              textAlign: "center",
              marginBottom: 16,
              color: pwdStatus.ok ? COLORS.success : COLORS.error,
            }}>
              {pwdStatus.msg}
            </p>
          )}

          <button type="submit" disabled={isSaving} style={submitBtn(isSaving)}>
            {isSaving ? "Saving…" : "Update Password"}
          </button>
        </form>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function MenuRow({
  icon, label, onPress, hovered, onHover,
}: {
  icon: ReactNode; label: string; onPress: () => void;
  hovered: boolean; onHover: (v: boolean) => void;
}) {
  return (
    <button
      onClick={onPress}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{ ...menuRow, background: hovered ? COLORS.divider : "transparent" }}
    >
      <span style={iconChip}>{icon}</span>
      <span style={menuRowLabel}>{label}</span>
      <ChevronRight size={16} color={COLORS.labelGray} />
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
    <div style={pwdFieldWrap}>
      <p style={pwdFieldLabel}>{label}</p>
      <div style={pwdInputBox}>
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          style={pwdInput}
        />
        <button type="button" onClick={onToggle} style={eyeBtn} aria-label="Toggle visibility">
          {show ? <EyeOff size={17} color={COLORS.labelGray} /> : <Eye size={17} color={COLORS.labelGray} />}
        </button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const pageTitle: CSSProperties = {
  color: COLORS.navy, fontSize: 26, fontWeight: 800, margin: "0 0 4px", letterSpacing: -0.3,
};

const pageSubtitle: CSSProperties = {
  color: COLORS.subtitleGray, fontSize: 14, margin: "0 0 28px",
};

const backBtn: CSSProperties = {
  background: "none", border: "none", cursor: "pointer",
  padding: 0, marginBottom: 18, display: "flex",
  transition: "opacity 0.15s ease",
};

const profileCard: CSSProperties = {
  display: "flex", alignItems: "center", gap: 14,
  background: COLORS.white, border: `1px solid ${COLORS.border}`,
  borderRadius: 18, padding: "14px 16px", marginBottom: 20,
};

const profileName: CSSProperties = { color: COLORS.navy, fontSize: 16, fontWeight: 800, margin: 0 };
const profileEmail: CSSProperties = { color: COLORS.subtitleGray, fontSize: 12, margin: "2px 0 0" };

function avatarImg(size: number): CSSProperties {
  return { width: size, height: size, borderRadius: "50%", objectFit: "cover", display: "block" };
}

function avatarPlaceholder(size: number): CSSProperties {
  return {
    width: size, height: size, borderRadius: "50%",
    background: COLORS.navy,
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  };
}

function cameraBtn(disabled: boolean): CSSProperties {
  return {
    position: "absolute", bottom: 2, right: 2,
    width: 30, height: 30, borderRadius: "50%",
    background: disabled ? COLORS.disabled : COLORS.navy,
    border: `2px solid ${COLORS.white}`,
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: "0 1px 4px rgba(10,31,68,0.25)",
    transition: "background 0.15s ease",
  };
}

const avatarBlock: CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 24, gap: 8,
};

const statusText: CSSProperties = { fontSize: 12, fontWeight: 600, margin: 0 };
const centerNote: CSSProperties = { color: COLORS.subtitleGray, textAlign: "center", padding: 32 };

const menuCard: CSSProperties = {
  background: COLORS.white, border: `1px solid ${COLORS.border}`,
  borderRadius: 18, overflow: "hidden",
};

const menuRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 12,
  width: "100%", padding: "14px 16px",
  border: "none", cursor: "pointer",
  textAlign: "left",
  transition: "background 0.15s ease",
};

const menuRowLabel: CSSProperties = { flex: 1, color: COLORS.navy, fontSize: 14, fontWeight: 600 };

const defaultViewLabel: CSSProperties = { margin: 0, color: COLORS.navy, fontSize: 14, fontWeight: 600 };

function segmentBtn(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: "10px 12px",
    borderRadius: 12,
    border: `1.5px solid ${active ? COLORS.navy : COLORS.border}`,
    background: active ? COLORS.navy : COLORS.white,
    color: active ? COLORS.white : COLORS.navy,
    fontSize: 13,
    fontWeight: 650,
    cursor: "pointer",
    transition: "background 0.15s ease, border-color 0.15s ease",
  };
}

const iconChip: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 34, height: 34, background: COLORS.divider, borderRadius: 10,
};

const dividerLine: CSSProperties = { height: 1, background: COLORS.divider };

const detailCard: CSSProperties = {
  background: COLORS.white, border: `1px solid ${COLORS.border}`,
  borderRadius: 20, overflow: "hidden", marginBottom: 16,
};

const detailRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 16,
  padding: "18px 20px", borderBottom: `1px solid ${COLORS.divider}`,
};

const detailIconWrap: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};

const detailLabel: CSSProperties = { color: COLORS.labelGray, fontSize: 13, fontWeight: 500 };
const detailValue: CSSProperties = { color: COLORS.navy, fontSize: 17, fontWeight: 700 };

const footerNote: CSSProperties = {
  color: COLORS.labelGray, fontSize: 13, textAlign: "center",
  lineHeight: 1.5, margin: "20px 12px 0",
};

const pwdFieldWrap: CSSProperties = { marginBottom: 26 };

const pwdFieldLabel: CSSProperties = {
  color: COLORS.navy, fontSize: 16, fontWeight: 700, margin: "0 0 10px",
};

const pwdInputBox: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  background: COLORS.white, border: `1.5px solid ${COLORS.border}`,
  borderRadius: 16, padding: "14px 18px",
};

const pwdInput: CSSProperties = {
  flex: 1, border: "none", outline: "none",
  fontSize: 15, color: COLORS.navy, background: "transparent",
};

const eyeBtn: CSSProperties = {
  background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex",
};

function submitBtn(saving: boolean): CSSProperties {
  return {
    display: "block", width: "100%", height: 56,
    borderRadius: 18, border: "none",
    background: saving ? COLORS.disabled : COLORS.navy,
    color: COLORS.white, fontSize: 16, fontWeight: 700,
    cursor: saving ? "not-allowed" : "pointer",
    marginTop: 8,
    transition: "background 0.15s ease",
  };
}