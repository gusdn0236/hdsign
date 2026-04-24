import sharp from 'sharp';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = (name) => path.join(__dirname, '..', 'public', name);

// ── OG Image (1200×630) ──────────────────────────────────────────
const W = 1200, H = 630;
const ogSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#0B1120"/>
      <stop offset="100%" stop-color="#0F1A2E"/>
    </linearGradient>
    <linearGradient id="blueLine" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%"   stop-color="#2563EB" stop-opacity="0"/>
      <stop offset="20%"  stop-color="#3B82F6"/>
      <stop offset="80%"  stop-color="#3B82F6"/>
      <stop offset="100%" stop-color="#2563EB" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- 배경 -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- 좌측 파란 수직 강조선 -->
  <rect x="100" y="160" width="4" height="310" rx="2" fill="#3B82F6" opacity="0.9"/>

  <!-- HD 메인 텍스트 -->
  <text
    x="152" y="350"
    font-family="'Arial','Helvetica',sans-serif"
    font-size="240" font-weight="900"
    fill="#FFFFFF"
    letter-spacing="-8"
    dominant-baseline="middle"
  >HD</text>

  <!-- SIGN 보조 텍스트 -->
  <text
    x="156" y="460"
    font-family="'Arial','Helvetica',sans-serif"
    font-size="52" font-weight="700"
    fill="#3B82F6"
    letter-spacing="22"
  >SIGN</text>

  <!-- 우측 구분선 -->
  <rect x="780" y="160" width="1" height="310" fill="rgba(255,255,255,0.08)"/>

  <!-- 우측 상단: 설명 텍스트 블록 -->
  <text
    x="830" y="230"
    font-family="'Arial','Helvetica',sans-serif"
    font-size="22" font-weight="400"
    fill="rgba(255,255,255,0.45)"
    letter-spacing="3"
  >PREMIUM SIGNAGE</text>

  <text
    x="830" y="290"
    font-family="'Arial','Helvetica',sans-serif"
    font-size="38" font-weight="700"
    fill="rgba(255,255,255,0.92)"
  >간판 전문기업</text>

  <!-- 우측 얇은 구분선 -->
  <rect x="830" y="332" width="200" height="1" fill="rgba(255,255,255,0.15)"/>

  <!-- 우측 하단 설명 -->
  <text x="830" y="375" font-family="'Arial','Helvetica',sans-serif"
    font-size="20" fill="rgba(255,255,255,0.40)">갈바 · 스테인리스</text>
  <text x="830" y="405" font-family="'Arial','Helvetica',sans-serif"
    font-size="20" fill="rgba(255,255,255,0.40)">에폭시 · 특수 간판</text>

  <!-- 하단 파란 선 -->
  <rect x="0" y="${H - 4}" width="${W}" height="4" fill="url(#blueLine)"/>

  <!-- URL -->
  <text
    x="${W - 48}" y="${H - 20}"
    text-anchor="end"
    font-family="'Arial','Helvetica',sans-serif"
    font-size="16" fill="rgba(255,255,255,0.22)" letter-spacing="1"
>hdsigncraft.com</text>
</svg>`;

await sharp(Buffer.from(ogSvg)).png({ compressionLevel: 9 }).toFile(pub('og-image.png'));
console.log('✔ og-image.png');

// ── Favicon base SVG (512×512) ────────────────────────────────────
const faviconSvg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#0B1120"/>
      <stop offset="100%" stop-color="#0F1A2E"/>
    </linearGradient>
  </defs>

  <!-- 배경 (둥근 모서리) -->
  <rect width="512" height="512" rx="100" ry="100" fill="url(#bg)"/>

  <!-- 좌측 파란 수직 강조선 -->
  <rect x="74" y="128" width="20" height="256" rx="10" fill="#3B82F6"/>

  <!-- HD 텍스트 -->
  <text
    x="270" y="342"
    text-anchor="middle"
    font-family="'Arial','Helvetica',sans-serif"
    font-size="240" font-weight="900"
    fill="#FFFFFF"
    letter-spacing="-10"
  >HD</text>
</svg>`;

await sharp(Buffer.from(faviconSvg)).resize(32, 32).png({ compressionLevel: 9 }).toFile(pub('favicon-32x32.png'));
console.log('✔ favicon-32x32.png');

await sharp(Buffer.from(faviconSvg)).resize(16, 16).png({ compressionLevel: 9 }).toFile(pub('favicon-16x16.png'));
console.log('✔ favicon-16x16.png');

await sharp(Buffer.from(faviconSvg)).resize(180, 180).png({ compressionLevel: 9 }).toFile(pub('apple-touch-icon.png'));
console.log('✔ apple-touch-icon.png');

await sharp(Buffer.from(faviconSvg)).resize(192, 192).png({ compressionLevel: 9 }).toFile(pub('favicon-192x192.png'));
console.log('✔ favicon-192x192.png');
