import PdfViewer from '../../components/common/PdfViewer.jsx';

// 돋보기 → 새 브라우저 창 전용 지시서 확대 뷰어.
// - PdfViewer 가 휠 확대/축소(커서 기준) + 좌클릭 드래그 이동 + 고화질 렌더를 담당.
// - PDF 페이지 비율을 알게 되면 창을 그 비율에 맞춰(화면 중앙) 다시 맞춘다 → "이미지 크기에 맞게".
// - 이 창을 닫아도 사이드바(현장 프로그램)는 그대로 — 메인 창과 별개의 팝업이라.
// src 쿼리: 표시할 지시서 PDF(또는 이미지) URL.
export default function FieldZoomViewer() {
    const params = new URLSearchParams(window.location.search);
    const src = (params.get('src') || '').trim();

    // 첫 페이지 크기를 알면 창을 그 비율로(화면 96% 한도, 중앙) 맞춘다.
    const handlePageSize = (wPt, hPt) => {
        if (!wPt || !hPt) return;
        try {
            const scr = window.screen;
            const aw = scr.availWidth;
            const ah = scr.availHeight;
            const al = scr.availLeft || 0;
            const at = scr.availTop || 0;
            const maxW = Math.round(aw * 0.96);
            const maxH = Math.round(ah * 0.96);
            const ar = wPt / hPt;
            let h = maxH;
            let w = Math.round(h * ar);
            if (w > maxW) {
                w = maxW;
                h = Math.round(w / ar);
            }
            window.resizeTo(w, h);
            window.moveTo(al + Math.round((aw - w) / 2), at + Math.round((ah - h) / 2));
        } catch {
            /* resizeTo/moveTo 가 막힌 환경 — 처음 연 크기 그대로 표시 */
        }
    };

    if (!src) {
        return (
            <div style={{
                position: 'fixed', inset: 0, background: '#1a1d24', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
            }}>
                표시할 지시서가 없습니다.
            </div>
        );
    }

    return (
        <div style={{ position: 'fixed', inset: 0, background: '#1a1d24' }}>
            <PdfViewer url={src} onPageSize={handlePageSize} />
        </div>
    );
}
