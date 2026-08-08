import { describe, it, expect } from "vitest";
import { parseBibTeX, parseRIS, parseCSV, parseFile } from "../importParsers";

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

  it("returns error for unsupported extension", () => {
    const result = parseFile("some content", "file.xyz");
    expect(result.papers).toHaveLength(0);
    expect(result.warnings[0]).toContain("Unsupported file format");
  });

  it("supports .nbib extension as RIS", () => {
    const result = parseFile("TY  - JOUR\nT1  - Title\nER  - ", "refs.nbib");
    expect(result.papers).toHaveLength(1);
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
