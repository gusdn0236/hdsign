import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { submitOrderApi } from '../../api/client';
import './ClientRequest.css';

const DELIVERY_OPTIONS = [
    { value: 'CARGO', label: '화물 발송', desc: '지정한 화물 지점으로 납품합니다.' },
    { value: 'QUICK', label: '퀵 발송', desc: '퀵서비스를 통해 지정 주소로 발송합니다.' },
    { value: 'DIRECT', label: '직접 배송', desc: 'HD Sign이 지정 주소로 직접 배송합니다.' },
    { value: 'LOCAL_CARGO', label: '지방화물차 배송', desc: '전날 상차하여 지정 시간에 지방으로 합차/단독 하차합니다.' },
    { value: 'PICKUP', label: '직접 수령', desc: '고객사가 직접 방문하여 수령합니다.' },
];

const ADDITIONAL_ITEMS = [
    { id: 'smps', label: '파워기(SMPS)' },
    { id: 'paper_draft', label: '종이도안' },
    { id: 'sheet_template', label: '시트 현도' },
    { id: 'bolts_nuts', label: '볼트&너트' },
    { id: 'extra_paint', label: '여분 페인트' },
];

const DUE_TIMES = [
    { value: '오전 중', desc: '12시 이전' },
    { value: '오후 중', desc: '12시 이후' },
    { value: '당일 내', desc: '시간 무관' },
];

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
// 50MB 초과 시 Railway 메모리/타임아웃 부담 + 일러스트 COM RPC 실패 위험이 커서, 한도를 명시하고
// 초과 케이스는 분할 발주 또는 이메일로 안내한다.
const MAX_TOTAL_FILE_SIZE_MB = 50;
const MAX_TOTAL_FILE_SIZE_BYTES = MAX_TOTAL_FILE_SIZE_MB * 1024 * 1024;
const COMPANY_EMAIL = 'hdno88@daum.net';

function OversizeNotice({ open, totalMB, onClose }) {
    if (!open) return null;
    const copyEmail = () => {
        try { navigator.clipboard.writeText(COMPANY_EMAIL); } catch (_) {}
    };
    return (
        <div className="oversize-overlay" role="dialog" aria-modal="true" onClick={onClose}>
            <div className="oversize-modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="oversize-title">파일 용량이 너무 큽니다</h3>
                <p className="oversize-desc">
                    첨부 총 용량 <b>{totalMB}MB</b>가 한도(<b>{MAX_TOTAL_FILE_SIZE_MB}MB</b>)를 초과했습니다.<br />
                    아래 두 가지 중 한 가지로 진행해 주세요.
                </p>
                <div className="oversize-options">
                    <div className="oversize-option">
                        <span className="oversize-option-num">1</span>
                        <div className="oversize-option-body">
                            <b>파일을 나누어 여러 건으로 발주</b>
                            <span className="oversize-sub">한 건당 {MAX_TOTAL_FILE_SIZE_MB}MB 이하가 되도록 나눠 보내주세요.</span>
                        </div>
                    </div>
                    <div className="oversize-option">
                        <span className="oversize-option-num">2</span>
                        <div className="oversize-option-body">
                            <b>이메일로 발주</b>
                            <span className="oversize-sub">아래 주소로 파일과 발주 내용을 보내주시면 동일하게 접수됩니다.</span>
                            <div className="oversize-email-row">
                                <span className="oversize-email">{COMPANY_EMAIL}</span>
                                <button type="button" className="oversize-copy" onClick={copyEmail}>복사</button>
                            </div>
                        </div>
                    </div>
                </div>
                <p className="oversize-warn">
                    ※ 메일로 발주하신 작업물은 <b>작업현황 페이지에서 실시간 확인이 어렵습니다.</b><br />
                    발주는 정상적으로 접수되오니 진행 상황은 <b>사무실로 문의</b> 바랍니다.
                </p>
                <button type="button" className="oversize-close" onClick={onClose}>확인</button>
            </div>
        </div>
    );
}
function DatePicker({ value, onChange }) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const days = Array.from({ length: 14 }, (_, index) => {
        const nextDay = new Date(today);
        nextDay.setDate(today.getDate() + index);
        return nextDay;
    });

    const toISODate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    return (
        <div className="date-grid">
            {days.map((date, index) => {
                const isoDate = toISODate(date);
                const isSelected = value === isoDate;
                const isToday = index === 0;
                const dayIndex = date.getDay();
                const classes = [
                    'date-btn',
                    isSelected && 'active',
                    isToday && 'today',
                    dayIndex === 0 && 'sunday',
                    dayIndex === 6 && 'saturday',
                ].filter(Boolean).join(' ');

                return (
                    <button key={isoDate} type="button" className={classes} onClick={() => onChange(isoDate)}>
                        <span className="date-md">{date.getMonth() + 1}/{date.getDate()}</span>
                        <span className="date-dow">{isToday ? '오늘' : DAY_NAMES[dayIndex]}</span>
                    </button>
                );
            })}
        </div>
    );
}

function FileDropZone({ files, onFilesChange }) {
    const [dragging, setDragging] = useState(false);
    const inputRef = useRef(null);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setDragging(false);
        onFilesChange([...files, ...Array.from(e.dataTransfer.files || [])]);
    }, [files, onFilesChange]);

    const removeFile = (index) => onFilesChange(files.filter((_, idx) => idx !== index));

    const formatSize = (bytes) => {
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const FILE_BADGES = {
        ai:    { label: 'Ai',   color: '#e07000', bg: '#fff3e0' },
        pdf:   { label: 'PDF',  color: '#c62828', bg: '#ffebee' },
        image: { label: 'IMG',  color: '#0277bd', bg: '#e1f5fe' },
        zip:   { label: 'ZIP',  color: '#6a1fa2', bg: '#f3e5f5' },
        file:  { label: 'FILE', color: '#546e7a', bg: '#eceff1' },
    };

    const getIcon = (name) => {
        const ext = name.split('.').pop().toLowerCase();
        const key = ext === 'ai' ? 'ai'
            : ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? 'image'
            : ext === 'pdf' ? 'pdf'
            : ['zip', 'rar'].includes(ext) ? 'zip'
            : 'file';
        const { label, color, bg } = FILE_BADGES[key];
        return (
            <span className="file-type-badge" style={{ color, background: bg }}>
                {label}
            </span>
        );
    };

    return (
        <div>
            <div
                className={`drop-zone ${dragging ? 'dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
            >
                <span className="drop-zone-icon">📁</span>
                <p className="drop-zone-text">파일을 드래그하거나 클릭하여 업로드</p>
                <p className="drop-zone-sub">
                    AI, PDF, JPG, PNG, ZIP 등 모든 형식 가능 (총 {MAX_TOTAL_FILE_SIZE_MB}MB 이하)
                </p>
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => onFilesChange([...files, ...Array.from(e.target.files || [])])}
                />
            </div>
            {files.length > 0 && (
                <ul className="file-list">
                    {files.map((file, index) => (
                        <li key={`${file.name}-${index}`} className="file-item">
                            {getIcon(file.name)}
                            <div className="file-info">
                                <span className="file-name">{file.name}</span>
                                <span className="file-size">{formatSize(file.size)}</span>
                            </div>
                            <button className="file-remove" type="button" onClick={() => removeFile(index)}>×</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function ImagePreview({ files }) {
    const images = files.filter((file) =>
        ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(file.name.split('.').pop().toLowerCase())
    );

    if (!images.length) return null;

    return (
        <div className="preview-wrap">
            <p className="preview-label">이미지 미리보기</p>
            <div className="preview-grid">
                {images.map((file, index) => (
                    <img key={`${file.name}-${index}`} src={URL.createObjectURL(file)} alt={file.name} className="preview-img" />
                ))}
            </div>
        </div>
    );
}

function AddressInput({ value, onChange, placeholder, savedKey, withSearch }) {
    const [saved, setSaved] = useState(() => {
        try { return JSON.parse(localStorage.getItem(savedKey) || '[]'); }
        catch { return []; }
    });

    useEffect(() => {
        if (!withSearch || window.daum?.Postcode) return;
        const script = document.createElement('script');
        script.src = 'https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
        document.head.appendChild(script);
    }, [withSearch]);

    const openKakao = () => {
        new window.daum.Postcode({
            oncomplete: (data) => onChange(data.roadAddress || data.jibunAddress),
        }).open();
    };

    const saveAddress = () => {
        const trimmed = value.trim();
        if (!trimmed || saved.includes(trimmed)) return;
        const next = [trimmed, ...saved].slice(0, 5);
        setSaved(next);
        localStorage.setItem(savedKey, JSON.stringify(next));
    };

    const removeAddress = (addr) => {
        const next = saved.filter((a) => a !== addr);
        setSaved(next);
        localStorage.setItem(savedKey, JSON.stringify(next));
    };

    const canSave = value.trim() && !saved.includes(value.trim());

    return (
        <div className="address-input-wrap">
            {saved.length > 0 && (
                <div className="saved-addresses">
                    <span className="saved-addr-label">저장된 주소</span>
                    {saved.map((addr) => (
                        <span key={addr} className="saved-addr-chip">
                            <button type="button" className="saved-addr-select" onClick={() => onChange(addr)}>{addr}</button>
                            <button type="button" className="saved-addr-remove" onClick={() => removeAddress(addr)}>×</button>
                        </span>
                    ))}
                </div>
            )}
            <div className="address-input-row">
                <input
                    type="text"
                    className="req-input"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    readOnly={withSearch}
                    style={withSearch ? { cursor: 'pointer' } : {}}
                    onClick={withSearch ? openKakao : undefined}
                />
                {withSearch && (
                    <button type="button" className="addr-search-btn" onClick={openKakao}>
                        🔍 검색
                    </button>
                )}
            </div>
            {canSave && (
                <button type="button" className="addr-save-btn" onClick={saveAddress}>
                    + 자주 쓰는 주소로 저장
                </button>
            )}
        </div>
    );
}

function Section({ number, title, children }) {
    return (
        <div className="req-section">
            <div className="req-section-header">
                <span className="req-section-num">{number}</span>
                <h3 className="req-section-title">{title}</h3>
            </div>
            {children}
        </div>
    );
}

const SMPS_WATTS = ['30', '70', '100', '150', '200', '300', '400', '500'];
// 조립 후 LED 수량을 보고 W수를 정해야 하는 케이스. 클라이언트가 미리 W수를 못 정할 때 선택.
const SMPS_QTY_MATCH = 'QTY_MATCH';

function formatSmpsLabel(watt) {
    if (!watt) return '파워기(SMPS)';
    if (watt === SMPS_QTY_MATCH) return '파워기(SMPS) LED수량맞춤';
    return `파워기(SMPS) ${watt}W`;
}

function RequestSidebar({
    selectedItems,
    onToggle,
    customItems,
    customInput,
    onInputChange,
    onAdd,
    onRemove,
    smpsWatt,
    onSmpsWattChange,
    quantities,
    onChangeQty,
}) {
    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            onAdd();
        }
    };

    const QtyCtrl = ({ label }) => (
        <div className="item-qty-ctrl" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => onChangeQty(label, -1)}>-</button>
            <span>{quantities[label] || 1}</span>
            <button type="button" onClick={() => onChangeQty(label, 1)}>+</button>
        </div>
    );

    return (
        <div className="request-sidebar">
            <div className="sidebar-panel">
                <h3 className="sidebar-title">추가 물품 선택</h3>
                <p className="sidebar-sub">필요한 항목을 선택해 주세요</p>
                <ul className="sidebar-items">
                    {ADDITIONAL_ITEMS.map((item) => {
                        const checked = selectedItems.includes(item.label);
                        return (
                            <li key={item.id}>
                                <div
                                    className={`sidebar-item ${checked ? 'checked' : ''}`}
                                    onClick={() => onToggle(item.label)}
                                >
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => onToggle(item.label)}
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                    <span className="sidebar-item-text">{item.label}</span>
                                    {checked && item.label === '파워기(SMPS)' && <QtyCtrl label={item.label} />}
                                </div>
                                {item.label === '파워기(SMPS)' && checked && (
                                    <div className="smps-watt-selector">
                                        {SMPS_WATTS.map((watt) => (
                                            <button
                                                key={watt}
                                                type="button"
                                                className={`watt-btn ${smpsWatt === watt ? 'active' : ''}`}
                                                onClick={() => onSmpsWattChange(smpsWatt === watt ? '' : watt)}
                                            >
                                                {watt}W
                                            </button>
                                        ))}
                                        <button
                                            key={SMPS_QTY_MATCH}
                                            type="button"
                                            className={`watt-btn watt-btn-qty ${smpsWatt === SMPS_QTY_MATCH ? 'active' : ''}`}
                                            onClick={() => onSmpsWattChange(smpsWatt === SMPS_QTY_MATCH ? '' : SMPS_QTY_MATCH)}
                                            title="조립 후 LED 수량에 맞춰 W수를 결정"
                                        >
                                            LED수량맞춤
                                        </button>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                    {customItems.map((label) => {
                        const checked = selectedItems.includes(label);
                        return (
                            <li key={label}>
                                <div
                                    className={`sidebar-item ${checked ? 'checked' : ''}`}
                                    onClick={() => onToggle(label)}
                                >
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => onToggle(label)}
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                    <span className="sidebar-item-text">{label}</span>
                                    <button
                                        type="button"
                                        className="sidebar-item-remove"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onRemove(label);
                                        }}
                                    >
                                        ×
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
                <div className="sidebar-custom-input">
                    <input
                        type="text"
                        className="sidebar-custom-text"
                        value={customInput}
                        onChange={(e) => onInputChange(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="직접 입력..."
                        maxLength={30}
                    />
                    <button
                        type="button"
                        className="sidebar-custom-add"
                        onClick={onAdd}
                        disabled={!customInput.trim()}
                    >
                        추가
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function ClientRequest() {
    const { clientToken, clientLogout, clientUser } = useAuth();
    const username = clientUser?.username || 'guest';
    const navigate = useNavigate();
    const [title, setTitle] = useState('');
    const [titleAutoFilled, setTitleAutoFilled] = useState(false);
    const [files, setFiles] = useState([]);
    const [selectedItems, setSelectedItems] = useState([]);
    const [customItems, setCustomItems] = useState([]);
    const [customInput, setCustomInput] = useState('');
    const [smpsWatt, setSmpsWatt] = useState('');
    const [quantities, setQuantities] = useState({});
    const [note, setNote] = useState('');
    const [noteTemplates, setNoteTemplates] = useState([]);
    const [dueDate, setDueDate] = useState('');
    const [dueTime, setDueTime] = useState('');
    const [delivery, setDelivery] = useState('CARGO');
    const [cargoPoint, setCargoPoint] = useState('');
    const [address, setAddress] = useState('');
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState('');
    const [pageDragging, setPageDragging] = useState(false);
    const dragCounter = useRef(0);
    const filesRef = useRef(files);
    filesRef.current = files;
    const titleRef = useRef(title);
    titleRef.current = title;

    const noteTplKey = `hd_note_templates_${username}`;

    useEffect(() => {
        try {
            const raw = localStorage.getItem(noteTplKey);
            setNoteTemplates(raw ? JSON.parse(raw) || [] : []);
        } catch {
            setNoteTemplates([]);
        }
    }, [noteTplKey]);

    const persistNoteTemplates = (next) => {
        setNoteTemplates(next);
        try {
            localStorage.setItem(noteTplKey, JSON.stringify(next));
        } catch {
            /* ignore quota errors */
        }
    };

    const saveNoteTemplate = () => {
        const v = note.trim();
        if (!v) return;
        if (noteTemplates.includes(v)) return;
        persistNoteTemplates([v, ...noteTemplates].slice(0, 8));
    };

    const removeNoteTemplate = (text) => {
        persistNoteTemplates(noteTemplates.filter((t) => t !== text));
    };

    const insertNoteTemplate = (text) => {
        const cur = note;
        if (cur.includes(text)) return;
        setNote(cur.trim() ? `${cur.replace(/\s+$/, '')}\n${text}` : text);
    };

    useEffect(() => {
        const onDragEnter = (e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            dragCounter.current++;
            setPageDragging(true);
        };
        const onDragLeave = () => {
            dragCounter.current--;
            if (dragCounter.current === 0) setPageDragging(false);
        };
        const onDragOver = (e) => e.preventDefault();
        const onDrop = (e) => {
            // 로컬 FileDropZone에서 이미 preventDefault() 했으면 중복 처리 방지
            const alreadyHandled = e.defaultPrevented;
            e.preventDefault();
            dragCounter.current = 0;
            setPageDragging(false);
            if (alreadyHandled) return;
            const dropped = Array.from(e.dataTransfer.files || []);
            if (!dropped.length) return;
            const newFiles = [...filesRef.current, ...dropped];
            const totalBytes = newFiles.reduce((s, f) => s + (f?.size || 0), 0);
            if (totalBytes > MAX_TOTAL_FILE_SIZE_BYTES) {
                setOversizeNotice({ open: true, totalMB: Math.ceil(totalBytes / 1024 / 1024) });
                return;
            }
            setFiles(newFiles);
            if (!titleRef.current.trim()) {
                setTitle(newFiles[0].name.replace(/\.[^/.]+$/, ''));
                setTitleAutoFilled(true);
            }
        };
        window.addEventListener('dragenter', onDragEnter);
        window.addEventListener('dragleave', onDragLeave);
        window.addEventListener('dragover', onDragOver);
        window.addEventListener('drop', onDrop);
        return () => {
            window.removeEventListener('dragenter', onDragEnter);
            window.removeEventListener('dragleave', onDragLeave);
            window.removeEventListener('dragover', onDragOver);
            window.removeEventListener('drop', onDrop);
        };
    }, []);

    const toggleItem = (label) => {
        setSelectedItems((prev) => {
            if (prev.includes(label)) {
                if (label === '파워기(SMPS)') setSmpsWatt('');
                setQuantities((q) => {
                    const next = { ...q };
                    delete next[label];
                    return next;
                });
                return prev.filter((item) => item !== label);
            }
            setQuantities((q) => ({ ...q, [label]: 1 }));
            return [...prev, label];
        });
    };

    const changeQty = (label, delta) => {
        setQuantities((q) => ({ ...q, [label]: Math.max(1, (q[label] || 1) + delta) }));
    };

    const addCustomItem = () => {
        const trimmed = customInput.trim();
        if (!trimmed || customItems.includes(trimmed) || ADDITIONAL_ITEMS.some((item) => item.label === trimmed)) return;
        setCustomItems((prev) => [...prev, trimmed]);
        setSelectedItems((prev) => [...prev, trimmed]);
        setCustomInput('');
    };

    const removeCustomItem = (label) => {
        setCustomItems((prev) => prev.filter((item) => item !== label));
        setSelectedItems((prev) => prev.filter((item) => item !== label));
        setQuantities((q) => {
            const next = { ...q };
            delete next[label];
            return next;
        });
    };

    const [oversizeNotice, setOversizeNotice] = useState({ open: false, totalMB: 0 });

    const handleFilesChange = useCallback((newFiles) => {
        const totalBytes = newFiles.reduce((s, f) => s + (f?.size || 0), 0);
        if (totalBytes > MAX_TOTAL_FILE_SIZE_BYTES) {
            setOversizeNotice({ open: true, totalMB: Math.ceil(totalBytes / 1024 / 1024) });
            return; // 한도 초과분은 추가 거부 — 기존 files 그대로 유지
        }
        setFiles(newFiles);
        if (!title.trim() && newFiles.length > 0) {
            const suggested = newFiles[0].name.replace(/\.[^/.]+$/, '');
            setTitle(suggested);
            setTitleAutoFilled(true);
        }
        if (newFiles.length === 0) setTitleAutoFilled(false);
    }, [title]);

    const handleTitleChange = (e) => {
        setTitle(e.target.value);
        setTitleAutoFilled(false);
    };

    const reset = () => {
        setTitle('');
        setTitleAutoFilled(false);
        setFiles([]);
        setSelectedItems([]);
        setCustomItems([]);
        setCustomInput('');
        setSmpsWatt('');
        setQuantities({});
        setNote('');
        setDueDate('');
        setDueTime('');
        setDelivery('CARGO');
        setCargoPoint('');
        setAddress('');
        setSubmitted(false);
        setError('');
    };

    const itemsPreviewLines = useMemo(() => {
        if (!selectedItems.length) return [];
        return selectedItems.map((item) => {
            if (item === '파워기(SMPS)') {
                const label = formatSmpsLabel(smpsWatt);
                const qty = quantities[item] || 1;
                return `• ${label}: ${qty}개`;
            }
            return `• ${item}`;
        });
    }, [selectedItems, quantities, smpsWatt]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (!title.trim()) return setError('작업 요청 제목을 입력해 주세요.');
        if (!files.length) return setError('작업 파일을 1개 이상 업로드해 주세요.');

        const totalSize = files.reduce((sum, file) => sum + (file?.size || 0), 0);
        if (totalSize > MAX_TOTAL_FILE_SIZE_BYTES) {
            return setError(`첨부 파일 총 용량은 ${MAX_TOTAL_FILE_SIZE_MB}MB 이하여야 합니다.`);
        }
        if (!dueDate) return setError('납기 희망일을 선택해 주세요.');
        if (!dueTime) return setError('납기 시간을 선택해 주세요.');
        if (delivery === 'CARGO' && !cargoPoint.trim()) return setError('화물 지점을 입력해 주세요.');
        if ((delivery === 'QUICK' || delivery === 'DIRECT' || delivery === 'LOCAL_CARGO') && !address.trim()) return setError('주소를 입력해 주세요.');

        setLoading(true);
        try {
            const formData = new FormData();
            files.forEach((file) => formData.append('files', file));
            formData.append('title', title.trim());

            const itemsWithDetail = selectedItems.map((item) => {
                if (item === '파워기(SMPS)') {
                    const label = formatSmpsLabel(smpsWatt);
                    const qty = quantities[item] || 1;
                    return `${label} ${qty}개`;
                }
                return item;
            });

            formData.append('additionalItems', itemsWithDetail.join(', '));
            formData.append('note', note);
            formData.append('dueDate', dueDate);
            formData.append('dueTime', dueTime);
            formData.append('deliveryMethod', delivery);
            formData.append('deliveryAddress', delivery === 'CARGO' ? cargoPoint : address);

            await submitOrderApi(formData, clientToken);
            setSubmitted(true);
        } catch (err) {
            if (err?.status === 401 || err?.status === 403) {
                clientLogout();
                navigate('/client/login', { replace: true });
                return;
            }
            setError(err.message || '접수 중 오류가 발생했습니다.');
        } finally {
            setLoading(false);
        }
    };

    if (submitted) {
        return (
            <div className="request-page">
                <div className="request-page-header">
                    <h1 className="request-page-title">작업 요청 접수</h1>
                </div>
                <div className="submitted-wrap">
                    <span className="submitted-icon">✅</span>
                    <h2 className="submitted-title">작업 요청이 접수되었습니다</h2>
                    <p className="submitted-desc">담당자가 확인 후 빠르게 연락드리겠습니다.</p>
                    <button className="req-submit-btn" onClick={reset}>새 요청 작성하기</button>
                </div>
            </div>
        );
    }

    return (
        <div className="request-page">
            {pageDragging && (
                <div className="page-drop-overlay">
                    <div className="page-drop-overlay-box">
                        <span className="page-drop-overlay-icon">📁</span>
                        <p>여기에 파일을 놓으세요</p>
                    </div>
                </div>
            )}
            <OversizeNotice
                open={oversizeNotice.open}
                totalMB={oversizeNotice.totalMB}
                onClose={() => setOversizeNotice({ open: false, totalMB: 0 })}
            />
            <div className="request-page-header">
                <h1 className="request-page-title">작업 요청 접수</h1>
            </div>

            <div className="request-notice">
                <span className="request-notice-icon">✉</span>
                <div className="request-notice-text">
                    <p>접수하기 버튼을 누르면 입력하신 내용과 첨부 파일이 <strong>HD Sign 담당자(hdno88@daum.net)에게 자동으로 전달됩니다.</strong></p>
                    <p>담당자 확인 후 빠르게 연락드리겠습니다. <strong>작업 현황</strong> 메뉴에서 진행 상황을 실시간으로 확인하실 수 있습니다.</p>
                </div>
            </div>

            <form className="request-form" onSubmit={handleSubmit}>
                <div className="request-layout">
                    <div className="request-sections">
                        <Section number="01" title="작업 정보">
                            <FileDropZone files={files} onFilesChange={handleFilesChange} />
                            <ImagePreview files={files} />
                            <div className="title-input-wrap">
                                <label className="req-label">
                                    작업 요청 제목
                                    <span className="title-label-sub">담당자에게 전달되는 메일 제목입니다</span>
                                </label>
                                <input
                                    type="text"
                                    className={`req-input${titleAutoFilled ? ' req-input--suggested' : ''}`}
                                    value={title}
                                    onChange={handleTitleChange}
                                    placeholder="예) 푸드케어 내부 아크릴, 행복치과의원 외부사인"
                                    maxLength={100}
                                />
                                {titleAutoFilled && (
                                    <span className="title-auto-hint">파일명으로 자동 입력됐어요 — 수정 가능합니다</span>
                                )}
                            </div>
                        </Section>

                        <Section number="02" title="추가 요청사항">
                            {itemsPreviewLines.length > 0 && (
                                <div className="req-items-preview">
                                    <div className="req-items-preview-title">추가 물품</div>
                                    <ul className="req-items-preview-list">
                                        {itemsPreviewLines.map((line, idx) => (
                                            <li key={idx}>{line}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {noteTemplates.length > 0 && (
                                <div className="note-templates">
                                    <div className="note-templates-label">자주 쓰는 문구 — 클릭해서 추가</div>
                                    <div className="note-template-chips">
                                        {noteTemplates.map((tpl) => (
                                            <span
                                                key={tpl}
                                                className={`note-template-chip ${note.includes(tpl) ? 'used' : ''}`}
                                            >
                                                <button
                                                    type="button"
                                                    className="note-template-text"
                                                    onClick={() => insertNoteTemplate(tpl)}
                                                    title="추가"
                                                >
                                                    {tpl}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="note-template-remove"
                                                    onClick={() => removeNoteTemplate(tpl)}
                                                    aria-label="삭제"
                                                    title="목록에서 삭제"
                                                >
                                                    ×
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <textarea
                                className="req-textarea"
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder="색상, 자재, 크기, 수량, 특이사항 등을 자유롭게 적어 주세요."
                                rows={5}
                            />
                            <div className="note-actions">
                                <p className="char-count">{note.length}자</p>
                                <button
                                    type="button"
                                    className="note-save-btn"
                                    onClick={saveNoteTemplate}
                                    disabled={!note.trim() || noteTemplates.includes(note.trim())}
                                    title="이 문구를 다음 요청에서도 한 번에 불러올 수 있게 저장합니다"
                                >
                                    + 다음에도 사용
                                </button>
                            </div>
                        </Section>

                        <Section number="03" title="납기 및 납품">
                            <label className="req-label">납기 희망일</label>
                            <DatePicker
                                value={dueDate}
                                onChange={(date) => {
                                    setDueDate(date);
                                    setDueTime('');
                                }}
                            />
                            {dueDate && (
                                <div className="due-time-wrap">
                                    {DUE_TIMES.map((time) => (
                                        <button
                                            key={time.value}
                                            type="button"
                                            className={`due-time-btn ${dueTime === time.value ? 'active' : ''}`}
                                            onClick={() => setDueTime(time.value)}
                                        >
                                            <span className="time-label">{time.value}</span>
                                            <span className="time-desc">{time.desc}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            <label className="req-label" style={{ marginTop: '20px' }}>납품 방법</label>
                            <div className="delivery-options">
                                {DELIVERY_OPTIONS.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        className={`delivery-option-btn ${delivery === option.value ? 'active' : ''}`}
                                        onClick={() => setDelivery(option.value)}
                                    >
                                        <span className="delivery-option-label">{option.label}</span>
                                        <span className="delivery-option-desc">{option.desc}</span>
                                    </button>
                                ))}
                            </div>

                            {delivery === 'CARGO' && (
                                <div className="delivery-input-wrap">
                                    <label className="req-label">화물 지점 입력</label>
                                    <AddressInput
                                        value={cargoPoint}
                                        onChange={setCargoPoint}
                                        placeholder="예: CJ대한통운 구포대리점, 서진항공 안양점"
                                        savedKey={`hd_cargo_${username}`}
                                        withSearch={false}
                                    />
                                </div>
                            )}

                            {(delivery === 'QUICK' || delivery === 'DIRECT' || delivery === 'LOCAL_CARGO') && (
                                <div className="delivery-input-wrap">
                                    <label className="req-label">
                                        {delivery === 'QUICK'
                                            ? '퀵 수령 주소'
                                            : delivery === 'LOCAL_CARGO'
                                                ? '하차 주소'
                                                : '배송 주소'}
                                    </label>
                                    <AddressInput
                                        value={address}
                                        onChange={setAddress}
                                        placeholder="클릭하여 주소 검색"
                                        savedKey={`hd_addr_${username}`}
                                        withSearch={true}
                                    />
                                </div>
                            )}
                        </Section>

                        {error && <p className="req-error">{error}</p>}
                        <button type="submit" className="req-submit-btn" disabled={loading}>
                            {loading ? '접수 중...' : '작업 요청 접수하기'}
                        </button>
                    </div>

                    <RequestSidebar
                        selectedItems={selectedItems}
                        onToggle={toggleItem}
                        customItems={customItems}
                        customInput={customInput}
                        onInputChange={setCustomInput}
                        onAdd={addCustomItem}
                        onRemove={removeCustomItem}
                        smpsWatt={smpsWatt}
                        onSmpsWattChange={setSmpsWatt}
                        quantities={quantities}
                        onChangeQty={changeQty}
                    />
                </div>
            </form>
        </div>
    );
}
