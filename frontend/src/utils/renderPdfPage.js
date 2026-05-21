import { pdfjs } from 'react-pdf';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// 워커 경로 — PdfViewer/WorksheetThumbnail 와 동일. 중복 설정해도 무해(같은 값).
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// PDF 한 페이지를 지정 폭의 <canvas> 로 렌더 — 목록 카드에서 지시서를 이미지로 공유할 때.
// 카드에는 그려둔 캔버스가 없으므로(또는 720px 썸네일뿐) 클릭 시 원본 PDF 를 새로 렌더한다.
export async function renderPdfPageToCanvas(url, { page = 1, targetWidth = 1800 } = {}) {
    const task = pdfjs.getDocument({ url });
    try {
        const doc = await task.promise;
        const pageNo = Math.min(Math.max(1, page), doc.numPages);
        const pdfPage = await doc.getPage(pageNo);
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = base.width > 0 ? targetWidth / base.width : 1;
        const viewport = pdfPage.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        // pdfjs v5 권장 방식 — canvas 를 직접 넘기면 내부에서 2D 컨텍스트를 잡는다.
        await pdfPage.render({ canvas, viewport }).promise;
        return canvas;
    } finally {
        task.destroy?.();
    }
}
