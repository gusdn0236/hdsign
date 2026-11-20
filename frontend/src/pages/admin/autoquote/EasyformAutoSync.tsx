/**
 * 이지폼 저장 → 홈페이지 자동반영 — 관리자 화면 어디서든 떠 있는 폴러(AdminLayout 에 붙음).
 *
 * 사무실 직원이 이지폼 '매출 거래명세서' [저장] → 이 PC 워처가 "홈페이지에도 반영할까요?" → 예 → 명세서를 읽어
 * 이벤트로 쌓는다. 여기서 그 이벤트를 가져가(claim — 탭 여러 개여도 하나만) 확인 카드(EasyformAutoSyncModal)를 띄운다.
 * 워처가 없는 PC(현장·집)면 조용히 드물게만 다시 물어본다.
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { claimEfAuto, pollEfAuto, type EfAutoEvent } from './data/easyformClient';
import { isDemoToken } from '../../../utils/demoGuard';

const EasyformAutoSyncModal = lazy(() => import('./EasyformAutoSyncModal'));

const FAST_MS = 1500; // 워처가 있으면
const SLOW_MS = 20000; // 워처가 없거나 옛 버전이면

export default function EasyformAutoSync({ token }: { token: string | null | undefined }) {
  const [queue, setQueue] = useState<EfAutoEvent[]>([]);
  const lastId = useRef(0);
  // 이 탭 표시 — 안 보이는 탭이 내려놓은 건을 다시 가져가지 않게
  const tab = useRef(Math.random().toString(36).slice(2, 10));

  useEffect(() => {
    if (!token || isDemoToken(token)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await pollEfAuto(lastId.current);
      if (!alive) return;
      if (r?.events?.length) {
        for (const ev of r.events) {
          lastId.current = Math.max(lastId.current, ev.id);
          if (await claimEfAuto(ev.id, tab.current)) setQueue((q) => [...q, ev]);
        }
      }
      if (alive) timer = setTimeout(tick, r?.available ? FAST_MS : SLOW_MS);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  const cur = queue[0];
  if (!cur) return null;
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
