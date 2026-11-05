// 작업완료 목록 '30일씩' 불러오기 공용 헬퍼.
// 백엔드(/api/admin/orders/trash, /api/public/worksheets/completed)가 ?page=N 이면
// {items, hasMore, nextPage, total?} 를 준다. page 0 = 최근 30일, 1 = 그 이전 30일 ...
// 보관은 3년이지만 화면이 무거워지지 않게 필요한 만큼만 받는다.

const withPage = (url, page) => `${url}${url.includes("?") ? "&" : "?"}page=${page}`;

async function fetchPage(url, page, init) {
  const res = await fetch(withPage(url, page), init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || "작업완료 목록을 불러오지 못했습니다.");
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  // 옛 서버(배열 응답) 호환 — 페이지 개념 없이 전부 온 것으로 취급.
  if (Array.isArray(data)) return { items: data, hasMore: false, total: data.length };
  return {
    items: Array.isArray(data.items) ? data.items : [],
    hasMore: !!data.hasMore,
    total: typeof data.total === "number" ? data.total : null,
  };
}

const keyOf = (o) => (o && (o.id ?? o.orderNumber)) ?? JSON.stringify(o);

/** 0..pages-1 페이지를 병렬로 받아 합친다(폴링/새로고침용 — 이미 펼친 범위 그대로 유지). */
export async function fetchCompletedPages(url, pages, init) {
  const n = Math.max(1, pages | 0);
  const results = await Promise.all(Array.from({ length: n }, (_, i) => fetchPage(url, i, init)));
  const seen = new Set();
  const items = [];
  for (const r of results) {
    for (const o of r.items) {
      const k = keyOf(o);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(o);
    }
  }
  const last = results[results.length - 1];
  return { items, hasMore: last.hasMore, total: results[0].total };
}

/** page 한 장만 (더보기). */
export async function fetchCompletedPage(url, page, init) {
  return fetchPage(url, page, init);
}

/** 기존 목록 뒤에 중복 없이 붙이기. */
export function appendUnique(prev, more) {
  const seen = new Set(prev.map(keyOf));
  return [...prev, ...more.filter((o) => !seen.has(keyOf(o)))];
}

/** 펼친 페이지 수 기준, 이미 받아둔 가장 옛날 날짜(자정). 이보다 옛날을 보려면 더 받아야 함. */
export function oldestLoadedDate(pages, windowDays = 30) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1 - windowDays * Math.max(1, pages));
  return d;
}
