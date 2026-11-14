/**
 * Small builders for route tests. Each takes the test database explicitly
 * (use `getTestDb()` from the route harness) and returns the inserted row.
 * Timestamps are ISO strings, like the live data.
 */
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import type { createTestDb } from "./setup";

type TestDb = ReturnType<typeof createTestDb>;

export function addUser(
  db: TestDb,
  values: { name: string; email: string; role?: schema.UserRole }
) {
  return db
    .insert(schema.users)
    .values({ role: schema.UserRole.Student, ...values })
    .returning()
    .get();
}

export function addPurchase(
  db: TestDb,
  values: {
    userId: number;
    courseId: number;
    amountPaid: number;
    createdAt?: string;
  }
) {
  return db.insert(schema.purchases).values(values).returning().get();
}

export function addRefundRequest(
  db: TestDb,
  values: {
    purchaseId: number;
    reason: string;
    requestedAt?: string;
    status?: schema.RefundStatus;
    amountRefunded?: number | null;
    resolvedAt?: string | null;
    resolvedByUserId?: number | null;
    declineReason?: string | null;
  }
) {
  return db.insert(schema.refunds).values(values).returning().get();
}

/** Adds a lesson to the course, inside a new module. */
export function addLesson(db: TestDb, courseId: number, title = "Lesson") {
  const mod = db
    .insert(schema.modules)
    .values({ courseId, title: `${title} module`, position: 1 })
    .returning()
    .get();
  return db
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title, position: 1 })
    .returning()
    .get();
}

/** Records the learner's video player reaching `positionSeconds` in a lesson. */
export function addWatchEvent(
  db: TestDb,
  values: { userId: number; lessonId: number; positionSeconds: number }
) {
  return db
    .insert(schema.videoWatchEvents)
    .values({ eventType: "progress", ...values })
    .returning()
    .get();
}

export function addEnrollment(
  db: TestDb,
  values: { userId: number; courseId: number }
) {
  return db.insert(schema.enrollments).values(values).returning().get();
}

/** A team with `seats` unclaimed seat codes on one purchase of the course. */
export function addTeamLicence(
  db: TestDb,
  values: { purchaseId: number; courseId: number; seats: number }
) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const codes = Array.from({ length: values.seats }, (_, i) =>
    db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: values.courseId,
        purchaseId: values.purchaseId,
        code: `SEAT-${values.purchaseId}-${i + 1}`,
      })
      .returning()
      .get()
  );
  return { team, codes };
}

/** Marks a seat code as claimed by `userId`, as redeeming it would. */
export function claimSeat(db: TestDb, couponId: number, userId: number) {
  return db
    .update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: new Date().toISOString() })
    .where(eq(schema.coupons.id, couponId))
    .returning()
    .get();
}
