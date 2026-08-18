// Authorship-provenance wiring inside the metadata Edge Function.
//
// ## Why this file reads source instead of calling the function
//
// `fetch-paper-metadata/index.ts` cannot be imported here: it targets the Deno
// Edge runtime, importing over HTTPS from `esm.sh` and registering a handler on
// the runtime's server global, neither of which exists under Vitest. The
// repository's standing position is that only *pure* helpers under `_shared/`
// are Node-importable, and that the formal compile check for `index.ts` is the
// Deno bundler run by `supabase functions deploy`.
//
// The extraction logic itself is therefore covered where it lives, exhaustively:
// `_shared/__tests__/pubmedAuthors.test.ts` and
// `_shared/__tests__/crossrefAuthors.test.ts`. What that coverage cannot pin is
// whether `index.ts` still *calls* those extractors, or whether someone
// reintroduced a second inline author loop beside them. This file pins exactly
// that and nothing more — a source-level fitness check, written to be honest
// about the difference.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolved from the repository root: the jsdom environment rewrites
// `import.meta.url` to a non-`file:` scheme, so it cannot locate the file.
const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/fetch-paper-metadata/index.ts"),
  "utf8",
);

describe("author extraction is delegated, not inlined", () => {
  it("imports both extractors from shared Edge modules", () => {
    // Relative `.ts` specifiers under `supabase/functions/` — the Edge bundle
    // boundary. Importing the application copies from `src/` would not resolve
    // at deploy time.
    expect(source).toMatch(
      /import \{ extractPubMedAuthors \} from "\.\.\/_shared\/pubmedAuthors\.ts";/,
    );
    expect(source).toMatch(
      /import \{ extractCrossrefAuthors \} from "\.\.\/_shared\/crossrefAuthors\.ts";/,
    );
  });

  it("calls each extractor exactly once", () => {
    expect(source.match(/extractPubMedAuthors\(/g) ?? []).toHaveLength(1);
    expect(source.match(/extractCrossrefAuthors\(/g) ?? []).toHaveLength(1);
  });

  it("contains no second, inline author loop", () => {
    // The previous implementation matched `<Author…>` blocks and joined
    // `${foreName} ${lastName}` here. A reappearance would mean two author
    // implementations that can disagree — and the one outside the extractor
    // would produce an `authors` array with no provenance aligned to it.
    expect(source).not.toMatch(/<Author\[\^>\]\*>/);
    expect(source).not.toMatch(/CollectiveName/);
    expect(source).not.toMatch(/\$\{foreName\}/);
    expect(source).not.toMatch(/work\.author/);
  });

  it("emits provenance on both provider paths", () => {
    // PubMed and Crossref each return it beside their own `authors`.
    expect(source.match(/author_provenance: authorProvenance,/g) ?? []).toHaveLength(2);
  });

  it("keeps decodeHTMLEntities as a single shared authority", () => {
    // It was moved to `_shared/htmlEntities.ts` so the author extractor and
    // this file decode identically; a local redefinition would fork them.
    expect(source).toMatch(
      /import \{ decodeHTMLEntities \} from "\.\.\/_shared\/htmlEntities\.ts";/,
    );
    expect(source).not.toMatch(/function decodeHTMLEntities/);
  });

  it("declares the response field as optional and nullable", () => {
    // Rollout compatibility: an older deployed function omits the field, and a
    // newer frontend must read that as "no provenance", not as a failure.
    expect(source).toMatch(/author_provenance\?: AuthorProvenance\[\] \| null;/);
  });
});
