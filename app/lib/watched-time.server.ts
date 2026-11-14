import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { lessons, modules, videoWatchEvents } from "~/db/schema";

/**
 * How much of a course a learner has watched, in seconds: for each lesson in
 * the course, the furthest position they reached, added up.
 *
 * This is the rule a learner faces when they raise a Refund Request (the
 * 2-hour watch limit), and the number Admins see when they decide one, so both
 * places must share this one implementation.
 */
export function getWatchedSeconds(userId: number, courseId: number): number {
  const courseLessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  if (courseLessonIds.length === 0) {
    return 0;
  }

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, courseLessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}
