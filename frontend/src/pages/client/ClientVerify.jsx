import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { verifyMagicLinkApi } from '../../api/client';
import './ClientLogin.css';

export default function ClientVerify() {
    const [status, setStatus] = useState('loading');
    const [error, setError] = useState('');
    const { clientLogin } = useAuth();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();

    useEffect(() => {
        const token = searchParams.get('token');
        if (!token) {
            setStatus('error');
            setError('유효하지 않은 링크입니다.');
            return;
        }

        verifyMagicLinkApi(token)
            .then(({ token: jwt, companyName, contactName, username }) => {
                clientLogin(jwt, { companyName, contactName, username });
                setStatus('success');
                setTimeout(() => navigate('/client/request', { replace: true }), 1500);
            })
            .catch((err) => {
                setStatus('error');
                setError(err.message || '링크 인증에 실패했습니다.');
            });
    }, [clientLogin, navigate, searchParams]);

    return (
        <div className="client-login-page">
            <div className="client-login-card">
                <div className="client-login-logo">
                    <h1>HD Sign</h1>
                    <p>거래처 포털 로그인 인증 중</p>
                </div>

                {status === 'loading' && (
                    <div className="verify-status">
                        <div className="verify-spinner" />
                        <p>인증 중입니다...</p>
                    </div>
                )}

                {status === 'success' && (
                    <div className="verify-status verify-success">
                        <div className="verify-icon">✓</div>
                        <p>로그인되었습니다. 잠시 후 이동합니다.</p>
                    </div>
                )}

                {status === 'error' && (
                    <div className="verify-status verify-error">
                        <div className="verify-icon">!</div>
                        <p>{error}</p>
                        <Link
                            to="/client/login"
                            className="login-btn"
                            style={{ display: 'block', textAlign: 'center', marginTop: '8px', textDecoration: 'none' }}
                        >
                            다시 로그인하기
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
