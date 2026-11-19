import { useEffect, useState } from 'react';
import { evidence as fetchEvidence, getEstimate, type Evidence } from '../autoquote/annot/api';
import { ZoomImg } from '../autoquote/LookupResultModal';
import FitWorksheet from './FitWorksheet';
import type { ScrapItem, ScrapRow } from './scrapStore';

/**
 * 스크랩 1건 보기 — 위: 지시서, 아래: 명세서 표. 서랍 참고 창·단가찾아보기 결과 크게 보기 공용.
 * 불러온 내용은 화면에 있는 동안 메모리에 보관(같은 걸 다시 눌러도 바로 뜸).
 */
export interface ViewerData {
  photos: string[]; // data URL(past) — home 은 pdf/thumb 로 보여줌
  grid: ScrapRow[];
  client?: string;
}

const cache = new Map<string, Promise<ViewerData>>();

const toNum = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const won = (v: unknown) => {
  const n = toNum(v);
  return n == null || String(v ?? '').trim() === '' ? String(v ?? '') : n.toLocaleString('ko-KR');
};

export function evidenceToData(ev: Evidence | null): ViewerData {
  if (!ev) return { photos: [], grid: [] };
  const photos =
    ev.photos && ev.photos.length
      ? ev.photos.map((p) => `data:${p.content_type || 'image/jpeg'};base64,${p.base64}`)
      : ev.photo_base64
        ? [`data:${ev.photo_content_type || 'image/jpeg'};base64,${ev.photo_base64}`]
        : [];
  return {
    photos,
    client: ev.client || '',
    grid: (ev.grid || []).map((g) => ({
      품목코드: String(g.item_code ?? ''),
      품목: String(g.item ?? ''),
      규격: String(g.spec ?? ''),
      수량: String(g.qty ?? ''),
      단가: String(g.unit_price ?? ''),
    })),
  };
}

export function loadViewerData(token: string | null | undefined, it: Pick<ScrapItem, 'key' | 'kind' | 'orderId' | 'invoiceIdx' | 'file'>): Promise<ViewerData> {
  const hit = cache.get(it.key);
  if (hit) return hit;
  const p = (async (): Promise<ViewerData> => {
    if (it.kind === 'home') {
      const doc = await getEstimate(token, it.orderId!);
      const grid = (doc?.estimate?.grid || []) as Record<string, string>[];
      return {
        photos: [],
        grid: grid.map((g) => ({ 품목코드: g['품목코드'], 품목: g['품목'], 규격: g['규격'], 수량: g['수량'], 단가: g['단가'] })),
      };
    }
    return evidenceToData(await fetchEvidence(token, it.invoiceIdx!, it.file!));
  })();
  cache.set(it.key, p);
  p.catch(() => cache.delete(it.key));
  return p;
}

const norm = (s?: string) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
// 카드에 담긴 줄과 같은 줄 — 품목코드는 양쪽 다 있을 때만 비교(예전 명세서 후보엔 코드가 없음).
const sameRow = (a: ScrapRow, b: ScrapRow) =>
  (!norm(a.품목코드) || !norm(b.품목코드) || norm(a.품목코드) === norm(b.품목코드)) &&
  norm(a.규격) === norm(b.규격) &&
  toNum(a.단가) === toNum(b.단가);

export function StatementTable({ grid, marks }: { grid: ScrapRow[]; marks?: ScrapRow[] }) {
  if (!grid.length) return <div className="sv-empty">명세서 내용이 없어요</div>;
  return (
    <table className="sv-tbl">
      <thead>
        <tr>
          <th>품목코드</th>
          <th>품목</th>
          <th>규격</th>
          <th>수량</th>
          <th className="p">단가</th>
          <th className="p">공급가액</th>
        </tr>
      </thead>
      <tbody>
        {grid.map((g, i) => {
          const p = toNum(g.단가);
          const q = toNum(g.수량) ?? 1;
          const hit = !!marks?.some((m) => sameRow(m, g));
          return (
            <tr key={i} className={hit ? 'is-hit' : ''}>
              <td>{g.품목코드}</td>
              <td>{g.품목}</td>
              <td>{g.규격}</td>
              <td>{g.수량}</td>
              <td className="p">{won(g.단가)}</td>
              <td className="p">{p != null && String(g.단가 ?? '').trim() ? (p * q).toLocaleString('ko-KR') : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function ScrapViewer({
  token,
  item,
  data: given,
}: {
  token: string | null | undefined;
  item: Pick<ScrapItem, 'key' | 'kind' | 'orderId' | 'invoiceIdx' | 'file' | 'pdfUrl' | 'thumb' | 'rows' | 'client'>;
  data?: ViewerData | null; // 이미 받아 둔 게 있으면(단가찾아보기 결과) 그대로
}) {
  const [data, setData] = useState<ViewerData | null>(given ?? null);
  const [err, setErr] = useState(false);
  const [pi, setPi] = useState(0);
  useEffect(() => {
    setPi(0);
    setErr(false);
    if (given) {
      setData(given);
      return undefined;
    }
    setData(null);
    let alive = true;
    loadViewerData(token, item)
      .then((d) => alive && setData(d))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key, given]);

  const photos = data?.photos || [];
  return (
    <div className="sv">
      <div className="sv-ws">
        {item.kind === 'home' ? (
          <FitWorksheet pdfUrl={item.pdfUrl} thumbUrl={item.thumb} title={item.client} />
        ) : photos.length ? (
          <>
            <ZoomImg src={photos[Math.min(pi, photos.length - 1)]} alt="지시서" />
            {photos.length > 1 && (
              <div className="sv-gal">
                <button type="button" onClick={() => setPi((i) => (i > 0 ? i - 1 : photos.length - 1))}>
                  ‹
                </button>
                <span>
                  {Math.min(pi, photos.length - 1) + 1} / {photos.length}
                </span>
                <button type="button" onClick={() => setPi((i) => (i < photos.length - 1 ? i + 1 : 0))}>
                  ›
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="sv-empty">{data ? '지시서 사진 없음' : err ? '' : <span className="sv-spin" />}</div>
        )}
      </div>
      <div className="sv-grid">
        {data ? (
          <StatementTable grid={data.grid} marks={item.rows} />
        ) : (
          <div className="sv-empty">{err ? '불러오지 못했어요' : '불러오는 중…'}</div>
        )}
      </div>
    </div>
  );
}
