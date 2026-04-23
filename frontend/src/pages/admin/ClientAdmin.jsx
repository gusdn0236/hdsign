import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import './ClientAdmin.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const EMPTY_FORM = { username: '', password: '', companyName: '', contactName: '', phone: '', email: '', isActive: true };

function formatDate(val) {
    if (!val) return '-';
    return String(val).replace('T', ' ').slice(0, 16);
}

export default function ClientAdmin() {
    const { token } = useAuth();
    const authHeader = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

    const [feedback, setFeedback] = useState(null);
    const [clients, setClients] = useState([]);
    const [loading, setLoading] = useState(true);

    const [modalMode, setModalMode] = useState(null); // 'create' | 'edit' | 'reset'
    const [editTarget, setEditTarget] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState(null);

    const field = (key) => ({
        value: form[key] ?? '',
        onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
    });

    const closeModal = () => { setModalMode(null); setEditTarget(null); setForm(EMPTY_FORM); };

    const openCreate = () => { setForm(EMPTY_FORM); setModalMode('create'); };
    const openEdit = (client) => {
        setEditTarget(client);
        setForm({ companyName: client.companyName || '', contactName: client.contactName || '', phone: client.phone || '', email: client.email || '', isActive: client.isActive ?? true });
        setModalMode('edit');
    };
    const openReset = (client) => { setEditTarget(client); setForm({ password: '' }); setModalMode('reset'); };

    const loadClients = async () => {
        setLoading(true);
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients`, { headers: authHeader });
            const data = await res.json().catch(() => []);
            if (!res.ok) throw new Error('거래처 목록을 불러오지 못했습니다.');
            setClients(Array.isArray(data) ? data : []);
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadClients(); }, []); // eslint-disable-line

    const handleCreate = async (e) => {
        e.preventDefault();
        setSaving(true);
        setFeedback(null);
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients`, {
                method: 'POST',
                headers: { ...authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || '추가에 실패했습니다.');
            setFeedback({ type: 'success', msg: '거래처가 추가되었습니다.' });
            closeModal();
            await loadClients();
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        } finally {
            setSaving(false);
        }
    };

    const handleEdit = async (e) => {
        e.preventDefault();
        setSaving(true);
        setFeedback(null);
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients/${editTarget.id}`, {
                method: 'PUT',
                headers: { ...authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || '저장에 실패했습니다.');
            setFeedback({ type: 'success', msg: '거래처가 수정되었습니다.' });
            closeModal();
            await loadClients();
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        } finally {
            setSaving(false);
        }
    };

    const handleResetPassword = async (e) => {
        e.preventDefault();
        setSaving(true);
        setFeedback(null);
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients/${editTarget.id}/reset-password`, {
                method: 'POST',
                headers: { ...authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ newPassword: form.password }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || '비밀번호 변경에 실패했습니다.');
            setFeedback({ type: 'success', msg: `${editTarget.companyName} 비밀번호가 변경되었습니다.` });
            closeModal();
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setSaving(true);
        setFeedback(null);
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients/${deleteTarget.id}`, {
                method: 'DELETE',
                headers: authHeader,
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || '삭제에 실패했습니다.');
            }
            setFeedback({ type: 'success', msg: '거래처 계정이 삭제되었습니다.' });
            setDeleteTarget(null);
            await loadClients();
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="ca-page">
            <div className="ca-header">
                <h2>거래처 관리</h2>
                <button type="button" className="ca-add-btn" onClick={openCreate}>+ 거래처 추가</button>
            </div>

            {feedback && <div className={`ca-feedback ${feedback.type}`}>{feedback.msg}</div>}

            {loading ? (
                <p className="ca-empty">불러오는 중...</p>
            ) : clients.length === 0 ? (
                <p className="ca-empty">등록된 거래처가 없습니다.</p>
            ) : (
                <div className="ca-table-wrap">
                    <table className="ca-table">
                        <thead>
                            <tr>
                                <th>업체명</th>
                                <th>아이디</th>
                                <th>담당자</th>
                                <th>연락처</th>
                                <th>이메일</th>
                                <th>상태</th>
                                <th>등록일</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {clients.map((client) => (
                                <tr key={client.id}>
                                    <td className="ca-company">{client.companyName}</td>
                                    <td className="ca-muted">{client.username}</td>
                                    <td>{client.contactName || '-'}</td>
                                    <td className="ca-muted">{client.phone || '-'}</td>
                                    <td className="ca-email">{client.email || <span className="ca-no-email">미등록</span>}</td>
                                    <td>
                                        <span className={`ca-status ${client.isActive ? 'active' : 'inactive'}`}>
                                            {client.isActive ? '활성' : '비활성'}
                                        </span>
                                    </td>
                                    <td className="ca-muted">{formatDate(client.createdAt)}</td>
                                    <td className="ca-actions">
                                        <button type="button" className="ca-edit-btn" onClick={() => openEdit(client)}>수정</button>
                                        <button type="button" className="ca-pw-btn" onClick={() => openReset(client)}>비번변경</button>
                                        <button type="button" className="ca-del-btn" onClick={() => setDeleteTarget(client)}>삭제</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* 추가 모달 */}
            {modalMode === 'create' && (
                <div className="ca-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
                    <div className="ca-modal" onClick={(e) => e.stopPropagation()}>
                        <h3>거래처 추가</h3>
                        <form className="ca-form" onSubmit={handleCreate}>
                            <div className="ca-field">
                                <label>아이디 *</label>
                                <input {...field('username')} placeholder="로그인 아이디" required />
                            </div>
                            <div className="ca-field">
                                <label>비밀번호 *</label>
                                <input {...field('password')} type="password" placeholder="4자 이상" required />
                            </div>
                            <div className="ca-field">
                                <label>업체명 *</label>
                                <input {...field('companyName')} placeholder="예: HD Sign 협력사" required />
                            </div>
                            <div className="ca-field">
                                <label>담당자명</label>
                                <input {...field('contactName')} placeholder="예: 홍길동" />
                            </div>
                            <div className="ca-field">
                                <label>연락처</label>
                                <input {...field('phone')} placeholder="예: 010-1234-5678" />
                            </div>
                            <div className="ca-field">
                                <label>이메일</label>
                                <input {...field('email')} type="email" placeholder="담당자 이메일 (선택)" />
                            </div>
                            <div className="ca-modal-actions">
                                <button type="button" className="ca-cancel-btn" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>취소</button>
                                <button type="submit" className="ca-save-btn" disabled={saving}>{saving ? '추가 중...' : '추가'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* 수정 모달 */}
            {modalMode === 'edit' && (
                <div className="ca-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
                    <div className="ca-modal" onClick={(e) => e.stopPropagation()}>
                        <h3>거래처 수정</h3>
                        <form className="ca-form" onSubmit={handleEdit}>
                            <div className="ca-field">
                                <label>업체명 *</label>
                                <input {...field('companyName')} required />
                            </div>
                            <div className="ca-field">
                                <label>담당자명</label>
                                <input {...field('contactName')} />
                            </div>
                            <div className="ca-field">
                                <label>연락처</label>
                                <input {...field('phone')} />
                            </div>
                            <div className="ca-field">
                                <label>이메일</label>
                                <input {...field('email')} type="email" />
                            </div>
                            <div className="ca-field ca-field-toggle">
                                <label>계정 상태</label>
                                <label className="ca-toggle">
                                    <input
                                        type="checkbox"
                                        checked={Boolean(form.isActive)}
                                        onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))}
                                    />
                                    <span className="ca-toggle-slider" />
                                    <span className="ca-toggle-label">{form.isActive ? '활성' : '비활성'}</span>
                                </label>
                            </div>
                            <div className="ca-modal-actions">
                                <button type="button" className="ca-cancel-btn" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>취소</button>
                                <button type="submit" className="ca-save-btn" disabled={saving}>{saving ? '저장 중...' : '저장'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* 비밀번호 초기화 모달 */}
            {modalMode === 'reset' && (
                <div className="ca-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
                    <div className="ca-modal ca-modal-sm" onClick={(e) => e.stopPropagation()}>
                        <h3>비밀번호 변경</h3>
                        <p className="ca-confirm-text"><strong>{editTarget?.companyName}</strong> 계정의 비밀번호를 변경합니다.</p>
                        <form className="ca-form" onSubmit={handleResetPassword}>
                            <div className="ca-field">
                                <label>새 비밀번호 *</label>
                                <input {...field('password')} type="password" placeholder="4자 이상" required />
                            </div>
                            <div className="ca-modal-actions">
                                <button type="button" className="ca-cancel-btn" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>취소</button>
                                <button type="submit" className="ca-save-btn" disabled={saving}>{saving ? '변경 중...' : '변경'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* 삭제 확인 모달 */}
            {deleteTarget && (
                <div className="ca-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setDeleteTarget(null); }}>
                    <div className="ca-modal ca-modal-sm" onClick={(e) => e.stopPropagation()}>
                        <h3>거래처 삭제</h3>
                        <p className="ca-confirm-text">
                            <strong>{deleteTarget.companyName}</strong> 계정을 삭제하시겠습니까?
                        </p>
                        <div className="ca-modal-actions">
                            <button type="button" className="ca-cancel-btn" onClick={() => setDeleteTarget(null)}>취소</button>
                            <button type="button" className="ca-delete-confirm-btn" disabled={saving} onClick={handleDelete}>
                                {saving ? '삭제 중...' : '삭제'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
