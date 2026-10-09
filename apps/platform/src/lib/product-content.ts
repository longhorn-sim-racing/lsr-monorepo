export const ON_DEMAND_TEXT = "This item is produced on demand and made specifically for your order. On-demand production helps reduce excess inventory and waste, but it may result in slightly longer fulfillment times compared to mass-produced items. We appreciate your patience and your support of a more responsible production process.";

export function hasOnDemandBoilerplate(html?: string): boolean {
  if (!html) return false;
  // Normalize whitespace to checking validity against HTML source that might have newlines
  const normalizedHtml = html.replace(/\s+/g, ' ');
  return normalizedHtml.includes(ON_DEMAND_TEXT);
}

export function cleanProductDescription(html?: string): string {
  if (!html) return "";
  let cleaned = html;

  // 1. Remove Size Guide (truncating everything after header). The cut starts at the heading's own
  // opening tags (e.g. <p><strong class="size-guide-title">), so nothing is left unclosed to swallow the page after it
  const sizeGuideRegex = /(?:<(?:p|h[1-6]|div)\b[^>]*>\s*)?(?:<(?:strong|b)\b[^>]*>\s*)?Size\s+guide(?:<\/strong>|<\/b>)?/i;
  const match = cleaned.match(sizeGuideRegex);
  if (match && match.index !== undefined) {
    cleaned = cleaned.substring(0, match.index);
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
