import { Link, useFetcher, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/redeem.$code";
import { getCurrentUserId } from "~/lib/session";
import { resolveCountry } from "~/lib/country.server";
import { parseParams, parseFormData } from "~/lib/validation";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Ticket, AlertCircle, CheckCircle2, Globe } from "lucide-react";
import { data } from "react-router";
import { db } from "~/db";
import { purchases, coupons, courses, enrollments } from "~/db/schema";
import { isEnrolled } from "~/lib/enrollments";
import { eq, and, isNull } from "drizzle-orm";

function getCourseById(id: number) {
  return db.select().from(courses).where(eq(courses.id, id)).get();
}

function getCouponByCode(code: string) {
  return db.select().from(coupons).where(eq(coupons.code, code)).get();
}

// The team licence was refunded, so its unclaimed seats can't be claimed.
const VOIDED_MESSAGE =
  "This coupon can no longer be used: the team licence it came with has been refunded.";
const ALREADY_REDEEMED_MESSAGE = "Coupon has already been redeemed.";

/**
 * Claims the seat for `userId` and enrolls them, or throws why it can't.
 * The claim is guarded on the seat still being unclaimed and not voided, and
 * runs in one transaction with the enrollment, so a seat voided or claimed
 * by someone else in the meantime enrolls nobody.
 */
function redeemCoupon(code: string, userId: number, userCountry: string) {
  const coupon = getCouponByCode(code);
  if (!coupon) {
    throw data("Coupon not found.", { status: 404 });
  }

  if (coupon.redeemedByUserId !== null) {
    throw data(ALREADY_REDEEMED_MESSAGE, { status: 409 });
  }

  if (coupon.voidedAt !== null) {
    throw data(VOIDED_MESSAGE, { status: 410 });
  }

  if (isEnrolled(userId, coupon.courseId)) {
    throw data("You are already enrolled in this course.", { status: 409 });
  }

  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, coupon.purchaseId))
    .get();

  if (purchase?.country && purchase.country !== userCountry) {
    throw data(
      "This coupon can only be redeemed from the same country as the purchaser.",
      { status: 403 }
    );
  }

  return db.transaction((tx) => {
    const claimed = tx
      .update(coupons)
      .set({
        redeemedByUserId: userId,
        redeemedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(coupons.id, coupon.id),
          isNull(coupons.redeemedByUserId),
          isNull(coupons.voidedAt)
        )
      )
      .returning({ id: coupons.id })
      .all();

    if (claimed.length === 0) {
      // Voided or claimed between our read and our write.
      const current = tx
        .select({ voidedAt: coupons.voidedAt })
        .from(coupons)
        .where(eq(coupons.id, coupon.id))
        .get();
      if (current?.voidedAt) {
        throw data(VOIDED_MESSAGE, { status: 410 });
      }
      throw data(ALREADY_REDEEMED_MESSAGE, { status: 409 });
    }

    return tx
      .insert(enrollments)
      .values({ userId, courseId: coupon.courseId })
      .returning()
      .get();
  });
}

const redeemParamsSchema = z.object({
  code: z.string().min(1),
});

const redeemActionSchema = z.object({
  intent: z.literal("confirm-redeem"),
});

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course?.title ?? "Redeem Coupon";
  return [
    { title: `Redeem: ${title} — Cadence` },
    { name: "description", content: `Redeem your coupon for ${title}` },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { code } = parseParams(params, redeemParamsSchema);

  const coupon = getCouponByCode(code);
  if (!coupon) {
    throw data("Coupon not found.", { status: 404 });
  }

  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw redirect(
      `/login?redirectTo=${encodeURIComponent(`/redeem/${code}`)}`
    );
  }

  const course = getCourseById(coupon.courseId);
  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  const alreadyRedeemed = coupon.redeemedByUserId !== null;
  const voided = !alreadyRedeemed && coupon.voidedAt !== null;
  const alreadyEnrolled = isEnrolled(currentUserId, coupon.courseId);

  // Check country mismatch upfront so we can show a clear message
  let countryMismatch = false;
  if (!alreadyRedeemed && !voided && !alreadyEnrolled) {
    const userCountry = await resolveCountry(request);
    const purchase = db
      .select()
      .from(purchases)
      .where(eq(purchases.id, coupon.purchaseId))
      .get();
    if (purchase?.country && purchase.country !== (userCountry ?? "")) {
      countryMismatch = true;
    }
  }

  return {
    course: { id: course.id, title: course.title, slug: course.slug },
    code,
    alreadyRedeemed,
    voided,
    alreadyEnrolled,
    countryMismatch,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const { code } = parseParams(params, redeemParamsSchema);

  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("You must be logged in.", { status: 401 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, redeemActionSchema);

  if (!parsed.success) {
    throw data("Invalid action.", { status: 400 });
  }

  const userCountry = await resolveCountry(request);
  const enrollment = redeemCoupon(code, currentUserId, userCountry ?? "");

  const course = getCourseById(enrollment.courseId);
  if (!course) {
    throw redirect("/courses");
  }

  throw redirect(`/courses/${course.slug}/welcome`);
}

export default function Redeem({ loaderData }: Route.ComponentProps) {
  const {
    course,
    code,
    alreadyRedeemed,
    voided,
    alreadyEnrolled,
    countryMismatch,
  } = loaderData;
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";

  // Determine which state to show
  const canRedeem =
    !alreadyRedeemed && !voided && !alreadyEnrolled && !countryMismatch;

  return (
    <div className="mx-auto max-w-2xl p-6 lg:p-8">
      <h1 className="mb-2 text-2xl font-bold">Redeem Coupon</h1>
      <p className="mb-8 text-muted-foreground">
        You&apos;ve been invited to enroll in a course.
      </p>

      <Card>
        <CardContent className="p-8 text-center">
          <div className="mb-4 inline-flex size-16 items-center justify-center rounded-full bg-primary/10">
            <Ticket className="size-8 text-primary" />
          </div>

          <h2 className="mb-2 text-xl font-semibold">{course.title}</h2>
          <p className="mb-6 text-sm text-muted-foreground">
            Coupon code:{" "}
            <code className="rounded bg-muted px-2 py-0.5">{code}</code>
          </p>

          {alreadyRedeemed ? (
            <div className="rounded-lg bg-destructive/10 p-4">
              <div className="flex items-center justify-center gap-2 text-destructive">
                <AlertCircle className="size-5" />
                <span className="font-medium">
                  This coupon has already been used
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Someone has already claimed this seat. Please ask the person who
                shared this link for a new coupon.
              </p>
            </div>
          ) : voided ? (
            <div className="rounded-lg bg-destructive/10 p-4">
              <div className="flex items-center justify-center gap-2 text-destructive">
                <AlertCircle className="size-5" />
                <span className="font-medium">
                  This coupon can no longer be used
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                The team licence it came with has been refunded, so its unused
                seats were cancelled.
              </p>
            </div>
          ) : alreadyEnrolled ? (
            <div className="rounded-lg bg-green-50 p-4 dark:bg-green-900/20">
              <div className="flex items-center justify-center gap-2 text-green-700 dark:text-green-400">
                <CheckCircle2 className="size-5" />
                <span className="font-medium">
                  You&apos;re already enrolled
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                You already have access to this course. The coupon has not been
                used, so it can still be shared with someone else.
              </p>
              <Link to={`/courses/${course.slug}`}>
                <Button className="mt-4" size="lg">
                  Go to Course
                </Button>
              </Link>
            </div>
          ) : countryMismatch ? (
            <div className="rounded-lg bg-amber-50 p-4 dark:bg-amber-900/20">
              <div className="flex items-center justify-center gap-2 text-amber-700 dark:text-amber-400">
                <Globe className="size-5" />
                <span className="font-medium">Region restriction</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                This coupon can only be redeemed from the same country as the
                person who purchased it. Your location doesn&apos;t match the
                purchaser&apos;s country.
              </p>
            </div>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="confirm-redeem" />
              <Button
                size="lg"
                className="w-full max-w-sm"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Enrolling..." : "Enroll Now"}
              </Button>
            </fetcher.Form>
          )}

          <div className="mt-6">
            <Link
              to={`/courses/${course.slug}`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              View course details
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
