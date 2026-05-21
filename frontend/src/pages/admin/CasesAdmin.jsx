import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import CaseEditor from './cases/CaseEditor.jsx';
import './cases/Cases.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const won = (n) => (Number(n) || 0).toLocaleString('ko-KR');

/**
 * 작업 사례 — 완료된 작업을 공정 설명 + 최종가로 기록한다.
 * 입력 자체는 AI/비용과 무관(데이터가 쌓일 뿐). 견적 AI 의 학습 재료가 된다.
 */
export default function CasesAdmin() {
  const { token } = useAuth();
  const [cases, setCases] = useState([]);
  const [clients, setClients] = useState([]);
  const [mode, setMode] = useState('list');      // 'list' | 'edit'
  const [editing, setEditing] = useState(null);  // 편집 대상 (null = 새 사례)
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const headers = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const loadCases = useCallback(async () => {
    const res = await fetch(`${BASE_URL}/api/admin/job-cases`, { headers: headers() });
    if (!res.ok) throw new Error('작업 사례 조회 실패');
    setCases(await res.json());
  }, [headers]);

  const loadClients = useCallback(async () => {
    const res = await fetch(`${BASE_URL}/api/admin/clients`, { headers: headers() });
    if (res.ok) setClients(await res.json());
  }, [headers]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        await Promise.all([loadCases(), loadClients()]);
      } catch (e) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadCases, loadClients]);

  const openNew = () => { setEditing(null); setMode('edit'); };
  const openEdit = (c) => { setEditing(c); setMode('edit'); };
  const back = () => { setMode('list'); setEditing(null); loadCases(); };

  const handleDelete = async (c) => {
    if (!window.confirm(`작업 사례 [${c.title || '제목 없음'}] 을(를) 삭제할까요?`)) return;
    try {
      const res = await fetch(`${BASE_URL}/api/admin/job-cases/${c.id}`, {
        method: 'DELETE', headers: headers(),
      });
      if (!res.ok) throw new Error('삭제 실패');
      loadCases();
    } catch (e) {
      alert(e.message);
    }
  };

  if (mode === 'edit') {
    return (
      <CaseEditor
        key={editing?.id || 'new'}
        jobCase={editing}
        clients={clients}
        onSaved={() => loadCases()}
        onClose={back}
      />
    );
  }

  return (
    <div className="cs-page">
      <div className="cs-head">
        <div>
          <h2>작업 사례</h2>
          <p>
            완료된 작업을 공정 설명 + 최종가로 기록합니다. 견적 AI가 학습할 재료예요 —
            과거 작업도 신규 작업도 같은 화면으로 쌓으면 됩니다. (입력은 비용이 들지 않습니다.)
          </p>
        </div>
        <button type="button" className="cs-new" onClick={openNew}>+ 새 작업 사례</button>
      </div>

      {err && <div className="cs-error">{err}</div>}

      {loading ? (
        <p className="cs-loading">불러오는 중…</p>
      ) : cases.length === 0 ? (
        <div className="cs-empty">
          아직 기록된 작업 사례가 없습니다. <b>+ 새 작업 사례</b>로 시작하세요.
        </div>
      ) : (
        <table className="cs-table">
          <thead>
            <tr>
              <th>작업명</th>
              <th>거래처</th>
              <th>사이즈</th>
              <th>재질</th>
              <th className="num">최종가</th>
              <th className="num">공정비용</th>
              <th>작업일</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id}>
                <td className="cs-title">{c.title || '-'}</td>
                <td>{c.clientName || '-'}</td>
                <td>{c.sizeText || '-'}</td>
                <td>{c.material || '-'}</td>
                <td className="num">{won(c.finalPrice)} 원</td>
                <td className="num cs-proc">{won(c.processCost)} 원</td>
                <td>{c.jobDate || (c.createdAt || '').slice(0, 10)}</td>
                <td className="cs-actions">
                  <button type="button" onClick={() => openEdit(c)}>편집</button>
                  <button type="button" className="del" onClick={() => handleDelete(c)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
