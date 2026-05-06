// 워처 분배함 슬롯 라벨 ↔ 직원 매핑.
// 워처(hdsign-watcher 의 SLOT_BOXES) 의 slot_label 과 정확히 일치해야 한다 — 워처는 수정하지 않고
// 모바일 필터/작업현황 탭에서만 직원 단위로 매칭하기 위한 매핑 데이터.
//
// 같은 직원이 여러 슬롯에 매핑될 수 있다(예: 신문식 → 4번 + 15번 슬롯).
// 한 슬롯에 여러 직원이 함께 배정될 수도 있다(예: 1번 김진섭+김명수 — 한 장의 지시서를 같이 봄).
// 두 케이스 모두 worksheet 의 departmentSlots 와 본인 슬롯 한 개라도 겹치면 본인 리스트에 노출,
// 한 명이 [작업완료] 누르면 같은 슬롯의 다른 직원에게서도 사라진다(claim 모델).
//
// 12·13 번(배송2팀, 홍철웅팀장) 은 현재 사용하지 않는 슬롯 — 빈 배열로 두면 어느 모바일에도 안 잡힘.
export const SLOT_TO_WORKERS = {
  '캡/일체형작업실': ['김진섭', '김명수'],   // 1번 — 타카/캡채널 공유
  '시트/도안실':     ['김현우'],            // 2번
  '에폭시실':        ['이경숙', '김순희'],   // 3번
  '아크릴/실리콘네온': ['신문식'],          // 4번
  '후레임실':        ['박철진'],            // 5번
  '도장실':          ['왕종길'],            // 6번
  '레이져용접':      ['김길수'],            // 7번
  '최창영부장':      ['김민우'],            // 8번 — 워처 슬롯 라벨은 옛 이름 그대로 두고 매핑만 변경
  '조립부':          ['이휘원'],            // 9번
  '아크릴부(레이져)': ['이재호'],           // 10번
  '배송1팀':         ['이창율'],            // 11번
  '배송2팀':         [],                   // 12번 — 비활성
  '홍철웅팀장':      [],                   // 13번 — 비활성
  'LED조립':         ['정숙자'],            // 14번
  '고무스카시(CNC)': ['신문식'],            // 15번 — 4번과 동일 직원
  '이휘원실장':      ['이휘원'],            // 16번 — 9번과 동일 직원
};

// 직원 → 본인이 매핑된 슬롯 라벨 목록. 슬롯 한 개라도 worksheet.departmentSlots 에 있으면 본인 거.
export const WORKER_TO_SLOTS = (() => {
  const m = {};
  for (const [slot, workers] of Object.entries(SLOT_TO_WORKERS)) {
    for (const w of workers) {
      if (!m[w]) m[w] = [];
      if (!m[w].includes(slot)) m[w].push(slot);
    }
  }
  return m;
})();

// 모바일 [내 정보 설정] 드롭다운에 노출되는 직원 이름들 — 가나다순.
// 비활성 슬롯에만 매핑된 직원은 어차피 위 reduce 결과에 안 잡혀 자연 제외.
export const ALL_WORKERS = Object.keys(WORKER_TO_SLOTS).sort((a, b) => a.localeCompare(b, 'ko'));

// 한 worksheet 의 departmentSlots(라벨 배열) 가 어느 직원들을 포함하는지 — 작업현황 탭에서
// "이 지시서가 누구에게 배정됐었나" 표시할 때 사용.
export function getWorkersForSlots(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  const set = new Set();
  for (const s of slots) {
    const list = SLOT_TO_WORKERS[s] || [];
    for (const w of list) set.add(w);
  }
  return Array.from(set);
}

// 모바일 "내 지시서만 보기" 매칭 — 본인 슬롯과 worksheet 슬롯이 한 개라도 겹치면 true.
export function matchesWorker(worksheetSlots, worker) {
  if (!worker) return false;
  const mySlots = WORKER_TO_SLOTS[worker] || [];
  if (mySlots.length === 0) return false;
  if (!Array.isArray(worksheetSlots) || worksheetSlots.length === 0) return false;
  return worksheetSlots.some((s) => mySlots.includes(s));
}

// 직원 이름 → 안정적인 컬러(HSL hue). 같은 이름은 항상 같은 색.
// 작업현황 카드의 직원 배지 + 모바일 라벨에 사용해 한눈에 누구인지 식별.
export function getWorkerHue(worker) {
  if (!worker) return 220;
  let h = 0;
  for (let i = 0; i < worker.length; i += 1) {
    h = (h * 31 + worker.charCodeAt(i)) & 0xffff;
  }
  return h % 360;
}
