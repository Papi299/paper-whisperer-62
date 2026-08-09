// DOI link construction inside the metadata Edge Function.
//
// ## Why this file reads source instead of calling the function
//
// `fetch-paper-metadata/index.ts` cannot be imported here. It targets the Deno
// Edge runtime: it imports over HTTPS from `esm.sh` and registers a handler on
// the runtime's server global, neither of which exists under Vitest. The
// repository's standing position (docs/deployment.md) is that the formal
// compile check for that file is the Deno bundler run by
// `supabase functions deploy`, and that only *pure* helpers under `_shared/`
// are Node-importable and unit-testable.
//
// The mapping logic itself is therefore already covered where it lives:
// `journal_url` is now exactly `canonicalDoiUrl(doi)`, and `canonicalDoiUrl` is
// tested exhaustively — encoding corpus, round-trip, and cross-runtime parity —
// in `supabase/functions/_shared/__tests__/identifierDetection.test.ts`.
//
// What that coverage cannot pin is whether `index.ts` still *calls* it. This
// file pins exactly that, and nothing more. It is a source-level fitness check,
// not a behavioural test, and it is written to be honest about the difference:
// it asserts the shape of the two DOI-derived assignments and the continued
// separation between resolver construction and provider API encoding.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolved from the repository root: the jsdom environment rewrites
// `import.meta.url` to a non-`file:` scheme, so it cannot locate the file.
const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/fetch-paper-metadata/index.ts"),
  "utf8",
);

describe("DOI resolver links are built, never interpolated", () => {
  it("contains no raw `https://doi.org/${...}` interpolation", () => {
    // The defect this PR fixes. A DOI name interpolated into a URL path
    // truncates at the first `#` or `?` in the suffix, so the emitted link
    // names a different DOI — or none.
    expect(source).not.toMatch(/https:\/\/doi\.org\/\$\{/);
  });

  it("builds every DOI-derived journal_url with canonicalDoiUrl", () => {
    // Three sites: the PubMed mapping, the Crossref mapping, and the DOI-search
    // backfill that runs when PubMed returned no DOI of its own.
    const assignments = source.match(/journal_url[^,;\n]*canonicalDoiUrl\(doi\)/g) ?? [];
    expect(assignments).toHaveLength(3);
  });

  it("imports the builder from the shared Edge module", () => {
    // Relative `.ts` specifier under `supabase/functions/` — the Edge bundle
    // boundary. Importing the application copy from `src/` would not resolve at
    // deploy time.
    expect(source).toMatch(
      /import \{[^}]*canonicalDoiUrl[^}]*\} from "\.\.\/_shared\/identifierDetection\.ts";/,
    );
  });

  it("keeps the PubMed backfill's precedence, not just its encoding", () => {
    // `||` preserves a DOI PubMed itself supplied; only an absent link is
    // backfilled from the searched-for DOI. Behaviour outside encoding is
    // unchanged by this PR.
    expect(source).toMatch(
      /pubmedResult\.journal_url = pubmedResult\.journal_url \|\| canonicalDoiUrl\(doi\)/,
    );
  });
});

describe("provider API encoding stays separate from resolver construction", () => {
  // A DOI reaches three different URL syntaxes with three different rules.
  // Routing the provider calls through `canonicalDoiUrl` would corrupt both:
  // Crossref puts the whole DOI name in ONE path segment, so its `/` must be
  // escaped, and the PubMed term is a query *value*. The resolver is the only
  // context where the prefix/suffix `/` stays literal.

  it("Crossref still encodes the DOI as a single path segment", () => {
    expect(source).toMatch(
      /https:\/\/api\.crossref\.org\/works\/\$\{encodeURIComponent\(doi\)\}/,
    );
  });

  it("PubMed still encodes the DOI as a [doi] query term value", () => {
    expect(source).toMatch(/term=\$\{encodeURIComponent\(doi\)\}\[doi\]/);
  });

  it("does not route either provider request through the resolver builder", () => {
    expect(source).not.toMatch(/api\.crossref\.org[^\n]*canonicalDoiUrl/);
    expect(source).not.toMatch(/eutils\.ncbi\.nlm\.nih\.gov[^\n]*canonicalDoiUrl/);
  });
});

describe("untouched neighbouring behaviour", () => {
  it("still builds the PubMed record URL from the PMID", () => {
    // Adjacent line to one of the changed assignments; unchanged by this PR.
    expect(source).toMatch(/pubmed_url: `https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\$\{pmid\}\/`/);
  });

  it("still consumes the classifier's authenticated DOI name", () => {
    // The handoff PR #196 established: the provider dispatch takes the DOI
    // *name* the classifier proved, never the raw pasted resolver URL.
    expect(source).toMatch(/detectIdentifier/);
  });
});
