import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './WorksheetThumbnail.css';

import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const DEFAULT_ROOT_MARGIN = '160px 0px';

// 보이기 시작할 때만 PDF 1페이지를 카드 폭에 맞춰 렌더. devicePixelRatio=1 + 텍스트/주석
// 레이어 끔 → 가벼운 미리보기. memo + 안정 prop(pdfUrl 문자열) 로 부모 폴링/필터 토글 시
// 불필요 재렌더 차단. /m/worksheets, /admin/orders 양쪽에서 공유.
const WorksheetThumbnail = memo(function WorksheetThumbnail({
  pdfUrl,
  rootMargin = DEFAULT_ROOT_MARGIN,
  fallback = null,
}) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const [canRender, setCanRender] = useState(false);
  const [errored, setErrored] = useState(false);
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
    if (!visible || canRender) return undefined;
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
  }, [canRender, visible]);

  const file = useMemo(() => (pdfUrl ? { url: pdfUrl } : null), [pdfUrl]);

  return (
    <div className="ws-thumb-frame" ref={ref}>
      {!pdfUrl && fallback}
      {pdfUrl && visible && canRender && file && width > 0 && !errored && (
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
            devicePixelRatio={1}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={null}
          />
        </Document>
      )}
      {pdfUrl && errored && <div className="ws-thumb-err">미리보기 실패</div>}
    </div>
  );
});

export default WorksheetThumbnail;
