import { describe, it, expect } from "vitest";
import {
  parseBibTeX,
  parseRIS,
  parseNBIB,
  parseEndNoteTagged,
  parseCSV,
  parseFile,
} from "../importParsers";
import { normalizePaperData, type NormalizationConfig } from "../normalizePaperData";

// ══════════════════════════════════════════════════════════════
// BibTeX Parser Tests
// ══════════════════════════════════════════════════════════════

describe("parseBibTeX", () => {
  it("parses a single standard article entry", () => {
    const bib = `@article{Smith2024_Example,
  title     = {{Effect of Treatment on Outcomes}},
  author    = {Smith, John and Doe, Jane},
  year      = {2024},
  journal   = {Journal of Testing},
  doi       = {10.1000/test123},
  pmid      = {12345678},
  abstract  = {This is the abstract.},
  keywords  = {treatment, outcomes, clinical trial},
  note      = {Study type: Randomized Controlled Trial}
}`;
    const result = parseBibTeX(bib);
    expect(result.warnings).toHaveLength(0);
    expect(result.papers).toHaveLength(1);

    const p = result.papers[0];
    expect(p.title).toBe("Effect of Treatment on Outcomes");
    expect(p.authors).toEqual(["Smith, John", "Doe, Jane"]);
    expect(p.year).toBe(2024);
    expect(p.journal).toBe("Journal of Testing");
    expect(p.doi).toBe("10.1000/test123");
    expect(p.pmid).toBe("12345678");
    expect(p.abstract).toBe("This is the abstract.");
    expect(p.keywords).toEqual(["treatment", "outcomes", "clinical trial"]);
    expect(p.study_type).toBe("Randomized Controlled Trial");
  });

  it("parses multiple entries", () => {
    const bib = `@article{a,
  title = {First Paper},
  author = {Author One}
}

@article{b,
  title = {Second Paper},
  author = {Author Two}
}`;
    const result = parseBibTeX(bib);
    expect(result.papers).toHaveLength(2);
    expect(result.papers[0].title).toBe("First Paper");
    expect(result.papers[1].title).toBe("Second Paper");
  });

  it("handles nested braces in title", () => {
    const bib = `@article{key,
  title = {{The {HIV} Epidemic: A {Meta-Analysis}}}
}`;
    const result = parseBibTeX(bib);
    expect(result.papers[0].title).toBe("The {HIV} Epidemic: A {Meta-Analysis}");
  });

  it("decodes LaTeX accents in author names", () => {
    const bib = `@article{key,
  title = {A Study},
  author = {Garc{\\'i}a, Mar{\\'i}a and M{\\"u}ller, Hans and Gon{\\c{c}}alves, Jo{\\~a}o}
}`;
    const result = parseBibTeX(bib);
    expect(result.papers[0].authors).toEqual([
      "García, María",
      "Müller, Hans",
      "Gonçalves, João",
    ]);
  });

  it("skips entries without title and adds warning", () => {
    const bib = `@article{key,
  author = {Smith, John},
  year = {2024}
}`;
    const result = parseBibTeX(bib);
    expect(result.papers).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing title");
  });

  it("skips @comment, @string, @preamble entries", () => {
    const bib = `@comment{This is a comment}
@string{jot = {Journal of Testing}}
@preamble{"LaTeX preamble"}
@article{key,
  title = {Real Paper}
}`;
    const result = parseBibTeX(bib);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].title).toBe("Real Paper");
  });

  it("handles quote-delimited field values", () => {
    const bib = `@article{key,
  title = "A Quoted Title",
  year = "2023"
}`;
    const result = parseBibTeX(bib);
    expect(result.papers[0].title).toBe("A Quoted Title");
    expect(result.papers[0].year).toBe(2023);
  });

  it("handles entries with missing optional fields gracefully", () => {
    const bib = `@article{key,
  title = {Minimal Paper}
}`;
    const result = parseBibTeX(bib);
    expect(result.papers).toHaveLength(1);
    const p = result.papers[0];
    expect(p.title).toBe("Minimal Paper");
    expect(p.authors).toEqual([]);
    expect(p.year).toBeNull();
    expect(p.doi).toBeNull();
    expect(p.keywords).toEqual([]);
  });

  it("extracts PMID from explicit pmid field and generates pubmed_url", () => {
    const bib = `@article{key,
  title = {PMID Test},
  pmid = {99887766}
}`;
    const result = parseBibTeX(bib);
    expect(result.papers[0].pmid).toBe("99887766");
    expect(result.papers[0].pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/99887766/");
  });

  it("extracts PMID from url field containing PubMed link", () => {
    const bib = `@article{key,
  title = {URL PMID Test},
  url = {https://pubmed.ncbi.nlm.nih.gov/12345678/}
}`;
    const result = parseBibTeX(bib);
    expect(result.papers[0].pmid).toBe("12345678");
    expect(result.papers[0].pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
  });

  it("extracts PMID from note field containing PubMed link", () => {
    const bib = `@article{key,
  title = {Note PMID Test},
  note = {Available at https://pubmed.ncbi.nlm.nih.gov/55443322/}
}`;
    const result = parseBibTeX(bib);
    expect(result.papers[0].pmid).toBe("55443322");
    expect(result.papers[0].pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/55443322/");
  });

  it("handles bare numeric values (e.g., year without braces)", () => {
    const bib = `@article{key,
  title = {Paper},
  year = 2025
}`;
    const result = parseBibTeX(bib);
    expect(result.papers[0].year).toBe(2025);
  });
});

// ══════════════════════════════════════════════════════════════
// RIS Parser Tests
// ══════════════════════════════════════════════════════════════

describe("parseRIS", () => {
  // The PMID is carried by the authenticated `UR` record link, not by `AN` —
  // see the "RIS AN is not a PMID" block below.
  it("parses a single standard RIS entry", () => {
    const ris = `TY  - JOUR
T1  - Effect of Treatment on Outcomes
AU  - Smith, John
AU  - Doe, Jane
PY  - 2024
JO  - Journal of Testing
AN  - 12345678
UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/
DO  - 10.1000/test123
AB  - This is the abstract.
KW  - treatment
KW  - outcomes
N1  - Randomized Controlled Trial
ER  - `;
    const result = parseRIS(ris);
    expect(result.warnings).toHaveLength(0);
    expect(result.papers).toHaveLength(1);

    const p = result.papers[0];
    expect(p.title).toBe("Effect of Treatment on Outcomes");
    expect(p.authors).toEqual(["Smith, John", "Doe, Jane"]);
    expect(p.year).toBe(2024);
    expect(p.journal).toBe("Journal of Testing");
    expect(p.pmid).toBe("12345678");
    expect(p.doi).toBe("10.1000/test123");
    expect(p.abstract).toBe("This is the abstract.");
    expect(p.keywords).toEqual(["treatment", "outcomes"]);
    expect(p.study_type).toBe("Randomized Controlled Trial");
  });

  it("parses multiple RIS entries", () => {
    const ris = `TY  - JOUR
T1  - First Paper
AU  - Author One
ER  -

TY  - JOUR
T1  - Second Paper
AU  - Author Two
ER  - `;
    const result = parseRIS(ris);
    expect(result.papers).toHaveLength(2);
    expect(result.papers[0].title).toBe("First Paper");
    expect(result.papers[1].title).toBe("Second Paper");
  });

  it("extracts study type from 'Study type:' prefixed N1", () => {
    const ris = `TY  - JOUR
T1  - A Study
N1  - Study type: Meta-Analysis
ER  - `;
    const result = parseRIS(ris);
    expect(result.papers[0].study_type).toBe("Meta-Analysis");
  });

  it("handles PY with date format (extracts year)", () => {
    const ris = `TY  - JOUR
T1  - Paper
PY  - 2024/03/15
ER  - `;
    const result = parseRIS(ris);
    expect(result.papers[0].year).toBe(2024);
  });

  it("skips entries without title", () => {
    const ris = `TY  - JOUR
AU  - Smith
ER  - `;
    const result = parseRIS(ris);
    expect(result.papers).toHaveLength(0);
    expect(result.warnings[0]).toContain("missing title");
  });

  it("handles alternate title tags (TI)", () => {
    const ris = `TY  - JOUR
TI  - Alternate Title Tag
ER  - `;
    const result = parseRIS(ris);
    expect(result.papers[0].title).toBe("Alternate Title Tag");
  });

  it("handles entry without ER terminator", () => {
    const ris = `TY  - JOUR
T1  - Missing Terminator
AU  - Smith`;
    const result = parseRIS(ris);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].title).toBe("Missing Terminator");
  });

  it("extracts URLs correctly", () => {
    const ris = `TY  - JOUR
T1  - URL Paper
UR  - https://pubmed.ncbi.nlm.nih.gov/12345/
L2  - https://journal.example.com/article
L1  - https://drive.google.com/file/abc
ER  - `;
    const result = parseRIS(ris);
    const p = result.papers[0];
    expect(p.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345/");
    expect(p.journal_url).toBe("https://journal.example.com/article");
    expect(p.drive_url).toBe("https://drive.google.com/file/abc");
  });
});

// ══════════════════════════════════════════════════════════════
// PubMed / NLM NBIB Parser Tests
//
// Fixtures are native MEDLINE tagged syntax, never RIS wearing an `.nbib`
// name. `NBIB_REAL_RECORD` is a field-for-field reduction of the genuine
// PubMed export for PMID 39725180 (J Ren Nutr, 2025 May) — retrieved once
// during development and pinned here as a static string; nothing in the suite
// touches the network. Only the abstract and the author list are truncated;
// every tag line below is in the shape PubMed emitted it.
// ══════════════════════════════════════════════════════════════

const NBIB_REAL_RECORD = `
PMID- 39725180
OWN - NLM
STAT- MEDLINE
IS  - 1532-8503 (Electronic)
VI  - 35
IP  - 3
DP  - 2025 May
TI  - Hypomagnesemia is a Risk Factor for Acute Kidney Injury in Patients Admitted
      With ST-Segment Elevation Myocardial Infarction: A Retrospective
      Observational Study.
PG  - 387-392
LID - S1051-2276(24)00291-7 [pii]
LID - 10.1053/j.jrn.2024.12.006 [doi]
AB  - OBJECTIVES: Acute kidney injury (AKI) is prevalent in patients hospitalized
      with ST segment elevation myocardial infarction (STEMI) and is correlated
      with worse cardiovascular outcomes.
FAU - Jin, Youkai
AU  - Jin Y
AD  - Department of Cardiology, The People's Hospital of Yuhuan, Taizhou, China.
FAU - Lin, Qingcheng
AU  - Lin Q
LA  - eng
PT  - Journal Article
PT  - Observational Study
PL  - United States
TA  - J Ren Nutr
JT  - Journal of renal nutrition : the official journal of the Council on Renal
      Nutrition of the National Kidney Foundation
JID - 9112938
RN  - I38ZP9992A (Magnesium)
SB  - IM
MH  - Humans
MH  - *Acute Kidney Injury/epidemiology/etiology/blood
MH  - *Magnesium/blood
OTO - NOTNLM
OT  - acute kidney injury
OT  - hypomagnesemia
EDAT- 2024/12/27 00:20
MHDA- 2025/06/10 00:30
CRDT- 2024/12/26 19:17
AID - S1051-2276(24)00291-7 [pii]
AID - 10.1053/j.jrn.2024.12.006 [doi]
PST - ppublish
SO  - J Ren Nutr. 2025 May;35(3):387-392. doi: 10.1053/j.jrn.2024.12.006.
`;

/** Minimal native record builder for focused single-behaviour assertions. */
const nbib = (body: string) => parseNBIB(`\nPMID- 11111111\nTI  - Fixture\n${body}`);
const nbibPaper = (body: string) => nbib(body).papers[0];

describe("parseNBIB — native PubMed record", () => {
  const result = parseNBIB(NBIB_REAL_RECORD);
  const p = result.papers[0];

  it("parses the record without warnings", () => {
    expect(result.warnings).toEqual([]);
    expect(result.papers).toHaveLength(1);
  });

  it("joins a wrapped TI into one logical title", () => {
    expect(p.title).toBe(
      "Hypomagnesemia is a Risk Factor for Acute Kidney Injury in Patients Admitted " +
        "With ST-Segment Elevation Myocardial Infarction: A Retrospective " +
        "Observational Study.",
    );
  });

  it("joins a wrapped JT into one logical journal title", () => {
    expect(p.journal).toBe(
      "Journal of renal nutrition : the official journal of the Council on Renal " +
        "Nutrition of the National Kidney Foundation",
    );
  });

  it("joins a wrapped AB into one logical abstract", () => {
    expect(p.abstract).toBe(
      "OBJECTIVES: Acute kidney injury (AKI) is prevalent in patients hospitalized " +
        "with ST segment elevation myocardial infarction (STEMI) and is correlated " +
        "with worse cardiovascular outcomes.",
    );
  });

  it("takes the PMID from the explicit PMID field and canonicalises the link", () => {
    expect(p.pmid).toBe("39725180");
    expect(p.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/39725180/");
  });

  it("takes the DOI only from the [doi]-qualified identifier", () => {
    expect(p.doi).toBe("10.1053/j.jrn.2024.12.006");
  });

  it("prefers FAU over AU without listing the same author twice", () => {
    expect(p.authors).toEqual(["Jin, Youkai", "Lin, Qingcheng"]);
  });

  it("reads the year from DP", () => {
    expect(p.year).toBe(2025);
  });

  it("maps OT to keywords and MH to mesh terms, not the other way round", () => {
    expect(p.keywords).toEqual(["acute kidney injury", "hypomagnesemia"]);
    expect(p.mesh_terms).toEqual([
      "Humans",
      "Acute Kidney Injury/epidemiology/etiology/blood",
      "Magnesium/blood",
    ]);
  });

  it("does not turn the RN registry entry into a substance", () => {
    expect(p.substances).toEqual([]);
    expect(p.substances).not.toContain("I38ZP9992A (Magnesium)");
  });

  it("passes repeated PT values through as comma-separated study-type input", () => {
    expect(p.study_type).toBe("Journal Article, Observational Study");
  });

  it("leaves journal_url null rather than mining SO for a link", () => {
    expect(p.journal_url).toBeNull();
    expect(p.drive_url).toBeNull();
  });
});

describe("parseNBIB — continuation lines", () => {
  it("keeps the trailing space PubMed leaves on a wrapped physical line", () => {
    // Real exports pad each wrapped line to the value column and leave a
    // trailing space before the newline. Written with an explicit escape so the
    // fixture keeps that byte without a trailing space in this source file.
    const wrapped =
      "\nPMID- 39725180\n" +
      "TI  - Hypomagnesemia is a Risk Factor for Acute Kidney Injury in Patients Admitted With \n" +
      "      ST-Segment Elevation Myocardial Infarction.\n";
    expect(parseNBIB(wrapped).papers[0].title).toBe(
      "Hypomagnesemia is a Risk Factor for Acute Kidney Injury in Patients Admitted " +
        "With ST-Segment Elevation Myocardial Infarction.",
    );
  });

  it("does not lose words across a three-line wrap", () => {
    const p = nbibPaper("AB  - one two\n      three four\n      five six\n");
    expect(p.abstract).toBe("one two three four five six");
  });

  it("does not turn a continuation line into a field of its own", () => {
    const p = nbibPaper("JT  - Journal of\n      Testing\nTA  - J Test\n");
    expect(p.journal).toBe("Journal of Testing");
  });

  it("does not attach a continuation to the wrong field", () => {
    const p = nbibPaper("AB  - abstract text\nJT  - Journal of\n      Testing\n");
    expect(p.abstract).toBe("abstract text");
    expect(p.journal).toBe("Journal of Testing");
  });
});

describe("parseNBIB — multiple records", () => {
  // Two native citations separated by a blank line. Every distinguishing field
  // differs, so any cross-record contamination shows up as a wrong value rather
  // than only as a wrong count.
  const MULTI = `
PMID- 11111111
DP  - 2019 Jan-Feb
TI  - First native record
FAU - Alpha, Ann
JT  - Journal of First Things
AID - 10.1000/first [doi]
PT  - Randomized Controlled Trial

PMID- 22222222
DP  - 2024 Winter
TI  - Second native record
FAU - Beta, Bob
JT  - Journal of Second Things
AID - 10.1000/second [doi]
PT  - Meta-Analysis
`;

  const result = parseNBIB(MULTI);

  it("keeps the records separate and in file order", () => {
    expect(result.warnings).toEqual([]);
    expect(result.papers).toHaveLength(2);
    expect(result.papers.map((p) => p.title)).toEqual([
      "First native record",
      "Second native record",
    ]);
  });

  it("does not merge fields between adjacent citations", () => {
    const [first, second] = result.papers;
    expect(first.pmid).toBe("11111111");
    expect(second.pmid).toBe("22222222");
    expect(first.authors).toEqual(["Alpha, Ann"]);
    expect(second.authors).toEqual(["Beta, Bob"]);
    expect(first.year).toBe(2019);
    expect(second.year).toBe(2024);
    expect(first.doi).toBe("10.1000/first");
    expect(second.doi).toBe("10.1000/second");
    expect(first.journal).toBe("Journal of First Things");
    expect(second.journal).toBe("Journal of Second Things");
    expect(first.study_type).toBe("Randomized Controlled Trial");
    expect(second.study_type).toBe("Meta-Analysis");
  });

  it("separates records that lost their blank separator", () => {
    const squashed = MULTI.replace(/\n\n/g, "\n");
    const papers = parseNBIB(squashed).papers;
    expect(papers).toHaveLength(2);
    expect(papers[0].pmid).toBe("11111111");
    expect(papers[1].pmid).toBe("22222222");
    expect(papers[0].authors).toEqual(["Alpha, Ann"]);
  });

  it("parses a CRLF export identically to an LF one", () => {
    const crlf = parseNBIB(MULTI.replace(/\n/g, "\r\n"));
    expect(crlf.warnings).toEqual([]);
    expect(crlf.papers).toEqual(result.papers);
  });

  it("parses a final record with no trailing newline", () => {
    const papers = parseNBIB(MULTI.trimEnd()).papers;
    expect(papers).toHaveLength(2);
    expect(papers[1].title).toBe("Second native record");
  });
});

describe("parseNBIB — author representation", () => {
  it("does not list a personal author under both its FAU and AU spelling", () => {
    const p = nbibPaper("FAU - Smith, John\nAU  - Smith J\n");
    expect(p.authors).toEqual(["Smith, John"]);
    expect(p.authors).not.toEqual(["Smith, John", "Smith J"]);
  });

  it("uses AU only when the export carries no FAU", () => {
    expect(nbibPaper("AU  - Smith J\nAU  - Doe J\n").authors).toEqual(["Smith J", "Doe J"]);
  });

  it("keeps FAU order and drops the parallel AU list entirely", () => {
    const p = nbibPaper("FAU - Smith, John\nAU  - Smith J\nFAU - Doe, Jane\nAU  - Doe J\n");
    expect(p.authors).toEqual(["Smith, John", "Doe, Jane"]);
  });

  it("appends a corporate author after the personal authors", () => {
    const p = nbibPaper("FAU - Smith, John\nAU  - Smith J\nCN  - GBD 2019 Collaborators\n");
    expect(p.authors).toEqual(["Smith, John", "GBD 2019 Collaborators"]);
  });

  it("keeps a corporate-only record's authorship", () => {
    expect(nbibPaper("CN  - World Health Organization\n").authors).toEqual([
      "World Health Organization",
    ]);
  });

  it("does not repeat a corporate author already selected", () => {
    const p = nbibPaper("FAU - World Health Organization\nCN  - World Health Organization\n");
    expect(p.authors).toEqual(["World Health Organization"]);
  });
});

describe("parseNBIB — publication year", () => {
  for (const [dp, year] of [
    ["2024", 2024],
    ["2024 Jan", 2024],
    ["2024 Jan-Feb", 2024],
    ["2024 Winter", 2024],
    ["2024 Sep 15", 2024],
  ] as const) {
    it(`reads ${year} from DP "${dp}"`, () => {
      expect(nbibPaper(`DP  - ${dp}\n`).year).toBe(year);
    });
  }

  it("ignores the Entrez processing dates", () => {
    // DP is the only publication-date authority: EDAT/MHDA/CRDT record when NLM
    // handled the citation, which is routinely a different year.
    const p = nbibPaper(
      "DP  - 1998 Nov-Dec\nEDAT- 2024/12/27 00:20\nMHDA- 2025/06/10 00:30\nCRDT- 2024/12/26 19:17\n",
    );
    expect(p.year).toBe(1998);
  });

  it("leaves the year null when DP establishes none", () => {
    expect(nbibPaper("EDAT- 2024/12/27 00:20\n").year).toBeNull();
    expect(nbibPaper("DP  - n.d.\n").year).toBeNull();
  });
});

describe("parseNBIB — journal title", () => {
  it("prefers the full JT over the TA abbreviation", () => {
    expect(nbibPaper("TA  - J Ren Nutr\nJT  - Journal of renal nutrition\n").journal).toBe(
      "Journal of renal nutrition",
    );
  });

  it("falls back to TA only when JT is absent", () => {
    expect(nbibPaper("TA  - J Ren Nutr\n").journal).toBe("J Ren Nutr");
  });

  it("does not concatenate JT and TA", () => {
    const journal = nbibPaper("JT  - Journal of renal nutrition\nTA  - J Ren Nutr\n").journal;
    expect(journal).not.toContain("J Ren Nutr");
  });
});

describe("parseNBIB — PMID is an explicit PubMed identifier", () => {
  // Unlike a generic accession number, `PMID` is PubMed's own field, so it may
  // establish identity — but the declared value is still syntax-checked.
  for (const value of ["123", "12345678", "2024123456789"]) {
    it(`accepts ${value}`, () => {
      const p = parseNBIB(`\nPMID- ${value}\nTI  - Fixture\n`).papers[0];
      expect(p.pmid).toBe(value);
      expect(p.pubmed_url).toBe(`https://pubmed.ncbi.nlm.nih.gov/${value}/`);
    });
  }

  for (const value of ["L629384756", "WOS:000123456700001", "not-a-pmid", "123abc", "-123", "12.3"]) {
    it(`rejects ${value}`, () => {
      const p = parseNBIB(`\nPMID- ${value}\nTI  - Fixture\n`).papers[0];
      expect(p.pmid).toBeNull();
      expect(p.pubmed_url).toBeNull();
    });
  }

  it("does not let another identifier rescue an invalid PMID", () => {
    const p = parseNBIB(
      "\nPMID- not-a-pmid\nTI  - Fixture\nAID - 10.1000/example [doi]\nLID - 12345678 [pii]\n",
    ).papers[0];
    expect(p.pmid).toBeNull();
    expect(p.pubmed_url).toBeNull();
    expect(p.doi).toBe("10.1000/example");
  });

  it("leaves PubMed identity null when the record has no PMID at all", () => {
    const p = parseNBIB("\nTI  - Fixture\nJT  - Journal\n").papers[0];
    expect(p.pmid).toBeNull();
    expect(p.pubmed_url).toBeNull();
  });
});

describe("parseNBIB — DOI requires the [doi] qualifier", () => {
  it("accepts a [doi]-qualified AID", () => {
    expect(nbibPaper("AID - 10.1000/example [doi]\n").doi).toBe("10.1000/example");
  });

  it("accepts a [doi]-qualified LID", () => {
    expect(nbibPaper("LID - 10.1000/example [doi]\n").doi).toBe("10.1000/example");
  });

  it("rejects a [pii] identifier that merely looks punctuated", () => {
    expect(nbibPaper("AID - S1234-5678(26)00001-2 [pii]\n").doi).toBeNull();
    expect(nbibPaper("LID - S1234-5678(26)00001-2 [pii]\n").doi).toBeNull();
  });

  it("picks the [doi] value out of a mixed identifier list", () => {
    const p = nbibPaper(
      "LID - S1051-2276(24)00291-7 [pii]\nLID - 10.1053/j.jrn.2024.12.006 [doi]\n" +
        "AID - S1051-2276(24)00291-7 [pii]\n",
    );
    expect(p.doi).toBe("10.1053/j.jrn.2024.12.006");
  });

  for (const unqualified of ["10.1000/example", "PMC1234567", "10.1000/example [pmc]"]) {
    it(`rejects an unqualified or foreign identifier: ${unqualified}`, () => {
      expect(nbibPaper(`AID - ${unqualified}\n`).doi).toBeNull();
    });
  }
});

describe("parseNBIB — controlled vocabulary lists", () => {
  it("maps NM to substances and never RN", () => {
    const p = nbibPaper("NM  - bevonium\nNM  - cagrilintide\nRN  - 0 (Hypoglycemic Agents)\n");
    expect(p.substances).toEqual(["bevonium", "cagrilintide"]);
    expect(p.substances).not.toContain("0 (Hypoglycemic Agents)");
  });

  it("strips the MeSH major-topic marker from the heading and its subheading", () => {
    const p = nbibPaper(
      "MH  - Humans\nMH  - *Acute Kidney Injury/epidemiology\nMH  - Kidney Failure, Chronic/*therapy\n",
    );
    expect(p.mesh_terms).toEqual([
      "Humans",
      "Acute Kidney Injury/epidemiology",
      "Kidney Failure, Chronic/therapy",
    ]);
    expect((p.mesh_terms ?? []).join(" ")).not.toContain("*");
  });

  it("keeps MeSH headings out of keywords and OT terms out of mesh terms", () => {
    const p = nbibPaper("MH  - Humans\nOT  - hypomagnesemia\n");
    expect(p.keywords).toEqual(["hypomagnesemia"]);
    expect(p.mesh_terms).toEqual(["Humans"]);
  });

  it("preserves repeated OT values in file order", () => {
    const p = nbibPaper("OT  - gamma\nOT  - alpha\nOT  - beta\n");
    expect(p.keywords).toEqual(["gamma", "alpha", "beta"]);
  });

  it("leaves all three lists empty when the record carries none", () => {
    const p = nbibPaper("JT  - Journal\n");
    expect(p.keywords).toEqual([]);
    expect(p.mesh_terms).toEqual([]);
    expect(p.substances).toEqual([]);
  });
});

describe("parseNBIB — abstract selection", () => {
  it("uses OAB only when AB is absent", () => {
    expect(nbibPaper("OAB - Publisher-supplied abstract.\n").abstract).toBe(
      "Publisher-supplied abstract.",
    );
  });

  it("does not append OAB to an AB that already exists", () => {
    const p = nbibPaper("AB  - The article abstract.\nOAB - A second abstract.\n");
    expect(p.abstract).toBe("The article abstract.");
  });

  it("leaves the abstract null when the record has neither", () => {
    expect(nbibPaper("JT  - Journal\n").abstract).toBeNull();
  });
});

describe("parseNBIB — malformed and empty input", () => {
  it("returns nothing and warns nothing for empty content", () => {
    expect(parseNBIB("")).toEqual({ papers: [], warnings: [] });
    expect(parseNBIB("   \n\n  ")).toEqual({ papers: [], warnings: [] });
  });

  it("names the format when a non-empty file holds no native records", () => {
    const result = parseNBIB("this file is not a PubMed export at all");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings).toEqual(["No valid PubMed/NBIB records found in file."]);
    expect(result.warnings.join(" ")).not.toContain("RIS");
  });

  it("skips a titleless record, naming the format and the record number", () => {
    const result = parseNBIB(
      "\nPMID- 11111111\nTI  - Has a title\n\nPMID- 22222222\nJT  - Journal only\n",
    );
    expect(result.papers).toHaveLength(1);
    expect(result.warnings).toEqual(["NBIB record 2: missing title, skipped"]);
  });

  it("treats an empty TI value as a missing title", () => {
    const result = parseNBIB("\nPMID- 11111111\nTI  - \n");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings[0]).toContain("missing title");
  });

  it("ignores unknown tags instead of failing", () => {
    const p = nbibPaper("ZZZZ- who knows\nQQ  - unknown\nJT  - Journal\n");
    expect(p.title).toBe("Fixture");
    expect(p.journal).toBe("Journal");
  });

  it("ignores unindented prose that is not a field line", () => {
    const result = parseNBIB("\nPMID- 11111111\nTI  - Fixture\nnot a tagged line at all\n");
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].title).toBe("Fixture");
  });
});

// ══════════════════════════════════════════════════════════════
// EndNote tagged (.enw) Parser Tests
//
// Fixtures are native `%`-tag syntax built to the tag table in Clarivate's
// "Creating a Tagged EndNote Import File" documentation. No RIS content is used
// to demonstrate EndNote support, and nothing here touches the network.
// ══════════════════════════════════════════════════════════════

const ENW_RECORD = `%0 Journal Article
%A Smith, John
%A Doe, Jane
%D 2024
%T Effect of Treatment on Outcomes
%J Journal of Testing
%V 12
%N 3
%P 145-158
%R 10.1000/test123
%U https://pubmed.ncbi.nlm.nih.gov/12345678/
%U https://www.nejm.org/doi/full/10.1056/example
%X This is the abstract.
%K treatment
%K outcomes
%M WOS:000123456700001
%~ Web of Science
`;

/** Minimal native record builder for focused single-behaviour assertions. */
const enw = (body: string) => parseEndNoteTagged(`%0 Journal Article\n%T Fixture\n${body}`);
const enwPaper = (body: string) => enw(body).papers[0];

describe("parseEndNoteTagged — native EndNote record", () => {
  const result = parseEndNoteTagged(ENW_RECORD);
  const p = result.papers[0];

  it("parses the record without warnings", () => {
    expect(result.warnings).toEqual([]);
    expect(result.papers).toHaveLength(1);
  });

  it("maps the core bibliographic fields", () => {
    expect(p.title).toBe("Effect of Treatment on Outcomes");
    expect(p.year).toBe(2024);
    expect(p.journal).toBe("Journal of Testing");
    expect(p.abstract).toBe("This is the abstract.");
    expect(p.keywords).toEqual(["treatment", "outcomes"]);
  });

  it("keeps each %A as one whole author, in order", () => {
    expect(p.authors).toEqual(["Smith, John", "Doe, Jane"]);
  });

  it("takes the DOI from %R", () => {
    expect(p.doi).toBe("10.1000/test123");
  });

  it("routes the two %U values to their separate destinations", () => {
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
    expect(p.journal_url).toBe("https://www.nejm.org/doi/full/10.1056/example");
  });

  it("leaves the fields EndNote tagged records cannot supply empty", () => {
    expect(p.mesh_terms).toEqual([]);
    expect(p.substances).toEqual([]);
    expect(p.drive_url).toBeNull();
  });
});

describe("parseEndNoteTagged — record structure", () => {
  it("parses two blank-line-separated records independently", () => {
    const result = parseEndNoteTagged(
      `%0 Journal Article
%A Alpha, Ann
%D 2019
%T First reference
%J Journal of First Things
%R 10.1000/first

%0 Journal Article
%A Beta, Bob
%D 2024
%T Second reference
%J Journal of Second Things
%R 10.1000/second
`,
    );
    expect(result.warnings).toEqual([]);
    expect(result.papers).toHaveLength(2);
    const [first, second] = result.papers;
    expect(first.title).toBe("First reference");
    expect(second.title).toBe("Second reference");
    expect(first.authors).toEqual(["Alpha, Ann"]);
    expect(second.authors).toEqual(["Beta, Bob"]);
    expect(first.year).toBe(2019);
    expect(second.year).toBe(2024);
    expect(first.doi).toBe("10.1000/first");
    expect(second.doi).toBe("10.1000/second");
    expect(first.journal).toBe("Journal of First Things");
    expect(second.journal).toBe("Journal of Second Things");
  });

  it("parses a CRLF export identically to an LF one", () => {
    expect(parseEndNoteTagged(ENW_RECORD.replace(/\n/g, "\r\n")).papers).toEqual(
      parseEndNoteTagged(ENW_RECORD).papers,
    );
  });

  it("parses a final record with no trailing newline", () => {
    const papers = parseEndNoteTagged(ENW_RECORD.trimEnd()).papers;
    expect(papers).toHaveLength(1);
    expect(papers[0].title).toBe("Effect of Treatment on Outcomes");
  });

  it("tolerates surrounding whitespace and repeated blank separators", () => {
    const papers = parseEndNoteTagged(`\n\n${ENW_RECORD}\n\n\n`).papers;
    expect(papers).toHaveLength(1);
    expect(papers[0].title).toBe("Effect of Treatment on Outcomes");
  });

  it("continues a wrapped value onto the untagged line below it", () => {
    const p = enwPaper("%X An abstract that runs on\nacross a second physical line.\n");
    expect(p.abstract).toBe("An abstract that runs on across a second physical line.");
  });

  it("never lets a continuation cross a record boundary", () => {
    const result = parseEndNoteTagged(
      "%0 Journal Article\n%T First reference\n%X First abstract\n\n%0 Journal Article\n%T Second reference\n",
    );
    expect(result.papers).toHaveLength(2);
    expect(result.papers[0].abstract).toBe("First abstract");
    expect(result.papers[0].title).toBe("First reference");
    expect(result.papers[1].title).toBe("Second reference");
    expect(result.papers[1].abstract).toBeNull();
  });

  it("discards untagged prose rather than inventing a reference from it", () => {
    const result = parseEndNoteTagged("just some prose in a file\n\nmore prose\n");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings).toEqual(["No valid EndNote tagged records found in file."]);
  });

  it("ignores tags Paperlume has no destination for", () => {
    const p = enwPaper("%E Editor, Ed\n%I A Publisher\n%C New York\n%V 12\n%N 3\n%P 1-10\n%Z A note\n");
    expect(p.title).toBe("Fixture");
    expect(p.journal).toBeNull();
    expect(p.keywords).toEqual([]);
  });
});

describe("parseEndNoteTagged — %M is an accession number, never a PMID", () => {
  // EndNote's %M is the Accession Number: whatever identifier the exporting
  // database assigned. Numeric shape proves nothing — this is the same trust
  // boundary that keeps RIS `AN` out of `papers.pmid`.
  for (const accession of [
    "12345678",
    "2019345678",
    "WOS:000123456700001",
    "L629384756",
    "MEDLINE:12345678",
  ]) {
    it(`does not become a PMID: ${accession}`, () => {
      const p = enwPaper(`%M ${accession}\n`);
      expect(p.pmid).toBeNull();
      expect(p.pubmed_url).toBeNull();
    });
  }

  it("stays null even for a numeric %M on a Journal Article from a medical database", () => {
    const p = parseEndNoteTagged(
      "%0 Journal Article\n%T Fixture\n%M 12345678\n%W PubMed\n%~ MEDLINE\n",
    ).papers[0];
    expect(p.pmid).toBeNull();
    expect(p.pubmed_url).toBeNull();
  });

  it("does not let %M override an authenticated %U", () => {
    const p = enwPaper("%M 99999999\n%U https://pubmed.ncbi.nlm.nih.gov/12345678/\n");
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
  });

  it("does not let %M rescue a lookalike %U", () => {
    const p = enwPaper("%M 12345678\n%U https://pubmed.example.com/12345678\n");
    expect(p.pmid).toBeNull();
    expect(p.pubmed_url).toBeNull();
    expect(p.journal_url).toBe("https://pubmed.example.com/12345678");
  });
});

describe("parseEndNoteTagged — %U routing", () => {
  it("accepts an authentic PubMed record URL", () => {
    const p = enwPaper("%U https://pubmed.ncbi.nlm.nih.gov/12345678/\n");
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
    expect(p.journal_url).toBeNull();
  });

  it("canonicalises a legacy PubMed record URL", () => {
    const p = enwPaper("%U https://www.ncbi.nlm.nih.gov/pubmed/12345678\n");
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
  });

  for (const lookalike of [
    "https://pubmed.example.com/12345678",
    "https://pubmed.ncbi.nlm.nih.gov.example.com/12345678",
    "https://evil-pubmed.example/12345678",
    "https://pubmed.ncbi.nlm.nih.gov@evil.example/12345678",
    "https://example.com/?url=https://pubmed.ncbi.nlm.nih.gov/12345678",
  ]) {
    it(`refuses a lookalike but keeps it as a journal link: ${lookalike}`, () => {
      const p = enwPaper(`%U ${lookalike}\n`);
      expect(p.pmid).toBeNull();
      expect(p.pubmed_url).toBeNull();
      expect(p.journal_url).toBe(lookalike);
    });
  }

  for (const unsafe of [
    "javascript:alert('pubmed')",
    "data:text/html,pubmed",
    "ftp://pubmed.ncbi.nlm.nih.gov/12345678",
    "pubmed.ncbi.nlm.nih.gov/12345678",
  ]) {
    it(`stores an unsafe or scheme-less value nowhere: ${unsafe}`, () => {
      const p = enwPaper(`%U ${unsafe}\n`);
      expect(p.pmid).toBeNull();
      expect(p.pubmed_url).toBeNull();
      expect(p.journal_url).toBeNull();
    });
  }

  it("keeps a generic URL as the journal link", () => {
    const p = enwPaper("%U https://doi.org/10.1000/example\n");
    expect(p.pubmed_url).toBeNull();
    expect(p.pmid).toBeNull();
    expect(p.journal_url).toBe("https://doi.org/10.1000/example");
  });

  it("lets a PubMed URL and a generic URL coexist in either order", () => {
    const pubmedFirst = enwPaper(
      "%U https://pubmed.ncbi.nlm.nih.gov/12345678/\n%U https://doi.org/10.1000/example\n",
    );
    const genericFirst = enwPaper(
      "%U https://doi.org/10.1000/example\n%U https://pubmed.ncbi.nlm.nih.gov/12345678/\n",
    );
    for (const p of [pubmedFirst, genericFirst]) {
      expect(p.pmid).toBe("12345678");
      expect(p.pubmed_url).toBe(CANONICAL_URL);
      expect(p.journal_url).toBe("https://doi.org/10.1000/example");
    }
  });
});

describe("parseEndNoteTagged — remaining field mappings", () => {
  it("takes the DOI from %R with no %U present at all", () => {
    const p = enwPaper("%R 10.1000/example\n");
    expect(p.doi).toBe("10.1000/example");
    expect(p.journal_url).toBeNull();
    expect(p.pubmed_url).toBeNull();
  });

  it("does not derive a DOI from %M", () => {
    expect(enwPaper("%M 10.1000/example\n").doi).toBeNull();
  });

  it("falls back from %J to %B for the container title", () => {
    expect(enwPaper("%B Journal of Secondary Titles\n").journal).toBe(
      "Journal of Secondary Titles",
    );
  });

  it("prefers %J over %B without concatenating them", () => {
    const journal = enwPaper("%B Secondary Title\n%J Journal of Testing\n").journal;
    expect(journal).toBe("Journal of Testing");
    expect(journal).not.toContain("Secondary");
  });

  it("falls back from %D to %8 for the year", () => {
    expect(enwPaper("%8 15 March 2024\n").year).toBe(2024);
    expect(enwPaper("%D 2019\n%8 15 March 2024\n").year).toBe(2019);
  });

  it("leaves the year null when neither date field carries one", () => {
    expect(enwPaper("%D in press\n").year).toBeNull();
    expect(enwPaper("%J Journal of Testing\n").year).toBeNull();
  });

  it("does not turn the reference type into a Paperlume study type", () => {
    // %0 names the bibliographic container and %9 the type of work; neither
    // states the research design.
    expect(enwPaper("%9 Doctoral dissertation\n").study_type).toBeNull();
    expect(parseEndNoteTagged("%0 Journal Article\n%T Fixture\n").papers[0].study_type).toBeNull();
    expect(parseEndNoteTagged("%0 Randomized Controlled Trial\n%T Fixture\n").papers[0].study_type)
      .toBeNull();
  });
});

describe("parseEndNoteTagged — malformed and empty input", () => {
  it("returns nothing and warns nothing for empty content", () => {
    expect(parseEndNoteTagged("")).toEqual({ papers: [], warnings: [] });
    expect(parseEndNoteTagged("  \n\n ")).toEqual({ papers: [], warnings: [] });
  });

  it("names the format when a non-empty file holds no native records", () => {
    const result = parseEndNoteTagged("TY  - JOUR\nT1  - Title\nER  - ");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings).toEqual(["No valid EndNote tagged records found in file."]);
    expect(result.warnings.join(" ")).not.toContain("RIS");
  });

  it("skips a titleless record, naming the format and the record number", () => {
    const result = parseEndNoteTagged(
      "%0 Journal Article\n%T Has a title\n\n%0 Journal Article\n%A Nobody, N\n",
    );
    expect(result.papers).toHaveLength(1);
    expect(result.warnings).toEqual(["EndNote record 2: missing title, skipped"]);
  });

  it("treats an empty %T value as a missing title", () => {
    const result = parseEndNoteTagged("%0 Journal Article\n%T\n%A Nobody, N\n");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings[0]).toContain("missing title");
  });

  it("ignores a lowercase tag rather than assuming it means its capital", () => {
    const result = parseEndNoteTagged("%0 Journal Article\n%t lowercase title tag\n");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings[0]).toContain("missing title");
  });
});

// ══════════════════════════════════════════════════════════════
// Native formats feed the existing normalization pipeline unchanged
// ══════════════════════════════════════════════════════════════

describe("native formats reuse the existing study-type evaluation", () => {
  const config: NormalizationConfig = {
    synonymLookup: {},
    poolKeywords: [],
    synonymGroups: [],
    poolStudyTypes: [
      { study_type: "Meta-Analysis", specificity_weight: 1, hierarchy_rank: 1 },
      { study_type: "Randomized Controlled Trial", specificity_weight: 1, hierarchy_rank: 2 },
      { study_type: "Observational Study", specificity_weight: 1, hierarchy_rank: 4 },
    ],
  };

  it("lets evaluateStudyType pick the pool winner from repeated NBIB PT values", () => {
    const raw = parseNBIB(
      "\nPMID- 11111111\nTI  - Fixture\nPT  - Journal Article\nPT  - Observational Study\nPT  - Meta-Analysis\n",
    ).papers[0];
    expect(raw.study_type).toBe("Journal Article, Observational Study, Meta-Analysis");
    // Highest-ranked pool entry wins; the parser does not rank anything itself.
    expect(normalizePaperData(raw, config).study_type).toBe("Meta-Analysis");
  });

  it("drops the generic 'Journal Article' publication type when nothing else matches", () => {
    const raw = parseNBIB("\nPMID- 11111111\nTI  - Fixture\nPT  - Journal Article\n").papers[0];
    expect(normalizePaperData(raw, config).study_type).toBeNull();
  });

  it("does not let an EndNote reference type reach study_type", () => {
    const raw = parseEndNoteTagged("%0 Randomized Controlled Trial\n%T Fixture\n").papers[0];
    expect(normalizePaperData(raw, config).study_type).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// CSV Parser Tests
// ══════════════════════════════════════════════════════════════

describe("parseCSV", () => {
  it("parses our own export format", () => {
    const csv = `Title,Authors,Year,Journal,PMID,DOI,Study Types,Keywords,MeSH Terms,Substances,Tags,Projects,URL,Abstract
"Effect of Treatment on Outcomes","Smith, John; Doe, Jane",2024,Journal of Testing,12345678,10.1000/test123,RCT,"treatment; outcomes","MeSH1; MeSH2","Sub1","tag1","proj1",https://pubmed.ncbi.nlm.nih.gov/12345678/,"This is the abstract."`;
    const result = parseCSV(csv);
    expect(result.warnings).toHaveLength(0);
    expect(result.papers).toHaveLength(1);

    const p = result.papers[0];
    expect(p.title).toBe("Effect of Treatment on Outcomes");
    expect(p.authors).toEqual(["Smith, John", "Doe, Jane"]);
    expect(p.year).toBe(2024);
    expect(p.journal).toBe("Journal of Testing");
    expect(p.pmid).toBe("12345678");
    expect(p.doi).toBe("10.1000/test123");
    expect(p.keywords).toEqual(["treatment", "outcomes"]);
    expect(p.mesh_terms).toEqual(["MeSH1", "MeSH2"]);
    expect(p.substances).toEqual(["Sub1"]);
    expect(p.study_type).toBe("RCT");
  });

  it("handles case-insensitive headers", () => {
    const csv = `title,author,publication_year,journal
Some Paper,"Author One",2023,A Journal`;
    const result = parseCSV(csv);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].title).toBe("Some Paper");
    expect(result.papers[0].year).toBe(2023);
  });

  it("skips rows without title", () => {
    const csv = `Title,Authors
First Paper,Author A
,Author B
Third Paper,Author C`;
    const result = parseCSV(csv);
    expect(result.papers).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing title");
  });

  it("handles quoted fields with commas and newlines", () => {
    const csv = `Title,Authors,Abstract
"Paper, With Commas","Author A; Author B","Abstract with
a newline in it."`;
    const result = parseCSV(csv);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].title).toBe("Paper, With Commas");
    expect(result.papers[0].authors).toEqual(["Author A", "Author B"]);
    expect(result.papers[0].abstract).toContain("newline");
  });

  it("handles empty CSV gracefully", () => {
    const result = parseCSV("");
    expect(result.papers).toHaveLength(0);
  });

  it("handles multiple rows correctly", () => {
    const csv = `Title,Year
Paper One,2020
Paper Two,2021
Paper Three,2022`;
    const result = parseCSV(csv);
    expect(result.papers).toHaveLength(3);
    expect(result.papers.map((p) => p.year)).toEqual([2020, 2021, 2022]);
  });
});

// ══════════════════════════════════════════════════════════════
// parseFile auto-detection
// ══════════════════════════════════════════════════════════════

describe("parseFile", () => {
  it("routes .bib to BibTeX parser", () => {
    const result = parseFile("@article{k, title={T}}", "refs.bib");
    expect(result.papers).toHaveLength(1);
  });

  it("routes .ris to RIS parser", () => {
    const result = parseFile("TY  - JOUR\nT1  - Title\nER  - ", "refs.ris");
    expect(result.papers).toHaveLength(1);
  });

  it("routes .csv to CSV parser", () => {
    const result = parseFile("Title\nMy Paper", "export.csv");
    expect(result.papers).toHaveLength(1);
  });

  it("routes .tsv to the CSV parser, as it always has", () => {
    const result = parseFile("Title\nMy Paper", "export.tsv");
    expect(result.papers).toHaveLength(1);
  });

  it("returns error for unsupported extension", () => {
    const result = parseFile("some content", "file.xyz");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings[0]).toContain("Unsupported file format");
  });

  it("lists every accepted extension in the unsupported-format warning", () => {
    const warning = parseFile("some content", "file.xyz").warnings[0];
    for (const ext of [".bib", ".ris", ".nbib", ".enw", ".csv"]) {
      expect(warning).toContain(ext);
    }
  });

  // `.nbib` and `.enw` used to be routed to `parseRIS`. The old test proved
  // only that an `.nbib` filename reached *some* parser — it fed RIS syntax in,
  // so a real PubMed export would still have failed. These route to the native
  // parsers and are proved with each format's own syntax.
  it("routes .nbib to the native PubMed/NBIB parser", () => {
    const result = parseFile(NBIB_REAL_RECORD, "refs.nbib");
    expect(result.warnings).toEqual([]);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].pmid).toBe("39725180");
    expect(result.papers[0].doi).toBe("10.1053/j.jrn.2024.12.006");
  });

  it("routes .enw to the native EndNote tagged parser", () => {
    const result = parseFile(ENW_RECORD, "refs.enw");
    expect(result.warnings).toEqual([]);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].title).toBe("Effect of Treatment on Outcomes");
    expect(result.papers[0].authors).toEqual(["Smith, John", "Doe, Jane"]);
  });

  it("no longer reads RIS syntax out of an .nbib file", () => {
    // The exact input the previous false-positive test used.
    const result = parseFile("TY  - JOUR\nT1  - Title\nER  - ", "refs.nbib");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("NBIB");
  });

  it("no longer reads RIS syntax out of an .enw file", () => {
    const result = parseFile("TY  - JOUR\nT1  - Title\nER  - ", "refs.enw");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings).toEqual(["No valid EndNote tagged records found in file."]);
  });

  it("does not route a malformed native file into another format's parser", () => {
    // Each warning names the format the user actually chose by extension.
    expect(parseFile("%0 Journal Article\n%T Native EndNote", "refs.nbib").warnings).toEqual([
      "No valid PubMed/NBIB records found in file.",
    ]);
    expect(parseFile(NBIB_REAL_RECORD, "refs.enw").warnings).toEqual([
      "No valid EndNote tagged records found in file.",
    ]);
  });

  it("leaves .ris routing on the RIS parser", () => {
    const result = parseFile("TY  - JOUR\nT1  - Title\nAU  - Smith, John\nER  - ", "refs.ris");
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].title).toBe("Title");
    expect(result.papers[0].authors).toEqual(["Smith, John"]);
  });
});

// ══════════════════════════════════════════════════════════════
// PubMed identifier & source-link integrity
//
// Provenance must be established structurally (protocol + hostname + path),
// never by substring presence. Each case asserts `pmid`, `pubmed_url` and
// `journal_url` independently so a failure names the guarantee that broke.
// ══════════════════════════════════════════════════════════════

const CANONICAL_URL = "https://pubmed.ncbi.nlm.nih.gov/12345678/";

/** The same URL, delivered through each format's dedicated source-URL field. */
const URL_FORMATS = [
  {
    name: "BibTeX",
    parse: (url: string) =>
      parseBibTeX(`@article{key,\n  title = {Fixture},\n  url = {${url}}\n}`).papers[0],
  },
  {
    name: "RIS",
    parse: (url: string) => parseRIS(`TY  - JOUR\nT1  - Fixture\nUR  - ${url}\nER  - `).papers[0],
  },
  {
    name: "CSV",
    parse: (url: string) => parseCSV(`Title,URL\nFixture,"${url}"`).papers[0],
  },
] as const;

describe("PubMed record URLs are accepted and canonicalised", () => {
  const accepted = [
    "https://pubmed.ncbi.nlm.nih.gov/12345678/",
    "https://pubmed.ncbi.nlm.nih.gov/12345678",
    "http://pubmed.ncbi.nlm.nih.gov/12345678/",
    // Hostnames are case-insensitive; the URL parser folds them for us.
    "https://PUBMED.NCBI.NLM.NIH.GOV/12345678/",
    "https://PubMed.ncbi.nlm.nih.gov/12345678/",
    // The default port is not a different host.
    "https://pubmed.ncbi.nlm.nih.gov:443/12345678/",
    // Query and fragment are noise around the record, not part of it.
    "https://pubmed.ncbi.nlm.nih.gov/12345678/?foo=bar",
    "https://pubmed.ncbi.nlm.nih.gov/12345678/#details",
    // A sub-resource still names the record it hangs off.
    "https://pubmed.ncbi.nlm.nih.gov/12345678/citedby/",
  ];

  for (const { name, parse } of URL_FORMATS) {
    for (const url of accepted) {
      it(`${name}: ${url}`, () => {
        const p = parse(url);
        expect(p.pmid).toBe("12345678");
        expect(p.pubmed_url).toBe(CANONICAL_URL);
        expect(p.journal_url).toBeNull();
      });
    }
  }
});

describe("legacy www.ncbi.nlm.nih.gov/pubmed/<PMID> URLs are accepted", () => {
  const accepted = [
    "https://www.ncbi.nlm.nih.gov/pubmed/12345678",
    "http://www.ncbi.nlm.nih.gov/pubmed/12345678",
    "https://www.ncbi.nlm.nih.gov/pubmed/12345678/",
  ];

  for (const { name, parse } of URL_FORMATS) {
    for (const url of accepted) {
      it(`${name}: ${url}`, () => {
        const p = parse(url);
        expect(p.pmid).toBe("12345678");
        expect(p.pubmed_url).toBe(CANONICAL_URL);
        expect(p.journal_url).toBeNull();
      });
    }
  }
});

describe("lookalike URLs never establish PubMed identity", () => {
  // Every one of these contains the substring the old classifier trusted.
  const lookalikes = [
    "https://example.com/pubmed/12345678",
    "https://example.com/articles/pubmed-reference",
    "https://example.com/?source=pubmed",
    // A nested URL lives in the query string, which can never supply a PMID.
    "https://example.com/?url=https://pubmed.ncbi.nlm.nih.gov/123",
    "https://pubmed.example.com/123",
    "https://pubmed.ncbi.nlm.nih.gov.example.com/123",
    "https://notpubmed.ncbi.nlm.nih.gov/123",
    "https://evil-pubmed.example/123",
    // User-info is not the host: the authority here is evil.example.
    "https://pubmed.ncbi.nlm.nih.gov@evil.example/123",
    "https://user@evil.example/pubmed.ncbi.nlm.nih.gov/999",
    // A sibling NCBI service on the legacy host is not PubMed.
    "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/",
  ];

  for (const { name, parse } of URL_FORMATS) {
    for (const url of lookalikes) {
      it(`${name}: ${url}`, () => {
        const p = parse(url);
        expect(p.pmid).toBeNull();
        expect(p.pubmed_url).toBeNull();
        // Still a usable link — it is just not a PubMed one.
        expect(p.journal_url).toBe(url);
      });
    }
  }
});

describe("non-http(s) and malformed values are not links at all", () => {
  const rejected = [
    "pubmed",
    "not a url pubmed",
    // Scheme-less: never repaired by guessing a scheme.
    "pubmed.ncbi.nlm.nih.gov/123",
    "javascript:alert('pubmed')",
    "data:text/html,pubmed",
    "ftp://pubmed.ncbi.nlm.nih.gov/123",
  ];

  for (const { name, parse } of URL_FORMATS) {
    for (const url of rejected) {
      it(`${name}: ${url}`, () => {
        const p = parse(url);
        expect(p.pmid).toBeNull();
        expect(p.pubmed_url).toBeNull();
        expect(p.journal_url).toBeNull();
      });
    }
  }
});

describe("generic scholarly URLs are kept as journal links", () => {
  const generic = [
    "https://doi.org/10.1000/example",
    "https://dx.doi.org/10.1000/example",
    "https://www.nejm.org/doi/full/10.1056/example",
    "https://europepmc.org/article/MED/12345678",
  ];

  for (const { name, parse } of URL_FORMATS) {
    for (const url of generic) {
      it(`${name}: ${url}`, () => {
        const p = parse(url);
        expect(p.pubmed_url).toBeNull();
        expect(p.pmid).toBeNull();
        // A DOI resolver URL is a real link to the work, not something to drop.
        expect(p.journal_url).toBe(url);
      });
    }
  }
});

describe("explicit PMID fields are validated as PMIDs", () => {
  const valid = ["123", "12345678", " 12345678 "];
  const invalid = ["L629384756", "WOS:000123456700001", "not-a-pmid", "123abc", "-123", "12.3"];

  const explicitFormats = [
    {
      name: "BibTeX pmid field",
      parse: (v: string) => parseBibTeX(`@article{k,\n  title = {Fixture},\n  pmid = {${v}}\n}`).papers[0],
    },
    {
      name: "CSV PMID column",
      parse: (v: string) => parseCSV(`Title,PMID\nFixture,"${v}"`).papers[0],
    },
    {
      name: "CSV pubmed_id column",
      parse: (v: string) => parseCSV(`Title,pubmed_id\nFixture,"${v}"`).papers[0],
    },
    {
      name: "CSV 'pubmed id' column",
      parse: (v: string) => parseCSV(`Title,pubmed id\nFixture,"${v}"`).papers[0],
    },
  ] as const;

  for (const { name, parse } of explicitFormats) {
    for (const value of valid) {
      it(`${name} accepts ${JSON.stringify(value)}`, () => {
        const p = parse(value);
        expect(p.pmid).toBe(value.trim());
        expect(p.pubmed_url).toBe(`https://pubmed.ncbi.nlm.nih.gov/${value.trim()}/`);
      });
    }

    for (const value of invalid) {
      it(`${name} rejects ${JSON.stringify(value)}`, () => {
        const p = parse(value);
        expect(p.pmid).toBeNull();
        expect(p.pubmed_url).toBeNull();
      });
    }
  }
});

describe("RIS AN is a generic accession number, not a PMID", () => {
  const risWithAn = (an: string, extra = "") =>
    parseRIS(`TY  - JOUR\nT1  - Fixture\nAN  - ${an}\n${extra}ER  - `).papers[0];

  // Numeric shape is not evidence: an Embase accession can look exactly
  // like a PMID, so a shape guard would not distinguish them.
  for (const an of ["12345678", "2019345678", "L629384756", "WOS:000123456700001", "not-a-pmid"]) {
    it(`AN alone does not establish a PMID: ${an}`, () => {
      const p = risWithAn(an);
      expect(p.pmid).toBeNull();
      expect(p.pubmed_url).toBeNull();
    });
  }

  it("recovers the PMID from an authenticated UR alongside an unrelated AN", () => {
    const p = risWithAn("L629384756", "UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/\n");
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
  });

  it("does not let AN override the authenticated UR", () => {
    const p = risWithAn("99999999", "UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/\n");
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
  });

  it("does not let AN rescue a lookalike UR", () => {
    const p = risWithAn("12345678", "UR  - https://pubmed.example.com/12345678\n");
    expect(p.pmid).toBeNull();
    expect(p.pubmed_url).toBeNull();
    expect(p.journal_url).toBe("https://pubmed.example.com/12345678");
  });
});

describe("CSV AN column is not a PMID alias", () => {
  it("ignores an AN column", () => {
    const p = parseCSV(`Title,AN\nFixture,12345678`).papers[0];
    expect(p.pmid).toBeNull();
    expect(p.pubmed_url).toBeNull();
  });

  it("ignores a lowercase an column", () => {
    const p = parseCSV(`Title,an\nFixture,L629384756`).papers[0];
    expect(p.pmid).toBeNull();
    expect(p.pubmed_url).toBeNull();
  });

  it("still reads an explicit PMID column when both are present", () => {
    const p = parseCSV(`Title,AN,PMID\nFixture,L629384756,12345678`).papers[0];
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
  });
});

describe("BibTeX note-field PMID extraction is structural", () => {
  const bibWithNote = (note: string) =>
    parseBibTeX(`@article{k,\n  title = {Fixture},\n  note = {${note}}\n}`).papers[0];

  it("still extracts a PMID from a PubMed link in prose", () => {
    const p = bibWithNote("Available at https://pubmed.ncbi.nlm.nih.gov/55443322/");
    expect(p.pmid).toBe("55443322");
    expect(p.pubmed_url).toBe("https://pubmed.ncbi.nlm.nih.gov/55443322/");
  });

  it("tolerates trailing sentence punctuation", () => {
    const p = bibWithNote("See https://pubmed.ncbi.nlm.nih.gov/55443322/.");
    expect(p.pmid).toBe("55443322");
  });

  for (const note of [
    "https://example.com/?url=https://pubmed.ncbi.nlm.nih.gov/123",
    "https://evil.example/pubmed.ncbi.nlm.nih.gov/123",
    "pubmed.ncbi.nlm.nih.gov/123",
    "Indexed in pubmed, see record 12345678",
  ]) {
    it(`does not extract a PMID from: ${note}`, () => {
      const p = bibWithNote(note);
      expect(p.pmid).toBeNull();
      expect(p.pubmed_url).toBeNull();
    });
  }
});

describe("BibTeX url routing", () => {
  it("keeps a DOI resolver URL as the journal link instead of dropping it", () => {
    const p = parseBibTeX(
      `@article{k,\n  title = {Fixture},\n  doi = {10.1000/example},\n  url = {https://doi.org/10.1000/example}\n}`,
    ).papers[0];
    expect(p.doi).toBe("10.1000/example");
    expect(p.pubmed_url).toBeNull();
    expect(p.journal_url).toBe("https://doi.org/10.1000/example");
  });

  it("keeps a publisher URL when an explicit PMID is also present", () => {
    const p = parseBibTeX(
      `@article{k,\n  title = {Fixture},\n  pmid = {12345678},\n  url = {https://www.nejm.org/doi/full/10.1056/example}\n}`,
    ).papers[0];
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
    expect(p.journal_url).toBe("https://www.nejm.org/doi/full/10.1056/example");
  });
});

describe("RIS URL routing across multiple tags", () => {
  const parseUrls = (body: string) => parseRIS(`TY  - JOUR\nT1  - Fixture\n${body}ER  - `).papers[0];

  it("generic UR before an authenticated PubMed UR", () => {
    const p = parseUrls(
      "UR  - https://www.nejm.org/doi/full/10.1056/example\nUR  - https://pubmed.ncbi.nlm.nih.gov/12345678/\n",
    );
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
    expect(p.journal_url).toBe("https://www.nejm.org/doi/full/10.1056/example");
  });

  it("authenticated PubMed UR before a generic UR", () => {
    const p = parseUrls(
      "UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/\nUR  - https://www.nejm.org/doi/full/10.1056/example\n",
    );
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
    expect(p.journal_url).toBe("https://www.nejm.org/doi/full/10.1056/example");
  });

  it("generic UR only", () => {
    const p = parseUrls("UR  - https://doi.org/10.1000/example\n");
    expect(p.pmid).toBeNull();
    expect(p.pubmed_url).toBeNull();
    expect(p.journal_url).toBe("https://doi.org/10.1000/example");
  });

  it("explicit L2 wins over a generic UR", () => {
    const p = parseUrls(
      "UR  - https://doi.org/10.1000/example\nL2  - https://journal.example.com/article\n",
    );
    expect(p.pubmed_url).toBeNull();
    expect(p.journal_url).toBe("https://journal.example.com/article");
  });

  it("explicit L2 coexists with an authenticated PubMed UR", () => {
    const p = parseUrls(
      "UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/\nL2  - https://journal.example.com/article\n",
    );
    expect(p.pmid).toBe("12345678");
    expect(p.pubmed_url).toBe(CANONICAL_URL);
    expect(p.journal_url).toBe("https://journal.example.com/article");
  });

  it("ignores an unusable L2 rather than storing it", () => {
    const p = parseUrls("L2  - javascript:alert('pubmed')\n");
    expect(p.journal_url).toBeNull();
  });
});
