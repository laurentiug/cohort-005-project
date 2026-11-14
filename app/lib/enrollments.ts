import { and, eq, isNull } from "drizzle-orm";
import { enrollments } from "~/db/schema";

// ─── Active Enrollments ───
// Enrollments are soft-deleted: approving a Refund Request sets `revokedAt`
// instead of deleting the row, so we keep a record of who had access and when
// (ADR 0001). A user can therefore have several rows for one course, and only
// the one with no `revokedAt` grants access.
//
// Every read of `enrollments` must include one of these conditions. A plain
// select would count refunded learners as enrolled.

/** Matches enrollments that still grant access. */
export function activeEnrollment() {
  return isNull(enrollments.revokedAt);
}

/** Matches this user's active enrollment in this course (at most one). */
export function activeEnrollmentOf(userId: number, courseId: number) {
  return and(
    eq(enrollments.userId, userId),
    eq(enrollments.courseId, courseId),
    activeEnrollment()
  );
}
