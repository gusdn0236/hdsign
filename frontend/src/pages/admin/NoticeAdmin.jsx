import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import "./NoticeAdmin.css";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

export default function NoticeAdmin() {
    const { token, logout } = useAuth();
    const [notices, setNotices] = useState([]);
    const [mode, setMode] = useState("list");
    const [selected, setSelected] = useState(null);
    const [form, setForm] = useState({ title: "", content: "", isPinned: false });
    const [feedback, setFeedback] = useState(null);

    useEffect(() => { loadNotices(); }, []);

    const loadNotices = () => {
        fetch(BASE_URL + "/api/notices")
            .then(res => res.json())
            .then(data => setNotices(data))
            .catch(console.error);
    };

    const handleEdit = (notice) => {
        setSelected(notice);
        setForm({ title: notice.title, content: notice.content, isPinned: notice.isPinned });
        setMode("edit");
    };

    const handleNew = () => {
        setSelected(null);
        setForm({ title: "", content: "", isPinned: false });
        setMode("edit");
    };

    const handleSubmit = async () => {
        if (!form.title.trim() || !form.content.trim()) {
            setFeedback({ type: "error", msg: "제목과 내용을 입력해주세요." });
            return;
        }
        const url = selected ? BASE_URL + "/api/notices/" + selected.id : BASE_URL + "/api/notices";
        const method = selected ? "PUT" : "POST";
        try {
            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
                body: JSON.stringify(form)
            });
            if (!res.ok) throw new Error("저장 실패");
            setFeedback({ type: "success", msg: selected ? "수정됐습니다." : "등록됐습니다." });
            loadNotices();
            setTimeout(() => { setMode("list"); setFeedback(null); }, 1000);
        } catch (e) {
            setFeedback({ type: "error", msg: e.message });
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm("삭제하시겠습니까?")) return;
        try {
            await fetch(BASE_URL + "/api/notices/" + id, {
                method: "DELETE",
                headers: { Authorization: "Bearer " + token }
            });
            loadNotices();
        } catch (e) {
            alert(e.message);
        }
    };

    const formatDate = (str) => str ? str.slice(0, 10) : "";

    return (
        <div className="notice-admin-page">
            <div className="upload-header">
                <h1>공지사항 관리</h1>
                <div className="header-actions">
                    <Link to="/admin/gallery-upload" className="site-link">이미지 관리</Link>
                    <Link to="/" className="site-link">사이트 보기</Link>
                    <button className="logout-btn" onClick={logout}>로그아웃</button>
                </div>
            </div>

            {mode === "list" ? (
                <div className="notice-admin-list">
                    <div className="notice-admin-toolbar">
                        <button className="new-btn" onClick={handleNew}>+ 새 공지 작성</button>
                    </div>
                    <table className="notice-admin-table">
                        <thead>
                            <tr>
                                <th>번호</th>
                                <th>제목</th>
                                <th>날짜</th>
                                <th>관리</th>
                            </tr>
                        </thead>
                        <tbody>
                            {notices.length === 0 ? (
                                <tr><td colSpan="4" className="notice-empty">등록된 공지사항이 없습니다.</td></tr>
                            ) : notices.map((n, i) => (
                                <tr key={n.id} className={n.isPinned ? "pinned" : ""}>
                                    <td>{n.isPinned ? "공지" : notices.length - i}</td>
                                    <td className="notice-title-cell">
                                        {n.isPinned && <span className="pin-badge">공지</span>}
                                        {n.title}
                                    </td>
                                    <td>{formatDate(n.createdAt)}</td>
                                    <td>
                                        <button className="edit-btn" onClick={() => handleEdit(n)}>수정</button>
                                        <button className="del-btn" onClick={() => handleDelete(n.id)}>삭제</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className="notice-admin-form">
                    <h2>{selected ? "공지사항 수정" : "새 공지사항 작성"}</h2>
                    <div className="form-group">
                        <label>제목</label>
                        <input
                            type="text"
                            value={form.title}
                            onChange={e => setForm({ ...form, title: e.target.value })}
                            placeholder="제목을 입력하세요"
                        />
                    </div>
                    <div className="form-group">
                        <label>내용</label>
                        <textarea
                            value={form.content}
                            onChange={e => setForm({ ...form, content: e.target.value })}
                            placeholder="내용을 입력하세요"
                            rows={12}
                        />
                    </div>
                    <div className="form-group form-check">
                        <input
                            type="checkbox"
                            id="isPinned"
                            checked={form.isPinned}
                            onChange={e => setForm({ ...form, isPinned: e.target.checked })}
                        />
                        <label htmlFor="isPinned">상단 고정 (공지)</label>
                    </div>
                    {feedback && <div className={"form-feedback " + feedback.type}>{feedback.msg}</div>}
                    <div className="form-actions">
                        <button className="submit-btn" onClick={handleSubmit}>저장</button>
                        <button className="cancel-btn" onClick={() => { setMode("list"); setFeedback(null); }}>취소</button>
                    </div>
                </div>
            )}
        </div>
    );
}