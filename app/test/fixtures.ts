/**
 * Small builders for route tests. Each takes the test database explicitly
 * (use `getTestDb()` from the route harness) and returns the inserted row.
 * Timestamps are ISO strings, like the live data.
 */
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
