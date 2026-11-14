# Soft-delete enrollments when a Refund Request is approved

When an Admin approves a Refund Request, the learner's enrollment is marked revoked (`revokedAt`) rather than deleted, because we want to keep a record of who had access to a course and when, even after a Refund. A learner who buys again gets a new enrollment row instead of the old one being reactivated, so the history shows each period of access separately.

## Consequences

- Every query on `enrollments` must go through the shared "active enrollment" filter. A plain `select from enrollments` will count refunded learners as enrolled: in access checks, the instructor's student list, dashboard and admin counts, and analytics.
- A user can have several enrollment rows for the same course, so "find enrollment" lookups must pick the active one, not any one.
- Lesson progress and watch history are keyed by user and lesson, not by enrollment, so a learner who buys again picks up where they left off.
- `revokedAt` doesn't record *why*. Approving a Refund Request is the only cause today, and that request already records who decided and when. Add a link to the cause if a second one ever appears.
