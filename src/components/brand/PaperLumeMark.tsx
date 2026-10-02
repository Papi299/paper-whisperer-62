// `?no-inline`: always a URL to the file itself, never a re-encoded data URI.
// In a build that is the same hashed asset the favicon already loads.
import paperLumeSymbolUrl from "../../../assets/brand/svg/paperlume-symbol.svg?no-inline";
import { cn } from "@/lib/utils";

/**
 * The canonical PaperLume symbol, imported straight from the brand pack's
 * master (`assets/brand/svg/paperlume-symbol.svg`) — never redrawn and never
 * copied into `src/` — so the web app shows the same mark the Chrome extension
 * ships. See `assets/brand/brand-spec.md`.
 *
 * An `<img>`, not inlined SVG: the master's gradient and clip-path ids are
 * document-global once inlined, and the sidebar mounts its brand row twice
 * below `md` (the CSS-hidden rail and the drawer).
 *
 * Decorative by default (`alt=""`). Where visible "PaperLume" text sits beside
 * the mark, that text already names the brand and an image announcing it too
 * would read the name twice. Pass `alt` only on a surface with no visible
 * brand text. Size it at 24px or more (brand-spec §3).
 */
export function PaperLumeMark({ className, alt = "" }: { className?: string; alt?: string }) {
  return (
    <img
      src={paperLumeSymbolUrl}
      alt={alt}
      width={64}
      height={64}
      draggable={false}
      className={cn("shrink-0 select-none", className)}
    />
  );
}
