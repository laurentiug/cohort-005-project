import { data, isRouteErrorResponse, Link } from "react-router";
import { AlertTriangle, ReceiptText } from "lucide-react";
import type { Route } from "./+types/admin.refund-requests";
import { getCurrentUserId } from "~/lib/session";
import {
  RefundStatus,
  UserRole,
  courses,
  purchases,
  refunds,
  users,
} from "~/db/schema";
import { db } from "~/db";
import { asc, desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getWatchedSeconds } from "~/lib/watched-time.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Review learners' Refund Requests" },
  ];
}

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
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

function getOpenRefundRequests(now: Date) {
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
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refund requests.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can access this page.", { status: 403 });
  }

  return {
    openRequests: getOpenRefundRequests(new Date()),
    decidedRequests: getDecidedRefundRequests(),
  };
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
                    <th className={thClass}>Refund</th>
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
                      <td className={tdClass}>
                        {request.amountRefunded != null
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
