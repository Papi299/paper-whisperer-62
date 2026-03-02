/**
 * Client-side PubMed/Crossref paper metadata fetcher.
 * Mirrors the logic previously in the fetch-paper-metadata edge function.
 */

import { decodeHTMLEntities } from "./decodeHTMLEntities";

export interface PaperMetadata {
  identifier: string;
  title?: string;
  authors?: string[];
  year?: number | null;
  journal?: string | null;
  pmid?: string | null;
  doi?: string | null;
  abstract?: string | null;
  keywords?: string[];
  mesh_terms?: string[];
  substances?: string[];
  study_type?: string | null;
  pubmed_url?: string | null;
  journal_url?: string | null;
  source?: "pubmed" | "crossref";
  error?: string;
}

// ── Identifier Detection ──

function detectIdentifierType(identifier: string): "pmid" | "doi" | "pubmed_url" | "title" {
  const trimmed = identifier.trim();
  if (/^\d+$/.test(trimmed)) return "pmid";
  if (trimmed.startsWith("10.") || trimmed.toLowerCase().startsWith("doi:")) return "doi";
  if (trimmed.includes("pubmed.ncbi.nlm.nih.gov")) return "pubmed_url";
  return "title";
}

function extractPmidFromUrl(url: string): string | null {
  const match = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
  return match ? match[1] : null;
}

function cleanDoi(doi: string): string {
  return doi.replace(/^doi:/i, "").trim();
}

// ── PubMed API ──

async function fetchFromPubMed(pmid: string): Promise<PaperMetadata | null> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const xml = await response.text();
    const title = xml.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1]?.replace(/<[^>]+>/g, "");

    const authorMatches = xml.matchAll(
      /<Author[^>]*>[\s\S]*?<LastName>([^<]+)<\/LastName>[\s\S]*?<ForeName>([^<]+)<\/ForeName>[\s\S]*?<\/Author>/g
    );
    const authors: string[] = [];
    for (const match of authorMatches) authors.push(`${match[2]} ${match[1]}`);

    const year = xml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/)?.[1];
    const journal = xml.match(/<Title>([^<]+)<\/Title>/)?.[1];
    const doi = xml.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/)?.[1];

    const abstractMatch = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
    const abstract = abstractMatch
      ? abstractMatch.map((a) => a.replace(/<[^>]+>/g, "")).join(" ")
      : null;

    const keywordMatches = xml.matchAll(/<Keyword[^>]*>([^<]+)<\/Keyword>/g);
    const keywords: string[] = [];
    for (const match of keywordMatches) keywords.push(decodeHTMLEntities(match[1]) || match[1]);

    const meshMatches = xml.matchAll(/<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g);
    const meshTerms: string[] = [];
    for (const match of meshMatches) meshTerms.push(match[1]);

    const substanceMatches = xml.matchAll(/<NameOfSubstance[^>]*>([^<]+)<\/NameOfSubstance>/g);
    const substances: string[] = [];
    for (const match of substanceMatches) substances.push(match[1]);

    const pubTypeMatches = xml.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g);
    const publicationTypes: string[] = [];
    for (const match of pubTypeMatches) publicationTypes.push(match[1]);

    if (!title) return null;

    return {
      identifier: pmid,
      title,
      authors,
      year: year ? parseInt(year) : null,
      journal,
      pmid,
      doi,
      abstract,
      keywords,
      mesh_terms: meshTerms,
      substances,
      study_type: publicationTypes.length > 0 ? publicationTypes.join(", ") : null,
      pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      journal_url: doi ? `https://doi.org/${doi}` : null,
      source: "pubmed",
    };
  } catch (error) {
    console.error("PubMed fetch error:", error);
    return null;
  }
}

async function searchPubMedByDoi(doi: string): Promise<string | null> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[doi]&retmode=json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.esearchresult?.idlist?.[0] || null;
  } catch {
    return null;
  }
}

async function searchPubMedByTitle(title: string): Promise<string | null> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(title)}&retmode=json&retmax=1`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.esearchresult?.idlist?.[0] || null;
  } catch {
    return null;
  }
}

// ── Crossref Adapter ──

function mapCrossrefToSchema(work: Record<string, unknown>, identifier: string): PaperMetadata | null {
  const title = (work.title as string[])?.[0] || null;
  if (!title) return null;

  const authors = ((work.author as Array<{ given?: string; family?: string }>) || [])
    .map((a) => `${a.given || ""} ${a.family || ""}`.trim())
    .filter(Boolean);

  const year =
    (work["published-print"] as Record<string, unknown>)?.["date-parts"]?.[0]?.[0] as number ||
    (work["published-online"] as Record<string, unknown>)?.["date-parts"]?.[0]?.[0] as number ||
    (work.published as Record<string, unknown>)?.["date-parts"]?.[0]?.[0] as number ||
    null;

  const journal = (work["container-title"] as string[])?.[0] || null;
  const doi = (work.DOI as string) || null;

  const rawAbstract = (work.abstract as string) || "";
  const abstract = rawAbstract
    .replace(/<jats:[^>]+>/g, "")
    .replace(/<\/jats:[^>]+>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim() || null;

  const crossrefType = (work.type as string) || null;
  const studyType = crossrefType
    ? crossrefType.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
    : null;

  return {
    identifier,
    title,
    authors,
    year,
    journal,
    pmid: null,
    doi,
    abstract,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: studyType,
    pubmed_url: null,
    journal_url: doi ? `https://doi.org/${doi}` : null,
    source: "crossref",
  };
}

async function fetchFromCrossrefByDoi(doi: string): Promise<PaperMetadata | null> {
  try {
    const cleanedDoi = cleanDoi(doi);
    const url = `https://api.crossref.org/works/${encodeURIComponent(cleanedDoi)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "PaperIndex/1.0 (mailto:support@paperindex.app)" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return mapCrossrefToSchema(data.message, doi);
  } catch (error) {
    console.error("Crossref DOI fetch error:", error);
    return null;
  }
}

async function searchCrossrefByTitle(title: string): Promise<PaperMetadata | null> {
  try {
    const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=1`;
    const response = await fetch(url, {
      headers: { "User-Agent": "PaperIndex/1.0 (mailto:support@paperindex.app)" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const items = data.message?.items;
    if (!items || items.length === 0) return null;
    return mapCrossrefToSchema(items[0], title);
  } catch (error) {
    console.error("Crossref title search error:", error);
    return null;
  }
}

// ── Composite Fetch with Fallback ──

async function fetchByDoi(doi: string): Promise<PaperMetadata | null> {
  const cleanedDoi = cleanDoi(doi);
  const pmid = await searchPubMedByDoi(cleanedDoi);
  if (pmid) {
    const pubmedResult = await fetchFromPubMed(pmid);
    if (pubmedResult) {
      pubmedResult.doi = pubmedResult.doi || cleanedDoi;
      pubmedResult.journal_url = pubmedResult.journal_url || `https://doi.org/${cleanedDoi}`;
      return pubmedResult;
    }
  }

  console.log(`PubMed unavailable for DOI ${cleanedDoi}, falling back to Crossref`);
  const crossrefResult = await fetchFromCrossrefByDoi(cleanedDoi);
  if (!crossrefResult) return null;

  if (crossrefResult.doi) {
    const enrichPmid = await searchPubMedByDoi(crossrefResult.doi);
    if (enrichPmid) {
      const pubmedData = await fetchFromPubMed(enrichPmid);
      if (pubmedData) {
        crossrefResult.pmid = enrichPmid;
        crossrefResult.keywords = pubmedData.keywords || [];
        crossrefResult.mesh_terms = pubmedData.mesh_terms || [];
        crossrefResult.substances = pubmedData.substances || [];
        crossrefResult.study_type = pubmedData.study_type || crossrefResult.study_type;
        crossrefResult.pubmed_url = pubmedData.pubmed_url;
      }
    }
  }

  return crossrefResult;
}

async function fetchByTitle(title: string): Promise<PaperMetadata | null> {
  const pmid = await searchPubMedByTitle(title);
  if (pmid) {
    const pubmedResult = await fetchFromPubMed(pmid);
    if (pubmedResult) return pubmedResult;
  }

  console.log(`PubMed unavailable for title "${title}", falling back to Crossref`);
  return await searchCrossrefByTitle(title);
}

// ── Public API ──

export async function fetchPaperMetadata(identifiers: string[]): Promise<PaperMetadata[]> {
  const results: PaperMetadata[] = [];

  for (const identifier of identifiers) {
    const type = detectIdentifierType(identifier);
    let result: PaperMetadata | null = null;

    console.log(`Processing identifier: ${identifier} (type: ${type})`);

    switch (type) {
      case "pmid":
        result = await fetchFromPubMed(identifier);
        break;
      case "pubmed_url": {
        const pmid = extractPmidFromUrl(identifier);
        if (pmid) result = await fetchFromPubMed(pmid);
        break;
      }
      case "doi":
        result = await fetchByDoi(identifier);
        break;
      case "title":
        result = await fetchByTitle(identifier);
        break;
    }

    if (result) {
      results.push(result);
    } else {
      results.push({ identifier, error: "Could not find paper metadata" });
    }
  }

  return results;
}
