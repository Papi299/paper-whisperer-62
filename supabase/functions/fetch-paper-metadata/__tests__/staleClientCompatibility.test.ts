// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { crossrefAbstract, pubmedAbstract, pubmedArticleTitle } from "../metadataText";
import { efetchDocument, pubmedArticle } from "../../_shared/__tests__/fixtures/pubmedEfetchXml";
import { decodeHTMLEntities as currentClient } from "../../../../src/lib/decodeHTMLEntities";
import { normalizePaperData, type RawPaperData } from "../../../../src/lib/normalizePaperData";
import { specDecode } from "../../../../src/lib/__tests__/fixtures/clientEntitySpec";

/**
 * Release state C (PAPERLUME-CODEQL-EDGE-TEXT-EXTRACTION-001B): the corrected
 * Edge Function is deployed while a browser tab opened before the Vercel
 * release still runs the client decoder it loaded. Nothing makes that tab
 * reload, and what it stores stays stored.
 *
 * That decoder is `src/lib/decodeHTMLEntities.ts` as main served it, kept byte
 * for byte in `fixtures/staleClientDecoder.main.ts.txt`. It is data, not a
 * source file, because it is the defective decoder CodeQL alert 6 reports
 * (`js/double-escaping`), and nothing may import it. This suite checks its git
 * blob hash, compiles it with TypeScript and runs it.
 *
 * Independent review of revision 001A found that this state stored
 * `AT&T and p < 0.05; invalid &#x110000;` as
 * `AT&amp;T and p &lt; 0.05; invalid &#x110000;`: the old decoder threw on the
 * reference above U+10FFFF and returned the whole field still escaped. The Edge
 * now writes every character reference that names no character as text, and a
 * reference to `&` as `&amp;` (`../../_shared/xmlText.ts`), so the old decoder
 * never reaches `String.fromCodePoint` with a value it rejects.
 *
 * What remains is the old decoder's own cascade: its `&lt;`, `&gt;`, `&quot;`,
 * `&apos;` and `&nbsp;` passes run after its `&amp;` pass and read what that pass
 * produced, so it can never return those five texts literally, whatever any
 * Edge Function sends. Production does the same today (state A).
 *
 * The client differs between the two releases only in `decodeHTMLEntities`, so
 * the stale tab's `normalizePaperData` is the current one with the old decoder
 * in place. Expected text is written by hand.
 */

type Decoder = (text: string | null | undefined) => string | null;

/** main's `src/lib/decodeHTMLEntities.ts`, the blob the fixture must equal. */
const STALE_DECODER_BLOB = "d2d9b39e9f7b6da6baa262853931afdc344bf9db";
const staleSource = readFileSync(new URL("./fixtures/staleClientDecoder.main.ts.txt", import.meta.url));

/** Git's object id for a blob: SHA-1 of "blob <size>", a NUL byte, then the bytes. */
const gitBlobId = (bytes: Buffer): string =>
  createHash("sha1").update(`blob ${bytes.length}${String.fromCharCode(0)}`).update(bytes).digest("hex");

function compileStaleDecoder(source: string): Decoder {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} as { decodeHTMLEntities?: Decoder } };
  new Function("module", "exports", outputText)(module, module.exports);
  if (typeof module.exports.decodeHTMLEntities !== "function") throw new Error("the fixture exports no decodeHTMLEntities");
  return module.exports.decodeHTMLEntities;
}

const staleClient = compileStaleDecoder(staleSource.toString("utf8"));

const C = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const CONFIG = { synonymLookup: {}, poolStudyTypes: [], poolKeywords: [], synonymGroups: [] };
const DECODER_MODULE = "../../../../src/lib/decodeHTMLEntities";

describe("the stale tab's decoder", () => {
  it("is main's client decoder, byte for byte", () => {
    expect(gitBlobId(staleSource)).toBe(STALE_DECODER_BLOB);
  });

  it("behaves as main's decoder did: a cascade, and a whole-field fallback", () => {
    expect(staleClient("Value &amp;lt; text")).toBe("Value < text");
    expect(staleClient("AT&amp;T &#x110000;")).toBe("AT&amp;T &#x110000;");
    expect(staleClient(null)).toBeNull();
  });
});

let staleNormalize: typeof normalizePaperData;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock(DECODER_MODULE, () => ({ decodeHTMLEntities: staleClient }));
  ({ normalizePaperData: staleNormalize } = await import("../../../../src/lib/normalizePaperData"));
  vi.doUnmock(DECODER_MODULE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function paper(normalize: typeof normalizePaperData, fields: Partial<RawPaperData>) {
  return normalize(
    {
      title: "T",
      authors: [],
      year: null,
      journal: null,
      pmid: null,
      doi: null,
      abstract: null,
      keywords: [],
      study_type: null,
      pubmed_url: null,
      journal_url: null,
      drive_url: null,
      ...fields,
    },
    CONFIG,
  );
}

type Field = "PubMed title" | "PubMed abstract" | "Crossref abstract";
const FIELDS: Field[] = ["PubMed title", "PubMed abstract", "Crossref abstract"];

/** The Edge reading of one provider field. */
function edgeOf(field: Field, source: string): string | null {
  if (field === "PubMed title") return pubmedArticleTitle(efetchDocument(pubmedArticle({ title: source }))) ?? null;
  if (field === "PubMed abstract") return pubmedAbstract(efetchDocument(pubmedArticle({ abstract: source })));
  return crossrefAbstract(`<jats:p>${source}</jats:p>`);
}

/** What a tab stores from that reading, through the whole client normalization. */
function storedBy(normalize: typeof normalizePaperData, field: Field, edge: string | null): string | null {
  return field === "PubMed title" ? paper(normalize, { title: edge ?? "" }).title : paper(normalize, { abstract: edge }).abstract;
}

describe("the two stale-tab regressions found in revision 001A", () => {
  const source = "AT&T and p < 0.05; invalid &#x110000;";
  const text = "AT&T and p < 0.05; invalid &#x110000;";

  it.each(FIELDS)("Example A in a %s: a stale tab stores the text", (field) => {
    const edge = edgeOf(field, source);
    expect(edge).toBe("AT&amp;T and p &lt; 0.05; invalid &amp;#x110000;");
    expect(storedBy(staleNormalize, field, edge)).toBe(text);
    expect(storedBy(normalizePaperData, field, edge)).toBe(text);
  });

  it("the representation revision 001A sent made the old decoder give up on the whole field", () => {
    // Recorded from revision 001A's xmlText.ts on the same source.
    const sentBy001A = "AT&amp;T and p &lt; 0.05; invalid &#x110000;";
    expect(staleClient(sentBy001A)).toBe(sentBy001A);
    expect(currentClient(sentBy001A)).toBe(text);
  });
});

describe("references the old decoder would have read differently", () => {
  it.each<[string, string, string, string]>([
    ["a reference above U+10FFFF beside valid ones", "A &amp; B &#x110000; C &lt; D", "A &amp; B &amp;#x110000; C &lt; D", "A & B &#x110000; C < D"],
    ["a decimal reference above U+10FFFF", "R&D &#1114112; at p < 1", "R&amp;D &amp;#1114112; at p &lt; 1", "R&D &#1114112; at p < 1"],
    [
      "a hexadecimal & the old decoder would have joined to a decimal reference",
      "AT&T &#x26;#1114112; p < 1",
      "AT&amp;T &amp;#1114112; p &lt; 1",
      "AT&T &#1114112; p < 1",
    ],
    ["U+0000, which PostgreSQL cannot store", "NUL &#0; and AT&T", "NUL &amp;#0; and AT&amp;T", "NUL &#0; and AT&T"],
    [
      "a lone surrogate beside an invalid reference",
      "&#x110000; lone &#xDC00; p < 2",
      "&amp;#x110000; lone &amp;#xDC00; p &lt; 2",
      "&#x110000; lone &#xDC00; p < 2",
    ],
    ["a decimal & before amp", "R&#38;amp;D", "R&amp;amp;D", "R&amp;D"],
  ])("%s", (_name, source, edge, text) => {
    for (const field of FIELDS) {
      const written = edgeOf(field, source);
      expect(written).toBe(edge);
      expect(storedBy(staleNormalize, field, written)).toBe(text);
      expect(storedBy(normalizePaperData, field, written)).toBe(text);
    }
  });

  it("surrogate pairs stay as written, so both decoders combine them", () => {
    const source = "Math &#xD835;&#xDC00; and &#55349;<i></i>&#56320; bold";
    const edge = "Math &#xD835;&#xDC00; and &#55349;&#56320; bold";
    const text = `Math ${C(0x1d400)} and ${C(0x1d400)} bold`;
    for (const field of FIELDS) {
      expect(edgeOf(field, source)).toBe(edge);
      expect(storedBy(staleNormalize, field, edge)).toBe(text);
      expect(storedBy(normalizePaperData, field, edge)).toBe(text);
    }
  });
});

describe("what a stale tab still reads differently: the old decoder's named cascade", () => {
  // Pre-existing. Production (state A) does the same to `&amp;lt;` today.
  it.each<[string, string, string, string]>([
    ["CDATA text that looks like a reference (Example B)", "<![CDATA[Literal &lt;]]>", "Literal &amp;lt;", "Literal &lt;"],
    ["one decoding of &amp;lt; (Example D)", "Value &amp;lt; text", "Value &amp;lt; text", "Value &lt; text"],
  ])("%s", (_name, source, edge, text) => {
    for (const field of FIELDS) {
      const written = edgeOf(field, source);
      expect(written).toBe(edge);
      expect(storedBy(normalizePaperData, field, written)).toBe(text);
      expect(storedBy(staleNormalize, field, written)).toBe(text.replace("&lt;", "<"));
    }
  });
});

/** Whether a string holds a UTF-16 surrogate that is not half of a pair. */
function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const NUMERIC_REFERENCE = /&#(?:x([0-9a-fA-F]+)|([0-9]+));/g;
const OLD_NAMED_CASCADE = /&amp;(?:lt|gt|quot|apos|nbsp);/;

/** The character references in `edge` that a decoder could read in more than one way. */
function ambiguousReferences(edge: string): string[] {
  const found: string[] = [];
  const references = [...edge.matchAll(NUMERIC_REFERENCE)].map((m) => ({
    text: m[0],
    at: m.index,
    value: m[1] !== undefined ? Number.parseInt(m[1], 16) : Number.parseInt(m[2], 10),
  }));
  references.forEach((r, k) => {
    const high = r.value >= 0xd800 && r.value <= 0xdbff;
    const low = r.value >= 0xdc00 && r.value <= 0xdfff;
    const next = references[k + 1];
    const previous = references[k - 1];
    const pairedAfter = high && next !== undefined && next.at === r.at + r.text.length && next.value >= 0xdc00 && next.value <= 0xdfff;
    const pairedBefore = low && previous !== undefined && previous.at + previous.text.length === r.at && previous.value >= 0xd800 && previous.value <= 0xdbff;
    if (r.value === 0 || r.value > 0x10ffff || r.value === 0x26 || ((high || low) && !pairedAfter && !pairedBefore)) found.push(r.text);
  });
  return found;
}

describe("generated fields: what the Edge sends reads alike in both decoders", () => {
  const FRAGMENTS = [
    "a", " ", ";", "#", "x", "0", "26", "60", "110000", "1114112", "&", "<", ">", "AT&T", "p < 0.05",
    "&amp;", "&lt;", "&gt;", "&quot;", "&apos;", "&nbsp;", "&alpha;", "&amp;lt;", "&amp;#x110000;",
    "&#x3B1;", "&#945;", "&#x26;", "&#38;", "&#x0026;", "&#x23;", "&#59;", "&#x31;",
    "&#x110000;", "&#1114112;", "&#99999999999999999999;", "&#x0000110000;", "&#0;", "&#x0;", "&#x0000041;",
    "&#xD835;", "&#xDC00;", "&#55349;", "&#56320;", "&#x1D400;", "&#1;", "&#xFFFE;", "&#X41;", "&amp", "&#65", "&#;",
    "<i>", "</i>", "<sub>", "</sub>", "<!-- c -->", "<![CDATA[", "]]>", "<![CDATA[&lt;]]>", "<![CDATA[&#x110000;]]>",
    "<![CDATA[]]>", "<?pi x?>", '<b title="a>b">', "<jats:title>", "</jats:title>", "<jats:p>", "</jats:p>",
  ];
  let seed = 20261128;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const contents = Array.from({ length: 4_000 }, () => {
    let content = "";
    const length = 1 + Math.floor(random() * 14);
    for (let k = 0; k < length; k++) content += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
    return content;
  });

  it.each(FIELDS)("%s", (field) => {
    const fromCodePoint = vi.spyOn(String, "fromCodePoint");
    for (const content of contents) {
      const edge = edgeOf(field, content);
      if (edge === null) continue;
      expect(ambiguousReferences(edge), content).toEqual([]);
      const current = currentClient(edge);
      expect(current, content).toBe(specDecode(edge));
      fromCodePoint.mockClear();
      const stale = staleClient(edge);
      expect(fromCodePoint.mock.results.some((result) => result.type === "throw"), content).toBe(false);
      expect(stale?.includes(String.fromCharCode(0)), content).toBe(false);
      expect(hasUnpairedSurrogate(stale ?? ""), content).toBe(false);
      if (!OLD_NAMED_CASCADE.test(edge)) expect(stale, content).toBe(current);
    }
    // 4,000 contents take well under a second; the allowance is for a loaded runner.
  }, 20_000);
});
