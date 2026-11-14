import { useRef, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { z } from "zod";
import { AlertTriangle, ReceiptText } from "lucide-react";
import type { Route } from "./+types/admin.refund-requests";
import {
  RefundStatus,
  courses,
  enrollments,
  purchases,
  refunds,
  users,
} from "~/db/schema";
import { db } from "~/db";
import { activeEnrollmentOf } from "~/lib/enrollments";
import {
  hasClaimedSeat,
  isTeamLicence,
  voidUnclaimedSeats,
} from "~/lib/seat-codes.server";
import { asc, desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getWatchedSeconds } from "~/lib/watched-time.server";
import { formatPrice } from "~/lib/utils";
import { parseFormData } from "~/lib/validation";
import { decideRefundRequest, requireAdmin } from "~/lib/refund-decisions.server";
import {
  buildRefundApprovedEmail,
  buildRefundDeclinedEmail,
} from "~/lib/refund-emails.server";
import { sendEmail } from "~/lib/email.server";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Review learners' Refund Requests" },
  ];
}

/** Midnight at the start of the local calendar day `when` falls on. */
function startOfDay(when: Date) {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate());
}

// Counted in calendar days, like the learner's 14-day window: a purchase made
// at 23:00 is "1 day ago" the next morning. Math.round absorbs DST shifts.
function calendarDaysBetween(fromIso: string, to: Date) {
  const elapsed = startOfDay(to).getTime() - startOfDay(new Date(fromIso)).getTime();
  return Math.max(0, Math.round(elapsed / 86_400_000));
}

function getOpenRefundRequests(now: Date, viewingAdminId: number) {
  const rows = db
    .select({
      id: refunds.id,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
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
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map((row) => ({
    ...row,
    // An Admin never decides their own Refund Request: no buttons for it.
    isOwnRequest: row.learnerId === viewingAdminId,
    // A team licence with a claimed seat can't be Approved, only Declined.
    hasClaimedSeat: hasClaimedSeat(row.purchaseId),
    daysSincePurchase: calendarDaysBetween(row.purchasedAt, now),
    hoursWatched: getWatchedSeconds(row.learnerId, row.courseId) / 3600,
  }));
}

function getDecidedRefundRequests() {
  const decider = alias(users, "decider");

  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      amountRefunded: refunds.amountRefunded,
      declineReason: refunds.declineReason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      decidedByName: decider.name,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(decider, eq(refunds.resolvedByUserId, decider.id))
    .where(ne(refunds.status, RefundStatus.Open))
    .orderBy(desc(refunds.resolvedAt), desc(refunds.id))
    .all();
}

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);

  return {
    openRequests: getOpenRefundRequests(new Date(), admin.id),
    decidedRequests: getDecidedRefundRequests(),
  };
}

const refundRequestActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    reason: z
      .string()
      .trim()
      .min(1, "Tell the learner why their Refund Request is declined.")
      .max(1000, "Please keep the reason under 1000 characters."),
  }),
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
]);

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundRequestActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  if (parsed.data.intent === "approve") {
    const approved = decideRefundRequest({
      refundRequestId: parsed.data.refundRequestId,
      admin,
      outcome: RefundStatus.Approved,
      // A Refund is always the full amount paid. It stays Pending: no
      // payment provider is called.
      decide: (tx, request) => {
        // We never refund money for a seat someone is using.
        if (hasClaimedSeat(request.purchaseId, tx)) {
          throw data(
            "A seat on this team licence has been claimed, so it can't be refunded. You can still decline it.",
            { status: 409 }
          );
        }

        if (isTeamLicence(request.purchaseId, tx)) {
          // A team licence gave the buyer no enrollment, so there is none to
          // revoke (any they have came from a separate purchase). Nobody can
          // claim a seat that has been refunded.
          voidUnclaimedSeats(request.purchaseId, tx);
        } else {
          // Access ends right away. The row is kept, not deleted (ADR 0001),
          // and lesson progress is untouched for if they buy again.
          tx.update(enrollments)
            .set({ revokedAt: new Date().toISOString() })
            .where(activeEnrollmentOf(request.learnerId, request.courseId))
            .run();
        }

        return { amountRefunded: request.amountPaid };
      },
    });

    sendEmail(
      buildRefundApprovedEmail({
        ...approved,
        amountRefunded: approved.amountPaid,
      })
    );

    return { success: true };
  }

  const { reason, refundRequestId } = parsed.data;

  const declined = decideRefundRequest({
    refundRequestId,
    admin,
    outcome: RefundStatus.Declined,
    decide: () => ({ declineReason: reason }),
  });

  sendEmail(buildRefundDeclinedEmail({ ...declined, declineReason: reason }));

  return { success: true };
}

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatHours(hours: number) {
  return `${hours.toFixed(1)} h`;
}

const thClass =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";
const tdClass = "px-4 py-3 align-top text-sm";

const outcomeLabel: Record<RefundStatus, string> = {
  [RefundStatus.Open]: "Open",
  [RefundStatus.Approved]: "Approved",
  [RefundStatus.Declined]: "Declined",
};

export default function AdminRefundRequests({
  loaderData,
}: Route.ComponentProps) {
  const { openRequests, decidedRequests } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Open Refund Requests, oldest first, and the decisions already made
        </p>
      </div>

      <h2 className="mb-3 text-xl font-semibold">
        Open ({openRequests.length})
      </h2>
      {openRequests.length === 0 ? (
        <Card className="mb-10">
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No Open Refund Requests right now.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="mb-10">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className={thClass}>Learner</th>
                    <th className={thClass}>Course</th>
                    <th className={thClass}>Paid</th>
                    <th className={thClass}>Reason</th>
                    <th className={thClass}>Requested</th>
                    <th className={thClass}>Days since purchase</th>
                    <th className={thClass}>Hours watched</th>
                    <th className={thClass}>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {openRequests.map((request) => (
                    <tr
                      key={request.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className={tdClass}>
                        <div className="font-medium">{request.learnerName}</div>
                        <div className="text-muted-foreground">
                          {request.learnerEmail}
                        </div>
                      </td>
                      <td className={tdClass}>{request.courseTitle}</td>
                      <td className={tdClass}>
                        {formatPrice(request.amountPaid)}
                      </td>
                      <td className={`${tdClass} max-w-sm whitespace-pre-wrap`}>
                        {request.reason}
                      </td>
                      <td className={tdClass}>
                        {formatDateTime(request.requestedAt)}
                      </td>
                      <td className={tdClass}>{request.daysSincePurchase}</td>
                      <td className={tdClass}>
                        {formatHours(request.hoursWatched)}
                      </td>
                      <td className={tdClass}>
                        {request.isOwnRequest ? (
                          <span className="text-muted-foreground">
                            Your own request — another Admin decides it
                          </span>
                        ) : (
                          <div className="flex flex-col items-start gap-2">
                            {request.hasClaimedSeat ? (
                              <span className="text-xs text-muted-foreground">
                                A seat on this team licence has been claimed,
                                so it can't be approved.
                              </span>
                            ) : (
                              <ApproveButton request={request} />
                            )}
                            <DeclineForm refundRequestId={request.id} />
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <h2 className="mb-3 text-xl font-semibold">
        Decided ({decidedRequests.length})
      </h2>
      {decidedRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No Refund Requests have been decided yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className={thClass}>Learner</th>
                    <th className={thClass}>Course</th>
                    <th className={thClass}>Outcome</th>
                    <th className={thClass}>Refund or reason</th>
                    <th className={thClass}>Decided by</th>
                    <th className={thClass}>Decided</th>
                  </tr>
                </thead>
                <tbody>
                  {decidedRequests.map((request) => (
                    <tr
                      key={request.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className={tdClass}>
                        <div className="font-medium">{request.learnerName}</div>
                        <div className="text-muted-foreground">
                          {request.learnerEmail}
                        </div>
                      </td>
                      <td className={tdClass}>{request.courseTitle}</td>
                      <td className={tdClass}>{outcomeLabel[request.status]}</td>
                      <td className={`${tdClass} max-w-sm whitespace-pre-wrap`}>
                        {request.status === RefundStatus.Declined
                          ? (request.declineReason ?? "—")
                          : request.amountRefunded != null
                            ? formatPrice(request.amountRefunded)
                            : "—"}
                      </td>
                      <td className={tdClass}>{request.decidedByName ?? "—"}</td>
                      <td className={tdClass}>
                        {formatDateTime(request.resolvedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Approve asks for confirmation first: the learner, the course, the amount,
 * and that the learner will lose access to the course.
 */
function ApproveButton({
  request,
}: {
  request: {
    id: number;
    learnerName: string;
    learnerEmail: string;
    courseTitle: string;
    amountPaid: number;
  };
}) {
  const fetcher = useFetcher<typeof action>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busy = fetcher.state !== "idle";

  return (
    <>
      <Button size="sm" onClick={() => dialogRef.current?.showModal()}>
        Approve
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby={`approve-title-${request.id}`}
        className="m-auto w-full max-w-md rounded-lg border border-border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/50"
      >
        <h3
          id={`approve-title-${request.id}`}
          className="mb-3 text-lg font-semibold"
        >
          Approve this Refund Request?
        </h3>
        <dl className="mb-4 space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Learner:</dt>
            <dd>
              {request.learnerName} ({request.learnerEmail})
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Course:</dt>
            <dd>{request.courseTitle}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Refund:</dt>
            <dd className="font-medium">{formatPrice(request.amountPaid)}</dd>
          </div>
        </dl>
        <p className="mb-6 text-sm">
          The learner will lose access to this course straight away. Their
          progress is kept in case they buy it again.
        </p>
        <fetcher.Form
          method="post"
          className="flex justify-end gap-2"
          onSubmit={() => dialogRef.current?.close()}
        >
          <input type="hidden" name="intent" value="approve" />
          <input type="hidden" name="refundRequestId" value={request.id} />
          <Button
            type="button"
            variant="ghost"
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy
              ? "Approving…"
              : `Approve ${formatPrice(request.amountPaid)} refund`}
          </Button>
        </fetcher.Form>
      </dialog>
    </>
  );
}

/** Decline opens a form asking for the reason the learner will be sent. */
function DeclineForm({ refundRequestId }: { refundRequestId: number }) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const errors =
    fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : undefined;

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Decline
      </Button>
    );
  }

  return (
    <fetcher.Form method="post" className="w-64 space-y-2">
      <input type="hidden" name="intent" value="decline" />
      <input type="hidden" name="refundRequestId" value={refundRequestId} />
      <label
        htmlFor={`decline-reason-${refundRequestId}`}
        className="text-xs font-medium"
      >
        Reason (sent to the learner)
      </label>
      <Textarea
        id={`decline-reason-${refundRequestId}`}
        name="reason"
        required
        maxLength={1000}
        aria-invalid={errors?.reason ? true : undefined}
      />
      {errors?.reason && (
        <p className="text-xs text-destructive">{errors.reason}</p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={busy}>
          {busy ? "Declining…" : "Decline"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </fetcher.Form>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
