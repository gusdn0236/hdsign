/**
 * Auto-quote pure quote engine (ported from tenet-test/web engine).
 * No DOM, no network — every export is a pure function or plain data.
 *
 * Public entry point: {@link estimate} implements the `estimate(line, ctx)`
 * contract (hierarchy ① history > ② brand-identity-filter + size > ③ category+size).
 */
export * from './types';
export * from './normalize';
export * from './similarity';
export * from './pricing';
export * from './totals';
export * from './confidence';
export * from './estimate';
