import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import './RatesAdmin.css';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const TABS = [
  { type: 'MATERIAL',  label: '자재',      hint: '스텐·아크릴·갈바 등 자재 단가' },
  { type: 'LABOR',     label: '가공·인건', hint: '공정별 시간당 비용 (장비+인건)' },
  { type: 'OUTSOURCE', label: '외주',      hint: '발색·도금 등 외주 단가' },
  { type: 'EXTRA',     label: '부대비용',  hint: '퀵·택배·출장 등' },
];

const NAME_PH = {
  MATERIAL: '예: 스텐폴리싱 1.2t',
  LABOR: '예: 레이저CNC 가공',
  OUTSOURCE: '예: 발색',
  EXTRA: '예: 퀵 배송',
};
const UNIT_PH = { MATERIAL: '판', LABOR: '시간', OUTSOURCE: '㎡', EXTRA: '건' };

const emptyForm = (type) => ({
  id: null, rateType: type, name: '', spec: '', vendor: '',
  unit: '', unitPrice: '', category: '',
});

/**
 * 단가 마스터 — 공정 기반 견적의 원가 기준.
 * 자재 / 가공·인건 / 외주 / 부대비용 4종을 탭으로 나눠 관리한다.
 */
export default function RatesAdmin() {
  const { token } = useAuth();
  const [tab, setTab] = useState('MATERIAL');
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(emptyForm('MATERIAL'));
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);

  const headers = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/admin/rate-items`, { headers: headers() });
      if (res.ok) setItems(await res.json());
    } catch {
      /* 무시 — 로딩 표시만 종료 */
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => { load(); }, [load]);

  const switchTab = (t) => { setTab(t); setForm(emptyForm(t)); setFeedback(null); };

  const submit = async () => {
    if (!form.name.trim()) {
      setFeedback({ type: 'error', msg: '항목명을 입력해주세요.' });
      return;
    }
    const payload = {
      ...form,
      rateType: tab,
      name: form.name.trim(),
      unitPrice: Number(form.unitPrice) || 0,
    };
    try {
      const url = form.id
        ? `${BASE_URL}/api/admin/rate-items/${form.id}`
        : `${BASE_URL}/api/admin/rate-items`;
      const res = await fetch(url, {
        method: form.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('저장에 실패했습니다.');
      setFeedback({ type: 'success', msg: form.id ? '수정됐습니다.' : '추가됐습니다.' });
      setForm(emptyForm(tab));
      load();
    } catch (e) {
      setFeedback({ type: 'error', msg: e.message });
    }
  };

  const edit = (it) => {
    setForm({
      id: it.id, rateType: it.rateType, name: it.name || '',
      spec: it.spec || '', vendor: it.vendor || '', unit: it.unit || '',
      unitPrice: it.unitPrice ?? '', category: it.category || '',
    });
    setFeedback(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const remove = async (it) => {
    if (!window.confirm(`[${it.name}] 단가를 삭제할까요?`)) return;
    try {
      const res = await fetch(`${BASE_URL}/api/admin/rate-items/${it.id}`, {
        method: 'DELETE', headers: headers(),
      });
      if (!res.ok) throw new Error('삭제 실패');
      load();
    } catch (e) {
      alert(e.message);
    }
  };

  const rows = items.filter((i) => i.rateType === tab);
  const isOut = tab === 'OUTSOURCE';
  const isLabor = tab === 'LABOR';
  const specLabel = isLabor ? '설명' : '규격';
  const priceLabel = isLabor ? '시간당 단가(원)' : '단가(원)';
  const colCount = isOut ? 7 : 6;

  return (
    <div className="rates-page">
      <div className="rates-head">
        <h2>단가 마스터</h2>
        <p>공정 기반 견적의 원가 기준입니다. 자재·가공·외주·부대비용 단가를 정확히 채울수록 견적이 정확해집니다.</p>
      </div>

      <div className="rates-tabs">
        {TABS.map((t) => (
          <button
            key={t.type}
            className={tab === t.type ? 'active' : ''}
            onClick={() => switchTab(t.type)}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="rates-form">
        <div className="rates-form-grid">
          <label className="grow">
            <span>항목명 *</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={NAME_PH[tab]} />
          </label>
          <label className="grow">
            <span>{specLabel}</span>
            <input value={form.spec} onChange={(e) => setForm({ ...form, spec: e.target.value })}
              placeholder={isLabor ? '비고' : '예: 4×8판'} />
          </label>
          {isOut && (
            <label className="grow">
              <span>외주처</span>
              <input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })}
                placeholder="예: OO발색" />
            </label>
          )}
          <label className="sm">
            <span>단위</span>
            <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}
              placeholder={UNIT_PH[tab]} />
          </label>
          <label className="sm">
            <span>{priceLabel}</span>
            <input type="number" inputMode="numeric" value={form.unitPrice}
              onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
              onWheel={(e) => e.target.blur()} placeholder="0" />
          </label>
          <label className="sm">
            <span>분류</span>
            <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
              placeholder="예: 스텐" />
          </label>
        </div>
        <div className="rates-form-actions">
          {form.id && (
            <button type="button" className="ghost" onClick={() => setForm(emptyForm(tab))}>취소</button>
          )}
          <button type="button" className="primary" onClick={submit}>
            {form.id ? '수정 저장' : '+ 추가'}
          </button>
        </div>
        {feedback && <div className={`rates-fb ${feedback.type}`}>{feedback.msg}</div>}
      </div>

      {loading ? (
        <p className="rates-loading">불러오는 중…</p>
      ) : (
        <table className="rates-table">
          <thead>
            <tr>
              <th>항목명</th>
              <th>{specLabel}</th>
              {isOut && <th>외주처</th>}
              <th>단위</th>
              <th className="num">{isLabor ? '시간당 단가' : '단가'}</th>
              <th>분류</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={colCount} className="rates-empty">등록된 단가가 없습니다.</td></tr>
            ) : rows.map((it) => (
              <tr key={it.id} className={it.active === false ? 'inactive' : ''}>
                <td className="rname">{it.name}</td>
                <td>{it.spec || '-'}</td>
                {isOut && <td>{it.vendor || '-'}</td>}
                <td>{it.unit || '-'}</td>
                <td className="num">{(it.unitPrice || 0).toLocaleString('ko-KR')} 원</td>
                <td>{it.category || '-'}</td>
                <td className="ractions">
                  <button type="button" onClick={() => edit(it)}>수정</button>
                  <button type="button" className="del" onClick={() => remove(it)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
