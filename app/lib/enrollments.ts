import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
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

/** Does this user have an active enrollment in this course? */
export function isEnrolled(userId: number, courseId: number) {
  const enrollment = db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(activeEnrollmentOf(userId, courseId))
    .get();
  return !!enrollment;
}

/** How many learners are actively enrolled in this course. */
export function countActiveEnrollments(courseId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(enrollments)
    .where(and(eq(enrollments.courseId, courseId), activeEnrollment()))
    .get();
  return result?.count ?? 0;
}
