import { useState } from 'react';
import { useAuth } from '../../../context/AuthContext';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const won = (n) => (Number(n) || 0).toLocaleString('ko-KR');

let uidSeq = 1;
const uid = () => `c${uidSeq++}`;

const numOrNull = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function costsFrom(jc) {
  if (!jc || !jc.costs || !jc.costs.length) return [{ key: uid(), label: '', amount: '' }];
  return jc.costs.map((c) => ({ key: uid(), label: c.label || '', amount: c.amount ?? '' }));
}

/**
 * 작업 사례 작성/편집.
 * props: jobCase(null=새 사례), clients[], onSaved(saved), onClose()
 */
export default function CaseEditor({ jobCase, clients = [], onSaved, onClose }) {
  const { token } = useAuth();

  const [id, setId] = useState(jobCase?.id || null);
  const [title, setTitle] = useState(jobCase?.title || '');
  const [clientId, setClientId] = useState(jobCase?.clientId || null);
  const [clientName, setClientName] = useState(jobCase?.clientName || '');
  const [jobDate, setJobDate] = useState(jobCase?.jobDate || '');
  const [description, setDescription] = useState(jobCase?.description || '');
  const [sizeText, setSizeText] = useState(jobCase?.sizeText || '');
  const [material, setMaterial] = useState(jobCase?.material || '');
  const [costs, setCosts] = useState(costsFrom(jobCase));
  const [finalPrice, setFinalPrice] = useState(jobCase?.finalPrice ?? '');
  const [note, setNote] = useState(jobCase?.note || '');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const knownTotal = costs.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const processCost = (Number(finalPrice) || 0) - knownTotal;

  const onClientInput = (v) => {
    setClientName(v);
    const m = clients.find((c) => c.companyName === v);
    setClientId(m ? m.id : null);
  };

  const addCost = () => setCosts((p) => [...p, { key: uid(), label: '', amount: '' }]);
  const patchCost = (k, patch) =>
    setCosts((p) => p.map((c) => (c.key === k ? { ...c, ...patch } : c)));
  const removeCost = (k) =>
    setCosts((p) => (p.length > 1 ? p.filter((c) => c.key !== k) : p));

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const payload = {
        title: title.trim() || null,
        clientId,
        clientName: clientName.trim() || null,
        description: description.trim() || null,
        sizeText: sizeText.trim() || null,
        material: material.trim() || null,
        finalPrice: Number(finalPrice) || 0,
        jobDate: jobDate || null,
        note: note.trim() || null,
        costs: costs.map((c, i) => ({
          sortOrder: i,
          label: c.label.trim() || null,
          amount: numOrNull(c.amount) || 0,
        })),
      };
      const url = id
        ? `${BASE_URL}/api/admin/job-cases/${id}`
        : `${BASE_URL}/api/admin/job-cases`;
      const res = await fetch(url, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`저장 실패 (${res.status})`);
      const saved = await res.json();
      setId(saved.id);
      setFeedback({ type: 'success', msg: '저장됐습니다.' });
      if (onSaved) onSaved(saved);
    } catch (e) {
      setFeedback({ type: 'error', msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cs-editor">
      <datalist id="cs-client-list">
        {clients.map((c) => <option key={c.id} value={c.companyName} />)}
      </datalist>

      <div className="cs-topbar">
        <div className="cs-tt">
          <button type="button" className="cs-back" onClick={onClose}>← 목록</button>
          <h2>{id ? '작업 사례 편집' : '새 작업 사례'}</h2>
        </div>
        <button type="button" className="cs-btn primary" onClick={save} disabled={saving}>
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>

      {feedback && <div className={`cs-fb ${feedback.type}`}>{feedback.msg}</div>}

      <div className="cs-card">
        <div className="cs-grid">
          <label className="cs-f">
            <span>작업명</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="예: 모델하우스 액자프레임" />
          </label>
          <label className="cs-f">
            <span>거래처</span>
            <input list="cs-client-list" value={clientName}
              onChange={(e) => onClientInput(e.target.value)} placeholder="거래처명" />
          </label>
          <label className="cs-f sm">
            <span>작업일</span>
            <input type="date" value={jobDate} onChange={(e) => setJobDate(e.target.value)} />
          </label>
        </div>
        <div className="cs-grid">
          <label className="cs-f">
            <span>사이즈</span>
            <input value={sizeText} onChange={(e) => setSizeText(e.target.value)}
              placeholder="예: 1200×800mm" />
          </label>
          <label className="cs-f">
            <span>재질 / 자재</span>
            <input value={material} onChange={(e) => setMaterial(e.target.value)}
              placeholder="예: 스텐폴리싱 1.2t" />
          </label>
        </div>
        <label className="cs-f">
          <span>작업 설명 — 공정이 어떻게 굴러갔는지 <em>자세히</em> (AI가 이걸로 학습해요)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6}
            placeholder="예: 스텐폴리싱 1.2t 한 판 떠서 레이저CNC로 액자 모양 8개 가공. 발색 외주 맡김. 직원이 절곡·연마 반나절. 퀵으로 발송. 중간에 1개 재작업함." />
        </label>
      </div>

      <div className="cs-card">
        <div className="cs-card-head">
          <h3>명시적 비용 — 아는 비용은 다 적기</h3>
          <button type="button" className="cs-btn sm" onClick={addCost}>+ 비용 추가</button>
        </div>
        <div className="cs-costs">
          {costs.map((c) => (
            <div className="cs-cost" key={c.key}>
              <input className="cs-cl" value={c.label}
                onChange={(e) => patchCost(c.key, { label: e.target.value })}
                placeholder="비용 항목 (예: 스텐폴리싱 1.2t 자재)" />
              <input className="cs-ca" type="number" inputMode="numeric" value={c.amount}
                onChange={(e) => patchCost(c.key, { amount: e.target.value })}
                onWheel={(e) => e.target.blur()} placeholder="금액" />
              <button type="button" className="cs-cx" onClick={() => removeCost(c.key)}>✕</button>
            </div>
          ))}
        </div>
      </div>

      <div className="cs-card cs-summary">
        <label className="cs-f sm cs-final">
          <span>최종 가격 (실제 받은 금액)</span>
          <input type="number" inputMode="numeric" value={finalPrice}
            onChange={(e) => setFinalPrice(e.target.value)}
            onWheel={(e) => e.target.blur()} placeholder="0" />
        </label>
        <div className="cs-calc">
          <div className="cs-calc-line"><span>명시적 비용 합</span><b>− {won(knownTotal)} 원</b></div>
          <div className="cs-calc-line final"><span>무형 공정 비용</span><b>{won(processCost)} 원</b></div>
          <p className="cs-calc-hint">최종가에서 아는 비용을 뺀 값 — 인건·노하우·난이도의 값. AI가 이걸 학습해요.</p>
        </div>
      </div>

      <div className="cs-card">
        <label className="cs-f">
          <span>비고</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            placeholder="특이사항 (선택)" />
        </label>
      </div>

      <div className="cs-footer">
        <button type="button" className="cs-btn ghost" onClick={onClose}>목록으로</button>
        <button type="button" className="cs-btn primary" onClick={save} disabled={saving}>
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}
