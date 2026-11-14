/**
 * Seat codes (the `coupons` table) on a team licence, as they matter to a
 * Refund: a claimed seat is someone using the course, so the purchase can't
 * be refunded; once it is refunded, the unclaimed seats can't be claimed.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, type Transaction } from "~/db";
import { coupons } from "~/db/schema";

type Executor = typeof db | Transaction;

/**
 * Was this purchase a team licence (it bought seat codes)? A team licence
 * gives the buyer no enrollment of their own; only redeemed seats do.
 */
export function isTeamLicence(purchaseId: number, executor: Executor = db) {
  const seat = executor
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();

  return !!seat;
}

/** Has anyone redeemed a seat code bought with this purchase? */
export function hasClaimedSeat(purchaseId: number, executor: Executor = db) {
  const claimed = executor
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedByUserId))
    )
    .get();

  return !!claimed;
}

/** Makes every unclaimed seat code on this purchase unusable. */
export function voidUnclaimedSeats(purchaseId: number, executor: Executor = db) {
  executor
    .update(coupons)
    .set({ voidedAt: new Date().toISOString() })
    .where(
      and(
        eq(coupons.purchaseId, purchaseId),
        isNull(coupons.redeemedByUserId),
        isNull(coupons.voidedAt)
      )
    )
    .run();
}
