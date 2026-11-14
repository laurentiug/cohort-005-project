import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/db", async () => (await import("~/test/route-harness")).dbModule);
vi.mock(
  "~/lib/session",
  async () => (await import("~/test/route-harness")).sessionModule
);

import { loader } from "./admin.refund-requests";
import {
  actAs,
  callLoader,
  getTestDb,
  rejectionStatus,
  resetTestDb,
} from "~/test/route-harness";
import {
  addLesson,
  addPurchase,
  addRefundRequest,
  addUser,
  addWatchEvent,
} from "~/test/fixtures";
import { RefundStatus, UserRole } from "~/db/schema";

const PATH = "/admin/refund-requests";

let base: ReturnType<typeof resetTestDb>;

beforeEach(() => {
  base = resetTestDb();
  actAs(base.admin);
});

describe("Refund Requests loader — who can open it", () => {
  // Only Admins decide Refund Requests, so nobody else should even see them:
  // the screen shows other people's reasons and what they paid.
  it("turns away a learner", async () => {
    actAs(base.user);
    expect(await rejectionStatus(callLoader(loader, PATH))).toBe(403);
  });

  it("turns away an Instructor", async () => {
    actAs(base.instructor);
    expect(await rejectionStatus(callLoader(loader, PATH))).toBe(403);
  });

  it("asks for a user when nobody is logged in", async () => {
    actAs(null);
    expect(await rejectionStatus(callLoader(loader, PATH))).toBe(401);
  });

  it("lets an Admin in", async () => {
    const result = await callLoader(loader, PATH);
    expect(result.openRequests).toEqual([]);
    expect(result.decidedRequests).toEqual([]);
  });
});

// Local wall-clock times (no "Z"), so calendar-day maths doesn't depend on
// the machine's time zone.
function local(when: string) {
  return new Date(when).toISOString();
}

describe("Refund Requests loader — Open list", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-05T09:00:00"));
    return () => vi.useRealTimers();
  });

  it("shows each Open Refund Request with what an Admin needs to judge it", async () => {
    const db = getTestDb();
    const lessonA = addLesson(db, base.course.id, "A");
    const lessonB = addLesson(db, base.course.id, "B");
    const purchase = addPurchase(db, {
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: local("2026-03-01T22:00:00"),
    });
    addRefundRequest(db, {
      purchaseId: purchase.id,
      reason: "Not what I expected from the description.",
      requestedAt: local("2026-03-04T12:00:00"),
    });
    // Hours watched count the furthest point reached in each lesson, not every
    // second of playback — rewatching a bit shouldn't push a learner over.
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonA.id, positionSeconds: 1800 });
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonA.id, positionSeconds: 3600 });
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonA.id, positionSeconds: 600 });
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonB.id, positionSeconds: 1800 });
    // Someone else's viewing doesn't count towards this learner.
    addWatchEvent(db, { userId: base.admin.id, lessonId: lessonB.id, positionSeconds: 9000 });

    const { openRequests } = await callLoader(loader, PATH);

    expect(openRequests).toEqual([
      expect.objectContaining({
        learnerName: "Test User",
        learnerEmail: "test@example.com",
        courseTitle: "Test Course",
        amountPaid: 7900,
        reason: "Not what I expected from the description.",
        requestedAt: local("2026-03-04T12:00:00"),
        // Bought late on the 1st, now the morning of the 5th: under four full
        // days have passed, but it is four calendar days — the same way the
        // learner's 14-day window is counted.
        daysSincePurchase: 4,
        hoursWatched: 1.5,
      }),
    ]);
  });

  it("lists the learners who have waited longest first, and leaves out decided ones", async () => {
    const db = getTestDb();
    const second = addUser(db, { name: "Second", email: "second@example.com" });
    const first = addUser(db, { name: "First", email: "first@example.com" });
    const decided = addUser(db, { name: "Decided", email: "decided@example.com" });

    for (const [learner, requestedAt, status] of [
      [second, "2026-03-04T08:00:00", RefundStatus.Open],
      [first, "2026-03-02T08:00:00", RefundStatus.Open],
      [decided, "2026-03-01T08:00:00", RefundStatus.Declined],
    ] as const) {
      const purchase = addPurchase(db, {
        userId: learner.id,
        courseId: base.course.id,
        amountPaid: 5000,
        createdAt: local("2026-03-01T07:00:00"),
      });
      addRefundRequest(db, {
        purchaseId: purchase.id,
        reason: "Changed my mind about this one.",
        requestedAt: local(requestedAt),
        status,
      });
    }

    const { openRequests } = await callLoader(loader, PATH);

    expect(openRequests.map((r) => r.learnerName)).toEqual(["First", "Second"]);
  });
});

describe("Refund Requests loader — Decided list", () => {
  // Decisions are final and must be traceable to a person, so the Decided
  // list always says what was decided, by whom, and when.
  it("shows each decision's outcome, the Admin who made it and when, newest first", async () => {
    const db = getTestDb();
    const otherAdmin = addUser(db, {
      name: "Other Admin",
      email: "other-admin@example.com",
      role: UserRole.Admin,
    });
    const approvedLearner = addUser(db, { name: "Ann", email: "ann@example.com" });
    const declinedLearner = addUser(db, { name: "Dan", email: "dan@example.com" });

    const approvedPurchase = addPurchase(db, {
      userId: approvedLearner.id,
      courseId: base.course.id,
      amountPaid: 7900,
    });
    addRefundRequest(db, {
      purchaseId: approvedPurchase.id,
      reason: "The course was not for me.",
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedAt: "2026-03-03T10:00:00.000Z",
      resolvedByUserId: base.admin.id,
    });

    const declinedPurchase = addPurchase(db, {
      userId: declinedLearner.id,
      courseId: base.course.id,
      amountPaid: 5000,
    });
    addRefundRequest(db, {
      purchaseId: declinedPurchase.id,
      reason: "I would like my money back.",
      status: RefundStatus.Declined,
      resolvedAt: "2026-03-04T10:00:00.000Z",
      resolvedByUserId: otherAdmin.id,
    });

    // Still Open: belongs in the other list, not this one.
    addRefundRequest(db, {
      purchaseId: approvedPurchase.id,
      reason: "Asking again for some reason.",
    });

    const { decidedRequests } = await callLoader(loader, PATH);

    expect(decidedRequests).toEqual([
      expect.objectContaining({
        learnerName: "Dan",
        courseTitle: "Test Course",
        status: RefundStatus.Declined,
        decidedByName: "Other Admin",
        resolvedAt: "2026-03-04T10:00:00.000Z",
        amountRefunded: null,
      }),
      expect.objectContaining({
        learnerName: "Ann",
        courseTitle: "Test Course",
        status: RefundStatus.Approved,
        decidedByName: "Test Admin",
        resolvedAt: "2026-03-03T10:00:00.000Z",
        amountRefunded: 7900,
      }),
    ]);
  });
});
