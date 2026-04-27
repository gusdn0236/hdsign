import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import './ClientAdmin.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const EMPTY_FORM = { username: '', password: '', companyName: '', networkFolderName: '', contactName: '', phone: '', email: '', aliases: '', isActive: true, pendingSignup: true };

function formatDate(val) {
    if (!val) return '-';
    return String(val).replace('T', ' ').slice(0, 16);
}

function statusLabel(status, isActive) {
    if (status === 'PENDING_SIGNUP') return { label: '가입대기', cls: 'pending-signup' };
    if (status === 'PENDING_APPROVAL') return { label: '승인대기', cls: 'pending-approval' };
    if (status === 'ACTIVE') return { label: isActive ? '활성' : '비활성', cls: isActive ? 'active' : 'inactive' };
    if (status === 'DISABLED') return { label: '비활성', cls: 'inactive' };
    return { label: status || '-', cls: '' };
}

export default function ClientAdmin() {
    const { token } = useAuth();
    const authHeader = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

    const [feedback, setFeedback] = useState(null);
    const [clients, setClients] = useState([]);
    const [loading, setLoading] = useState(true);
    // 워처가 푸시한 네트워크 거래처 폴더명 — 모달의 datalist 자동완성에 사용.
    const [folderOptions, setFolderOptions] = useState([]);
    const [folderSyncedAt, setFolderSyncedAt] = useState(null);

    const [modalMode, setModalMode] = useState(null); // 'create' | 'edit' | 'reset' | 'bulk'
    const [editTarget, setEditTarget] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const overlayDownRef = useRef(false);

    // 일괄 등록 모달 상태
    const [bulkRows, setBulkRows] = useState([]); // [{folder, checked, username, password, companyName, contactName, phone, email, error}]
    const [bulkLoading, setBulkLoading] = useState(false);
    const [bulkHideTemp, setBulkHideTemp] = useState(true);
    const [bulkMeta, setBulkMeta] = useState({ totalFolders: 0, syncedAt: null });
    // 일괄 등록을 가입대기 모드로 만들 것인지 — 켜면 행별 ID/비번 입력란 숨기고 거래처명/이메일만 받음.
    const [bulkPendingMode, setBulkPendingMode] = useState(true);

    // 평문 비번 표시 모달 — 승인/재발급/비번보기 결과를 한 번 노출 (복사 가능, 분실 안내 문구).
    const [credentials, setCredentials] = useState(null); // {companyName, username, password, hint}
    // status 필터: 'all' | 'PENDING_SIGNUP' | 'PENDING_APPROVAL' | 'ACTIVE'
    const [statusFilter, setStatusFilter] = useState('all');

    const field = (key) => ({
        value: form[key] ?? '',
        onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
    });

    const closeModal = () => { setModalMode(null); setEditTarget(null); setForm(EMPTY_FORM); };

    const openCreate = () => { setForm(EMPTY_FORM); setModalMode('create'); };
    const openEdit = (client) => {
        setEditTarget(client);
        setForm({
            companyName: client.companyName || '',
            networkFolderName: client.networkFolderName || '',
            contactName: client.contactName || '',
            phone: client.phone || '',
            email: client.email || '',
            aliases: client.aliases || '',
            isActive: client.isActive ?? true,
        });
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

    const loadFolderOptions = async () => {
        try {
            const res = await fetch(`${BASE_URL}/api/admin/network-folders`, { headers: authHeader });
            if (!res.ok) return;
            const data = await res.json().catch(() => ({}));
            setFolderOptions(Array.isArray(data?.folders) ? data.folders : []);
            setFolderSyncedAt(data?.syncedAt || null);
        } catch {
            // 워처가 아직 푸시하지 않았거나 서버 재시작 직후일 수 있음 — 조용히 무시.
        }
    };

    // 모달이 열릴 때마다 최신 폴더 목록을 가져와서 datalist 갱신.
    useEffect(() => {
        if (modalMode === 'create' || modalMode === 'edit') loadFolderOptions();
    }, [modalMode]); // eslint-disable-line

    // 임시폴더 패턴 — '새 폴더', '새 폴더 (N)', '(N)' 등 의미 없는 작업용 폴더 자동 필터.
    const isTempFolder = (name) => /^\(\d+\)$|^새 폴더( \(\d+\))?$/.test(name);

    const randomPassword = (len = 8) => {
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        let out = '';
        for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
    };

    const openBulk = async () => {
        setBulkLoading(true);
        setFeedback(null);
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients/unregistered-folders`, { headers: authHeader });
            if (!res.ok) throw new Error('미등록 폴더를 불러오지 못했습니다.');
            const data = await res.json().catch(() => ({}));
            const folders = Array.isArray(data?.folders) ? data.folders : [];
            setBulkMeta({ totalFolders: data?.totalFolders ?? folders.length, syncedAt: data?.syncedAt || null });
            setBulkRows(folders.map((folder) => ({
                folder,
                checked: !isTempFolder(folder),
                username: '',
                password: '',
                companyName: folder,
                contactName: '',
                phone: '',
                email: '',
                aliases: '',
                error: null,
            })));
            setModalMode('bulk');
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        } finally {
            setBulkLoading(false);
        }
    };

    const updateBulkRow = (idx, patch) => {
        setBulkRows((prev) => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
    };

    const bulkAutoFillPasswords = () => {
        setBulkRows((prev) => prev.map((r) => r.checked && !r.password ? { ...r, password: randomPassword() } : r));
    };

    const bulkToggleAll = (checked) => {
        setBulkRows((prev) => prev.map((r) => isTempFolder(r.folder) && bulkHideTemp ? r : { ...r, checked }));
    };

    const handleBulkSubmit = async () => {
        const targets = bulkRows
            .map((r, idx) => ({ r, idx }))
            .filter(({ r }) => r.checked && !(bulkHideTemp && isTempFolder(r.folder)));
        if (targets.length === 0) {
            setFeedback({ type: 'error', msg: '저장할 행을 선택해주세요.' });
            return;
        }
        setSaving(true);
        setFeedback(null);
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients/bulk`, {
                method: 'POST',
                headers: { ...authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    rows: targets.map(({ r }) => ({
                        networkFolderName: r.folder,
                        username: bulkPendingMode ? '' : r.username,
                        password: bulkPendingMode ? '' : r.password,
                        companyName: r.companyName,
                        contactName: r.contactName,
                        phone: r.phone,
                        email: r.email,
                        aliases: r.aliases,
                        pendingSignup: bulkPendingMode,
                    })),
                }),
            });
            if (!res.ok) throw new Error('일괄 등록 호출 실패');
            const data = await res.json();
            const results = Array.isArray(data?.results) ? data.results : [];
            // 결과를 행에 매핑 — 성공한 행은 표시 후 제거, 실패는 에러를 행에 박아둠.
            const successFolders = new Set();
            setBulkRows((prev) => prev.map((r) => {
                const matched = results.find((x) => x.networkFolderName === r.folder);
                if (!matched) return r;
                if (matched.ok) {
                    successFolders.add(r.folder);
                    return { ...r, error: null };
                }
                return { ...r, error: matched.error || '등록 실패' };
            }));
            // 가입대기 모드면 아이디/비번이 없으니 CSV 미생성. 직접 발급 모드만 다운로드.
            if (successFolders.size > 0 && !bulkPendingMode) {
                const csvRows = [['폴더명', '업체명', '아이디', '비밀번호']];
                for (const { r } of targets) {
                    if (successFolders.has(r.folder)) csvRows.push([r.folder, r.companyName, r.username, r.password]);
                }
                downloadCsv(`hdsign_거래처계정_${new Date().toISOString().slice(0, 10)}.csv`, csvRows);
            }
            if (successFolders.size > 0) {
                // 성공 행은 표에서 제거.
                setBulkRows((prev) => prev.filter((r) => !successFolders.has(r.folder)));
            }
            setFeedback({
                type: data.failed > 0 ? 'error' : 'success',
                msg: `등록 ${data.success}건 성공${data.failed > 0 ? ` / ${data.failed}건 실패 (행에 사유 표시)` : ''}`,
            });
            await loadClients();
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        } finally {
            setSaving(false);
        }
    };

    const downloadCsv = (filename, rows) => {
        // Excel 한글 호환을 위해 UTF-8 BOM 포함.
        const csv = '﻿' + rows.map((r) =>
            r.map((cell) => {
                const s = String(cell ?? '');
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            }).join(',')
        ).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

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

    const handleApprove = async (client) => {
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients/${client.id}/approve`, {
                method: 'POST', headers: authHeader,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || '승인 실패');
            setCredentials({
                companyName: data.companyName,
                username: data.username,
                password: data.password,
                hint: '거래처에 카톡/전화로 아이디와 비번을 전달해주세요. 분실 시 [비번 보기]로 다시 확인 가능합니다.',
            });
            await loadClients();
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        }
    };

    const handleReject = async (client) => {
        if (!window.confirm(`${client.companyName}의 가입 신청을 거부하시겠습니까? 거래처는 다시 신청할 수 있습니다.`)) return;
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients/${client.id}/reject`, {
                method: 'POST', headers: authHeader,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || '거부 실패');
            setFeedback({ type: 'success', msg: '가입 신청이 거부되었습니다.' });
            await loadClients();
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        }
    };

    const handleViewPassword = async (client) => {
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients/${client.id}/password`, { headers: authHeader });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || '비번 조회 실패');
            if (!data.hasPlaintext) {
                if (window.confirm('이 거래처는 평문 비번이 보관돼있지 않습니다(이전 등록 또는 직접 변경된 계정). 새 비번을 재발급하시겠습니까?')) {
                    handleRegeneratePassword(client);
                }
                return;
            }
            setCredentials({
                companyName: client.companyName,
                username: data.username,
                password: data.password,
                hint: '거래처에 전달할 정보입니다. 분실 시 다시 [비번 보기]로 확인 가능합니다.',
            });
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        }
    };

    const handleRegeneratePassword = async (client) => {
        if (!window.confirm(`${client.companyName}의 비번을 재발급하시겠습니까? 기존 비번은 즉시 무효화됩니다.`)) return;
        try {
            const res = await fetch(`${BASE_URL}/api/admin/clients/${client.id}/regenerate-password`, {
                method: 'POST', headers: authHeader,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || '재발급 실패');
            setCredentials({
                companyName: client.companyName,
                username: data.username,
                password: data.password,
                hint: '새 비번입니다. 거래처에 카톡/전화로 전달해주세요.',
            });
            await loadClients();
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        }
    };

    const copyToClipboard = (text) => {
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).catch(() => {});
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
                <div className="ca-header-actions">
                    <button type="button" className="ca-bulk-btn" onClick={openBulk} disabled={bulkLoading}>
                        {bulkLoading ? '불러오는 중...' : '+ 미등록 폴더 일괄 등록'}
                    </button>
                    <button type="button" className="ca-add-btn" onClick={openCreate}>+ 거래처 추가</button>
                </div>
            </div>

            {feedback && <div className={`ca-feedback ${feedback.type}`}>{feedback.msg}</div>}

            {(() => {
                const counts = clients.reduce((acc, c) => {
                    acc[c.status || 'ACTIVE'] = (acc[c.status || 'ACTIVE'] || 0) + 1;
                    return acc;
                }, {});
                const filtered = statusFilter === 'all' ? clients : clients.filter((c) => (c.status || 'ACTIVE') === statusFilter);
                return (
                    <>
                        <div className="ca-status-tabs">
                            <button type="button" className={`ca-tab-btn ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => setStatusFilter('all')}>전체 {clients.length}</button>
                            <button type="button" className={`ca-tab-btn ${statusFilter === 'PENDING_APPROVAL' ? 'active' : ''}`} onClick={() => setStatusFilter('PENDING_APPROVAL')}>승인대기 {counts.PENDING_APPROVAL || 0}</button>
                            <button type="button" className={`ca-tab-btn ${statusFilter === 'PENDING_SIGNUP' ? 'active' : ''}`} onClick={() => setStatusFilter('PENDING_SIGNUP')}>가입대기 {counts.PENDING_SIGNUP || 0}</button>
                            <button type="button" className={`ca-tab-btn ${statusFilter === 'ACTIVE' ? 'active' : ''}`} onClick={() => setStatusFilter('ACTIVE')}>활성 {counts.ACTIVE || 0}</button>
                        </div>

                        {loading ? (
                            <p className="ca-empty">불러오는 중...</p>
                        ) : filtered.length === 0 ? (
                            <p className="ca-empty">표시할 거래처가 없습니다.</p>
                        ) : (
                            <div className="ca-table-wrap">
                                <table className="ca-table">
                                    <thead>
                                        <tr>
                                            <th>상태</th>
                                            <th>업체명</th>
                                            <th>아이디</th>
                                            <th>담당자</th>
                                            <th>연락처</th>
                                            <th>이메일</th>
                                            <th>등록일</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filtered.map((client) => {
                                            const st = statusLabel(client.status, client.isActive);
                                            return (
                                                <tr key={client.id}>
                                                    <td><span className={`ca-status ${st.cls}`}>{st.label}</span></td>
                                                    <td className="ca-company">{client.companyName}</td>
                                                    <td className="ca-muted">{client.username || '-'}</td>
                                                    <td>{client.contactName || '-'}</td>
                                                    <td className="ca-muted">{client.phone || '-'}</td>
                                                    <td className="ca-email">{client.email || <span className="ca-no-email">미등록</span>}</td>
                                                    <td className="ca-muted">{formatDate(client.signupRequestedAt || client.createdAt)}</td>
                                                    <td className="ca-actions">
                                                        {client.status === 'PENDING_APPROVAL' && (
                                                            <>
                                                                <button type="button" className="ca-approve-btn" onClick={() => handleApprove(client)}>승인</button>
                                                                <button type="button" className="ca-reject-btn" onClick={() => handleReject(client)}>거부</button>
                                                            </>
                                                        )}
                                                        {client.status === 'ACTIVE' && (
                                                            <>
                                                                <button type="button" className="ca-edit-btn" onClick={() => openEdit(client)}>수정</button>
                                                                <button type="button" className="ca-pw-btn" onClick={() => handleViewPassword(client)}>비번 보기</button>
                                                                <button type="button" className="ca-pw-btn" onClick={() => handleRegeneratePassword(client)}>재발급</button>
                                                            </>
                                                        )}
                                                        {client.status === 'PENDING_SIGNUP' && (
                                                            <button type="button" className="ca-edit-btn" onClick={() => openEdit(client)}>수정</button>
                                                        )}
                                                        <button type="button" className="ca-del-btn" onClick={() => setDeleteTarget(client)}>삭제</button>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                );
            })()}

            {/* 추가 모달 */}
            {modalMode === 'create' && (
                <div className="ca-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) overlayDownRef.current = true; }} onMouseUp={(e) => { if (e.target === e.currentTarget && overlayDownRef.current) closeModal(); overlayDownRef.current = false; }}>
                    <div className="ca-modal" onClick={(e) => e.stopPropagation()}>
                        <h3>거래처 추가</h3>
                        <form className="ca-form" onSubmit={handleCreate}>
                            <div className="ca-field ca-field-toggle">
                                <label>가입대기로 만들기</label>
                                <label className="ca-toggle">
                                    <input
                                        type="checkbox"
                                        checked={Boolean(form.pendingSignup)}
                                        onChange={(e) => setForm((p) => ({ ...p, pendingSignup: e.target.checked }))}
                                    />
                                    <span className="ca-toggle-slider" />
                                    <span className="ca-toggle-label">{form.pendingSignup ? '거래처가 가입신청 후 승인' : '관리자가 직접 발급'}</span>
                                </label>
                            </div>
                            {!form.pendingSignup && (
                                <>
                                    <div className="ca-field">
                                        <label>아이디 *</label>
                                        <input {...field('username')} placeholder="로그인 아이디" required />
                                    </div>
                                    <div className="ca-field">
                                        <label>비밀번호 *</label>
                                        <input {...field('password')} placeholder="4자 이상" required />
                                    </div>
                                </>
                            )}
                            <div className="ca-field">
                                <label>업체명 *</label>
                                <input {...field('companyName')} placeholder="예: HD Sign 협력사" required />
                            </div>
                            <div className="ca-field">
                                <label>거래처 폴더명</label>
                                <input
                                    {...field('networkFolderName')}
                                    list="ca-folder-options"
                                    placeholder="네트워크 거래처 폴더명 (비워두면 업체명으로 매칭)"
                                />
                                <small className="ca-hint">
                                    {folderOptions.length > 0
                                        ? `워처 동기화: ${folderOptions.length}개 폴더${folderSyncedAt ? ` · ${formatDate(folderSyncedAt)}` : ''}`
                                        : '워처가 아직 폴더를 동기화하지 않았습니다. 직접 입력 가능.'}
                                </small>
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
                            <div className="ca-field">
                                <label>별칭 (검색 보조)</label>
                                <input {...field('aliases')} placeholder="콤마구분, 예: 디자인H, dH" />
                                <small className="ca-hint">
                                    거래처가 회원가입 시 이 별칭으로 검색해도 본 행이 후보로 뜹니다. 폴더명/업체명과 거래처가 부르는 상호가 다를 때 사용.
                                </small>
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
                <div className="ca-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) overlayDownRef.current = true; }} onMouseUp={(e) => { if (e.target === e.currentTarget && overlayDownRef.current) closeModal(); overlayDownRef.current = false; }}>
                    <div className="ca-modal" onClick={(e) => e.stopPropagation()}>
                        <h3>거래처 수정</h3>
                        <form className="ca-form" onSubmit={handleEdit}>
                            <div className="ca-field">
                                <label>업체명 *</label>
                                <input {...field('companyName')} required />
                            </div>
                            <div className="ca-field">
                                <label>거래처 폴더명</label>
                                <input
                                    {...field('networkFolderName')}
                                    list="ca-folder-options"
                                    placeholder="네트워크 거래처 폴더명 (비워두면 업체명으로 매칭)"
                                />
                                <small className="ca-hint">
                                    {folderOptions.length > 0
                                        ? `워처 동기화: ${folderOptions.length}개 폴더${folderSyncedAt ? ` · ${formatDate(folderSyncedAt)}` : ''}`
                                        : '워처가 아직 폴더를 동기화하지 않았습니다. 직접 입력 가능.'}
                                </small>
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
                            <div className="ca-field">
                                <label>별칭 (검색 보조)</label>
                                <input {...field('aliases')} placeholder="콤마구분, 예: 디자인H, dH" />
                                <small className="ca-hint">
                                    거래처가 회원가입 시 이 별칭으로 검색해도 본 행이 후보로 뜹니다.
                                </small>
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
                <div className="ca-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) overlayDownRef.current = true; }} onMouseUp={(e) => { if (e.target === e.currentTarget && overlayDownRef.current) closeModal(); overlayDownRef.current = false; }}>
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

            {/* 미등록 폴더 일괄 등록 모달 */}
            {modalMode === 'bulk' && (() => {
                const visibleRows = bulkRows.map((r, idx) => ({ r, idx }))
                    .filter(({ r }) => !(bulkHideTemp && isTempFolder(r.folder)));
                const checkedCount = visibleRows.filter(({ r }) => r.checked).length;
                return (
                    <div className="ca-overlay">
                        <div className="ca-modal ca-modal-xl" onClick={(e) => e.stopPropagation()}>
                            <div className="ca-bulk-header">
                                <h3>미등록 폴더 일괄 등록</h3>
                                <div className="ca-bulk-meta">
                                    워처 동기화 폴더 {bulkMeta.totalFolders}개 중 미등록 {bulkRows.length}개
                                    {bulkMeta.syncedAt && ` · ${formatDate(bulkMeta.syncedAt)}`}
                                </div>
                            </div>

                            <div className="ca-bulk-toolbar">
                                <label className="ca-bulk-checkbox">
                                    <input type="checkbox" checked={bulkPendingMode} onChange={(e) => setBulkPendingMode(e.target.checked)} />
                                    가입대기로 만들기 (거래처가 직접 가입신청 → 관리자 승인)
                                </label>
                                <span className="ca-bulk-spacer" />
                            </div>
                            <div className="ca-bulk-toolbar">
                                <label className="ca-bulk-checkbox">
                                    <input type="checkbox" checked={bulkHideTemp} onChange={(e) => setBulkHideTemp(e.target.checked)} />
                                    임시폴더 숨기기 (새 폴더, (N))
                                </label>
                                <button type="button" className="ca-mini-btn" onClick={() => bulkToggleAll(true)}>전체 선택</button>
                                <button type="button" className="ca-mini-btn" onClick={() => bulkToggleAll(false)}>전체 해제</button>
                                {!bulkPendingMode && (
                                    <button type="button" className="ca-mini-btn" onClick={bulkAutoFillPasswords}>비번 자동생성</button>
                                )}
                                <span className="ca-bulk-spacer" />
                                <span className="ca-bulk-count">{checkedCount}개 선택됨</span>
                            </div>

                            <div className="ca-bulk-table-wrap">
                                <table className="ca-bulk-table">
                                    <thead>
                                        <tr>
                                            <th style={{ width: 32 }} />
                                            <th>폴더명 (고정)</th>
                                            {!bulkPendingMode && <th>아이디 *</th>}
                                            {!bulkPendingMode && <th>비번 *</th>}
                                            <th>업체명 *</th>
                                            <th>별칭</th>
                                            <th>담당자</th>
                                            <th>연락처</th>
                                            <th>이메일</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visibleRows.map(({ r, idx }) => (
                                            <tr key={r.folder} className={r.error ? 'has-error' : ''}>
                                                <td>
                                                    <input type="checkbox" checked={r.checked}
                                                        onChange={(e) => updateBulkRow(idx, { checked: e.target.checked })} />
                                                </td>
                                                <td className="ca-bulk-folder">{r.folder}</td>
                                                {!bulkPendingMode && <td><input value={r.username} placeholder="영문" onChange={(e) => updateBulkRow(idx, { username: e.target.value })} /></td>}
                                                {!bulkPendingMode && <td><input value={r.password} placeholder="4자+" onChange={(e) => updateBulkRow(idx, { password: e.target.value })} /></td>}
                                                <td><input value={r.companyName} onChange={(e) => updateBulkRow(idx, { companyName: e.target.value })} /></td>
                                                <td><input value={r.aliases} placeholder="콤마구분" onChange={(e) => updateBulkRow(idx, { aliases: e.target.value })} /></td>
                                                <td><input value={r.contactName} onChange={(e) => updateBulkRow(idx, { contactName: e.target.value })} /></td>
                                                <td><input value={r.phone} onChange={(e) => updateBulkRow(idx, { phone: e.target.value })} /></td>
                                                <td><input value={r.email} onChange={(e) => updateBulkRow(idx, { email: e.target.value })} /></td>
                                                <td className="ca-bulk-error">{r.error || ''}</td>
                                            </tr>
                                        ))}
                                        {visibleRows.length === 0 && (
                                            <tr><td colSpan={bulkPendingMode ? 8 : 10} className="ca-empty">표시할 폴더가 없습니다.</td></tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            <div className="ca-modal-actions">
                                <button type="button" className="ca-cancel-btn" onClick={closeModal}>닫기</button>
                                <button type="button" className="ca-save-btn" disabled={saving || checkedCount === 0} onClick={handleBulkSubmit}>
                                    {saving ? '저장 중...' : `선택 ${checkedCount}개 저장`}
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* 평문 비번 노출 모달 — 승인/재발급/비번보기 결과를 한 번 표시. */}
            {credentials && (
                <div className="ca-overlay" onClick={(e) => { if (e.target === e.currentTarget) setCredentials(null); }}>
                    <div className="ca-modal" onClick={(e) => e.stopPropagation()}>
                        <h3>거래처 계정 정보</h3>
                        <div className="ca-cred-card">
                            <div className="ca-cred-row"><span className="ca-cred-label">업체명</span><span className="ca-cred-value">{credentials.companyName}</span></div>
                            <div className="ca-cred-row">
                                <span className="ca-cred-label">아이디</span>
                                <span className="ca-cred-value">{credentials.username}</span>
                                <button type="button" className="ca-mini-btn" onClick={() => copyToClipboard(credentials.username)}>복사</button>
                            </div>
                            <div className="ca-cred-row">
                                <span className="ca-cred-label">비밀번호</span>
                                <span className="ca-cred-value ca-cred-password">{credentials.password}</span>
                                <button type="button" className="ca-mini-btn" onClick={() => copyToClipboard(credentials.password)}>복사</button>
                            </div>
                            <button type="button" className="ca-mini-btn ca-cred-copy-all" onClick={() => copyToClipboard(`${credentials.companyName}\n아이디: ${credentials.username}\n비밀번호: ${credentials.password}`)}>
                                전체 복사 (메시지 형식)
                            </button>
                        </div>
                        <p className="ca-cred-hint">{credentials.hint}</p>
                        <div className="ca-modal-actions">
                            <button type="button" className="ca-save-btn" onClick={() => setCredentials(null)}>확인</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 거래처 폴더명 자동완성 — 추가/수정 모달 input list 가 참조 */}
            <datalist id="ca-folder-options">
                {folderOptions.map((name) => (
                    <option key={name} value={name} />
                ))}
            </datalist>

            {/* 삭제 확인 모달 */}
            {deleteTarget && (
                <div className="ca-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) overlayDownRef.current = true; }} onMouseUp={(e) => { if (e.target === e.currentTarget && overlayDownRef.current) setDeleteTarget(null); overlayDownRef.current = false; }}>
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
