import {
  Shield,
  Trophy,
  Star,
  GraduationCap,
  Handshake,
  type LucideIcon,
} from "lucide-react";

export type StatusIndicator = {
  key: string;
  icon: LucideIcon;
  label: string;
  tooltip: string;
  colorClass: string;
};

/**
 * Compute which status indicators to display for a user.
 * Membership tiers are mutually exclusive; officer and participation badges stack alongside.
 */
export function getStatusIndicators(opts: {
  roles: string[];
  activeTierKey: string | null;
  officerTitle?: string | null;
}): StatusIndicator[] {
  const { roles, activeTierKey, officerTitle } = opts;
  const indicators: StatusIndicator[] = [];

  // Officer
  if (roles.includes("admin") || roles.includes("officer") || officerTitle) {
    indicators.push({
      key: "officer",
      icon: Shield,
      label: officerTitle || "Officer",
      tooltip: officerTitle || "Officer",
      colorClass: "text-lsr-orange",
    });
  }

  // Membership tier (mutually exclusive)
  if (activeTierKey === "ALUMNI") {
    indicators.push({
      key: "alumni",
      icon: GraduationCap,
      label: "Alumni",
      tooltip: "Alumni",
      colorClass: "text-purple-400",
    });
  } else if (activeTierKey === "PARTNER") {
    indicators.push({
      key: "partner",
      icon: Handshake,
      label: "Partner",
      tooltip: "Partner",
      colorClass: "text-blue-400",
    });
  }
  // No dues badges (paid/unpaid): LSR is dues-optional and only charges for activities.

  // Participation badges (can stack)
  if (roles.includes("lsc_driver")) {
    indicators.push({
      key: "lsc_driver",
      icon: Trophy,
      label: "LSC Driver",
      tooltip: "Lone Star Cup Driver",
      colorClass: "text-yellow-400",
    });
  }

  if (roles.includes("collegiate_driver")) {
    indicators.push({
      key: "collegiate_driver",
      icon: Star,
      label: "Collegiate Series",
      tooltip: "Collegiate Series Driver",
      colorClass: "text-cyan-400",
    });
  }

  return indicators;
}

/** Extract the active membership tier key from a memberships array. */
export function getActiveTierKey(
  memberships?: { tier: { key: string }; validTo: Date | null }[]
): string | null {
  if (!memberships) return null;
  const active = memberships.find(
    (m) => !m.validTo || new Date(m.validTo) > new Date()
  );
  return active?.tier.key ?? null;
}
