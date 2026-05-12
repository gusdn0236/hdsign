import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import './AdminFolderChangeNotice.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

// 일괄 등록 화면과 동일한 임시폴더 패턴 — '새 폴더', '새 폴더 (N)', '(N)'.
const isTempFolder = (name) => /^\(\d+\)$|^새 폴더( \(\d+\))?$/.test(name || '');

const DISMISS_KEY = 'hdsign.folderChangeDismiss';

/**
 * 관리자 페이지 어디서든 마운트되어, 워처가 보고한 네트워크 거래처 폴더와
 * 등록된 거래처의 차이를 감지하면 안내 모달을 띄운다.
 * - 새 폴더(미등록): "거래처 관리"의 일괄 등록 화면을 바로 열어준다.
 * - 폴더가 사라진 거래처: 폴더명 수정/통합/삭제가 필요하니 거래처 관리로 유도.
 * "닫기"를 누르면 같은 내용에 대해서는 이번 브라우저 세션 동안 다시 뜨지 않는다.
 */
export default function AdminFolderChangeNotice() {
    const { token } = useAuth();
    const navigate = useNavigate();
    const [diff, setDiff] = useState(null);
    const [open, setOpen] = useState(false);

    const newFolders = useMemo(
        () => (diff?.newFolders || []).filter((f) => !isTempFolder(f)),
        [diff],
    );
    const missingClients = diff?.missingClients || [];
    const renameSuggestions = diff?.renameSuggestions || [];

    // 같은 변경 내용인지 식별하는 서명 — 내용이 달라지면 닫았어도 다시 띄운다.
    const signature = useMemo(() => {
        if (!diff) return '';
        return JSON.stringify({
            n: [...newFolders].sort(),
            m: missingClients.map((c) => `${c.id}:${c.networkFolderName}`).sort(),
        });
    }, [diff, newFolders, missingClients]);

    useEffect(() => {
        if (!token) return;
        let alive = true;
        fetch(`${BASE_URL}/api/admin/clients/folder-diff`, { headers: { Authorization: `Bearer ${token}` } })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (!alive || !data || !data.hasData) return;
                setDiff(data);
            })
            .catch(() => {});
        return () => { alive = false; };
    }, [token]);

    useEffect(() => {
        if (!diff) return;
        const hasChanges = newFolders.length > 0 || missingClients.length > 0;
        if (!hasChanges) return;
        let dismissed = null;
        try { dismissed = sessionStorage.getItem(DISMISS_KEY); } catch { /* ignore */ }
        if (dismissed === signature) return;
        setOpen(true);
    }, [diff, signature, newFolders.length, missingClients.length]);

    if (!open) return null;

    const dismiss = () => {
        try { sessionStorage.setItem(DISMISS_KEY, signature); } catch { /* ignore */ }
        setOpen(false);
    };

    const goManage = (state) => {
        dismiss();
        navigate('/admin/clients', state ? { state } : undefined);
    };

    return (
        <div className="fcn-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
            <div className="fcn-modal" onClick={(e) => e.stopPropagation()}>
                <h3>거래처 폴더 변경 감지</h3>
                <p className="fcn-sub">
                    워처가 보고한 거래처 폴더와 등록된 거래처 목록이 달라요. 아래 내용을 거래처 관리에서 정리해 주세요.
                </p>

                {newFolders.length > 0 && (
                    <div className="fcn-section">
                        <div className="fcn-section-title">새 폴더 {newFolders.length}개 — 거래처 등록 필요</div>
                        <ul className="fcn-list">
                            {newFolders.slice(0, 12).map((f) => <li key={f}>{f}</li>)}
                            {newFolders.length > 12 && <li className="fcn-more">… 외 {newFolders.length - 12}개</li>}
                        </ul>
                    </div>
                )}

                {renameSuggestions.length > 0 && (
                    <div className="fcn-section">
                        <div className="fcn-section-title">이름이 바뀐 듯한 폴더 {renameSuggestions.length}건</div>
                        <ul className="fcn-list">
                            {renameSuggestions.map((r, i) => (
                                <li key={i}>
                                    <strong>{r.companyName}</strong>: <span className="fcn-old">{r.oldFolder}</span> → <span className="fcn-new">{r.newFolder}</span>
                                </li>
                            ))}
                        </ul>
                        <div className="fcn-hint">거래처 관리에서 해당 거래처의 폴더명을 새 이름으로 수정하거나, 새로 만들어진 거래처와 [통합]하세요.</div>
                    </div>
                )}

                {missingClients.length > 0 && (
                    <div className="fcn-section">
                        <div className="fcn-section-title">폴더가 사라진 거래처 {missingClients.length}곳</div>
                        <ul className="fcn-list">
                            {missingClients.map((c) => (
                                <li key={c.id}>
                                    <strong>{c.companyName}</strong> <span className="fcn-old">(폴더: {c.networkFolderName})</span>
                                    {c.orderCount > 0
                                        ? <span className="fcn-note"> · 지시서 {c.orderCount}건 — 삭제 시 비활성화 처리됨</span>
                                        : <span className="fcn-note"> · 지시서 없음 — 삭제 가능</span>}
                                </li>
                            ))}
                        </ul>
                        <div className="fcn-hint">폴더명만 바뀐 거라면 거래처 [수정]에서 폴더명을 고치고, 정말 없어진 거래처면 [삭제]하세요.</div>
                    </div>
                )}

                <div className="fcn-actions">
                    <button type="button" className="fcn-secondary" onClick={dismiss}>나중에</button>
                    {newFolders.length > 0 && (
                        <button type="button" className="fcn-secondary" onClick={() => goManage({ openBulk: true })}>
                            새 폴더 일괄 등록 열기
                        </button>
                    )}
                    <button type="button" className="fcn-primary" onClick={() => goManage()}>거래처 관리로 이동</button>
                </div>
            </div>
        </div>
    );
}
