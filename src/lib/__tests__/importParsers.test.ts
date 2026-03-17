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
  author = {Garc{\\'i}a, Mar{\\'i}a and M{\\\"u}ller, Hans and Gon{\\c{c}}alves, Jo{\\~a}o}
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
  it("parses a single standard RIS entry", () => {
    const ris = `TY  - JOUR
T1  - Effect of Treatment on Outcomes
AU  - Smith, John
AU  - Doe, Jane
PY  - 2024
JO  - Journal of Testing
AN  - 12345678
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
