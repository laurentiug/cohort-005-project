import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/db", async () => (await import("~/test/route-harness")).dbModule);
vi.mock(
  "~/lib/session",
  async () => (await import("~/test/route-harness")).sessionModule
);

import { loader } from "./settings";
import {
  actAs,
  callLoader,
  getTestDb,
  resetTestDb,
} from "~/test/route-harness";
import { addPurchase, addRefundRequest } from "~/test/fixtures";
import { RefundStatus } from "~/db/schema";

const PATH = "/settings";

let base: ReturnType<typeof resetTestDb>;

beforeEach(() => {
  base = resetTestDb();
  actAs(base.user);
});

function purchaseFor(learnerId: number, amountPaid = 7900) {
  return addPurchase(getTestDb(), {
    userId: learnerId,
    courseId: base.course.id,
    amountPaid,
  });
}

function declinedRequest(
  purchaseId: number,
  declineReason: string,
  resolvedAt = "2026-03-05T09:00:00.000Z"
) {
  return addRefundRequest(getTestDb(), {
    purchaseId,
    reason: "Not what I expected.",
    requestedAt: "2026-03-01T09:00:00.000Z",
    status: RefundStatus.Declined,
    declineReason,
    resolvedAt,
    resolvedByUserId: base.admin.id,
  });
}

function approvedRequest(
  purchaseId: number,
  amountRefunded: number,
  resolvedAt = "2026-03-05T09:00:00.000Z"
) {
  return addRefundRequest(getTestDb(), {
    purchaseId,
    reason: "Not what I expected.",
    requestedAt: "2026-03-01T09:00:00.000Z",
    status: RefundStatus.Approved,
    amountRefunded,
    resolvedAt,
    resolvedByUserId: base.admin.id,
  });
}

describe("Refund Request decisions on the learner's settings", () => {
  // The learner is owed the reason for a decline so they can decide whether
  // to ask again; settings is where they can check it at any time.
  it("shows a Declined Refund Request with its decline reason", async () => {
    const purchase = purchaseFor(base.user.id);
    declinedRequest(purchase.id, "You have finished most of the course.");

    const result = await callLoader(loader, PATH);

    expect(result.refundRequestsByPurchase).toEqual([
      expect.objectContaining({
        purchaseId: purchase.id,
        courseTitle: "Test Course",
        openRequest: null,
        latestDecision: expect.objectContaining({
          status: RefundStatus.Declined,
          declineReason: "You have finished most of the course.",
        }),
      }),
    ]);
  });

  // A Pending Refund isn't visible anywhere else to the learner, so settings
  // tells them the amount and that it hasn't been forgotten.
  it("shows an Approved Refund Request with the amount refunded", async () => {
    const purchase = purchaseFor(base.user.id, 7900);
    approvedRequest(purchase.id, 7900);

    const result = await callLoader(loader, PATH);

    expect(result.refundRequestsByPurchase).toEqual([
      expect.objectContaining({
        purchaseId: purchase.id,
        latestDecision: expect.objectContaining({
          status: RefundStatus.Approved,
          amountRefunded: 7900,
        }),
      }),
    ]);
  });

  // A purchase can collect several decisions over time; only the most
  // recent one describes where the learner stands now.
  it("shows only the latest decided Refund Request per purchase", async () => {
    const purchase = purchaseFor(base.user.id);
    declinedRequest(purchase.id, "Newest reason.", "2026-04-10T09:00:00.000Z");
    declinedRequest(purchase.id, "Oldest reason.", "2026-03-05T09:00:00.000Z");

    const result = await callLoader(loader, PATH);

    expect(result.refundRequestsByPurchase).toHaveLength(1);
    expect(result.refundRequestsByPurchase[0].latestDecision).toMatchObject({
      declineReason: "Newest reason.",
    });
  });

  // After a decline the learner may ask again; they should see the new Open
  // request and the earlier decision side by side.
  it("shows an Open Refund Request next to the latest decision", async () => {
    const purchase = purchaseFor(base.user.id);
    declinedRequest(purchase.id, "Please tell us more.");
    addRefundRequest(getTestDb(), {
      purchaseId: purchase.id,
      reason: "Here is more detail.",
      requestedAt: "2026-03-06T09:00:00.000Z",
    });

    const result = await callLoader(loader, PATH);

    expect(result.refundRequestsByPurchase).toEqual([
      expect.objectContaining({
        openRequest: expect.objectContaining({
          reason: "Here is more detail.",
        }),
        latestDecision: expect.objectContaining({
          declineReason: "Please tell us more.",
        }),
      }),
    ]);
  });

  it("leaves out purchases without any Refund Request", async () => {
    purchaseFor(base.user.id);

    const result = await callLoader(loader, PATH);

    expect(result.refundRequestsByPurchase).toEqual([]);
  });

  // Refund Requests are about someone's money; a learner sees only their own.
  it("leaves out other learners' Refund Requests", async () => {
    const purchase = purchaseFor(base.instructor.id);
    declinedRequest(purchase.id, "Not yours to see.");

    const result = await callLoader(loader, PATH);

    expect(result.refundRequestsByPurchase).toEqual([]);
  });
});
