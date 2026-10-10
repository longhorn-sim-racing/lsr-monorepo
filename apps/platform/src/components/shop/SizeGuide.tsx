"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Ruler } from "lucide-react";
import { useEffect, useState } from "react";

interface SizeChartData {
  headers: string[];
  rows: string[][];
}

interface SizeGuideProps {
  descriptionHtml?: string;
}

function parseSizeGuide(html?: string): SizeChartData | null {
  if (!html) return null;

  // 1. Find the "Size guide" section
  // Matches "Size guide" or "**Size guide**" etc. case-insensitive
  const regex = /(?:<strong>|<b>)?Size\s+guide(?:<\/strong>|<\/b>)?/i;
  const match = html.match(regex);

  if (!match || match.index === undefined) {
    return null;
  }

  // Extract content after the header
  const contentHtml = html.substring(match.index + match[0].length);
  
  // Use DOMParser to handle the HTML structure
  if (typeof window === "undefined") return null; // Guard for SSR
  const parser = new DOMParser();
  const doc = parser.parseFromString(contentHtml, "text/html");

  // Strategy A: Check for an HTML Table
  const table = doc.querySelector("table");
  if (table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) return null; // Need at least header + 1 row

    const data: string[][] = rows.map(tr => {
      // Get all cells (th or td)
      const cells = Array.from(tr.querySelectorAll("td, th"));
      return cells.map(cell => cell.textContent?.trim() || "");
    }).filter(row => row.some(cell => cell.length > 0)); // Filter empty rows

    if (data.length < 2) return null;

    const headers = data[0];
    // If first header is empty, assume it's "Size"
    if (!headers[0]) headers[0] = "Size";

    return {
      headers,
      rows: data.slice(1)
    };
  }

  // Strategy B: Text Parsing (Fallback for copy-pasted text)
  // Get text content, handling <br> and blocks as newlines
  // We use innerText if available (preserves layout), or emulate it
  const body = doc.body;
  // Replace block elements with newlines to ensure separation
  const blockElements = body.querySelectorAll("p, div, br, li, tr");
  blockElements.forEach(el => el.after("\n"));
  
  const rawText = body.textContent || "";
  
  // Split by newlines and filter empty
  const lines = rawText.split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines.length < 2) return null;

  // Detect delimiter: Tab or Multiple Spaces
  // Check the first line (header)
  const headerLine = lines[0];
  const tabSplit = headerLine.split("\t");
  const spaceSplit = headerLine.split(/\s{2,}/); // 2 or more spaces

  let delimiter: RegExp | string = "\t";
  
  if (spaceSplit.length > tabSplit.length) {
    delimiter = /\s{2,}/;
  }

  // Parse Headers
  let headers = lines[0].split(delimiter).map(s => s.trim());
  // Fix empty first header (common in size charts: "  Chest  Waist")
  if (headers.length > 0 && !headers[0]) {
     headers[0] = "Size";
  } else if (headers.length > 0 && headers[0] === "") {
      // Sometimes splitting " Chest..." results in ["", "Chest"]
      headers[0] = "Size";
  }
  
  // Clean empty trailing headers
  headers = headers.filter(h => h !== "");

  // Parse Rows
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop if we hit something that doesn't look like a chart row?
    // For now, assume the section is just the chart.
    
    // Split
    const cells = line.split(delimiter).map(s => s.trim());
    
    // Align with headers count if possible, or just take what we have
    // Filter empty cells usually? No, "Size" might be first.
    
    // Check if valid row (has content)
    if (cells.some(c => c.length > 0)) {
        rows.push(cells);
    }
  }

  if (rows.length === 0) return null;

  return { headers, rows };
}

export function SizeGuide({ descriptionHtml }: SizeGuideProps) {
  // Parsed after mount: it needs DOMParser, and the server and the first client render must match
  const [chartData, setChartData] = useState<SizeChartData | null>(null);
  useEffect(() => {
    setChartData(parseSizeGuide(descriptionHtml));
  }, [descriptionHtml]);

  if (!chartData) {
    return null;
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="inline-flex h-10 items-center gap-2 font-sans text-[11px] font-bold uppercase tracking-[0.2em] text-white/60 transition-colors hover:text-lsr-orange">
          <Ruler className="h-4 w-4" aria-hidden />
          Size Guide
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg bg-lsr-charcoal border-white/10 rounded-none max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display font-black italic text-2xl uppercase tracking-normal">
            Size <span className="text-lsr-orange">Guide</span>
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  {chartData.headers.map((header, i) => (
                    <th
                      key={i}
                      className="py-3 px-4 text-left font-bold text-white/60 uppercase tracking-wider text-xs whitespace-nowrap"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {chartData.rows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-white/5 hover:bg-white/5 transition-colors"
                  >
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className={`py-3 px-4 ${j === 0 ? "font-bold text-white" : "text-white/80"}`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 text-xs text-white/40 space-y-2">
            <p>
              <strong>How to measure:</strong> Lay a similar garment flat and
              measure across the chest (armpit to armpit) and from shoulder to
              hem for length.
            </p>
            <p>
              Measurements are approximate. When in doubt, size up for a relaxed
              fit.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
