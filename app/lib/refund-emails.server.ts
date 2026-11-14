import type { Email } from "~/lib/email.server";
import { formatPrice } from "~/lib/utils";

type DecidedRefundRequest = {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
};

/**
 * Tells the learner their Refund Request was Approved: how much the Refund is,
 * and that their access to the course has ended.
 */
export function buildRefundApprovedEmail(
  input: DecidedRefundRequest & { amountRefunded: number }
): Email {
  return {
    to: input.learnerEmail,
    subject: `Refund approved — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have approved your refund request for "${input.courseTitle}". You will be refunded ${formatPrice(input.amountRefunded)}, the full amount you paid.`,
      "",
      "Your access to the course has ended. Your progress is kept, so if you buy the course again you can pick up where you left off.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

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
