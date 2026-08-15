import * as React from "react";

const MOBILE_BREAKPOINT = 768;

function readIsMobile() {
  return typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;
}

/**
 * Whether the viewport is narrower than the `md` breakpoint (768px), which is
 * the single responsive contract PFA-C09 established and this hook is the only
 * place it is read in JS.
 *
 * The initial value is resolved synchronously from `window.innerWidth` rather
 * than being left undefined until the first effect. Consumers that *compose*
 * differently per viewport (the Dashboard renders either the compact mobile
 * control stack or the desktop toolbar, never both) would otherwise paint one
 * frame of the desktop layout on a phone before correcting itself.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(readIsMobile);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
