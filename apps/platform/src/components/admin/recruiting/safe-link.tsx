import { domainOf } from "@/lib/recruiting/labels";

/**
 * A link an APPLICANT typed. Officers will click these, so: only clean https links become links
 * (anything else is shown as plain text), the host is always shown next to it, it opens in a new
 * tab without passing the opener or referrer, and nothing is ever embedded or fetched.
 */
export function SafeLink({ url, label }: { url: string; label?: string }) {
  const domain = domainOf(url);
  if (!domain) return <span className="break-all text-white/60">{url}</span>;
  return (
    <span className="break-all">
      <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-lsr-orange hover:underline">
        {label ?? url}
      </a>{" "}
      <span className="text-white/40">({domain})</span>
    </span>
  );
}
