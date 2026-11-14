import type { Email } from "~/lib/email.server";

type DecidedRefundRequest = {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
};

/** Tells the learner their Refund Request was Declined, and why. */
export function buildRefundDeclinedEmail(
  input: DecidedRefundRequest & { declineReason: string }
): Email {
  return {
    to: input.learnerEmail,
    subject: `Refund request declined — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have looked at your refund request for "${input.courseTitle}" and declined it. Here is why:`,
      "",
      input.declineReason,
      "",
      "You still have access to the course. If something changes, you may raise a new Refund Request from the course page.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
