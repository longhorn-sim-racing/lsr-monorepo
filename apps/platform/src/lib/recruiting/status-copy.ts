import type { TrackStatus } from "@prisma/client";

export type StatusTone = "neutral" | "progress" | "good" | "bad";

/** What an applicant is told about one team's status, in plain words. */
export function teamStatusCopy(
  status: TrackStatus,
  options: { interviewRequired: boolean; hasBookingUrl: boolean },
): { headline: string; detail: string; tone: StatusTone } {
  switch (status) {
    case "SUBMITTED":
      return { headline: "Received", detail: "Officers review applications as they come in. You will get an email when there is news.", tone: "neutral" };
    case "IN_REVIEW":
      return { headline: "Under review", detail: "An officer is looking at your application for this team.", tone: "progress" };
    case "INTERVIEW":
      return {
        headline: "Invited to interview",
        detail: options.hasBookingUrl
          ? "Pick a time with the button below. We also sent the details by email."
          : "Check your email for how to schedule your interview, or reply to that email.",
        tone: "good",
      };
    case "ACCEPTED":
      return { headline: "Accepted", detail: "Welcome to the team. A team lead will be in touch with next steps (check your email).", tone: "good" };
    case "REJECTED":
      return { headline: "Not moving forward", detail: "Thank you for applying. We would love to see you at our events and in future rounds.", tone: "bad" };
  }
}

/** What a draft that outlived its round is told (the round has closed, so it can no longer be edited). */
export function expiredDraftCopy(complete: boolean): { headline: string; detail: string } {
  return complete
    ? {
        headline: "Your application is being submitted",
        detail: "The round has closed. Your application was complete, so it is submitted for you automatically. This can take a few minutes: refresh this page shortly.",
      }
    : {
        headline: "This application was not submitted",
        detail: "The round closed before this application was finished, so it was not submitted and officers have not seen it. Watch for the next round.",
      };
}
