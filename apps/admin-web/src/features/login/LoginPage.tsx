import { FormEvent, useState } from "react";
import {
  FiMail,
  FiLock,
  FiEye,
  FiEyeOff,
  FiArrowLeft,
  FiKey,
} from "react-icons/fi";
import { AuthUser, forgotPassword, login, resetPassword, verifyResetOtp } from "../../lib/api";
import logo from "../../assets/unileaf-logo.png";
import "./LoginPage.css";

type View = "login" | "forgot-email" | "forgot-otp" | "forgot-new-password";

export function LoginPage({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [view, setView] = useState<View>("login");

  // login
  const [email,       setEmail]       = useState("");
  const [password,    setPassword]    = useState("");
  const [showPwd,     setShowPwd]     = useState(false);
  const [loginError,  setLoginError]  = useState("");
  const [submitting,  setSubmitting]  = useState(false);

  // forgot flow
  const [fpEmail,     setFpEmail]     = useState("");
  const [otp,         setOtp]         = useState("");
  const [resetToken,  setResetToken]  = useState("");
  const [newPwd,      setNewPwd]      = useState("");
  const [confirmPwd,  setConfirmPwd]  = useState("");
  const [showNewPwd,  setShowNewPwd]  = useState(false);
  const [fpError,     setFpError]     = useState("");
  const [fpSuccess,   setFpSuccess]   = useState("");
  const [fpLoading,   setFpLoading]   = useState(false);

  // ── Login ──────────────────────────────────────────────────────────────────
  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoginError("");
    setSubmitting(true);
    try {
      onLogin(await login(email, password));
    } catch {
      setLoginError("Invalid email or password.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Forgot: send OTP ──────────────────────────────────────────────────────
  async function handleSendOtp(e: FormEvent) {
    e.preventDefault();
    setFpError("");
    setFpLoading(true);
    try {
      await forgotPassword(fpEmail.trim());
      setView("forgot-otp");
    } catch (err: any) {
      setFpError(err?.message ?? "Could not send reset code. Check the email and try again.");
    } finally {
      setFpLoading(false);
    }
  }

  // ── Forgot: verify OTP ───────────────────────────────────────────────────
  async function handleVerifyOtp(e: FormEvent) {
    e.preventDefault();
    setFpError("");
    setFpLoading(true);
    try {
      const data = await verifyResetOtp(fpEmail.trim(), otp.trim());
      setResetToken(data.resetToken);
      setView("forgot-new-password");
    } catch (err: any) {
      setFpError(err?.message ?? "Invalid or expired code. Please try again.");
    } finally {
      setFpLoading(false);
    }
  }

  // ── Forgot: set new password ──────────────────────────────────────────────
  async function handleResetPassword(e: FormEvent) {
    e.preventDefault();
    setFpError("");
    if (newPwd !== confirmPwd) { setFpError("Passwords do not match."); return; }
    if (newPwd.length < 6)     { setFpError("Password must be at least 6 characters."); return; }
    setFpLoading(true);
    try {
      await resetPassword(resetToken, newPwd);
      setFpSuccess("Password reset successfully. You can now log in.");
      // pre-fill the email on the login form
      setEmail(fpEmail);
      setTimeout(() => {
        setFpSuccess("");
        setFpEmail(""); setOtp(""); setResetToken(""); setNewPwd(""); setConfirmPwd("");
        setView("login");
      }, 1800);
    } catch (err: any) {
      setFpError(err?.message ?? "Failed to reset password. Please start over.");
    } finally {
      setFpLoading(false);
    }
  }

  function backToLogin() {
    setFpEmail(""); setOtp(""); setResetToken(""); setNewPwd(""); setConfirmPwd("");
    setFpError(""); setFpSuccess("");
    setView("login");
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-header">
          <div className="logo-wrapper">
            <img src={logo} alt="Universal Leaf Philippines" className="login-logo" />
          </div>

          {view === "login" && (
            <>
              <h1>Log In</h1>
              <p className="login-subtitle">Attendance &amp; Leave Management System</p>
            </>
          )}
          {view === "forgot-email" && (
            <>
              <h1>Forgot Password</h1>
              <p className="login-subtitle">Enter your email to receive a reset code.</p>
            </>
          )}
          {view === "forgot-otp" && (
            <>
              <h1>Enter Code</h1>
              <p className="login-subtitle">A 6-digit code was sent to <strong>{fpEmail}</strong>.</p>
            </>
          )}
          {view === "forgot-new-password" && (
            <>
              <h1>New Password</h1>
              <p className="login-subtitle">Choose a new password for your account.</p>
            </>
          )}
        </div>

        {/* ── LOGIN FORM ─────────────────────────────────────────────────── */}
        {view === "login" && (
          <form className="login-form" onSubmit={handleLogin}>
            <div className="input-group">
              <label htmlFor="email">Email Address</label>
              <div className="input-wrapper">
                <FiMail className="input-icon" />
                <input
                  id="email" type="email" placeholder="Enter your email address"
                  value={email} onChange={(e) => setEmail(e.target.value)} required
                />
              </div>
            </div>

            <div className="input-group">
              <label htmlFor="password">Password</label>
              <div className="password-wrapper">
                <FiLock className="input-icon" />
                <input
                  id="password" type={showPwd ? "text" : "password"}
                  placeholder="Enter your password"
                  value={password} onChange={(e) => setPassword(e.target.value)} required
                />
                <span className="toggle-password" onClick={() => setShowPwd((v) => !v)}>
                  {showPwd ? <FiEyeOff /> : <FiEye />}
                </span>
              </div>
            </div>

            {loginError && <p className="form-error">{loginError}</p>}

            <button type="submit" className="signin-btn" disabled={submitting}>
              {submitting ? "Logging In…" : "Log In"}
            </button>

            <p className="forgot-password" onClick={() => { setFpEmail(email); setView("forgot-email"); }}>
              Forgot your password?
            </p>
          </form>
        )}

        {/* ── FORGOT: EMAIL ──────────────────────────────────────────────── */}
        {view === "forgot-email" && (
          <form className="login-form" onSubmit={handleSendOtp}>
            <div className="input-group">
              <label htmlFor="fp-email">Email Address</label>
              <div className="input-wrapper">
                <FiMail className="input-icon" />
                <input
                  id="fp-email" type="email" placeholder="Enter your email address"
                  value={fpEmail} onChange={(e) => setFpEmail(e.target.value)} required autoFocus
                />
              </div>
            </div>

            {fpError && <p className="form-error">{fpError}</p>}

            <button type="submit" className="signin-btn" disabled={fpLoading}>
              {fpLoading ? "Sending…" : "Send Reset Code"}
            </button>

            <p className="forgot-password" onClick={backToLogin}>
              <FiArrowLeft style={{ verticalAlign: "middle", marginRight: 4 }} />
              Back to Log In
            </p>
          </form>
        )}

        {/* ── FORGOT: OTP ────────────────────────────────────────────────── */}
        {view === "forgot-otp" && (
          <form className="login-form" onSubmit={handleVerifyOtp}>
            <div className="input-group">
              <label htmlFor="otp">6-Digit Code</label>
              <div className="input-wrapper">
                <FiKey className="input-icon" />
                <input
                  id="otp" type="text" inputMode="numeric" placeholder="Enter the code"
                  value={otp} onChange={(e) => setOtp(e.target.value)}
                  maxLength={6} required autoFocus
                />
              </div>
            </div>

            {fpError && <p className="form-error">{fpError}</p>}

            <button type="submit" className="signin-btn" disabled={fpLoading}>
              {fpLoading ? "Verifying…" : "Verify Code"}
            </button>

            <p className="forgot-password" onClick={() => { setOtp(""); setFpError(""); setView("forgot-email"); }}>
              <FiArrowLeft style={{ verticalAlign: "middle", marginRight: 4 }} />
              Re-enter email
            </p>
          </form>
        )}

        {/* ── FORGOT: NEW PASSWORD ───────────────────────────────────────── */}
        {view === "forgot-new-password" && (
          <form className="login-form" onSubmit={handleResetPassword}>
            <div className="input-group">
              <label htmlFor="new-pwd">New Password</label>
              <div className="password-wrapper">
                <FiLock className="input-icon" />
                <input
                  id="new-pwd" type={showNewPwd ? "text" : "password"}
                  placeholder="At least 6 characters"
                  value={newPwd} onChange={(e) => setNewPwd(e.target.value)} required autoFocus
                />
                <span className="toggle-password" onClick={() => setShowNewPwd((v) => !v)}>
                  {showNewPwd ? <FiEyeOff /> : <FiEye />}
                </span>
              </div>
            </div>

            <div className="input-group">
              <label htmlFor="confirm-pwd">Confirm New Password</label>
              <div className="password-wrapper">
                <FiLock className="input-icon" />
                <input
                  id="confirm-pwd" type={showNewPwd ? "text" : "password"}
                  placeholder="Repeat your new password"
                  value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} required
                />
              </div>
            </div>

            {fpError   && <p className="form-error">{fpError}</p>}
            {fpSuccess  && <p className="form-success">{fpSuccess}</p>}

            <button type="submit" className="signin-btn" disabled={fpLoading || Boolean(fpSuccess)}>
              {fpLoading ? "Saving…" : "Save New Password"}
            </button>

            <p className="forgot-password" onClick={backToLogin}>
              <FiArrowLeft style={{ verticalAlign: "middle", marginRight: 4 }} />
              Back to Log In
            </p>
          </form>
        )}
      </section>
    </main>
  );
}
