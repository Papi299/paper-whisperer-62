/**
 * Decodes HTML entities (e.g., &#x2265; → ≥) using DOMParser.
 * Safe for all standard named/numeric entities.
 */
export function decodeHTMLEntities(text: string | null | undefined): string | null {
  if (!text) return text as null;
  try {
    const doc = new DOMParser().parseFromString(text, "text/html");
    return doc.documentElement.textContent || text;
  } catch {
    return text;
  }
}
