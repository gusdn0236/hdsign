import { useEffect, useRef, useState } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import './PdfPanZoom.css';

/**
 * 어드민 모달 PDF 뷰어 — Chrome/Edge 의 내장 PDF 뷰어를 iframe 으로 띄워서
 * (toolbar/navpanes/scrollbar 숨김) 벡터 그대로 가장 선명하게 보여주고,
 * 그 위에 +/- 버튼과 마우스 드래그 패닝만 추가했다.
 *
 * iframe 에 pointer-events: none 을 주는 이유 — react-zoom-pan-pinch 는
 * wrapper 위에서 발생한 마우스 이벤트로 드래그/휠 줌을 처리하는데, iframe 이
 * 마우스 이벤트를 자기 안쪽으로 가로채면 라이브러리가 드래그 시작을 인식 못 함.
 * iframe 안 PDF 뷰어와의 직접 상호작용(스크롤·hand 도구) 은 포기하지만, 어차피
 * 본 흐름은 1 페이지 지시서라 영향 없음.
 *
 * 줌은 CSS transform 이라 1x 초과로 확대하면 비트맵이 늘어나 약간 흐릿함은 있지만,
 * 1x(기본 보기) 에서는 브라우저 네이티브 렌더링이라 텍스트가 가장 또렷하다.
 */
export default function PdfPanZoom({ url }) {
    const wrapRef = useRef(null);
    const [size, setSize] = useState({ w: 0, h: 0 });

    useEffect(() => {
        const measure = () => {
            if (!wrapRef.current) return;
            const w = wrapRef.current.clientWidth;
            const h = wrapRef.current.clientHeight;
            if (w > 0 && h > 0) setSize({ w, h });
        };
        measure();
        const ro = new ResizeObserver(measure);
        if (wrapRef.current) ro.observe(wrapRef.current);
        window.addEventListener('resize', measure);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, []);

    const iframeUrl = `${url}#toolbar=0&navpanes=0&scrollbar=0`;

    return (
        <div className="ppz-wrap" ref={wrapRef}>
            <TransformWrapper
                initialScale={1}
                minScale={1}
                maxScale={4}
                doubleClick={{ mode: 'toggle', step: 1.5 }}
                wheel={{ step: 0.5 }}
                pinch={{ step: 5 }}
                panning={{ velocityDisabled: true }}
            >
                {({ zoomIn, zoomOut, resetTransform }) => (
                    <>
                        <div className="ppz-controls">
                            <button
                                type="button"
                                className="ppz-btn"
                                onClick={() => zoomIn()}
                                title="확대"
                                aria-label="확대"
                            >
                                <span className="ppz-btn-icon">＋</span>
                                <span className="ppz-btn-text">확대</span>
                            </button>
                            <button
                                type="button"
                                className="ppz-btn"
                                onClick={() => zoomOut()}
                                title="축소"
                                aria-label="축소"
                            >
                                <span className="ppz-btn-icon">－</span>
                                <span className="ppz-btn-text">축소</span>
                            </button>
                            <button
                                type="button"
                                className="ppz-btn ppz-btn-reset"
                                onClick={() => resetTransform()}
                                title="원래대로"
                                aria-label="원래대로"
                            >
                                <span className="ppz-btn-icon">⟲</span>
                                <span className="ppz-btn-text">원래대로</span>
                            </button>
                        </div>

                        <TransformComponent
                            wrapperClass="ppz-tc-wrapper"
                            contentClass="ppz-tc-content"
                        >
                            {size.w > 0 && (
                                <iframe
                                    key={url}
                                    src={iframeUrl}
                                    title="지시서 PDF"
                                    className="ppz-iframe"
                                    style={{ width: size.w, height: size.h }}
                                />
                            )}
                        </TransformComponent>
                    </>
                )}
            </TransformWrapper>
            <div className="ppz-hint">드래그로 이동 · 더블클릭으로 확대</div>
        </div>
    );
}
