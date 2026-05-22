import { useState } from "react";
import { Navigate, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { loginApi } from "../../api/auth";
import { clientLoginApi } from "../../api/client";
import { isDemoToken } from "../../utils/demoGuard";
import "./AdminLogin.css";

export default function AdminLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login, isAdmin, clientLogin } = useAuth();
  const navigate = useNavigate();

  if (isAdmin) {
    return <Navigate to="/admin/orders" replace />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { token } = await loginApi(username, password);
      // 데모 계정이면 거래처 세션도 함께 연다 — 데모 하나로 관리자·거래처 양쪽 둘러보기.
      if (isDemoToken(token)) {
        try {
          const clientData = await clientLoginApi(username, password);
          clientLogin(clientData.token, {
            companyName: clientData.companyName,
            contactName: clientData.contactName,
            username: clientData.username,
          });
        } catch { /* 거래처 데모 계정이 없으면 관리자만 로그인 */ }
      }
      login(token);
      navigate("/admin/orders");
    } catch (err) {
      setError(err.message || "로그인에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <div className="admin-login-logo">
          <h1>관리자 로그인</h1>
          <p>HD Sign 관리자 전용 페이지입니다</p>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}
          <div className="form-group">
            <label htmlFor="username">아이디</label>
            <input id="username" type="text" value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="관리자 아이디" autoComplete="username" required />
          </div>
          <div className="form-group">
            <label htmlFor="password">비밀번호</label>
            <input id="password" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호" autoComplete="current-password" required />
          </div>
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? "로그인 중..." : "로그인"}
          </button>
        </form>
        <Link to="/" className="back-link">← 메인 사이트로 돌아가기</Link>
      </div>
    </div>
  );
}
