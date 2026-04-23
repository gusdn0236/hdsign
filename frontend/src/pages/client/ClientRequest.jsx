import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { submitOrderApi } from '../../api/client';
import './ClientRequest.css';

const DELIVERY_OPTIONS = [
    { value: 'CARGO',  label: '화물 발송', desc: '지정 화물 지점으로 납품합니다' },
    { value: 'QUICK',  label: '퀵 발송',   desc: '퀵서비스를 통해 지정 주소로 발송합니다' },
    { value: 'DIRECT', label: '직접 배송', desc: 'HD사인 배송팀이 해당 주소로 직접 배송합니다' },
    { value: 'PICKUP', label: '직접 픽업', desc: '고객님이 직접 HD사인을 방문하여 수령합니다' },
];

const ADDITIONAL_ITEMS = [
    { id: 'smps', label: '파워기(SMPS)' },
    { id: 'paper_draft', label: '종이도안' },
    { id: 'sheet_template', label: '시트현도' },
    { id: 'bolts_nuts', label: '볼트&너트' },
    { id: 'extra_paint', label: '여분페인트' },
];

const DUE_TIMES = [
    { value: '오전 중', desc: '12시 이전' },
    { value: '오후 중', desc: '12시 이후' },
    { value: '당일 내', desc: '시간 무관' },
];

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

function DatePicker({ value, onChange }) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const days = Array.from({ length: 14 }, (_, i) => {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        return d;
    });

    const toISODate = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    return (
        <div className="date-grid">
            {days.map((d, i) => {
                const iso = toISODate(d);
                const isSelected = value === iso;
                const isToday = i === 0;
                const dayIdx = d.getDay();
                const classes = [
                    'date-btn',
                    isSelected && 'active',
                    isToday && 'today',
                    dayIdx === 0 && 'sunday',
                    dayIdx === 6 && 'saturday',
                ].filter(Boolean).join(' ');
                return (
                    <button key={iso} type="button" className={classes} onClick={() => onChange(iso)}>
                        <span className="date-md">{d.getMonth() + 1}/{d.getDate()}</span>
                        <span className="date-dow">{isToday ? '오늘' : DAY_NAMES[dayIdx]}</span>
                    </button>
                );
            })}
        </div>
    );
}

const LARGE_LINK_THRESHOLD_MB = 25;
const MAX_TOTAL_FILE_SIZE_MB = 300;
const MAX_TOTAL_FILE_SIZE_BYTES = MAX_TOTAL_FILE_SIZE_MB * 1024 * 1024;

function FileDropZone({ files, onFilesChange }) {
    const [dragging, setDragging] = useState(false);
    const inputRef = useRef(null);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setDragging(false);
        onFilesChange([...files, ...Array.from(e.dataTransfer.files)]);
    }, [files, onFilesChange]);

    const removeFile = (idx) => onFilesChange(files.filter((_, i) => i !== idx));

    const formatSize = (bytes) => {
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const getIcon = (name) => {
        const ext = name.split('.').pop().toLowerCase();
        if (ext === 'ai') return '🎨';
        if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return '🖼️';
        if (ext === 'pdf') return '📄';
        if (['zip', 'rar'].includes(ext)) return '📦';
        return '📎';
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
                    AI, PDF, JPG, PNG, ZIP 등 모든 형식 가능 ({LARGE_LINK_THRESHOLD_MB}MB 초과분 자동 대용량 링크 전환, 총 {MAX_TOTAL_FILE_SIZE_MB}MB)
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
                    {files.map((file, idx) => (
                        <li key={idx} className="file-item">
                            <span className="file-icon">{getIcon(file.name)}</span>
                            <div className="file-info">
                                <span className="file-name">{file.name}</span>
                                <span className="file-size">{formatSize(file.size)}</span>
                            </div>
                            <button className="file-remove" type="button" onClick={() => removeFile(idx)}>×</button>
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
                {images.map((file, idx) => (
                    <img key={idx} src={URL.createObjectURL(file)} alt={file.name} className="preview-img" />
                ))}
            </div>
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

function RequestSidebar({ selectedItems, onToggle, customItems, customInput, onInputChange, onAdd, onRemove, smpsWatt, onSmpsWattChange, quantities, onChangeQty }) {
    const handleKeyDown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); onAdd(); }
    };

    const QtyCtrl = ({ label }) => (
        <div className="item-qty-ctrl" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => onChangeQty(label, -1)}>−</button>
            <span>{quantities[label] || 1}</span>
            <button type="button" onClick={() => onChangeQty(label, 1)}>+</button>
        </div>
    );

    return (
        <div className="request-sidebar">
            <div className="sidebar-panel">
                <h3 className="sidebar-title">추가 물품 선택</h3>
                <p className="sidebar-sub">필요한 항목을 선택하세요</p>
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
                                    {checked && <QtyCtrl label={item.label} />}
                                </div>
                                {item.label === '파워기(SMPS)' && checked && (
                                    <div className="smps-watt-selector">
                                        {SMPS_WATTS.map((w) => (
                                            <button
                                                key={w}
                                                type="button"
                                                className={`watt-btn ${smpsWatt === w ? 'active' : ''}`}
                                                onClick={() => onSmpsWattChange(smpsWatt === w ? '' : w)}
                                            >
                                                {w}W
                                            </button>
                                        ))}
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
                                    {checked && <QtyCtrl label={label} />}
                                    <button
                                        type="button"
                                        className="sidebar-item-remove"
                                        onClick={(e) => { e.stopPropagation(); onRemove(label); }}
                                    >×</button>
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
                    >추가</button>
                </div>
            </div>
        </div>
    );
}

export default function ClientRequest() {
    const { clientToken, clientLogout } = useAuth();
    const navigate = useNavigate();
    const [title, setTitle] = useState('');
    const [files, setFiles] = useState([]);
    const [selectedItems, setSelectedItems] = useState([]);
    const [customItems, setCustomItems] = useState([]);
    const [customInput, setCustomInput] = useState('');
    const [smpsWatt, setSmpsWatt] = useState('');
    const [quantities, setQuantities] = useState({});
    const [note, setNote] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [dueTime, setDueTime] = useState('');
    const [delivery, setDelivery] = useState('CARGO');
    const [cargoPoint, setCargoPoint] = useState('');
    const [address, setAddress] = useState('');
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState('');

    const toggleItem = (label) => {
        setSelectedItems((prev) => {
            if (prev.includes(label)) {
                if (label === '파워기(SMPS)') setSmpsWatt('');
                setQuantities((q) => { const next = { ...q }; delete next[label]; return next; });
                return prev.filter((i) => i !== label);
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
        if (!trimmed || customItems.includes(trimmed) || ADDITIONAL_ITEMS.some(i => i.label === trimmed)) return;
        setCustomItems((prev) => [...prev, trimmed]);
        setSelectedItems((prev) => [...prev, trimmed]);
        setCustomInput('');
    };

    const removeCustomItem = (label) => {
        setCustomItems((prev) => prev.filter((i) => i !== label));
        setSelectedItems((prev) => prev.filter((i) => i !== label));
        setQuantities((q) => { const next = { ...q }; delete next[label]; return next; });
    };

    const reset = () => {
        setTitle('');
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

    const BLOCK_DIVIDER = '─────────────────';

    const itemsBlock = useMemo(() => {
        if (!selectedItems.length) return '';
        const lines = selectedItems.map((item) => {
            const label = item === '파워기(SMPS)' && smpsWatt ? `파워기(SMPS) ${smpsWatt}W` : item;
            const qty = quantities[item] || 1;
            return `• ${label}: ${qty}개`;
        });
        return `[추가 물품]\n${lines.join('\n')}\n${BLOCK_DIVIDER}\n`;
    }, [selectedItems, quantities, smpsWatt]);

    const textareaValue = itemsBlock + note;

    const handleNoteChange = (e) => {
        const val = e.target.value;
        if (itemsBlock && val.startsWith(itemsBlock)) {
            setNote(val.slice(itemsBlock.length));
        } else if (!itemsBlock) {
            setNote(val);
        } else {
            const divIdx = val.indexOf(BLOCK_DIVIDER);
            if (divIdx >= 0) {
                setNote(val.slice(divIdx + BLOCK_DIVIDER.length).replace(/^\n/, ''));
            }
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (!title.trim()) return setError('작업 요청 제목을 입력해주세요.');
        if (!files.length) return setError('작업 파일을 1개 이상 업로드해주세요.');
        const totalSize = files.reduce((sum, file) => sum + (file?.size || 0), 0);
        if (totalSize > MAX_TOTAL_FILE_SIZE_BYTES) {
            return setError(`첨부파일 총 용량은 ${MAX_TOTAL_FILE_SIZE_MB}MB 이하여야 합니다.`);
        }
        if (!dueDate) return setError('납품 희망일을 선택해주세요.');
        if (!dueTime) return setError('납품 시간대를 선택해주세요.');
        if (delivery === 'CARGO' && !cargoPoint.trim()) return setError('화물 지점을 입력해주세요.');
        if ((delivery === 'QUICK' || delivery === 'DIRECT') && !address.trim()) return setError('주소를 입력해주세요.');

        setLoading(true);
        try {
            const formData = new FormData();
            files.forEach((file) => formData.append('files', file));
            formData.append('title', title.trim());
            const itemsWithDetail = selectedItems.map((item) => {
                const label = item === '파워기(SMPS)' && smpsWatt ? `파워기(SMPS) ${smpsWatt}W` : item;
                const qty = quantities[item] || 1;
                return `${label} ${qty}개`;
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
                    <p className="submitted-desc">담당자가 확인 후 곧 연락드리겠습니다.</p>
                    <button className="req-submit-btn" onClick={reset}>새 요청 작성하기</button>
                </div>
            </div>
        );
    }

    return (
        <div className="request-page">
            <div className="request-page-header">
                <h1 className="request-page-title">작업 요청 접수</h1>
            </div>
            <div className="request-notice">
                <span className="request-notice-icon">✉</span>
                <div className="request-notice-text">
                    <p>접수하기 버튼을 누르시면 입력하신 내용과 첨부 파일이 <strong>HD사인 담당자(hdno88@daum.net)에게 자동으로 전달</strong>됩니다.</p>
                    <p>담당자 확인 후 빠르게 연락드리겠습니다.<br />접수 내역은 <strong>고객님의 보낸메일함</strong>에서 확인하실 수 있으며, <strong>작업 현황</strong> 메뉴에서 진행 상황을 실시간으로 확인하실 수 있습니다.</p>
                </div>
            </div>
            <form className="request-form" onSubmit={handleSubmit}>
                <div className="request-layout">
                    <div className="request-sections">
                        <Section number="01" title="작업 요청 제목">
                            <input
                                type="text"
                                className="req-input"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="예) 푸드케어 내부 아크릴, 행복치과의원 외부사인"
                                maxLength={100}
                            />
                        </Section>

                        <Section number="02" title="작업 파일 업로드">
                            <FileDropZone files={files} onFilesChange={setFiles} />
                            <ImagePreview files={files} />
                        </Section>

                        <Section number="03" title="추가 요청사항">
                            <textarea
                                className="req-textarea"
                                value={textareaValue}
                                onChange={handleNoteChange}
                                placeholder="색상, 소재, 크기, 수량, 특이사항 등 자유롭게 작성해주세요..."
                                rows={5}
                            />
                            <p className="char-count">{textareaValue.length}자</p>
                        </Section>

                        <Section number="04" title="마감 및 납품 희망일">
                            <DatePicker
                                value={dueDate}
                                onChange={(d) => { setDueDate(d); setDueTime(''); }}
                            />
                            {dueDate && (
                                <div className="due-time-wrap">
                                    {DUE_TIMES.map((t) => (
                                        <button
                                            key={t.value}
                                            type="button"
                                            className={`due-time-btn ${dueTime === t.value ? 'active' : ''}`}
                                            onClick={() => setDueTime(t.value)}
                                        >
                                            <span className="time-label">{t.value}</span>
                                            <span className="time-desc">{t.desc}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </Section>

                        <Section number="05" title="납품 방법">
                            <div className="delivery-options">
                                {DELIVERY_OPTIONS.map((opt) => (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        className={`delivery-option-btn ${delivery === opt.value ? 'active' : ''}`}
                                        onClick={() => setDelivery(opt.value)}
                                    >
                                        <span className="delivery-option-label">{opt.label}</span>
                                        <span className="delivery-option-desc">{opt.desc}</span>
                                    </button>
                                ))}
                            </div>
                            {delivery === 'CARGO' && (
                                <div className="delivery-input-wrap">
                                    <label className="req-label">화물 지점 입력</label>
                                    <input
                                        type="text"
                                        className="req-input"
                                        value={cargoPoint}
                                        onChange={(e) => setCargoPoint(e.target.value)}
                                        placeholder="예) CJ대한통운 군포터미널, 한진택배 안양점..."
                                    />
                                </div>
                            )}
                            {(delivery === 'QUICK' || delivery === 'DIRECT') && (
                                <div className="delivery-input-wrap">
                                    <label className="req-label">{delivery === 'QUICK' ? '퀵 수령 주소' : '배송 주소'}</label>
                                    <input
                                        type="text"
                                        className="req-input"
                                        value={address}
                                        onChange={(e) => setAddress(e.target.value)}
                                        placeholder="도로명 주소를 입력해주세요..."
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
