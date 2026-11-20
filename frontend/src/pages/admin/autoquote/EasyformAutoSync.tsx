/**
 * 이지폼 저장 → 홈페이지 자동반영 — 관리자 화면 어디서든 떠 있는 폴러(AdminLayout 에 붙음).
 *
 * 사무실 직원이 이지폼 '매출 거래명세서' [저장] → 이 PC 워처가 "홈페이지에도 반영할까요?" → 예 → 명세서를 읽어
 * 이벤트로 쌓는다. 여기서 그 이벤트를 가져가(claim — 탭 여러 개여도 하나만) 명세서 탭으로 가서 확인 카드
 * (EasyformAutoSyncModal)를 띄운다. 워처가 없는 PC(현장·집)면 조용히 드물게만 다시 물어본다.
 *
 * - 관리자 화면 제목 = 'HD Sign 관리자' — 워처가 Chrome 탭 목록에서 이 이름으로 관리자 탭(=로그인된 화면)을 찾아
 *   켜져 있는지 확인하고, 숨어 있으면 골라 앞으로 가져온다.
 * - [예] 직후 워처가 읽는 동안(reading) '읽는 중' 표시 + 카드·명세서 화면 코드를 미리 받아 둬 바로 뜨게.
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { claimEfAuto, pollEfAuto, type EfAutoEvent } from './data/easyformClient';
import { isDemoToken } from '../../../utils/demoGuard';
import './EasyformAutoSync.css';

const loadModal = () => import('./EasyformAutoSyncModal');
const EasyformAutoSyncModal = lazy(loadModal);

const FAST_MS = 500; // 워처가 있으면(같은 PC 라 가벼움 — [예] 뒤 바로 반응)
const SLOW_MS = 20000; // 워처가 없거나 옛 버전이면
const ADMIN_TITLE = 'HD Sign 관리자'; // 워처 ADMIN_TAB_MARK 와 같아야 함

export default function EasyformAutoSync({ token }: { token: string | null | undefined }) {
  const [queue, setQueue] = useState<EfAutoEvent[]>([]);
  const [reading, setReading] = useState(false);
  const lastId = useRef(0);
  // 이 탭 표시 — 탭 여러 개일 때 같은 건을 두 번 가져가지 않게
  const tab = useRef(Math.random().toString(36).slice(2, 10));
  const prefetched = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  const locRef = useRef(location);
  locRef.current = location;

  // 관리자 화면 표시(워처가 탭 목록에서 찾음). 로그아웃 등으로 빠지면 원래 제목.
  useEffect(() => {
    if (!token) return;
    document.title = ADMIN_TITLE;
    return () => {
      if (document.title.includes(ADMIN_TITLE)) document.title = 'HD Sign | 간판 전문기업';
    };
  }, [token]);

  useEffect(() => {
    if (!token || isDemoToken(token)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await pollEfAuto(lastId.current);
      if (!alive) return;
      if (r?.available && !prefetched.current) {
        // 워처 있는 PC — 카드·명세서 화면 코드를 미리 받아 둔다(처음 뜰 때 기다림 없게)
        prefetched.current = true;
        loadModal().catch(() => {});
        import('./AutoQuote').catch(() => {});
      }
      setReading(!!r?.reading);
      if (r?.events?.length) {
        for (const ev of r.events) {
          lastId.current = Math.max(lastId.current, ev.id);
          if (await claimEfAuto(ev.id, tab.current)) {
            setQueue((q) => [...q, ev]);
            // 명세서 탭으로(카드는 그 위에 뜨고, 끝나면 목록에 바로 반영돼 보임)
            const l = locRef.current;
            if (l.pathname !== '/admin/orders' || new URLSearchParams(l.search).get('tab') !== 'statement') {
              navigate('/admin/orders?tab=statement');
            }
          }
        }
      }
      if (alive) timer = setTimeout(tick, r?.available ? FAST_MS : SLOW_MS);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [token, navigate]);

  const cur = queue[0];
  if (!cur) {
    return reading ? (
      <div className="efas-reading" role="status">
        <span className="efas-spin" aria-hidden="true" />
        이지폼 명세서를 읽고 있어요…
      </div>
    ) : null;
  }
  return (
    <Suspense fallback={null}>
      <EasyformAutoSyncModal
        key={cur.id}
        ev={cur}
        token={token}
        more={queue.length - 1}
        onClose={() => setQueue((q) => q.slice(1))}
      />
    </Suspense>
  );
}
