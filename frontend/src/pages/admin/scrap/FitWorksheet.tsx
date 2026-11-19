import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import '../autoquote/EasyformBulkImport.css';

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

/** 지시서를 칸에 꽉 맞춰 보여준다(이지폼 불러오기·단가찾아보기·스크랩 참고 창 공용). */
export default function FitWorksheet({ pdfUrl, thumbUrl, title }: { pdfUrl?: string | null; thumbUrl?: string | null; title?: string | null }) {
  // 넘기자마자 보이게: ① 미리 만들어 둔 미리보기 사진(JPEG)을 즉시 ② 선명한 PDF 가 다 그려지면 그 위로 바꿔 끼움.
  // 크기는 미리보기 사진 비율로 먼저 정해 PDF 를 두 번 그리지 않는다.
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [ratio, setRatio] = useState<number | null>(null); // 가로/세로
  const [failed, setFailed] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [thumbBad, setThumbBad] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const upd = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    upd();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setRatio(null);
    setFailed(false);
    setRendered(false);
    setThumbBad(false);
  }, [pdfUrl, thumbUrl]);
  const fit = (r: number) => Math.floor(Math.min(size.w, size.h * r));
  const width = size.w && size.h ? fit(ratio || 0.75) : 0;
  const ph = thumbUrl && !thumbBad ? (
    <img
      className="efb-fit-img"
      src={thumbUrl}
      alt="지시서"
      style={ratio && width ? { width, height: Math.floor(width / ratio) } : undefined}
      onLoad={(e) => {
        const im = e.currentTarget;
        if (!ratio && im.naturalWidth && im.naturalHeight) setRatio(im.naturalWidth / im.naturalHeight);
      }}
      onError={() => setThumbBad(true)}
    />
  ) : null;
  if (!pdfUrl || failed) {
    return (
      <div className="efb-fit" ref={box}>
        {ph || <div className="efb-ws-empty">{title || '지시서 없음'}</div>}
      </div>
    );
  }
  // 미리보기 사진이 있으면 비율을 알 때까지(사진 로드) PDF 를 그리지 않는다 — 한 번만 그리게.
  const canDraw = width > 0 && (ratio != null || !thumbUrl || thumbBad);
  return (
    <div className="efb-fit" ref={box}>
      {!rendered && (ph || <span className="efb-spin" />)}
      {canDraw && (
        <div className={rendered ? 'efb-fit-pdf' : 'efb-fit-pdf is-loading'}>
          <Document file={pdfUrl} loading={null} error={null} onLoadError={() => setFailed(true)}>
            <Page
              pageNumber={1}
              width={width}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              devicePixelRatio={Math.min(2.5, window.devicePixelRatio || 1)}
              loading={null}
              onLoadSuccess={(p) => !ratio && setRatio(p.originalWidth / p.originalHeight)}
              onRenderSuccess={() => setRendered(true)}
            />
          </Document>
        </div>
      )}
    </div>
  );
}
