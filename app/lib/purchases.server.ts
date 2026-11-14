import { and, desc, eq } from "drizzle-orm";
import { db } from "~/db";
import { purchases } from "~/db/schema";

/**
 * The user's most recent purchase of this course. A learner who was refunded
 * and bought again has several; the latest one is what their current access
 * was bought with. Ties on `createdAt` go to the higher id.
 */
export function findLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .get();
}
