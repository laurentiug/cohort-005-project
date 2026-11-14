/**
 * The rules every Admin decision on a Refund Request follows, whether it
 * Approves or Declines:
 *
 * - Only Admins decide (`requireAdmin`).
 * - A decision is final: only an Open Refund Request can be decided, and the
 *   update itself is guarded on the request still being Open, so two Admins
 *   acting at once can't both succeed.
 * - An Admin never decides a Refund Request on their own Purchase.
 *
 * `decideRefundRequest` runs all of it in one transaction. Anything the
 * decision's own `decide` callback writes is rolled back if the request turns
 * out to be already decided.
 */
import { data } from "react-router";
import { and, eq } from "drizzle-orm";
import { db, type Transaction } from "~/db";
import {
  RefundStatus,
  UserRole,
  courses,
  purchases,
  refunds,
  users,
} from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";

/** The acting user, if they are an Admin. Throws 401 / 403 otherwise. */
export async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data(
      "Select a user from the DevUI panel to review Refund Requests.",
      { status: 401 }
    );
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only Admins can review Refund Requests.", { status: 403 });
  }

  return currentUser;
}


/** What a decision needs to know about the Refund Request being decided. */
export type RefundRequestToDecide = {
  id: number;
  status: RefundStatus;
  reason: string;
  purchaseId: number;
  amountPaid: number;
  learnerId: number;
  learnerName: string;
  learnerEmail: string;
  courseId: number;
  courseTitle: string;
};

/** The columns a decision sets besides status, `resolvedAt` and `resolvedByUserId`. */
type DecisionFields = Partial<
  Pick<typeof refunds.$inferInsert, "amountRefunded" | "declineReason">
>;

function findRefundRequest(tx: Transaction, id: number) {
  return tx
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, id))
    .get();
}

function alreadyDecided() {
  return data("This Refund Request has already been decided.", {
    status: 409,
  });
}

/**
 * Decides an Open Refund Request as `admin`, applying the shared rules above.
 *
 * `decide` runs inside the transaction, after the shared rules pass and
 * before the guarded update. It may throw (e.g. `throw data(..., { status })`)
 * to refuse, may make its own writes through `tx`, and returns the extra
 * columns to store with the decision.
 *
 * Returns the Refund Request as it was before the decision, merged with what
 * `decide` returned, for the email.
 */
export function decideRefundRequest<Fields extends DecisionFields>(input: {
  refundRequestId: number;
  admin: { id: number };
  outcome: RefundStatus.Approved | RefundStatus.Declined;
  decide: (tx: Transaction, request: RefundRequestToDecide) => Fields;
}): RefundRequestToDecide & Fields {
  return db.transaction((tx) => {
    const request = findRefundRequest(tx, input.refundRequestId);

    if (!request) {
      throw data("Refund Request not found.", { status: 404 });
    }

    if (request.status !== RefundStatus.Open) {
      throw alreadyDecided();
    }

    // Nobody decides a Refund Request about their own money. Another Admin
    // can still decide it, so it doesn't stay Open forever.
    if (request.learnerId === input.admin.id) {
      throw data("You can't decide your own Refund Request.", { status: 403 });
    }

    const fields = input.decide(tx, request);

    const updated = tx
      .update(refunds)
      .set({
        ...fields,
        status: input.outcome,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: input.admin.id,
      })
      .where(
        and(
          eq(refunds.id, request.id),
          eq(refunds.status, RefundStatus.Open)
        )
      )
      .returning({ id: refunds.id })
      .all();

    // Someone else decided it between our read and our write. Throwing rolls
    // back anything `decide` wrote.
    if (updated.length === 0) {
      throw alreadyDecided();
    }

    return { ...request, ...fields };
  });
}
