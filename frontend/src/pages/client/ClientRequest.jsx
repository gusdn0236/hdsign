import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { submitOrderApi } from '../../api/client';
import './ClientRequest.css';

const DELIVERY_OPTIONS = [
    { value: 'CARGO', label: '화물 발송', desc: '지정한 화물 지점으로 납품합니다.' },
    { value: 'QUICK', label: '퀵 발송', desc: '퀵서비스를 통해 지정 주소로 발송합니다.' },
    { value: 'DIRECT', label: '직접 배송', desc: 'HD Sign이 지정 주소로 직접 배송합니다.' },
    { value: 'PICKUP', label: '직접 수령', desc: '고객사가 직접 방문하여 수령합니다.' },
];

const ADDITIONAL_ITEMS = [
    { id: 'smps', label: '파워기(SMPS)' },
    { id: 'paper_draft', label: '종이 시안' },
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
const LARGE_LINK_THRESHOLD_MB = 25;
const MAX_TOTAL_FILE_SIZE_MB = 300;
const MAX_TOTAL_FILE_SIZE_BYTES = MAX_TOTAL_FILE_SIZE_MB * 1024 * 1024;
const NOTICE_LINES = [
    '접수하기 버튼을 누르면 입력하신 내용과 첨부 파일이 HD Sign 담당자에게 자동으로 전달됩니다.',
    '담당자 확인 후 빠르게 연락드리겠습니다. 작업 현황 메뉴에서 진행 상황을 실시간으로 확인하실 수 있습니다.',
];

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

    const getIcon = (name) => {
        const ext = name.split('.').pop().toLowerCase();
        if (ext === 'ai') return '벡터';
        if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return '이미지';
        if (ext === 'pdf') return 'PDF';
        if (['zip', 'rar'].includes(ext)) return '압축';
        return '파일';
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
                <span className="drop-zone-icon">업로드</span>
                <p className="drop-zone-text">파일을 드래그하거나 클릭하여 업로드</p>
                <p className="drop-zone-sub">
                    AI, PDF, JPG, PNG, ZIP 등 모든 형식 가능 ({LARGE_LINK_THRESHOLD_MB}MB 초과분은 자동 대용량 링크 전환, 총 {MAX_TOTAL_FILE_SIZE_MB}MB)
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
                            <span className="file-icon">{getIcon(file.name)}</span>
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
                                    {checked && <QtyCtrl label={item.label} />}
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

    const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

    const itemsBlock = useMemo(() => {
        if (!selectedItems.length) return '';
        const lines = selectedItems.map((item) => {
            const label = item === '파워기(SMPS)' && smpsWatt ? `파워기(SMPS) ${smpsWatt}W` : item;
            const qty = quantities[item] || 1;
            return `• ${label}: ${qty}개`;
        });
        return `[추가 물품]\n${lines.join('\n')}\n${divider}\n`;
    }, [selectedItems, quantities, smpsWatt]);

    const textareaValue = itemsBlock + note;

    const handleNoteChange = (e) => {
        const value = e.target.value;
        if (itemsBlock && value.startsWith(itemsBlock)) {
            setNote(value.slice(itemsBlock.length));
            return;
        }
        if (!itemsBlock) {
            setNote(value);
            return;
        }
        const dividerIndex = value.indexOf(divider);
        if (dividerIndex >= 0) {
            setNote(value.slice(dividerIndex + divider.length).replace(/^\n/, ''));
        }
    };

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
        if ((delivery === 'QUICK' || delivery === 'DIRECT') && !address.trim()) return setError('주소를 입력해 주세요.');

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
                    <span className="submitted-icon">완료</span>
                    <h2 className="submitted-title">작업 요청이 접수되었습니다</h2>
                    <p className="submitted-desc">담당자가 확인 후 빠르게 연락드리겠습니다.</p>
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
                    {NOTICE_LINES.map((line) => (
                        <p key={line}>{line}</p>
                    ))}
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
                                placeholder="예: 목포 북항 크림색 후면채널간판"
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
                                placeholder="색상, 자재, 크기, 수량, 특이사항 등을 자유롭게 적어 주세요."
                                rows={5}
                            />
                            <p className="char-count">{textareaValue.length}자</p>
                        </Section>

                        <Section number="04" title="마감 및 납품 희망일">
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
                        </Section>

                        <Section number="05" title="납품 방법">
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
                                    <input
                                        type="text"
                                        className="req-input"
                                        value={cargoPoint}
                                        onChange={(e) => setCargoPoint(e.target.value)}
                                        placeholder="예: CJ대한통운 구포대리점, 서진항공 안양점"
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
                                        placeholder="도로명 주소를 입력해 주세요."
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
