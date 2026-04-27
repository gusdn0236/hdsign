import { useState } from 'react';
import { Link } from 'react-router-dom';
import './ClientLogin.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

export default function ClientSignup() {
    // step: 1=검색, 2=신청서, 3=완료
    const [step, setStep] = useState(1);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    // Step 1
    const [query, setQuery] = useState('');
    const [matches, setMatches] = useState([]);
    // 백엔드가 정확일치 결과를 줬는지 여부. false 면 자모 유사도 후보 — 단일 후보라도 자동진입하지 않고 확인 받음.
    const [matchesExact, setMatchesExact] = useState(true);

    // Step 2 — 선택한 거래처 + 신청 폼
    const [selected, setSelected] = useState(null); // {id, companyName, emailMasked}
    const [form, setForm] = useState({ username: '', phone: '', email: '' });

    const reset = () => {
        setStep(1); setError(''); setQuery(''); setMatches([]); setMatchesExact(true);
        setSelected(null); setForm({ username: '', phone: '', email: '' });
    };

    const handleSearch = async (e) => {
        e.preventDefault();
        setLoading(true); setError('');
        try {
            const res = await fetch(`${BASE_URL}/api/client/auth/signup/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: query.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || '검색에 실패했습니다.');
            const list = Array.isArray(data?.matches) ? data.matches : [];
            if (list.length === 0) {
                setError('일치하거나 비슷한 가입대기 거래처가 없습니다. 다른 표기로 다시 검색하거나 사무실에 문의해주세요.');
                setMatches([]);
                setMatchesExact(true);
                return;
            }
            const isExact = Boolean(data?.exact);
            setMatches(list);
            setMatchesExact(isExact);
            // 정확일치 단일 후보만 자동 진입. 유사도 후보는 잘못 진입할 위험이 있어 본인 확인 카드를 띄움.
            if (list.length === 1 && isExact) {
                setSelected(list[0]);
                setStep(2);
            }
        } catch (err) {
            setError(err.message || '검색 중 오류가 발생했습니다.');
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true); setError('');
        try {
            const res = await fetch(`${BASE_URL}/api/client/auth/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: selected.id,
                    username: form.username.trim(),
                    phone: form.phone.trim(),
                    email: form.email.trim(),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || '신청에 실패했습니다.');
            setStep(3);
        } catch (err) {
            setError(err.message || '신청 중 오류가 발생했습니다.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="client-login-page">
            <div className="client-login-card">
                <div className="client-login-logo">
                    <h1>거래처 회원가입</h1>
                    <p>관리자가 미리 등록한 거래처만 가입 가능합니다</p>
                </div>

                {error && <div className="login-error">{error}</div>}

                {/* Step 1 — 검색 */}
                {step === 1 && (
                    <form className="client-login-form" onSubmit={handleSearch}>
                        <div className="form-group">
                            <label htmlFor="query">거래처명 또는 이메일</label>
                            <input
                                id="query" type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="예: 현대기업 또는 hdno88@daum.net"
                                required
                            />
                            <small className="signup-hint">
                                관리자가 등록한 거래처명/이메일을 입력해주세요. 표기가 정확하지 않아도 비슷한 거래처를 후보로 보여드립니다.
                            </small>
                        </div>
                        <button type="submit" className="login-btn" disabled={loading || !query.trim()}>
                            {loading ? '검색 중...' : '거래처 찾기'}
                        </button>

                        {/* 후보 카드: 정확일치+다수 / 유사도(단일이라도 본인 확인 필요) 모두 노출 */}
                        {(matches.length > 1 || (matches.length === 1 && !matchesExact)) && (
                            <div className="signup-matches">
                                <p>
                                    {matchesExact
                                        ? '여러 거래처가 매칭되었습니다. 본인 거래처를 선택해주세요:'
                                        : '정확히 일치하는 거래처가 없습니다. 비슷한 거래처 중 본인 거래처를 선택해주세요:'}
                                </p>
                                {matches.map((m) => (
                                    <button
                                        key={m.id} type="button" className="signup-match-btn"
                                        onClick={() => { setSelected(m); setStep(2); }}
                                    >
                                        <strong>{m.companyName}</strong>
                                        {m.emailMasked && <span className="signup-match-email">{m.emailMasked}</span>}
                                    </button>
                                ))}
                            </div>
                        )}
                    </form>
                )}

                {/* Step 2 — 본인 확인 + 신청 폼 */}
                {step === 2 && selected && (
                    <form className="client-login-form" onSubmit={handleSubmit}>
                        <div className="signup-confirm">
                            <span>본인 거래처가 맞으신가요?</span>
                            <strong>{selected.companyName}</strong>
                        </div>

                        <div className="form-group">
                            <label htmlFor="su-username">사용할 아이디 *</label>
                            <input
                                id="su-username" type="text"
                                value={form.username}
                                onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
                                placeholder="영문/숫자 (예: jinsung01)"
                                autoComplete="username"
                                required
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="su-phone">담당자 전화번호 *</label>
                            <input
                                id="su-phone" type="tel"
                                value={form.phone}
                                onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                                placeholder="010-1234-5678"
                                required
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="su-email">담당자 이메일</label>
                            <input
                                id="su-email" type="email"
                                value={form.email}
                                onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                                placeholder="contact@company.com (선택)"
                            />
                        </div>

                        <p className="signup-policy">
                            비밀번호는 관리자가 승인 시 자동 발급해 카톡/전화로 전달드립니다.
                        </p>

                        <div className="signup-actions">
                            <button type="button" className="signup-back-btn" onClick={() => { setStep(1); setSelected(null); }}>
                                다시 찾기
                            </button>
                            <button type="submit" className="login-btn" disabled={loading}>
                                {loading ? '신청 중...' : '가입 신청'}
                            </button>
                        </div>
                    </form>
                )}

                {/* Step 3 — 완료 */}
                {step === 3 && (
                    <div className="signup-done">
                        <h2>가입 신청이 접수되었습니다</h2>
                        <p>관리자 확인 후 등록된 연락처로 임시 비밀번호를 안내드립니다.</p>
                        <p className="signup-done-meta">보통 영업일 기준 1일 이내 처리됩니다.</p>
                        <Link to="/client/login" className="login-btn" style={{ display: 'inline-block', textAlign: 'center' }}>
                            로그인 화면으로
                        </Link>
                    </div>
                )}

                <Link to="/client/login" className="back-link">← 로그인 화면으로</Link>
            </div>
        </div>
    );
}
