// One-off generator for a NON-IDENTIFYING work-order sample fixture.
// The real auto-quote-data/work-order-samples/*.ai files contain live client data and are
// gitignored; the e2e vision boundary is route-mocked in CI, so the fixture only needs to be
// a valid PNG of plausible 작업지시서 layout (no real names/phones/prices).
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), 'work-order-sample.png');

const row = (y, a, b, c) => `
  <line x1="40" y1="${y}" x2="760" y2="${y}" stroke="#c9d1da" stroke-width="1"/>
  <text x="52" y="${y + 22}" font-size="15" fill="#1f2733">${a}</text>
  <text x="300" y="${y + 22}" font-size="15" fill="#1f2733">${b}</text>
  <text x="600" y="${y + 22}" font-size="15" fill="#1f2733">${c}</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="#ffffff"/>
  <rect x="40" y="30" width="720" height="540" fill="none" stroke="#1a1a2e" stroke-width="2"/>
  <text x="400" y="74" font-size="28" font-weight="700" fill="#1a1a2e" text-anchor="middle">작업 지시서 (SAMPLE)</text>
  <text x="52" y="120" font-size="15" fill="#6b7785">거래처: (비식별 샘플)        담당: ○○○        일자: 0000-00-00</text>
  <rect x="40" y="150" width="720" height="40" fill="#e0f0f1"/>
  <text x="52" y="176" font-size="15" font-weight="700" fill="#005f73">품목</text>
  <text x="300" y="176" font-size="15" font-weight="700" fill="#005f73">규격(W*H)</text>
  <text x="600" y="176" font-size="15" font-weight="700" fill="#005f73">수량</text>
  ${row(190, '채널간판', '3000 * 600  (2도)', '1')}
  ${row(240, '돌출간판', '1200 * 400', '1')}
  ${row(290, '시트컷팅', '1100 * 300', '2')}
  ${row(340, 'LED 모듈', '-', '120')}
  ${row(390, '시공·운반', '-', '1')}
  <line x1="40" y1="440" x2="760" y2="440" stroke="#c9d1da" stroke-width="1"/>
  <text x="52" y="500" font-size="14" fill="#6b7785">비고: LED 포함 / 비식별 테스트 픽스처 — 실제 거래정보 없음</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log('wrote', out);
