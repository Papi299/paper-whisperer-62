// Hand-written expectations for the Edge text extraction and reference
// decoding (CODEQL-EDGE-TEXT-EXTRACTION-001). Every expected value below was
// written from the XML 1.0 grammar and the contracts in `../../xmlText.ts`,
// `../../htmlEntities.ts` and `../../../fetch-paper-metadata/metadataText.ts`,
// never by running those modules.
//
// Data only — no test framework import — so the Vitest suites and a Deno run
// read the same vectors. Non-ASCII text is built with String.fromCodePoint so
// no raw invisible character is written into this file.

const C = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

export interface DecodeVector {
  name: string;
  input: string;
  expected: string;
}

/** `decodeHTMLEntities`: each reference once; only XML `Char` values decoded. */
export const DECODE_VECTORS: DecodeVector[] = [
  // Predefined entities.
  { name: "amp", input: "A &amp; B", expected: "A & B" },
  { name: "lt and gt", input: "p &lt; 0.05 and q &gt; 0.1", expected: "p < 0.05 and q > 0.1" },
  { name: "quot and apos", input: "&quot;x&quot; &apos;y&apos;", expected: `"x" 'y'` },
  // Decimal character references.
  { name: "decimal", input: "&#945;&#177;&#8201;", expected: C(0x3b1, 0xb1, 0x2009) },
  { name: "decimal with leading zeros", input: "&#0000065;&#00945;", expected: "A" + C(0x3b1) },
  // Hexadecimal character references.
  { name: "hex, lowercase digits", input: "&#x3b1;&#x3b2;", expected: C(0x3b1, 0x3b2) },
  { name: "hex, uppercase digits", input: "&#x3B1;&#x2265;", expected: C(0x3b1, 0x2265) },
  { name: "hex with leading zeros", input: "&#x0000041;", expected: "A" },
  { name: "uppercase X is not an XML reference", input: "&#X41;", expected: "&#X41;" },
  // Each reference once: what a reference produces is never read again.
  { name: "&amp;lt; stays one level encoded", input: "&amp;lt;", expected: "&lt;" },
  { name: "&amp;amp; stays one level encoded", input: "&amp;amp;", expected: "&amp;" },
  { name: "&amp; before a hex reference", input: "&amp;#x3B1;", expected: "&#x3B1;" },
  { name: "&amp; before quot, apos and gt", input: "&amp;quot;&amp;apos;&amp;gt;", expected: "&quot;&apos;&gt;" },
  { name: "decimal ampersand before lt", input: "&#38;lt;", expected: "&lt;" },
  { name: "decimal ampersand before amp", input: "&#38;amp;", expected: "&amp;" },
  { name: "hex ampersand before a decimal reference", input: "&#x26;#60;", expected: "&#60;" },
  { name: "hex ampersand before a hex reference", input: "&#x26;#x3C;", expected: "&#x3C;" },
  { name: "decoded < never starts anything", input: "&lt;b&gt;bold&lt;/b&gt;", expected: "<b>bold</b>" },
  // References to values that are not XML characters stay as written.
  { name: "zero", input: "a&#0;b", expected: "a&#0;b" },
  { name: "hex zero", input: "&#x0;&#x00;", expected: "&#x0;&#x00;" },
  { name: "C0 controls", input: "&#x1;&#31;&#x1F;&#8;", expected: "&#x1;&#31;&#x1F;&#8;" },
  { name: "tab, LF and CR are characters", input: "a&#9;b&#xA;c&#13;d", expected: "a\tb\nc\rd" },
  { name: "DEL and C1 controls are XML characters", input: "&#x7F;&#x85;&#x9F;", expected: C(0x7f, 0x85, 0x9f) },
  {
    name: "surrogate code points",
    input: "&#xD800;&#xDBFF;&#xDC00;&#xDFFF;&#55296;",
    expected: "&#xD800;&#xDBFF;&#xDC00;&#xDFFF;&#55296;",
  },
  { name: "either side of the surrogate block", input: "&#xD7FF;&#xE000;", expected: C(0xd7ff, 0xe000) },
  { name: "U+FFFE and U+FFFF", input: "&#xFFFE;&#xFFFF;&#65534;", expected: "&#xFFFE;&#xFFFF;&#65534;" },
  { name: "U+FFFD is a character", input: "&#xFFFD;", expected: C(0xfffd) },
  { name: "the maximum code point", input: "&#x10FFFF;&#1114111;", expected: C(0x10ffff, 0x10ffff) },
  { name: "above the maximum", input: "&#x110000;&#1114112;", expected: "&#x110000;&#1114112;" },
  // Astral characters.
  { name: "astral", input: "&#x1D6FC;&#128512;", expected: C(0x1d6fc, 0x1f600) },
  // Long references.
  { name: "twenty decimal digits", input: "&#99999999999999999999;", expected: "&#99999999999999999999;" },
  { name: "a thousand hex digits", input: `&#x${"F".repeat(1000)};`, expected: `&#x${"F".repeat(1000)};` },
  { name: "a thousand leading zeros", input: `&#${"0".repeat(1000)}65;`, expected: "A" },
  // Unknown and incomplete references.
  { name: "unknown names", input: "&nbsp;&alpha;&copy;&AMP;&Amp;", expected: "&nbsp;&alpha;&copy;&AMP;&Amp;" },
  { name: "incomplete syntax", input: "&amp &#65 &#; &#x; &#x;; & &;", expected: "&amp &#65 &#; &#x; &#x;; & &;" },
  { name: "bare ampersands", input: "AT&T R&D & co", expected: "AT&T R&D & co" },
  { name: "repeated malformed references", input: "&#x110000;".repeat(5) + "&amp;", expected: "&#x110000;".repeat(5) + "&" },
  { name: "valid and invalid together", input: "&#x3B1;&#xD800;&amp;&#0;&lt;", expected: C(0x3b1) + "&#xD800;&&#0;<" },
  // Scientific text without references.
  { name: "literal comparison operators", input: "p < 0.05 & x > 1", expected: "p < 0.05 & x > 1" },
  { name: "scientific Unicode", input: `${C(0x3b1)}-helix ${C(0x2264)} 5 ${C(0x3bc)}g CO${C(0x2082)}`, expected: `${C(0x3b1)}-helix ${C(0x2264)} 5 ${C(0x3bc)}g CO${C(0x2082)}` },
  { name: "empty", input: "", expected: "" },
];

export interface CharacterDataVector {
  name: string;
  input: string;
  expected: string;
  /** Local names of elements whose tags separate words. */
  boundaries?: string[];
}

/** `xmlCharacterData`: markup removed, output still escaped. */
export const CHARACTER_DATA_VECTORS: CharacterDataVector[] = [
  { name: "plain text", input: "Plain text", expected: "Plain text" },
  {
    name: "references are copied as written, except one that names no character",
    input: "A &amp; B &lt; C &#x3B1; &#945; &nbsp; &#x110000;",
    expected: "A &amp; B &lt; C &#x3B1; &#945; &nbsp; &amp;#x110000;",
  },
  { name: "inline markup", input: "Growth of <i>E. coli</i> in CO<sub>2</sub>-rich media", expected: "Growth of E. coli in CO2-rich media" },
  { name: "nested markup", input: "<b><i>bold italic</i></b> and <sup><i>x</i></sup>", expected: "bold italic and x" },
  { name: "underline and superscript", input: "<sup>13</sup>C and H<sub>2</sub>O <u>yield</u>", expected: "13C and H2O yield" },
  { name: "empty-element tags", input: "a<br/>b<br />c", expected: "abc" },
  { name: "white space inside tags", input: "<i >x</i >", expected: "x" },
  {
    name: "attributes in both quote styles",
    input: `<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML" display='inline'><mml:mi>x</mml:mi><mml:mo>&gt;</mml:mo><mml:mn>1</mml:mn></mml:math>`,
    expected: "x&gt;1",
  },
  { name: "a quoted > in an attribute", input: '<sup note="a>b">1</sup> of X', expected: "1 of X" },
  { name: "a quoted > in a single-quoted attribute", input: "<sup note='a > b'>1</sup>", expected: "1" },
  { name: "references in an attribute", input: '<x a="&amp;&gt;">t</x>', expected: "t" },
  { name: "CDATA text is escaped", input: "<![CDATA[p < 0.05 & q > 0.1]]> in trials", expected: "p &lt; 0.05 &amp; q &gt; 0.1 in trials" },
  { name: "reference text inside CDATA", input: "<![CDATA[&amp;lt;]]>", expected: "&amp;amp;lt;" },
  { name: "markup text inside CDATA", input: "<![CDATA[<i>x</i>]]>", expected: "&lt;i&gt;x&lt;/i&gt;" },
  { name: "empty CDATA", input: "a<![CDATA[]]>b", expected: "ab" },
  { name: "comment", input: "Before<!-- a > b --> after", expected: "Before after" },
  { name: "empty comment", input: "a<!---->b", expected: "ab" },
  { name: "processing instruction", input: "x<?pi a > b?>y", expected: "xy" },
  { name: "escaped markup stays text", input: "Use &lt;b&gt;bold&lt;/b&gt;", expected: "Use &lt;b&gt;bold&lt;/b&gt;" },
  { name: "literal >", input: "p > 0.001 and x >= 5", expected: "p > 0.001 and x >= 5" },
  { name: "stray < before a digit", input: "Dose <5 mg", expected: "Dose &lt;5 mg" },
  { name: "stray < before a space", input: "5 < x < 10", expected: "5 &lt; x &lt; 10" },
  { name: "stray < without a following >", input: "p<0.05", expected: "p&lt;0.05" },
  { name: "tag-like text that is not a tag", input: "a <b and c> d", expected: "a &lt;b and c> d" },
  { name: "attribute without preceding white space", input: '<a b="1"c="2">x</a>', expected: '&lt;a b="1"c="2">x' },
  { name: "unterminated quote", input: 'Unit <tag attr="unterminated>rest', expected: 'Unit &lt;tag attr="unterminated>rest' },
  { name: "< inside an attribute value", input: '<x a="1<2">t</x>', expected: '&lt;x a="1&lt;2">t' },
  { name: "unterminated comment", input: "a <!-- never closed", expected: "a &lt;!-- never closed" },
  { name: "unterminated CDATA", input: "a <![CDATA[ never closed", expected: "a &lt;![CDATA[ never closed" },
  { name: "unterminated processing instruction", input: "a <?pi never closed", expected: "a &lt;?pi never closed" },
  { name: "declaration other than comment or CDATA", input: "<!DOCTYPE x>t", expected: "&lt;!DOCTYPE x>t" },
  { name: "processing instruction without a target", input: "<? x ?>t", expected: "&lt;? x ?>t" },
  { name: "end tag without a name", input: "a</>b", expected: "a&lt;/>b" },
  { name: "repeated angle brackets", input: "<< >> <> <-", expected: "&lt;&lt; >> &lt;> &lt;-" },
  { name: "stray ampersand", input: "AT&T", expected: "AT&amp;T" },
  { name: "incomplete references", input: "&amp &#65 &#; &#X41;", expected: "&amp;amp &amp;#65 &amp;#; &amp;#X41;" },
  { name: "removing markup never completes a reference", input: "A &am<i>p; B</i>", expected: "A &amp;amp; B" },
  { name: "an unclosed start tag is still a tag", input: "a<i>b", expected: "ab" },
  { name: "a stray end tag is still a tag", input: "a</i>b", expected: "ab" },
  { name: "non-ASCII element names", input: `<${C(0xe9)}l>x</${C(0xe9)}l>`, expected: "x" },
  { name: "< before a character that cannot start a name", input: `a<${C(0x2264)}b`, expected: `a&lt;${C(0x2264)}b` },
  { name: "white space is kept as written", input: "  a \n\t b  ", expected: "  a \n\t b  " },
  // Word boundaries (Crossref JATS).
  {
    name: "a block boundary separates touching words",
    input: "<jats:title>Abstract</jats:title><jats:p>Text</jats:p>",
    boundaries: ["title", "p"],
    expected: "Abstract Text",
  },
  {
    name: "existing white space at a boundary is kept",
    input: "<jats:title>Abstract</jats:title>\n<jats:p>Text</jats:p>",
    boundaries: ["title", "p"],
    expected: "Abstract\nText",
  },
  {
    name: "inline elements never add a space",
    input: "CO<jats:sub>2</jats:sub> and <jats:italic>E</jats:italic>.",
    boundaries: ["title", "p"],
    expected: "CO2 and E.",
  },
  { name: "no space before the first word", input: "<jats:p>Text</jats:p>", boundaries: ["p"], expected: "Text" },
  { name: "a boundary at the end adds nothing", input: "<jats:p>One</jats:p><jats:p></jats:p>", boundaries: ["p"], expected: "One" },
  { name: "an empty-element boundary", input: "<jats:p>one<jats:break/>two</jats:p>", boundaries: ["p", "break"], expected: "one two" },
  { name: "boundaries match the local name", input: "<p>a</p><x:p>b</x:p>", boundaries: ["p"], expected: "a b" },
  { name: "one space for several boundaries", input: "<jats:sec><jats:title>A</jats:title></jats:sec><jats:sec><jats:p>B</jats:p></jats:sec>", boundaries: ["sec", "title", "p"], expected: "A B" },
  { name: "a boundary before escaped text", input: "<jats:p>A</jats:p><jats:p><![CDATA[<b]]></jats:p>", boundaries: ["p"], expected: "A &lt;b" },
];

/**
 * `xmlCharacterData`: the character references written as text or as `&amp;`
 * (CODEQL-EDGE-TEXT-EXTRACTION-001B), so that every decoder reads the output
 * alike. Decoding each expected value once gives what decoding the reference
 * as written gave: the references kept as text decode to themselves, and
 * `&amp;` decodes as `&#x26;` does.
 */
export const DECODER_NEUTRAL_VECTORS: CharacterDataVector[] = [
  // U+0000 and values above U+10FFFF: the `&` is escaped.
  { name: "above U+10FFFF, hexadecimal and decimal", input: "invalid &#x110000; and &#1114112;", expected: "invalid &amp;#x110000; and &amp;#1114112;" },
  { name: "twenty decimal digits", input: "a&#99999999999999999999;b", expected: "a&amp;#99999999999999999999;b" },
  { name: "a thousand hex digits", input: `&#x${"F".repeat(1000)};`, expected: `&amp;#x${"F".repeat(1000)};` },
  { name: "leading zeros keep a value small", input: "&#x0000000041; &#00000065; &#x0000110000;", expected: "&#x0000000041; &#00000065; &amp;#x0000110000;" },
  { name: "U+0000 in each spelling", input: "a&#0;b&#x0;c&#x0000;d&#000;", expected: "a&amp;#0;b&amp;#x0;c&amp;#x0000;d&amp;#000;" },
  { name: "the largest code point is copied, the next is not", input: "&#x10FFFF;&#1114111;&#x110000;", expected: "&#x10FFFF;&#1114111;&amp;#x110000;" },
  { name: "valid references beside invalid ones", input: "&#x3B1;&#x110000;&amp;&#0;&lt;&#177;", expected: "&#x3B1;&amp;#x110000;&amp;&amp;#0;&lt;&#177;" },
  { name: "a stray & and < with an invalid reference", input: "AT&T and p < 0.05; invalid &#x110000;", expected: "AT&amp;T and p &lt; 0.05; invalid &amp;#x110000;" },
  { name: "an already escaped reference is unchanged", input: "&amp;#x110000; &amp;#0;", expected: "&amp;#x110000; &amp;#0;" },
  { name: "CDATA text that looks like an invalid reference", input: "<![CDATA[&#x110000;]]>", expected: "&amp;#x110000;" },
  // A reference to "&" itself: written &amp;.
  { name: "every spelling of a reference to &", input: "AT&#38;T R&#x26;D &#x0026; &#038;", expected: "AT&amp;T R&amp;D &amp; &amp;" },
  { name: "a hexadecimal & before a decimal reference", input: "&#x26;#60; and &#x26;#1114112;", expected: "&amp;#60; and &amp;#1114112;" },
  { name: "a decimal & before amp", input: "&#38;amp;", expected: "&amp;amp;" },
  { name: "other references to punctuation are copied", input: "&#x23;&#59;&#x3C;&#60;", expected: "&#x23;&#59;&#x3C;&#60;" },
  // Surrogate code points: kept only as one half of a pair.
  { name: "surrogate pairs stay as written", input: "&#xD835;&#xDC00; &#55349;&#56320; &#xD835;&#56320;", expected: "&#xD835;&#xDC00; &#55349;&#56320; &#xD835;&#56320;" },
  { name: "a pair across markup the output does not show", input: "&#xD835;<i></i>&#xDC00; &#xD835;<!-- c -->&#xDC01;", expected: "&#xD835;&#xDC00; &#xD835;&#xDC01;" },
  { name: "an empty CDATA section does not separate a pair", input: "&#xD835;<![CDATA[]]>&#xDC00;", expected: "&#xD835;&#xDC00;" },
  { name: "lone halves are text", input: "&#xD835; and &#xDC00; and &#55296;", expected: "&amp;#xD835; and &amp;#xDC00; and &amp;#55296;" },
  { name: "a high half followed by something else", input: "&#xD835;x&#xDC00; &#xD835;&#x41;", expected: "&amp;#xD835;x&amp;#xDC00; &amp;#xD835;&#x41;" },
  { name: "two high halves, then a low half", input: "&#xD835;&#xD835;&#xDC00;", expected: "&amp;#xD835;&#xD835;&#xDC00;" },
  { name: "a high half, then two low halves", input: "&#xD835;&#xDC00;&#xDC00;", expected: "&#xD835;&#xDC00;&amp;#xDC00;" },
  { name: "a low half before a high half", input: "&#xDC00;&#xD835;", expected: "&amp;#xDC00;&amp;#xD835;" },
  { name: "a high half at the end", input: "x&#xD835;", expected: "x&amp;#xD835;" },
  { name: "a high half before escaped text", input: "&#xD835;<![CDATA[a]]>&#xD835;&amp;&#xD835;<5", expected: "&amp;#xD835;a&amp;#xD835;&amp;&amp;#xD835;&lt;5" },
  { name: "a high half before an invalid reference or a reference to &", input: "&#xD835;&#x110000; &#xD835;&#x26;", expected: "&amp;#xD835;&amp;#x110000; &amp;#xD835;&amp;" },
  {
    name: "a word boundary separates a pair",
    input: "<jats:p>&#xD835;</jats:p><jats:p>&#xDC00;</jats:p>",
    boundaries: ["p"],
    expected: "&amp;#xD835; &amp;#xDC00;",
  },
  {
    name: "a word boundary before a pair keeps it whole",
    input: "<jats:p>A</jats:p><jats:p>&#xD835;&#xDC00;</jats:p>",
    boundaries: ["p"],
    expected: "A &#xD835;&#xDC00;",
  },
];

export interface ElementVector {
  name: string;
  xml: string;
  element: string;
  limit?: number;
  expected: string[];
}

/** `xmlElementContents`: complete elements, in order, first end tag closes. */
export const ELEMENT_VECTORS: ElementVector[] = [
  { name: "the first element only", xml: "<A>1</A><A>2</A>", element: "A", limit: 1, expected: ["1"] },
  { name: "every element", xml: "<A>1</A>x<A>2</A>", element: "A", expected: ["1", "2"] },
  {
    name: "a start tag with a quoted >",
    xml: '<A Label="P > 0.05" NlmCategory="RESULTS">Significant.</A>',
    element: "A",
    expected: ["Significant."],
  },
  { name: "an empty-element tag contributes nothing", xml: '<A Label="X"/><A>only</A>', element: "A", expected: ["only"] },
  { name: "an explicit empty element is empty", xml: "<A></A><A>b</A>", element: "A", expected: ["", "b"] },
  { name: "inner markup is left for the extractor", xml: "<A>x <i>y</i></A>", element: "A", expected: ["x <i>y</i>"] },
  { name: "names are compared exactly", xml: "<AB>no</AB><a>no</a><A>yes</A>", element: "A", expected: ["yes"] },
  { name: "tags inside a comment are not tags", xml: "<!-- <A>no</A> --><A>yes</A>", element: "A", expected: ["yes"] },
  { name: "tags inside CDATA are not tags", xml: "<X><![CDATA[<A>no</A>]]></X><A>yes</A>", element: "A", expected: ["yes"] },
  { name: "CDATA inside the element is content", xml: "<A><![CDATA[</A>]]>x</A>", element: "A", expected: ["<![CDATA[</A>]]>x"] },
  { name: "an unclosed element yields nothing", xml: "<A>never closed", element: "A", expected: [] },
  { name: "the first end tag closes the element", xml: "<A>a<A>b</A>c</A>", element: "A", expected: ["a<A>b"] },
  { name: "a stray end tag is ignored", xml: "</A><A>x</A>", element: "A", expected: ["x"] },
  {
    name: "the prolog and DOCTYPE are skipped",
    xml: '<?xml version="1.0" ?>\n<!DOCTYPE S PUBLIC "-//X//EN" "x.dtd">\n<S><A>t</A></S>',
    element: "A",
    expected: ["t"],
  },
  { name: "no element", xml: "<S>nothing</S>", element: "A", expected: [] },
  { name: "not XML at all", xml: "plain text with p < 0.05", element: "A", expected: [] },
];
