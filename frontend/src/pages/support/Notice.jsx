import React, { useState, useEffect } from 'react';
import './Notice.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const Notice = () => {
    const [notices, setNotices] = useState([]);
    const [selected, setSelected] = useState(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        setLoading(true);
        fetch(BASE_URL + '/api/notices')
            .then(res => res.json())
            .then(data => { setNotices(data); setLoading(false); })
            .catch(() => setLoading(false));
    }, []);

    const formatDate = (str) => {
        if (!str) return '';
        return str.slice(0, 10);
    };

    if (selected) {
        return (
            <div className="notice-page">
                <div className="notice-detail">
                    <div className="notice-detail-header">
                        <h2 className="notice-detail-title">
                            {selected.isPinned && <span className="pin-badge">공지</span>}
                            {selected.title}
                        </h2>
                        <span className="notice-detail-date">{formatDate(selected.createdAt)}</span>
                    </div>
                    <div className="notice-detail-content">{selected.content}</div>
                    <button className="notice-back-btn" onClick={() => setSelected(null)}>목록으로</button>
                </div>
            </div>
        );
    }

    return (
        <div className="notice-page">
            <table className="notice-table">
                <thead>
                    <tr>
                        <th className="col-num">번호</th>
                        <th className="col-title">제목</th>
                        <th className="col-date">날짜</th>
                    </tr>
                </thead>
                <tbody>
                    {loading ? (
                        <tr><td colSpan="3" className="notice-empty">불러오는 중...</td></tr>
                    ) : notices.length === 0 ? (
                        <tr><td colSpan="3" className="notice-empty">등록된 공지사항이 없습니다.</td></tr>
                    ) : notices.map((n, i) => (
                        <tr
                            key={n.id}
                            className={'notice-row' + (n.isPinned ? ' pinned' : '')}
                            onClick={() => setSelected(n)}
                        >
                            <td className="col-num">{n.isPinned ? '공지' : notices.length - i}</td>
                            <td className="col-title">
                                {n.isPinned && <span className="pin-badge">공지</span>}
                                {n.title}
                            </td>
                            <td className="col-date">{formatDate(n.createdAt)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default Notice;