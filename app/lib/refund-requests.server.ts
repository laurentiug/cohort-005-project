import { desc, eq } from "drizzle-orm";
import { db } from "~/db";
import { RefundStatus, courses, purchases, refunds } from "~/db/schema";

/**
 * For each of the learner's purchases that has any Refund Request: the Open
 * one (if any) and the latest decided one (by `resolvedAt`, if any). Older
 * decisions are left out — the learner only needs the current outcome.
 */
export function getRefundRequestsByPurchase(learnerId: number) {
  const rows = db
    .select({
      id: refunds.id,
      purchaseId: purchases.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      status: refunds.status,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      declineReason: refunds.declineReason,
      amountRefunded: refunds.amountRefunded,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.userId, learnerId))
    .orderBy(desc(purchases.id))
    .all();

  type Row = (typeof rows)[number];
  const byPurchase = new Map<
    number,
    {
      purchaseId: number;
      courseTitle: string;
      courseSlug: string;
      amountPaid: number;
      openRequest: Pick<Row, "id" | "reason" | "requestedAt"> | null;
      latestDecision: Omit<
        Row,
        "purchaseId" | "courseTitle" | "courseSlug" | "amountPaid"
      > | null;
    }
  >();

  for (const row of rows) {
    const { purchaseId, courseTitle, courseSlug, amountPaid, ...request } = row;
    let entry = byPurchase.get(purchaseId);
    if (!entry) {
      entry = {
        purchaseId,
        courseTitle,
        courseSlug,
        amountPaid,
        openRequest: null,
        latestDecision: null,
      };
      byPurchase.set(purchaseId, entry);
    }

    if (request.status === RefundStatus.Open) {
      entry.openRequest = {
        id: request.id,
        reason: request.reason,
        requestedAt: request.requestedAt,
      };
    } else if (
      !entry.latestDecision ||
      (request.resolvedAt ?? "") > (entry.latestDecision.resolvedAt ?? "")
    ) {
      entry.latestDecision = request;
    }
  }

  return [...byPurchase.values()];
}
