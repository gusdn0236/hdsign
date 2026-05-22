import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { clientLoginApi } from '../../api/client';
import { loginApi } from '../../api/auth';
import { isDemoToken } from '../../utils/demoGuard';
import './ClientLogin.css';

const REMEMBER_KEY = 'clientLoginUsername';

export default function ClientLogin() {
    const { clientUser, clientLogin, login } = useAuth();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [rememberMe, setRememberMe] = useState(true);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const saved = localStorage.getItem(REMEMBER_KEY);
        if (saved) setUsername(saved);
    }, []);

    if (clientUser) return <Navigate to="/client/request" replace />;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        try {
            const data = await clientLoginApi(username.trim(), password);
            if (rememberMe) {
                localStorage.setItem(REMEMBER_KEY, username.trim());
            } else {
                localStorage.removeItem(REMEMBER_KEY);
            }
            // 데모 계정이면 관리자 세션도 함께 연다 — 데모 하나로 거래처·관리자 양쪽 둘러보기.
            // 관리자 토큰을 먼저 확보한 뒤 마지막에 clientLogin 을 호출해, 화면 이동 시점에
            // 양쪽 토큰이 모두 준비돼 있게 한다.
            if (isDemoToken(data.token)) {
                try {
                    const adminData = await loginApi(username.trim(), password);
                    login(adminData.token);
                } catch { /* 관리자 데모 계정이 없으면 거래처만 로그인 */ }
            }
            clientLogin(data.token, {
                companyName: data.companyName,
                contactName: data.contactName,
                username: data.username,
            });
        } catch (err) {
            setError(err.message || '로그인에 실패했습니다.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="client-login-page">
            <div className="client-login-card">
                <div className="client-login-logo">
                    <h1>거래처 로그인</h1>
                    <p>HD Sign 거래처 전용 포털입니다</p>
                </div>

                <form className="client-login-form" onSubmit={handleSubmit}>
                    {error && <div className="login-error">{error}</div>}
                    <div className="form-group">
                        <label htmlFor="username">아이디</label>
                        <input
                            id="username"
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="아이디 입력"
                            autoComplete="username"
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="password">비밀번호</label>
                        <input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="비밀번호 입력"
                            autoComplete="current-password"
                            required
                        />
                    </div>
                    <label className="remember-email">
                        <input
                            type="checkbox"
                            checked={rememberMe}
                            onChange={(e) => setRememberMe(e.target.checked)}
                        />
                        아이디 기억하기
                    </label>
                    <button type="submit" className="login-btn" disabled={loading}>
                        {loading ? '로그인 중...' : '로그인'}
                    </button>
                </form>

                <Link to="/client/signup" className="signup-link">처음이세요? 회원가입 →</Link>
                <Link to="/" className="back-link">← 메인 사이트로 돌아가기</Link>
            </div>
        </div>
    );
}
