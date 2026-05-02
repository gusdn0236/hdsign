import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import './ProxyOrder.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const DELIVERY_OPTIONS = [
    { value: 'CARGO', label: '화물 발송' },
    { value: 'QUICK', label: '퀵 발송' },
    { value: 'DIRECT', label: '직접 배송' },
    { value: 'LOCAL_CARGO', label: '지방화물차' },
    { value: 'PICKUP', label: '직접 수령' },
];

const DUE_TIMES = [
    { value: '오전 중', desc: '12시 이전' },
    { value: '오후 중', desc: '12시 이후' },
    { value: '당일 내', desc: '시간 무관' },
];
const DUE_TIME_PRESETS = DUE_TIMES.map((t) => t.value);

function composeCustomTime(ampm, hour, minute) {
    if (!hour || minute === '' || minute == null) return '';
    return `${ampm} ${hour}시 ${minute}분`;
}

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

const MAX_TOTAL_FILE_SIZE_MB = 60;
const MAX_TOTAL_FILE_SIZE_BYTES = MAX_TOTAL_FILE_SIZE_MB * 1024 * 1024;

function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ProxyOrder() {
    const { token } = useAuth();
    const navigate = useNavigate();

    const [clients, setClients] = useState([]);
    const [clientsLoading, setClientsLoading] = useState(true);
    const [clientQuery, setClientQuery] = useState('');
    const [selectedClient, setSelectedClient] = useState(null);
    const [showSuggest, setShowSuggest] = useState(false);

    const [files, setFiles] = useState([]);
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef(null);
    const dragCounter = useRef(0);

    const [title, setTitle] = useState('');
    const [titleAutoFilled, setTitleAutoFilled] = useState(false);
    const [additionalItems, setAdditionalItems] = useState('');
    const [note, setNote] = useState('');
    const [dueDate, setDueDate] = useState(todayISO());
    const [dueTime, setDueTime] = useState('당일 내');
    const [customTimeMode, setCustomTimeMode] = useState(false);
    const [customAmpm, setCustomAmpm] = useState('오전');
    const [customHour, setCustomHour] = useState('');
    const [customMinute, setCustomMinute] = useState('');
    const minuteInputRef = useRef(null);
    const [delivery, setDelivery] = useState('CARGO');
    const [deliveryAddress, setDeliveryAddress] = useState('');

    const [submitting, setSubmitting] = useState(false);
    const [feedback, setFeedback] = useState(null);

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

    const pickClient = (c) => {
        setSelectedClient(c);
        setClientQuery(c.companyName);
        setShowSuggest(false);
    };

    const clearClient = () => {
        setSelectedClient(null);
        setClientQuery('');
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
            setTitleAutoFilled(true);
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
        setFiles([]);
        setTitle('');
        setTitleAutoFilled(false);
        setAdditionalItems('');
        setNote('');
        setDueDate(todayISO());
        setDueTime('당일 내');
        setDelivery('CARGO');
        setDeliveryAddress('');
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setFeedback(null);

        if (!selectedClient) return setFeedback({ type: 'error', msg: '거래처를 선택해 주세요.' });
        if (!files.length) return setFeedback({ type: 'error', msg: '파일을 1개 이상 첨부해 주세요.' });
        if (!title.trim()) return setFeedback({ type: 'error', msg: '작업명을 입력해 주세요.' });
        if (!dueDate) return setFeedback({ type: 'error', msg: '납기일을 선택해 주세요.' });
        if (!dueTime) return setFeedback({ type: 'error', msg: '납기 시간을 선택해 주세요.' });
        if ((delivery === 'CARGO' || delivery === 'QUICK' || delivery === 'DIRECT' || delivery === 'LOCAL_CARGO') && !deliveryAddress.trim()) {
            return setFeedback({ type: 'error', msg: delivery === 'CARGO' ? '화물 지점을 입력해 주세요.' : '주소를 입력해 주세요.' });
        }

        setSubmitting(true);
        try {
            const formData = new FormData();
            formData.append('clientId', selectedClient.id);
            formData.append('title', title.trim());
            formData.append('additionalItems', additionalItems.trim());
            formData.append('note', note.trim());
            formData.append('dueDate', dueDate);
            formData.append('dueTime', dueTime);
            formData.append('deliveryMethod', delivery);
            formData.append('deliveryAddress', deliveryAddress.trim());
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
            setFeedback({ type: 'success', msg: `${data.orderNumber || ''} 등록 완료 — 거래처 ${selectedClient.companyName}` });
            reset();
        } catch (err) {
            setFeedback({ type: 'error', msg: err.message });
        } finally {
            setSubmitting(false);
        }
    };

    const dateChips = useMemo(() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return Array.from({ length: 14 }, (_, i) => {
            const d = new Date(today);
            d.setDate(today.getDate() + i);
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            return { iso, m: d.getMonth() + 1, d: d.getDate(), dow: d.getDay(), isToday: i === 0 };
        });
    }, []);

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
                    <p className="proxy-sub">메일/전화로 들어온 발주를 한 번에 등록합니다. 거래처 로그인 절차가 필요 없습니다.</p>
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
                                onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
                                disabled={clientsLoading}
                                autoComplete="off"
                            />
                            {showSuggest && clientSuggestions.length > 0 && (
                                <ul className="proxy-suggest-list">
                                    {clientSuggestions.map((c) => (
                                        <li key={c.id}>
                                            <button type="button" className="proxy-suggest-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pickClient(c)}>
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
                                    ))}
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

                <section className="proxy-section">
                    <div className="proxy-section-head">
                        <span className="proxy-section-num">03</span>
                        <h2>발주 내용</h2>
                    </div>
                    <label className="proxy-label">
                        작업명
                        {titleAutoFilled && <span className="proxy-hint">파일명에서 자동 입력 — 수정 가능</span>}
                    </label>
                    <input
                        type="text"
                        className="proxy-input"
                        value={title}
                        onChange={(e) => { setTitle(e.target.value); setTitleAutoFilled(false); }}
                        placeholder="예) 스타벅스 강남점 채널간판"
                        maxLength={120}
                    />

                    <label className="proxy-label" style={{ marginTop: 16 }}>추가 물품 (선택)</label>
                    <input
                        type="text"
                        className="proxy-input"
                        value={additionalItems}
                        onChange={(e) => setAdditionalItems(e.target.value)}
                        placeholder="예) 파워기(SMPS) 200W 2개, 볼트&너트"
                    />

                    <label className="proxy-label" style={{ marginTop: 16 }}>요청사항 (선택)</label>
                    <textarea
                        className="proxy-textarea"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="거래처 요청사항을 그대로 받아 적어주세요."
                        rows={4}
                    />
                </section>

                <section className="proxy-section">
                    <div className="proxy-section-head">
                        <span className="proxy-section-num">04</span>
                        <h2>납기 및 납품</h2>
                    </div>
                    <label className="proxy-label">납기일</label>
                    <div className="proxy-date-grid">
                        {dateChips.map((c) => {
                            const cls = [
                                'proxy-date-btn',
                                dueDate === c.iso && 'on',
                                c.isToday && 'today',
                                c.dow === 0 && 'sun',
                                c.dow === 6 && 'sat',
                            ].filter(Boolean).join(' ');
                            return (
                                <button key={c.iso} type="button" className={cls} onClick={() => setDueDate(c.iso)}>
                                    <span className="proxy-date-md">{c.m}/{c.d}</span>
                                    <span className="proxy-date-dow">{c.isToday ? '오늘' : DAY_NAMES[c.dow]}</span>
                                </button>
                            );
                        })}
                    </div>

                    <label className="proxy-label" style={{ marginTop: 16 }}>납기 시간</label>
                    <div className="proxy-time-row">
                        {DUE_TIMES.map((t) => (
                            <button
                                key={t.value}
                                type="button"
                                className={`proxy-time-btn ${!customTimeMode && dueTime === t.value ? 'on' : ''}`}
                                onClick={() => { setCustomTimeMode(false); setDueTime(t.value); }}
                            >
                                <span>{t.value}</span>
                                <span className="proxy-time-desc">{t.desc}</span>
                            </button>
                        ))}
                        <button
                            type="button"
                            className={`proxy-time-btn ${customTimeMode ? 'on' : ''}`}
                            onClick={() => {
                                setCustomTimeMode(true);
                                if (DUE_TIME_PRESETS.includes(dueTime)) setDueTime('');
                            }}
                        >
                            <span>시간 지정</span>
                            <span className="proxy-time-desc">직접 입력</span>
                        </button>
                    </div>
                    {customTimeMode && (
                        <div className="proxy-time-custom">
                            <div className="proxy-ampm-toggle">
                                {['오전', '오후'].map((ap) => (
                                    <button
                                        key={ap}
                                        type="button"
                                        className={`proxy-ampm-btn ${customAmpm === ap ? 'on' : ''}`}
                                        onClick={() => {
                                            setCustomAmpm(ap);
                                            setDueTime(composeCustomTime(ap, customHour, customMinute));
                                        }}
                                    >
                                        {ap}
                                    </button>
                                ))}
                            </div>
                            <div className="proxy-hm-row">
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    className="proxy-hm-input"
                                    placeholder="00"
                                    maxLength={2}
                                    value={customHour}
                                    onChange={(e) => {
                                        const v = e.target.value.replace(/\D/g, '').slice(0, 2);
                                        const n = v === '' ? '' : Math.min(12, parseInt(v, 10) || 0);
                                        const next = n === '' ? '' : String(n);
                                        setCustomHour(next);
                                        setDueTime(composeCustomTime(customAmpm, next, customMinute));
                                        if (next.length === 2 || (next.length === 1 && parseInt(next, 10) > 1)) {
                                            minuteInputRef.current?.focus();
                                            minuteInputRef.current?.select();
                                        }
                                    }}
                                />
                                <span className="proxy-hm-unit">시</span>
                                <input
                                    ref={minuteInputRef}
                                    type="text"
                                    inputMode="numeric"
                                    className="proxy-hm-input"
                                    placeholder="00"
                                    maxLength={2}
                                    value={customMinute}
                                    onChange={(e) => {
                                        const v = e.target.value.replace(/\D/g, '').slice(0, 2);
                                        const n = v === '' ? '' : Math.min(59, parseInt(v, 10) || 0);
                                        const next = n === '' ? '' : String(n);
                                        setCustomMinute(next);
                                        setDueTime(composeCustomTime(customAmpm, customHour, next));
                                    }}
                                />
                                <span className="proxy-hm-unit">분</span>
                            </div>
                        </div>
                    )}

                    <label className="proxy-label" style={{ marginTop: 16 }}>납품 방법</label>
                    <div className="proxy-delivery-row">
                        {DELIVERY_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                className={`proxy-delivery-btn ${delivery === opt.value ? 'on' : ''}`}
                                onClick={() => setDelivery(opt.value)}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>

                    {delivery !== 'PICKUP' && (
                        <>
                            <label className="proxy-label" style={{ marginTop: 16 }}>
                                {delivery === 'CARGO' ? '화물 지점' : delivery === 'LOCAL_CARGO' ? '하차 주소' : '배송 주소'}
                            </label>
                            <input
                                type="text"
                                className="proxy-input"
                                value={deliveryAddress}
                                onChange={(e) => setDeliveryAddress(e.target.value)}
                                placeholder={delivery === 'CARGO' ? '예) 경동택배 군포금정214영업소' : '주소를 입력하세요'}
                            />
                        </>
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
