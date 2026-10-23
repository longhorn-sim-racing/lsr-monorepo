import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/admin/recruiting/actions", () => ({ resendAllFailedAction: vi.fn(), resendEmailAction: vi.fn() }));

import { EmailsConsole } from "./emails-console";

const props: ComponentProps<typeof EmailsConsole> = {
  cycles: [{ slug: "fall-2026", name: "Fall 2026", isActive: true }],
  cycle: { id: "c1", slug: "fall-2026", name: "Fall 2026" },
  quota: { sentToday: 3, dailyLimit: 100, left: 90 },
  rows: [],
  deliverySummary: null,
};
const render = (extra: Partial<ComponentProps<typeof EmailsConsole>> = {}) => renderToStaticMarkup(createElement(EmailsConsole, { ...props, ...extra }));

describe("Recruiting → Emails delivery notice", () => {
  it("says when delivery reports couldn't be read, so an empty list isn't taken as all clear", () => {
    expect(render({ deliveryUnavailable: true })).toContain("Couldn&#x27;t load Resend&#x27;s delivery reports");
  });

  it("says nothing extra when they loaded (or tracking isn't set up)", () => {
    expect(render()).not.toContain("delivery reports");
  });
});
