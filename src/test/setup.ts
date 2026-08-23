import "@testing-library/jest-dom";

/**
 * `matchMedia` is a browser API jsdom does not implement, and several
 * components read it (`useIsMobile`, `useCoarsePointer`).
 *
 * The guard exists because not every suite runs under jsdom. A file may opt
 * into `// @vitest-environment node` — the Edge Function handlers do, because
 * they run in Deno and need the platform APIs Node shares with it rather than
 * jsdom's partial ones (jsdom has no `AbortSignal.timeout`, so a timeout-bearing
 * fetch would throw before it was ever issued). There is no `window` in that
 * environment, and a DOM shim has nothing to shim: this stub is installed only
 * where a DOM exists, and jsdom behaviour is unchanged.
 */
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
