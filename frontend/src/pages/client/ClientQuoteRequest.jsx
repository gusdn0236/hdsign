import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { submitQuoteApi } from '../../api/client';
import './ClientRequest.css';

const MAX_TOTAL_FILE_SIZE_MB = 300;
const MAX_TOTAL_FILE_SIZE_BYTES = MAX_TOTAL_FILE_SIZE_MB * 1024 * 1024;

function FileDropZone({ files, onFilesChange }) {
    const [dragging, setDragging] = useState(false);
    const inputRef = useRef(null);

    const appendFiles = (nextFiles) => {
        onFilesChange([...files, ...Array.from(nextFiles || [])]);
    };

    const removeFile = (index) => onFilesChange(files.filter((_, idx) => idx !== index));

    const formatSize = (bytes) => {
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return (
        <div>
            <div
                className={`drop-zone ${dragging ? 'dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    appendFiles(e.dataTransfer.files);
                }}
                onClick={() => inputRef.current?.click()}
            >
                <span className="drop-zone-icon">파일</span>
                <p className="drop-zone-text">파일을 드래그하거나 클릭해서 업로드</p>
                <p className="drop-zone-sub">AI, PDF, JPG, PNG, ZIP 등 모든 형식 가능 / 총 {MAX_TOTAL_FILE_SIZE_MB}MB 이하</p>
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => appendFiles(e.target.files)}
                />
            </div>
            {files.length > 0 && (
                <ul className="file-list">
                    {files.map((file, index) => (
                        <li key={`${file.name}-${index}`} className="file-item">
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

export default function ClientQuoteRequest() {
    const { clientToken, clientLogout } = useAuth();
    const navigate = useNavigate();
    const [title, setTitle] = useState('');
    const [files, setFiles] = useState([]);
    const [note, setNote] = useState('');
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState('');

    const reset = () => {
        setTitle('');
        setFiles([]);
        setNote('');
        setSubmitted(false);
        setError('');
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (!title.trim()) {
            setError('견적 요청 제목을 입력해 주세요.');
            return;
        }
        if (!files.length) {
            setError('견적에 필요한 파일을 1개 이상 업로드해 주세요.');
            return;
        }

        const totalSize = files.reduce((sum, file) => sum + (file?.size || 0), 0);
        if (totalSize > MAX_TOTAL_FILE_SIZE_BYTES) {
            setError(`첨부 파일 총 용량은 ${MAX_TOTAL_FILE_SIZE_MB}MB 이하여야 합니다.`);
            return;
        }

        setLoading(true);
        try {
            const formData = new FormData();
            formData.append('title', title.trim());
            formData.append('note', note.trim());
            files.forEach((file) => formData.append('files', file));
            await submitQuoteApi(formData, clientToken);
            setSubmitted(true);
        } catch (err) {
            if (err?.status === 401 || err?.status === 403) {
                clientLogout();
                navigate('/client/login', { replace: true });
                return;
            }
            setError(err.message || '견적 요청 접수에 실패했습니다.');
        } finally {
            setLoading(false);
        }
    };

    if (submitted) {
        return (
            <div className="request-page">
                <div className="request-page-header">
                    <h1 className="request-page-title">견적 요청 접수</h1>
                </div>
                <div className="submitted-wrap">
                    <span className="submitted-icon">완료</span>
                    <h2 className="submitted-title">견적 요청이 접수되었습니다</h2>
                    <p className="submitted-desc">담당자가 확인 후 회신드리겠습니다.</p>
                    <button className="req-submit-btn" onClick={reset}>새 견적 요청 작성</button>
                </div>
            </div>
        );
    }

    return (
        <div className="request-page">
            <div className="request-page-header">
                <h1 className="request-page-title">견적 요청 접수</h1>
            </div>

            <div className="request-notice">
                <span className="request-notice-icon">안내</span>
                <div className="request-notice-text">
                    <p>견적 요청을 접수하면 담당자에게 메일이 자동 발송됩니다.</p>
                    <p>파일과 요청 내용을 최대한 구체적으로 적어 주시면 견적 회신이 빨라집니다.</p>
                </div>
            </div>

            <form className="request-form" onSubmit={handleSubmit}>
                <div className="request-sections">
                    <Section number="01" title="견적 요청 제목">
                        <input
                            type="text"
                            className="req-input"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="예: 목포 외부 채널간판 견적 문의"
                            maxLength={100}
                        />
                    </Section>

                    <Section number="02" title="관련 파일 업로드">
                        <FileDropZone files={files} onFilesChange={setFiles} />
                    </Section>

                    <Section number="03" title="추가 문의사항">
                        <textarea
                            className="req-textarea"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="사이즈, 수량, 설치 위치, 희망 일정, 문의 내용을 적어 주세요."
                            rows={6}
                        />
                        <p className="char-count">{note.length}자</p>
                    </Section>

                    {error && <p className="req-error">{error}</p>}
                    <button type="submit" className="req-submit-btn" disabled={loading}>
                        {loading ? '접수 중...' : '견적 요청 접수하기'}
                    </button>
                </div>
            </form>
        </div>
    );
}
