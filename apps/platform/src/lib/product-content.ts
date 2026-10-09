export const ON_DEMAND_TEXT = "This item is produced on demand and made specifically for your order. On-demand production helps reduce excess inventory and waste, but it may result in slightly longer fulfillment times compared to mass-produced items. We appreciate your patience and your support of a more responsible production process.";

export function hasOnDemandBoilerplate(html?: string): boolean {
  if (!html) return false;
  // Normalize whitespace to checking validity against HTML source that might have newlines
  const normalizedHtml = html.replace(/\s+/g, ' ');
  return normalizedHtml.includes(ON_DEMAND_TEXT);
}

const SIZE_GUIDE_HEADING =
  /<(p|h[1-6]|div)\b[^>]*>\s*(?:<(?:strong|b)\b[^>]*>\s*)?Size\s+guide\s*(?:<\/(?:strong|b)>\s*)?<\/\1>/i;

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Appends closing tags for any elements still open at the end of an HTML fragment */
function closeOpenTags(html: string): string {
  const open: string[] = [];
  for (const [tag, name] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
    const lower = name.toLowerCase();
    if (tag.startsWith("</")) {
      const at = open.lastIndexOf(lower);
      if (at !== -1) open.splice(at);
    } else if (!VOID_TAGS.has(lower) && !tag.endsWith("/>")) {
      open.push(lower);
    }
  }
  return html + open.reverse().map((name) => `</${name}>`).join("");
}

export function cleanProductDescription(html?: string): string {
  if (!html) return "";
  let cleaned = html;

  // 1. Remove Size Guide (truncating everything after header). Prefer a block that is only the heading
  // (Shopify's <p><strong class="size-guide-title">Size guide</strong></p>) over the words in a sentence,
  // and start the cut at the heading's own opening tags
  const match =
    cleaned.match(SIZE_GUIDE_HEADING) ?? cleaned.match(/(?:<(?:p|h[1-6]|div)\b[^>]*>\s*)?(?:<(?:strong|b)\b[^>]*>\s*)?Size\s+guide(?:<\/strong>|<\/b>)?/i);
  if (match && match.index !== undefined) {
    // Close anything the cut left open, or the browser wraps the rest of the page in it
    cleaned = closeOpenTags(cleaned.substring(0, match.index));
  }

  // 2. Remove On Demand Boilerplate
  // We need to be careful. It might be wrapped in tags.
  // Simple strategy: Remove the exact text string.
  // Then clean up empty paragraphs.
  
  // Note: HTML might have &nbsp; or encoded entities. 
  // For now, assume simple text match or simple variations.
  
  if (cleaned.includes(ON_DEMAND_TEXT)) {
      cleaned = cleaned.replace(ON_DEMAND_TEXT, "");
  } else {
       // Try normalized match? 
       // This is hard to do cleanly on raw HTML without a parser.
       // But if the source is consistent, simple replace might work.
  }
  
  // Cleanup empty tags often left behind: <p></p>, <p> </p>
  cleaned = cleaned.replace(/<p>\s*<\/p>/g, "");
  cleaned = cleaned.replace(/<div>\s*<\/div>/g, "");
  
  return cleaned.trim();
}
