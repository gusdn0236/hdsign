import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './WorksheetThumbnail.css';

import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const DEFAULT_ROOT_MARGIN = '160px 0px';
// 카드 안에서 작업지시서 헤더/제목 정도는 글씨가 또렷이 보여야 해서 device DPR 반영.
// 단, 카드 폭이 작아 픽셀 절대량은 크지 않으니 캡 2.5 면 충분 — 더 올려도 카드 크기 대비
// 의미 없고 폴링 시 재렌더 비용만 증가.
const THUMB_MAX_DPR = 2.5;

// 보이기 시작할 때만 PDF 1페이지를 카드 폭에 맞춰 렌더. 텍스트/주석 레이어 끔 → 가벼운 미리보기.
// memo + 안정 prop(pdfUrl 문자열) 로 부모 폴링/필터 토글 시 불필요 재렌더 차단.
// /m/worksheets, /admin/orders 양쪽에서 공유.
//
// thumbnailUrl: 백엔드가 PDF 업로드 시 PDFBox 로 미리 생성한 JPEG (admin/모바일 카드 빠른 로딩용).
// 있으면 <img> 한 장으로 끝내고 react-pdf 는 아예 호출 안 함 → 다운로드/CPU 모두 대폭 절감.
// 없으면(과거 업로드 등) 기존 PDF 렌더 폴백.
const WorksheetThumbnail = memo(function WorksheetThumbnail({
  pdfUrl,
  thumbnailUrl,
  rootMargin = DEFAULT_ROOT_MARGIN,
  fallback = null,
  // 본인이 [작업완료] 처리한 지시서면 true — 코너에 대각선 "완료" 리본을 띄우고
  // 썸네일 본문은 약간 디밍해서 한눈에 걸러볼 수 있도록.
  completed = false,
  // 모바일 카드에 [📷 N장] 배지를 띄울 때 사용 — 0/undefined 이면 안 띄움.
  // 작업자가 현장 사진을 업로드한 지시서를 목록에서 한눈에 식별 가능.
  evidenceCount = 0,
}) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const [canRender, setCanRender] = useState(false);
  const [errored, setErrored] = useState(false);
  const [imgErrored, setImgErrored] = useState(false);
  const renderTimerRef = useRef(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        if (w > 0) setWidth((prev) => (prev === w ? prev : w));
      }
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (visible || !ref.current) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible, rootMargin]);

  useEffect(() => {
    setCanRender(false);
    setErrored(false);
  }, [pdfUrl]);

  useEffect(() => {
    setImgErrored(false);
  }, [thumbnailUrl]);

  // 썸네일 JPEG 가 있으면 PDF 렌더 자체를 건너뛴다 — img 가 onError 면 PDF 폴백.
  const useImageThumb = Boolean(thumbnailUrl) && !imgErrored;

  useEffect(() => {
    if (!visible || canRender || useImageThumb) return undefined;
    const run = () => {
      renderTimerRef.current = null;
      setCanRender(true);
    };
    if (typeof window !== 'undefined' && window.requestIdleCallback) {
      renderTimerRef.current = {
        kind: 'idle',
        id: window.requestIdleCallback(run, { timeout: 1200 }),
      };
    } else {
      renderTimerRef.current = { kind: 'timeout', id: setTimeout(run, 120) };
    }
    return () => {
      const timer = renderTimerRef.current;
      if (!timer) return;
      if (timer.kind === 'idle' && typeof window !== 'undefined' && window.cancelIdleCallback) {
        window.cancelIdleCallback(timer.id);
      } else {
        clearTimeout(timer.id);
      }
      renderTimerRef.current = null;
    };
  }, [canRender, visible, useImageThumb]);

  const file = useMemo(() => (pdfUrl ? { url: pdfUrl } : null), [pdfUrl]);

  const thumbDpr = useMemo(() => {
    const deviceDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return Math.min(THUMB_MAX_DPR, Math.max(1, deviceDpr));
  }, []);

  return (
    <div className={`ws-thumb-frame${completed ? ' completed' : ''}`} ref={ref}>
      {!pdfUrl && !thumbnailUrl && fallback}
      {useImageThumb && (
        <img
          className="ws-thumb-img"
          src={thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setImgErrored(true)}
        />
      )}
      {!useImageThumb && pdfUrl && visible && canRender && file && width > 0 && !errored && (
        <Document
          file={file}
          loading={null}
          error={null}
          noData={null}
          onLoadError={() => setErrored(true)}
        >
          <Page
            pageNumber={1}
            width={width}
            devicePixelRatio={thumbDpr}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={null}
          />
        </Document>
      )}
      {!useImageThumb && pdfUrl && errored && <div className="ws-thumb-err">미리보기 실패</div>}
      {evidenceCount > 0 && (
        <span
          className="ws-thumb-photos"
          aria-label={`사진 ${evidenceCount}장 업로드됨`}
        >
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h2.2l1.3-1.6h5l1.3 1.6H15a1.2 1.2 0 0 1 1.2 1.2v6.4a1.2 1.2 0 0 1-1.2 1.2H3A1.2 1.2 0 0 1 1.8 13.6V7.2A1.2 1.2 0 0 1 3 6z" />
            <circle cx="9" cy="10.6" r="2.5" />
          </svg>
          <span className="ws-thumb-photos-num">{evidenceCount > 99 ? '99+' : evidenceCount}</span>
        </span>
      )}
      {completed && (
        <span className="ws-thumb-ribbon" aria-label="작업완료">완료</span>
      )}
    </div>
  );
});

export default WorksheetThumbnail;
