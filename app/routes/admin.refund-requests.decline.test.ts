import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/db", async () => (await import("~/test/route-harness")).dbModule);
vi.mock(
  "~/lib/session",
  async () => (await import("~/test/route-harness")).sessionModule
);

import { eq } from "drizzle-orm";
import { action } from "./admin.refund-requests";
import {
  actAs,
  callAction,
  getTestDb,
  rejectionStatus,
  resetTestDb,
} from "~/test/route-harness";
import { addPurchase, addRefundRequest, addUser } from "~/test/fixtures";
import { RefundStatus, UserRole, refunds } from "~/db/schema";

const PATH = "/admin/refund-requests";

let base: ReturnType<typeof resetTestDb>;

beforeEach(() => {
  base = resetTestDb();
  actAs(base.admin);
});

function openRequestFor(learnerId: number) {
  const db = getTestDb();
  const purchase = addPurchase(db, {
    userId: learnerId,
    courseId: base.course.id,
    amountPaid: 7900,
  });
  return addRefundRequest(db, {
    purchaseId: purchase.id,
    reason: "Not what I expected from the description.",
  });
}

function refundRequest(id: number) {
  return getTestDb().select().from(refunds).where(eq(refunds.id, id)).get();
}

function decline(refundRequestId: number, reason: string) {
  return callAction(action, PATH, {
    intent: "decline",
    refundRequestId: String(refundRequestId),
    reason,
  });
}

describe("Declining a Refund Request", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-05T09:00:00.000Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    return () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    };
  });

  // A decision must be traceable to a person and a moment, and the learner
  // is owed the reason, so all of it is stored with the request.
  it("records Declined, the reason, who decided and when", async () => {
    const request = openRequestFor(base.user.id);

    await decline(request.id, "  You have finished most of the course.  ");

    expect(refundRequest(request.id)).toMatchObject({
      status: RefundStatus.Declined,
      declineReason: "You have finished most of the course.",
      resolvedAt: "2026-03-05T09:00:00.000Z",
      resolvedByUserId: base.admin.id,
      amountRefunded: null,
    });
  });

  // No learner is turned down without an explanation.
  it("rejects an empty reason and leaves the request Open", async () => {
    const request = openRequestFor(base.user.id);

    const result = await decline(request.id, "   ");

    expect(result).toMatchObject({ init: { status: 400 } });
    expect(refundRequest(request.id)).toMatchObject({
      status: RefundStatus.Open,
      declineReason: null,
      resolvedAt: null,
    });
  });

  it("rejects a reason over 1000 characters", async () => {
    const request = openRequestFor(base.user.id);

    const result = await decline(request.id, "x".repeat(1001));

    expect(result).toMatchObject({ init: { status: 400 } });
    expect(refundRequest(request.id)?.status).toBe(RefundStatus.Open);
  });

  // The learner was promised "we will email you again when it is done", and
  // they need the reason to decide whether to ask again.
  it("emails the learner the reason and that they may ask again", async () => {
    const request = openRequestFor(base.user.id);

    await decline(request.id, "You have finished most of the course.");

    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    const email = logged.find((line) => line.startsWith("[email]"));
    expect(email).toContain("to=test@example.com");
    expect(email).toContain("Test Course");
    expect(email).toContain("You have finished most of the course.");
    expect(email).toMatch(/new Refund Request/);
  });
});

describe("Deciding a Refund Request — shared rules", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    return () => vi.restoreAllMocks();
  });

  // A decision is final. If another Admin got there first while this one had
  // the screen open, the first decision stands untouched.
  it("says 'already decided' and changes nothing when the request was decided", async () => {
    const db = getTestDb();
    const otherAdmin = addUser(db, {
      name: "Other Admin",
      email: "other-admin@example.com",
      role: UserRole.Admin,
    });
    const purchase = addPurchase(db, {
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
    });
    const request = addRefundRequest(db, {
      purchaseId: purchase.id,
      reason: "Not what I expected from the description.",
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedAt: "2026-03-03T10:00:00.000Z",
      resolvedByUserId: otherAdmin.id,
    });

    const promise = decline(request.id, "Too late, sorry.");

    await expect(promise).rejects.toMatchObject({
      data: expect.stringMatching(/already been decided/),
      init: { status: 409 },
    });
    expect(refundRequest(request.id)).toMatchObject({
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      declineReason: null,
      resolvedAt: "2026-03-03T10:00:00.000Z",
      resolvedByUserId: otherAdmin.id,
    });
    expect(console.log).not.toHaveBeenCalled();
  });

  // Nobody decides a Refund Request about their own money.
  it("rejects an Admin deciding their own Refund Request", async () => {
    const request = openRequestFor(base.admin.id);

    expect(await rejectionStatus(decline(request.id, "Nope."))).toBe(403);
    expect(refundRequest(request.id)?.status).toBe(RefundStatus.Open);
  });

  // ...but it still gets decided, by someone else.
  it("lets another Admin decide an Admin's Refund Request", async () => {
    const request = openRequestFor(base.admin.id);
    const otherAdmin = addUser(getTestDb(), {
      name: "Other Admin",
      email: "other-admin@example.com",
      role: UserRole.Admin,
    });
    actAs(otherAdmin);

    await decline(request.id, "Admins don't get refunds on training courses.");

    expect(refundRequest(request.id)).toMatchObject({
      status: RefundStatus.Declined,
      resolvedByUserId: otherAdmin.id,
    });
  });

  it("rejects a learner", async () => {
    const request = openRequestFor(base.user.id);
    actAs(base.user);

    expect(await rejectionStatus(decline(request.id, "Declining my own."))).toBe(403);
    expect(refundRequest(request.id)?.status).toBe(RefundStatus.Open);
  });

  it("rejects an Instructor", async () => {
    const request = openRequestFor(base.user.id);
    actAs(base.instructor);

    expect(await rejectionStatus(decline(request.id, "Not refundable."))).toBe(403);
    expect(refundRequest(request.id)?.status).toBe(RefundStatus.Open);
  });

  it("asks for a user when nobody is logged in", async () => {
    const request = openRequestFor(base.user.id);
    actAs(null);

    expect(await rejectionStatus(decline(request.id, "Not refundable."))).toBe(401);
  });
});
