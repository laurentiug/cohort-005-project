import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let currentUserId: number | null = null;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => currentUserId),
  getSession: vi.fn(async () => ({ get: () => undefined })),
}));

import { getAccess } from "./access.server";
import { action as purchaseAction } from "~/routes/courses.$slug.purchase";

// A CF-IPCountry header keeps country resolution off the network.
function makeRequest(init: RequestInit = {}) {
  return new Request("http://localhost:3000", {
    ...init,
    headers: { "CF-IPCountry": "US" },
  });
}

function buyCourse(slug: string) {
  const formData = new FormData();
  formData.set("intent", "confirm-purchase");
  return purchaseAction({
    params: { slug },
    request: makeRequest({ method: "POST", body: formData }),
  } as unknown as Parameters<typeof purchaseAction>[0]);
}

function revokeEnrollments(userId: number, courseId: number) {
  testDb
    .update(schema.enrollments)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, courseId)
      )
    )
    .run();
}

describe("getAccess with revoked enrollments", () => {
  let base: ReturnType<typeof seedBaseData>;

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    currentUserId = base.user.id;
  });

  // Approving a Refund Request revokes the enrollment rather than deleting it
  // (ADR 0001), so access must treat a revoked row as no enrollment at all —
  // otherwise a refunded learner keeps the course they got their money back for.
  it("treats a learner whose enrollment is revoked as not enrolled", async () => {
    testDb
      .insert(schema.enrollments)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        revokedAt: new Date().toISOString(),
      })
      .run();

    const access = await getAccess(makeRequest(), base.course.id);

    expect(access.enrolled).toBe(false);
    expect(access.canViewContent).toBe(false);
  });

  // Buying again must start a new period of access (a new row) so the history
  // shows each one, and progress is keyed by user and lesson so it survives.
  it("lets a refunded learner buy again and keep their earlier progress", async () => {
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module 1", position: 1 })
      .returning()
      .get();
    const lesson = testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: "Lesson 1", position: 1 })
      .returning()
      .get();
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: lesson.id,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();

    await expect(buyCourse(base.course.slug)).rejects.toBeInstanceOf(Response);
    revokeEnrollments(base.user.id, base.course.id);
    expect((await getAccess(makeRequest(), base.course.id)).enrolled).toBe(
      false
    );

    await expect(buyCourse(base.course.slug)).rejects.toBeInstanceOf(Response);

    const access = await getAccess(makeRequest(), base.course.id);
    expect(access.enrolled).toBe(true);
    expect(access.canViewContent).toBe(true);

    const rows = testDb
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.userId, base.user.id))
      .all();
    expect(rows).toHaveLength(2);

    const progress = testDb
      .select()
      .from(schema.lessonProgress)
      .where(eq(schema.lessonProgress.userId, base.user.id))
      .all();
    expect(progress).toEqual([
      expect.objectContaining({
        lessonId: lesson.id,
        status: schema.LessonProgressStatus.Completed,
      }),
    ]);
  });
});
