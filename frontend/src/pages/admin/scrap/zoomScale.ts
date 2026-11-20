import { createContext } from 'react';

/** ZoomBox 가 지금 확대한 배율(손을 멈춘 뒤 값) — FitWorksheet 가 이 배율만큼 PDF 를 더 촘촘히 다시 그려 선명하게. */
export const ZoomScaleContext = createContext(1);
