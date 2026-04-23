import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { registerClientApi, sendMagicLinkApi } from '../../api/client';
import './ClientLogin.css';

const MODE_LOGIN = 'login';
const MODE_REGISTER = 'register';
const REMEMBER_KEY = 'clientLoginEmail';

function getMailboxUrl(email) {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (domain === 'gmail.com') return 'https://mail.google.com';
    if (domain === 'naver.com') return 'https://mail.naver.com';
    if (domain === 'daum.net' || domain === 'kakao.com') return 'https://mail.daum.net';
    if (domain === 'hanmail.net') return 'https://mail.daum.net';
    if (domain === 'nate.com') return 'https://mail.nate.com';
    if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com') return 'https://outlook.live.com';
    if (domain === 'yahoo.com') return 'https://mail.yahoo.com';
    return null;
}

export default function ClientLogin() {
    const { clientUser } = useAuth();
    const [mode, setMode] = useState(MODE_LOGIN);
    const [email, setEmail] = useState('');
    const [companyName, setCompanyName] = useState('');
    const [contactName, setContactName] = useState('');
    const [phone, setPhone] = useState('');
    const [rememberEmail, setRememberEmail] = useState(true);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [sent, setSent] = useState(false);
    const [submittedEmail, setSubmittedEmail] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [successStatus, setSuccessStatus] = useState('');

    useEffect(() => {
        const remembered = localStorage.getItem(REMEMBER_KEY);
        if (remembered) {
            setEmail(remembered);
            setRememberEmail(true);
        }
    }, []);

    if (clientUser) return <Navigate to="/client/request" replace />;

    const mailboxUrl = useMemo(() => getMailboxUrl(submittedEmail), [submittedEmail]);

    const resetStatus = () => {
        setSent(false);
        setError('');
        setSuccessMessage('');
        setSuccessStatus('');
    };

    const switchMode = (nextMode) => {
        setMode(nextMode);
        setCompanyName('');
        setContactName('');
        setPhone('');
        resetStatus();
    };

    const handleLoginSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const trimmed = email.trim().toLowerCase();
            const data = await sendMagicLinkApi(trimmed);
            if (rememberEmail) {
                localStorage.setItem(REMEMBER_KEY, trimmed);
            } else {
                localStorage.removeItem(REMEMBER_KEY);
            }
            setSubmittedEmail(trimmed);
            setSuccessMessage(data.message || '');
            setSuccessStatus('LOGIN_LINK_SENT');
            setSent(true);
        } catch (err) {
            setError(err.message || '오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
        } finally {
            setLoading(false);
        }
    };

    const handleRegisterSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const trimmedEmail = email.trim().toLowerCase();
            const trimmedCompany = companyName.trim();
            const trimmedContactName = contactName.trim();
            const trimmedPhone = phone.trim();
            const data = await registerClientApi(trimmedEmail, trimmedCompany, trimmedContactName, trimmedPhone);
            if (rememberEmail) {
                localStorage.setItem(REMEMBER_KEY, trimmedEmail);
            } else {
                localStorage.removeItem(REMEMBER_KEY);
            }
            setSubmittedEmail(trimmedEmail);
            setSuccessMessage(data.message || '');
            setSuccessStatus(data.status || 'CREATED');
            setSent(true);
        } catch (err) {
            setError(err.message || '가입 신청 중 오류가 발생했습니다.');
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

                <div className="client-auth-tabs">
                    <button
                        type="button"
                        className={`client-auth-tab ${mode === MODE_LOGIN ? 'active' : ''}`}
                        onClick={() => switchMode(MODE_LOGIN)}
                    >
                        로그인
                    </button>
                    <button
                        type="button"
                        className={`client-auth-tab ${mode === MODE_REGISTER ? 'active' : ''}`}
                        onClick={() => switchMode(MODE_REGISTER)}
                    >
                        가입 신청
                    </button>
                </div>

                {sent ? (
                    <div className="magic-sent-box">
                        <div className="magic-sent-icon">✉</div>
                        {mode === MODE_LOGIN || successStatus === 'ALREADY_REGISTERED' ? (
                            <>
                                <p className="magic-sent-title">이메일을 확인해 주세요</p>
                                <p className="magic-sent-desc">
                                    {successMessage || (
                                        <>
                                            <strong>{submittedEmail}</strong>로 로그인 링크를 발송했습니다.<br />
                                            링크는 <strong>10분간</strong> 유효합니다.<br />
                                            스팸함도 함께 확인해 보세요.
                                        </>
                                    )}
                                </p>
                                {mailboxUrl && (
                                    <a
                                        href={mailboxUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="login-btn mailbox-btn"
                                    >
                                        메일함 바로가기 →
                                    </a>
                                )}
                            </>
                        ) : (
                            <>
                                <p className="magic-sent-title">
                                    {successStatus === 'ALREADY_PENDING' ? '가입 신청이 이미 접수되어 있습니다' : '가입 신청이 접수되었습니다'}
                                </p>
                                <p className="magic-sent-desc">
                                    {successMessage || (
                                        <>
                                            관리자 승인 후 <strong>{submittedEmail}</strong>로<br />
                                            24시간 유효 로그인 링크가 발송됩니다.
                                        </>
                                    )}
                                </p>
                                {mailboxUrl && (
                                    <a
                                        href={mailboxUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="login-btn mailbox-btn"
                                    >
                                        메일함 바로가기 →
                                    </a>
                                )}
                            </>
                        )}
                        <button
                            type="button"
                            className="login-btn login-btn-outline"
                            onClick={resetStatus}
                        >
                            다시 입력하기
                        </button>
                    </div>
                ) : (
                    <>
                        {mode === MODE_LOGIN ? (
                            <form className="client-login-form" onSubmit={handleLoginSubmit}>
                                {error && <div className="login-error">{error}</div>}
                                <div className="form-group">
                                    <label htmlFor="email">이메일</label>
                                    <input
                                        id="email"
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="등록된 이메일 주소"
                                        autoComplete="email"
                                        required
                                    />
                                </div>
                                <label className="remember-email">
                                    <input
                                        type="checkbox"
                                        checked={rememberEmail}
                                        onChange={(e) => setRememberEmail(e.target.checked)}
                                    />
                                    이 이메일 기억하기
                                </label>
                                <p className="magic-hint">이메일로 로그인 링크를 발송합니다. 비밀번호가 필요 없습니다.</p>
                                <button type="submit" className="login-btn" disabled={loading}>
                                    {loading ? '발송 중...' : '로그인 링크 받기'}
                                </button>
                            </form>
                        ) : (
                            <form className="client-login-form" onSubmit={handleRegisterSubmit}>
                                {error && <div className="login-error">{error}</div>}
                                <div className="form-group">
                                    <label htmlFor="companyName">상호명</label>
                                    <input
                                        id="companyName"
                                        type="text"
                                        value={companyName}
                                        onChange={(e) => setCompanyName(e.target.value)}
                                        placeholder="예: HD Sign 협력사"
                                        required
                                    />
                                </div>
                                <div className="form-group">
                                    <label htmlFor="registerEmail">이메일</label>
                                    <input
                                        id="registerEmail"
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="담당자 이메일 주소"
                                        autoComplete="email"
                                        required
                                    />
                                </div>
                                <div className="form-group">
                                    <label htmlFor="contactName">담당자 성함</label>
                                    <input
                                        id="contactName"
                                        type="text"
                                        value={contactName}
                                        onChange={(e) => setContactName(e.target.value)}
                                        placeholder="예: 홍길동"
                                        required
                                    />
                                </div>
                                <div className="form-group">
                                    <label htmlFor="phone">전화번호</label>
                                    <input
                                        id="phone"
                                        type="tel"
                                        value={phone}
                                        onChange={(e) => setPhone(e.target.value)}
                                        placeholder="예: 010-1234-5678"
                                        autoComplete="tel"
                                        required
                                    />
                                </div>
                                <label className="remember-email">
                                    <input
                                        type="checkbox"
                                        checked={rememberEmail}
                                        onChange={(e) => setRememberEmail(e.target.checked)}
                                    />
                                    이 이메일 기억하기
                                </label>
                                <p className="magic-hint">
                                    같은 회사에서 담당자가 여러 명이면 각 담당자 이메일로 각각 신청해 주세요.
                                </p>
                                <button type="submit" className="login-btn" disabled={loading}>
                                    {loading ? '신청 중...' : '가입 신청하기'}
                                </button>
                            </form>
                        )}
                    </>
                )}

                <Link to="/" className="back-link">← 메인 사이트로 돌아가기</Link>
            </div>
        </div>
    );
}
