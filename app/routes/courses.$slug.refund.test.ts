import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/db", async () => (await import("~/test/route-harness")).dbModule);
vi.mock(
  "~/lib/session",
  async () => (await import("~/test/route-harness")).sessionModule
);

import { action } from "./courses.$slug.refund";
import {
  actAs,
  callAction,
  getTestDb,
  rejectionStatus,
  resetTestDb,
} from "~/test/route-harness";
import { addLesson, addPurchase, addWatchEvent } from "~/test/fixtures";

let base: ReturnType<typeof resetTestDb>;

beforeEach(() => {
  base = resetTestDb();
  actAs(base.user);
  vi.spyOn(console, "log").mockImplementation(() => {});
  addPurchase(getTestDb(), {
    userId: base.user.id,
    courseId: base.course.id,
    amountPaid: 7900,
  });
});

function requestRefund() {
  return callAction(
    action,
    "/courses/test-course/refund",
    { reason: "This course was not what I expected." },
    { slug: "test-course" }
  );
}

describe("Raising a Refund Request — the 2-hour watch limit", () => {
  // Only the furthest point in each lesson counts. A learner who scrubs back
  // and rewatches a section hasn't used more of the course.
  it("ignores rewatching when adding up hours watched", async () => {
    const db = getTestDb();
    const lessonA = addLesson(db, base.course.id, "A");
    const lessonB = addLesson(db, base.course.id, "B");
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonA.id, positionSeconds: 3500 });
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonA.id, positionSeconds: 1000 });
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonA.id, positionSeconds: 3500 });
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonB.id, positionSeconds: 3600 });

    const response = await requestRefund();

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe("/settings");
  });

  it("refuses once the furthest positions add up to two hours", async () => {
    const db = getTestDb();
    const lessonA = addLesson(db, base.course.id, "A");
    const lessonB = addLesson(db, base.course.id, "B");
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonA.id, positionSeconds: 3600 });
    addWatchEvent(db, { userId: base.user.id, lessonId: lessonB.id, positionSeconds: 3600 });

    expect(await rejectionStatus(requestRefund())).toBe(403);
  });
});
