import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/db", async () => (await import("~/test/route-harness")).dbModule);
vi.mock(
  "~/lib/session",
  async () => (await import("~/test/route-harness")).sessionModule
);

import { eq } from "drizzle-orm";
import { action } from "./redeem.$code";
import {
  actAs,
  callAction,
  getTestDb,
  rejectionStatus,
  resetTestDb,
} from "~/test/route-harness";
import {
  addPurchase,
  addTeamLicence,
  addUser,
  claimSeat,
} from "~/test/fixtures";
import { coupons, enrollments } from "~/db/schema";

let base: ReturnType<typeof resetTestDb>;

beforeEach(() => {
  base = resetTestDb();
});

function seatCode() {
  const db = getTestDb();
  const purchase = addPurchase(db, {
    userId: base.user.id,
    courseId: base.course.id,
    amountPaid: 7900,
  });
  const { codes } = addTeamLicence(db, {
    purchaseId: purchase.id,
    courseId: base.course.id,
    seats: 1,
  });
  return codes[0];
}

function redeem(code: string) {
  return callAction(
    action,
    `/redeem/${code}`,
    { intent: "confirm-redeem" },
    { code }
  );
}

function enrollmentsOf(userId: number) {
  return getTestDb()
    .select()
    .from(enrollments)
    .where(eq(enrollments.userId, userId))
    .all();
}

describe("Redeeming a seat code", () => {
  it("claims the seat and enrolls the colleague", async () => {
    const code = seatCode();
    const colleague = addUser(getTestDb(), {
      name: "Colleague",
      email: "colleague@example.com",
    });
    actAs(colleague);

    const status = await rejectionStatus(redeem(code.code));

    expect(status).toBe(302);
    expect(enrollmentsOf(colleague.id)).toHaveLength(1);
    const seat = getTestDb()
      .select()
      .from(coupons)
      .where(eq(coupons.id, code.id))
      .get();
    expect(seat?.redeemedByUserId).toBe(colleague.id);
  });

  it("refuses a seat someone else already claimed", async () => {
    const db = getTestDb();
    const code = seatCode();
    const first = addUser(db, { name: "First", email: "first@example.com" });
    const second = addUser(db, { name: "Second", email: "second@example.com" });
    claimSeat(db, code.id, first.id);
    actAs(second);

    const status = await rejectionStatus(redeem(code.code));

    expect(status).toBe(409);
    expect(enrollmentsOf(second.id)).toHaveLength(0);
  });
});
