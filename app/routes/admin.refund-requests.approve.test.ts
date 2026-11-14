import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/db", async () => (await import("~/test/route-harness")).dbModule);
vi.mock(
  "~/lib/session",
  async () => (await import("~/test/route-harness")).sessionModule
);

import { eq } from "drizzle-orm";
import { action, loader } from "./admin.refund-requests";
import { action as redeemAction } from "./redeem.$code";
import {
  actAs,
  callAction,
  callLoader,
  getTestDb,
  rejectionStatus,
  resetTestDb,
} from "~/test/route-harness";
import {
  addEnrollment,
  addLesson,
  addPurchase,
  addRefundRequest,
  addTeamLicence,
  addUser,
  addWatchEvent,
  claimSeat,
} from "~/test/fixtures";
import {
  RefundStatus,
  UserRole,
  coupons,
  enrollments,
  refunds,
} from "~/db/schema";
import { getAccess } from "~/lib/access.server";

const PATH = "/admin/refund-requests";

let base: ReturnType<typeof resetTestDb>;

beforeEach(() => {
  base = resetTestDb();
  actAs(base.admin);
});

/** The learner bought the course, is enrolled, and asked for a Refund. */
function openRequestFor(learnerId: number, purchasedAt?: string) {
  const db = getTestDb();
  const purchase = addPurchase(db, {
    userId: learnerId,
    courseId: base.course.id,
    amountPaid: 7900,
    createdAt: purchasedAt,
  });
  addEnrollment(db, { userId: learnerId, courseId: base.course.id });
  const request = addRefundRequest(db, {
    purchaseId: purchase.id,
    reason: "Not what I expected from the description.",
  });
  return { purchase, request };
}

function refundRequest(id: number) {
  return getTestDb().select().from(refunds).where(eq(refunds.id, id)).get();
}

function approve(refundRequestId: number) {
  return callAction(action, PATH, {
    intent: "approve",
    refundRequestId: String(refundRequestId),
  });
}

describe("Approving a Refund Request", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-05T09:00:00.000Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    return () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    };
  });

  // A Refund is always the full amount paid, and every decision must be
  // traceable to a person and a moment.
  it("records Approved, the full amount paid, who decided and when", async () => {
    const { request } = openRequestFor(base.user.id);

    await approve(request.id);

    expect(refundRequest(request.id)).toMatchObject({
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedAt: "2026-03-05T09:00:00.000Z",
      resolvedByUserId: base.admin.id,
      declineReason: null,
    });
  });

  // A learner who gets their money back can't keep using the course. The
  // enrollment row is kept (ADR 0001) so we know who had access and when.
  it("revokes the learner's enrollment, keeping the row, so they lose access", async () => {
    const { request } = openRequestFor(base.user.id);

    await approve(request.id);

    const rows = getTestDb()
      .select()
      .from(enrollments)
      .where(eq(enrollments.userId, base.user.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toBe("2026-03-05T09:00:00.000Z");

    actAs(base.user);
    const access = await getAccess(
      new Request("http://localhost:3000/", {
        headers: { "CF-IPCountry": "US" },
      }),
      base.course.id
    );
    expect(access.enrolled).toBe(false);
    expect(access.canViewContent).toBe(false);
  });

  // Eligibility is judged only when the learner asks. By the time an Admin
  // gets to it, the learner may be past the 14-day window or the 2-hour
  // limit; the decision is still the Admin's call.
  it("approves even after the 14-day window and the 2-hour limit have passed", async () => {
    const db = getTestDb();
    const { request } = openRequestFor(
      base.user.id,
      "2026-01-10T09:00:00.000Z"
    );
    const lesson = addLesson(db, base.course.id);
    addWatchEvent(db, {
      userId: base.user.id,
      lessonId: lesson.id,
      positionSeconds: 3 * 3600,
    });

    await approve(request.id);

    expect(refundRequest(request.id)?.status).toBe(RefundStatus.Approved);
  });

  // The learner was promised "we will email you again when it is done".
  it("emails the learner the Refund amount and that access has ended", async () => {
    const { request } = openRequestFor(base.user.id);

    await approve(request.id);

    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    const email = logged.find((line) => line.startsWith("[email]"));
    expect(email).toContain("to=test@example.com");
    expect(email).toContain("Test Course");
    expect(email).toContain("$79.00");
    expect(email).toMatch(/access .* has ended/i);
  });
});

describe("Approving a Refund Request — shared rules", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    return () => vi.restoreAllMocks();
  });

  // A decision is final: a request another Admin already declined is not
  // turned into a Refund, and the learner keeps their access.
  it("says 'already decided' and changes nothing when the request was decided", async () => {
    const { request } = openRequestFor(base.user.id);
    await callAction(action, PATH, {
      intent: "decline",
      refundRequestId: String(request.id),
      reason: "You have finished most of the course.",
    });
    vi.mocked(console.log).mockClear();

    const promise = approve(request.id);

    await expect(promise).rejects.toMatchObject({
      data: expect.stringMatching(/already been decided/),
      init: { status: 409 },
    });
    expect(refundRequest(request.id)).toMatchObject({
      status: RefundStatus.Declined,
      amountRefunded: null,
    });
    const enrollment = getTestDb()
      .select()
      .from(enrollments)
      .where(eq(enrollments.userId, base.user.id))
      .get();
    expect(enrollment?.revokedAt).toBeNull();
    expect(console.log).not.toHaveBeenCalled();
  });

  // Nobody approves a Refund of their own money.
  it("rejects an Admin approving their own Refund Request", async () => {
    const { request } = openRequestFor(base.admin.id);

    expect(await rejectionStatus(approve(request.id))).toBe(403);
    expect(refundRequest(request.id)?.status).toBe(RefundStatus.Open);
  });

  it("lets another Admin approve an Admin's Refund Request", async () => {
    const { request } = openRequestFor(base.admin.id);
    const otherAdmin = addUser(getTestDb(), {
      name: "Other Admin",
      email: "other-admin@example.com",
      role: UserRole.Admin,
    });
    actAs(otherAdmin);

    await approve(request.id);

    expect(refundRequest(request.id)).toMatchObject({
      status: RefundStatus.Approved,
      resolvedByUserId: otherAdmin.id,
    });
  });

  it("rejects a learner and an Instructor", async () => {
    const { request } = openRequestFor(base.user.id);

    actAs(base.user);
    expect(await rejectionStatus(approve(request.id))).toBe(403);
    actAs(base.instructor);
    expect(await rejectionStatus(approve(request.id))).toBe(403);
    expect(refundRequest(request.id)?.status).toBe(RefundStatus.Open);
  });
});

describe("Approving a Refund Request on a team licence", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    return () => vi.restoreAllMocks();
  });

  /** The buyer bought 3 seats and asked for a Refund. */
  function teamLicenceRequest() {
    const db = getTestDb();
    const { purchase, request } = openRequestFor(base.user.id);
    const { codes } = addTeamLicence(db, {
      purchaseId: purchase.id,
      courseId: base.course.id,
      seats: 3,
    });
    return { purchase, request, codes };
  }

  function seatCodes(purchaseId: number) {
    return getTestDb()
      .select()
      .from(coupons)
      .where(eq(coupons.purchaseId, purchaseId))
      .all();
  }

  // We never refund money for a seat someone is using.
  it("is unavailable once a seat has been claimed, and the action rejects it", async () => {
    const db = getTestDb();
    const { purchase, request, codes } = teamLicenceRequest();
    const colleague = addUser(db, {
      name: "Colleague",
      email: "colleague@example.com",
    });
    claimSeat(db, codes[0].id, colleague.id);

    const { openRequests } = await callLoader(loader, PATH);
    expect(openRequests.find((r) => r.id === request.id)).toMatchObject({
      hasClaimedSeat: true,
    });

    expect(await rejectionStatus(approve(request.id))).toBe(409);
    expect(refundRequest(request.id)).toMatchObject({
      status: RefundStatus.Open,
      amountRefunded: null,
    });
    expect(
      seatCodes(purchase.id).every((code) => code.voidedAt === null)
    ).toBe(true);
    const buyerEnrollment = db
      .select()
      .from(enrollments)
      .where(eq(enrollments.userId, base.user.id))
      .get();
    expect(buyerEnrollment?.revokedAt).toBeNull();
  });

  // ...but the request can still be declined, so it doesn't stay Open forever.
  it("can still be declined once a seat has been claimed", async () => {
    const db = getTestDb();
    const { request, codes } = teamLicenceRequest();
    const colleague = addUser(db, {
      name: "Colleague",
      email: "colleague@example.com",
    });
    claimSeat(db, codes[0].id, colleague.id);

    await callAction(action, PATH, {
      intent: "decline",
      refundRequestId: String(request.id),
      reason: "A seat on this licence is already in use.",
    });

    expect(refundRequest(request.id)?.status).toBe(RefundStatus.Declined);
  });

  // Nobody can redeem a seat that has been refunded.
  it("voids every unclaimed seat code, and redeeming one fails clearly", async () => {
    const db = getTestDb();
    const { purchase, request, codes } = teamLicenceRequest();

    await approve(request.id);

    expect(refundRequest(request.id)?.status).toBe(RefundStatus.Approved);
    expect(
      seatCodes(purchase.id).every((code) => code.voidedAt !== null)
    ).toBe(true);

    const colleague = addUser(db, {
      name: "Colleague",
      email: "colleague@example.com",
    });
    actAs(colleague);
    const result = await callAction(
      redeemAction,
      `/redeem/${codes[0].code}`,
      { intent: "confirm-redeem" },
      { code: codes[0].code }
    );

    expect(result).toMatchObject({
      init: { status: 400 },
      data: { error: expect.stringMatching(/refunded/i) },
    });
    const colleagueEnrollment = db
      .select()
      .from(enrollments)
      .where(eq(enrollments.userId, colleague.id))
      .get();
    expect(colleagueEnrollment).toBeUndefined();
  });

  it("is available while no seat has been claimed", async () => {
    const { request } = teamLicenceRequest();

    const { openRequests } = await callLoader(loader, PATH);

    expect(openRequests.find((r) => r.id === request.id)).toMatchObject({
      hasClaimedSeat: false,
    });
  });
});
