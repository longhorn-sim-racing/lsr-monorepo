import { domainOf } from "@/lib/recruiting/labels";
import { cn } from "@/lib/utils";

/**
 * A link an APPLICANT typed. Officers will click these, so: only clean https links become links
 * (anything else is shown as plain text), the host is always shown next to it, it opens in a new
 * tab without passing the opener or referrer, and nothing is ever embedded or fetched.
 *
 * `tone` picks the colours: "site" for the dark public pages (the applicant side), "admin" for the
 * admin console, whose colours follow its light/dark theme.
 */
export function SafeLink({ url, label, tone = "site" }: { url: string; label?: string; tone?: "site" | "admin" }) {
  const admin = tone === "admin";
  const domain = domainOf(url);
  if (!domain) return <span className={cn("break-all", admin ? "text-muted-foreground" : "text-white/60")}>{url}</span>;
  return (
    <span className="break-all">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className={admin ? "font-medium text-foreground underline underline-offset-2 hover:text-primary" : "text-lsr-orange hover:underline"}
      >
        {label ?? url}
      </a>{" "}
      <span className={admin ? "text-admin-subtle" : "text-white/40"}>({domain})</span>
    </span>
  );
}
