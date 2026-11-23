/**
 * 거래처별 이지폼 익히기 — 이지폼 목록(주식회사·개인, 올해) × 홈페이지 명세서 지문(발행일·합계)을 맞춰
 * 주문마다 '이지폼 어느 쪽·어느 거래처로 끊었는지'를 서버에 저장한다(모든 PC 공용).
 * 거래처는 보통 한쪽 이지폼에만 계속 끊으므로(사용자 2026-11-23), [이지폼에서 열기]·[이지폼에 적용하기]가
 * 그 명세서 기록이 없어도 '주로 끊는 쪽'부터 보고, [이지폼 새로 작성]은 거래처를 미리 골라 둔다.
 */
import { getEasyformUsedKeys, locateEasyformBulk } from '../annot/api';
import { clientSim } from './efMatch';
import type { EfListRow } from './easyformClient';

const dig = (s: string) => String(s || '').replace(/[^0-9-]/g, '');

/** lists(이지폼 목록) 로 익혀서 저장. 결과 = {matched: 맞춘 주문 수, updated: 저장된 수, keys: 지문 수}. */
export async function learnFromLists(
  token: string | null | undefined,
  lists: { biz: 'corp' | 'personal'; rows: EfListRow[] }[],
): Promise<{ matched: number; updated: number; keys: number }> {
  const keys = await getEasyformUsedKeys(token);
  const byKey = new Map<string, EfListRow[]>();
  for (const l of lists) {
    for (const r of l.rows) {
      const k = `${r.date}|${dig(r.total)}`;
      byKey.set(k, [...(byKey.get(k) || []), r]);
    }
  }
  const items: { orderId: number; efDate: string; efTotal: string; efClient?: string; efBiz?: string }[] = [];
  for (const k of keys) {
    let rows = byKey.get(`${k.date}|${dig(k.total)}`) || [];
    // 같은 날·같은 합계가 여럿이면 홈페이지 거래처와 이름이 비슷한 것만
    if (rows.length > 1) rows = rows.filter((r) => clientSim(k.client, r.client) >= 0.6);
    const kinds = new Set(rows.map((r) => `${r.biz}|${r.bizNo}`));
    if (!rows.length || kinds.size !== 1) continue; // 애매하면 안 적음
    const r = rows[0];
    items.push({ orderId: k.orderId, efDate: r.date, efTotal: r.total, efClient: r.client, efBiz: r.biz });
  }
  let updated = 0;
  for (let i = 0; i < items.length; i += 200) updated += await locateEasyformBulk(token, items.slice(i, i + 200));
  return { matched: items.length, updated, keys: keys.length };
}
