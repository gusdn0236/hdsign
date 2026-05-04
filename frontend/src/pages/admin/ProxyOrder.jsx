import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import './ProxyOrder.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const MAX_TOTAL_FILE_SIZE_MB = 80;
const MAX_TOTAL_FILE_SIZE_BYTES = MAX_TOTAL_FILE_SIZE_MB * 1024 * 1024;

function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProxyOrder() {
    const { token } = useAuth();
    const navigate = useNavigate();

    const [clients, setClients] = useState([]);
    const [clientsLoading, setClientsLoading] = useState(true);
    const [clientQuery, setClientQuery] = useState('');
    const [selectedClient, setSelectedClient] = useState(null);
    const [showSuggest, setShowSuggest] = useState(false);
    const [activeSuggestIndex, setActiveSuggestIndex] = useState(0);
    const suggestListRef = useRef(null);

    const [files, setFiles] = useState([]);
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef(null);
    const dragCounter = useRef(0);

    // title 은 UI 가 없지만 첨부 첫 파일명에서 자동 채워 넣어
    // 발주관리 목록의 "제목" 컬럼 식별자로 사용한다. 납기/배송 등 나머지는
    // 빈 값으로 등록되며 발주관리 모달에서 통화 후 채운다.
    const [title, setTitle] = useState('');

    const [submitting, setSubmitting] = useState(false);
    const [feedback, setFeedback] = useState(null);
    const [submitted, setSubmitted] = useState(false);
    const [submittedOrder, setSubmittedOrder] = useState(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch(`${BASE_URL}/api/admin/clients`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!res.ok) throw new Error('거래처 목록을 불러오지 못했습니다.');
                const data = await res.json();
                if (!alive) return;
                const selectable = (Array.isArray(data) ? data : []).filter((c) => c.status === 'ACTIVE' || c.status === 'PENDING_SIGNUP');
                setClients(selectable);
            } catch (err) {
                if (alive) setFeedback({ type: 'error', msg: err.message });
            } finally {
                if (alive) setClientsLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [token]);

    const clientSuggestions = useMemo(() => {
        const q = clientQuery.trim().toLowerCase();
        const sorted = [...clients].sort((a, b) =>
            (a.companyName || '').localeCompare(b.companyName || '', 'ko')
        );
        if (!q) return sorted;
        return sorted.filter((c) => {
            const haystack = `${c.companyName || ''} ${c.networkFolderName || ''} ${c.aliases || ''} ${c.contactName || ''}`.toLowerCase();
            return haystack.includes(q);
        });
    }, [clientQuery, clients]);

    useEffect(() => {
        setActiveSuggestIndex(0);
    }, [clientQuery]);

    useEffect(() => {
        if (activeSuggestIndex >= clientSuggestions.length) {
            setActiveSuggestIndex(Math.max(0, clientSuggestions.length - 1));
        }
    }, [activeSuggestIndex, clientSuggestions.length]);

    useEffect(() => {
        if (!showSuggest || !suggestListRef.current) return;
        const active = suggestListRef.current.querySelector('[data-active="true"]');
        active?.scrollIntoView({ block: 'nearest' });
    }, [activeSuggestIndex, showSuggest]);

    const pickClient = (c) => {
        setSelectedClient(c);
        setClientQuery(c.companyName);
        setShowSuggest(false);
        setActiveSuggestIndex(0);
    };

    const clearClient = () => {
        setSelectedClient(null);
        setClientQuery('');
        setShowSuggest(false);
        setActiveSuggestIndex(0);
    };

    const handleClientSearchKeyDown = (e) => {
        if (clientsLoading) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!showSuggest) {
                setShowSuggest(true);
                setActiveSuggestIndex(0);
                return;
            }
            setShowSuggest(true);
            setActiveSuggestIndex((idx) => (
                clientSuggestions.length ? Math.min(idx + 1, clientSuggestions.length - 1) : 0
            ));
            return;
        }

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!showSuggest) {
                setShowSuggest(true);
                setActiveSuggestIndex(Math.max(0, clientSuggestions.length - 1));
                return;
            }
            setShowSuggest(true);
            setActiveSuggestIndex((idx) => Math.max(idx - 1, 0));
            return;
        }

        if (e.key === 'Enter' && showSuggest && clientSuggestions.length > 0) {
            e.preventDefault();
            pickClient(clientSuggestions[activeSuggestIndex] || clientSuggestions[0]);
            return;
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            setShowSuggest(false);
        }
    };

    const acceptFiles = (incoming) => {
        const merged = [...files, ...incoming];
        const total = merged.reduce((s, f) => s + (f?.size || 0), 0);
        if (total > MAX_TOTAL_FILE_SIZE_BYTES) {
            setFeedback({
                type: 'error',
                msg: `첨부 총 용량이 ${MAX_TOTAL_FILE_SIZE_MB}MB 를 초과했습니다 (현재 ${Math.ceil(total / 1024 / 1024)}MB).`,
            });
            return;
        }
        setFiles(merged);
        if (!title.trim() && incoming.length > 0) {
            setTitle(incoming[0].name.replace(/\.[^/.]+$/, ''));
        }
    };

    const onPick = (e) => {
        const list = Array.from(e.target.files || []);
        if (list.length) acceptFiles(list);
        e.target.value = '';
    };

    const onDrop = (e) => {
        e.preventDefault();
        setDragging(false);
        dragCounter.current = 0;
        const list = Array.from(e.dataTransfer.files || []);
        if (list.length) acceptFiles(list);
    };

    const removeFile = (idx) => {
        setFiles(files.filter((_, i) => i !== idx));
    };

    useEffect(() => {
        const onDragEnter = (e) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            dragCounter.current++;
            setDragging(true);
        };
        const onDragLeave = () => {
            dragCounter.current--;
            if (dragCounter.current <= 0) {
                dragCounter.current = 0;
                setDragging(false);
            }
        };
        const onDragOverWin = (e) => e.preventDefault();
        const onDropWin = (e) => {
            // 페이지 어느 위치든 드롭 허용 — 단, 드롭존이 자체 처리하면 중복 회피
            if (e.defaultPrevented) return;
            e.preventDefault();
            dragCounter.current = 0;
            setDragging(false);
            const list = Array.from(e.dataTransfer.files || []);
            if (list.length) acceptFiles(list);
        };
        window.addEventListener('dragenter', onDragEnter);
        window.addEventListener('dragleave', onDragLeave);
        window.addEventListener('dragover', onDragOverWin);
        window.addEventListener('drop', onDropWin);
        return () => {
            window.removeEventListener('dragenter', onDragEnter);
            window.removeEventListener('dragleave', onDragLeave);
            window.removeEventListener('dragover', onDragOverWin);
            window.removeEventListener('drop', onDropWin);
        };
    }, [files, title]);

    const reset = () => {
        setSelectedClient(null);
        setClientQuery('');
        setShowSuggest(false);
        setActiveSuggestIndex(0);
        setFiles([]);
        setTitle('');
        setFeedback(null);
    };

    const startNewProxyOrder = () => {
        reset();
        setSubmitted(false);
        setSubmittedOrder(null);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setFeedback(null);

        if (!selectedClient) return setFeedback({ type: 'error', msg: '거래처를 선택해 주세요.' });
        if (!files.length) return setFeedback({ type: 'error', msg: '파일을 1개 이상 첨부해 주세요.' });

        setSubmitting(true);
        try {
            const formData = new FormData();
            formData.append('clientId', selectedClient.id);
            formData.append('title', title.trim());
            files.forEach((f) => formData.append('files', f));

            const res = await fetch(`${BASE_URL}/api/admin/orders/proxy`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: formData,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || '등록에 실패했습니다.');
            }
            const data = await res.json().catch(() => ({}));
            setSubmittedOrder({
                orderNumber: data.orderNumber || '',
                companyName: selectedClient.companyName,
            });
            reset();
            setSubmitted(true);
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        } finally {
            setSubmitting(false);
        }
    };

    if (submitted) {
        return (
            <div className="proxy-page">
                <header className="proxy-header">
                    <div>
                        <h1 className="proxy-title">대리 발주 등록</h1>
                        <p className="proxy-sub">
                            {submittedOrder?.companyName ? `${submittedOrder.companyName} 발주가 등록되었습니다.` : '발주가 등록되었습니다.'}
                        </p>
                    </div>
                    <button type="button" className="proxy-back-btn" onClick={() => navigate('/admin/orders')}>발주 관리로</button>
                </header>
                <div className="proxy-submitted-wrap">
                    <span className="proxy-submitted-icon">✅</span>
                    <h2 className="proxy-submitted-title">발주에 성공했습니다.</h2>
                    <p className="proxy-submitted-desc">
                        {submittedOrder?.orderNumber
                            ? <><strong className="proxy-submitted-order-no">{submittedOrder.orderNumber}</strong> 주문이 생성되었습니다.</>
                            : '새 주문이 생성되었습니다.'}
                    </p>

                    <div className="proxy-next-step">
                        <div className="proxy-next-step-head">다음 단계</div>
                        <ol className="proxy-next-step-list">
                            <li>
                                <span className="proxy-next-step-num">1</span>
                                <span><strong>발주관리</strong> 탭에서 방금 등록한 주문을 엽니다.</span>
                            </li>
                            <li>
                                <span className="proxy-next-step-num">2</span>
                                <span><strong>[지시서 자동작성]</strong> 버튼을 눌러 FlexSign 에 지시서를 띄웁니다.</span>
                            </li>
                            <li>
                                <span className="proxy-next-step-num">3</span>
                                <span>거래처와 통화하며 납기 · 배송 등을 채워 최종 완성 후 PDF24/워처로 웹에 반영합니다.</span>
                            </li>
                        </ol>
                    </div>

                    <div className="proxy-submitted-actions">
                        <button type="button" className="proxy-secondary-btn" onClick={startNewProxyOrder}>새 대리발주 작성</button>
                        <button type="button" className="proxy-primary-btn" onClick={() => navigate('/admin/orders')}>
                            발주관리로 이동 →
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="proxy-page">
            {dragging && (
                <div className="proxy-drop-overlay">
                    <div className="proxy-drop-overlay-box">
                        <span>📁</span>
                        <p>여기에 파일을 놓으세요</p>
                    </div>
                </div>
            )}

            <header className="proxy-header">
                <div>
                    <h1 className="proxy-title">대리 발주 등록</h1>
                    <p className="proxy-sub">메일/전화로 들어온 발주를 거래처 + 첨부파일만으로 빠르게 등록합니다. 작업명·납기·배송 등은 발주관리에서 통화하며 채워 넣습니다.</p>
                </div>
                <button type="button" className="proxy-back-btn" onClick={() => navigate('/admin/orders')}>← 작업 관리로</button>
            </header>

            {feedback && (
                <div className={`proxy-feedback ${feedback.type}`}>
                    {feedback.msg}
                </div>
            )}

            <form className="proxy-form" onSubmit={handleSubmit}>
                <section className="proxy-section">
                    <div className="proxy-section-head">
                        <span className="proxy-section-num">01</span>
                        <h2>거래처 선택</h2>
                    </div>
                    {selectedClient ? (
                        <div className="proxy-client-pick">
                            <div className="proxy-client-info">
                                <span className="proxy-client-name">
                                    {selectedClient.companyName}
                                    {selectedClient.status === 'PENDING_SIGNUP' && (
                                        <span className="proxy-pending-badge">가입대기</span>
                                    )}
                                </span>
                                <span className="proxy-client-meta">
                                    {selectedClient.contactName ? `${selectedClient.contactName} · ` : ''}
                                    {selectedClient.phone || '-'}
                                </span>
                            </div>
                            <button type="button" className="proxy-client-clear" onClick={clearClient}>변경</button>
                        </div>
                    ) : (
                        <div className="proxy-client-search-wrap">
                            <input
                                type="text"
                                className="proxy-input"
                                placeholder={clientsLoading ? '거래처 목록 로딩 중...' : '거래처명/연락처/별칭 검색'}
                                value={clientQuery}
                                onChange={(e) => { setClientQuery(e.target.value); setShowSuggest(true); }}
                                onFocus={() => setShowSuggest(true)}
                                onKeyDown={handleClientSearchKeyDown}
                                onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
                                disabled={clientsLoading}
                                autoComplete="off"
                                role="combobox"
                                aria-expanded={showSuggest}
                                aria-controls="proxy-client-suggestions"
                                aria-activedescendant={
                                    showSuggest && clientSuggestions[activeSuggestIndex]
                                        ? `proxy-client-suggestion-${clientSuggestions[activeSuggestIndex].id}`
                                        : undefined
                                }
                            />
                            {showSuggest && clientSuggestions.length > 0 && (
                                <ul
                                    id="proxy-client-suggestions"
                                    className="proxy-suggest-list"
                                    role="listbox"
                                    ref={suggestListRef}
                                >
                                    {clientSuggestions.map((c, idx) => {
                                        const active = idx === activeSuggestIndex;
                                        return (
                                        <li key={c.id} role="option" aria-selected={active}>
                                            <button
                                                id={`proxy-client-suggestion-${c.id}`}
                                                type="button"
                                                className={`proxy-suggest-item ${active ? 'active' : ''}`}
                                                data-active={active}
                                                onMouseEnter={() => setActiveSuggestIndex(idx)}
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => pickClient(c)}
                                            >
                                                <span className="proxy-suggest-name">
                                                    {c.companyName}
                                                    {c.status === 'PENDING_SIGNUP' && (
                                                        <span className="proxy-pending-badge">가입대기</span>
                                                    )}
                                                </span>
                                                <span className="proxy-suggest-meta">
                                                    {c.contactName ? `${c.contactName} · ` : ''}
                                                    {c.phone || ''}
                                                </span>
                                            </button>
                                        </li>
                                    );})}
                                </ul>
                            )}
                        </div>
                    )}
                </section>

                <section className="proxy-section">
                    <div className="proxy-section-head">
                        <span className="proxy-section-num">02</span>
                        <h2>파일 첨부</h2>
                    </div>
                    <div
                        className={`proxy-drop ${dragging ? 'on' : ''}`}
                        onDragOver={(e) => { e.preventDefault(); }}
                        onDrop={onDrop}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <span className="proxy-drop-icon">📁</span>
                        <p className="proxy-drop-text">AI/PDF/이미지 등을 드래그하거나 클릭해서 선택</p>
                        <p className="proxy-drop-sub">총 {MAX_TOTAL_FILE_SIZE_MB}MB 이하</p>
                        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={onPick} />
                    </div>
                    {files.length > 0 && (
                        <ul className="proxy-file-list">
                            {files.map((f, i) => (
                                <li key={`${f.name}-${i}`} className="proxy-file-item">
                                    <span className="proxy-file-name">{f.name}</span>
                                    <span className="proxy-file-size">{formatSize(f.size)}</span>
                                    <button type="button" className="proxy-file-rm" onClick={() => removeFile(i)}>×</button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <div className="proxy-actions">
                    <button type="button" className="proxy-secondary-btn" onClick={reset} disabled={submitting}>초기화</button>
                    <button type="submit" className="proxy-primary-btn" disabled={submitting}>
                        {submitting ? '등록 중...' : '발주 등록'}
                    </button>
                </div>
            </form>
        </div>
    );
}
