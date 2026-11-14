/**
 * Route test harness ("seam 1"): call a route's real `loader` / `action`
 * with a real `Request`, against a fresh in-memory database, as a chosen user.
 *
 * Usage in a route test file — the two `vi.mock` lines must live in the test
 * file itself (vitest hoists them there), and simply delegate to this module:
 *
 *   vi.mock("~/db", async () => (await import("~/test/route-harness")).dbModule);
 *   vi.mock("~/lib/session", async () => (await import("~/test/route-harness")).sessionModule);
 *
 *   import { loader, action } from "./admin.refund-requests";
 *   import { resetTestDb, actAs, callLoader, callAction, getTestDb } from "~/test/route-harness";
 *
 *   let base: ReturnType<typeof resetTestDb>;
 *   beforeEach(() => { base = resetTestDb(); actAs(base.admin); });
 *
 *   const result = await callLoader(loader, "/admin/refund-requests");
 *   const status = await rejectionStatus(callLoader(loader, "/admin/refund-requests"));
 */
import { createTestDb, seedBaseData } from "./setup";

type TestDb = ReturnType<typeof createTestDb>;

let currentDb: TestDb | undefined;
let actingUserId: number | null = null;

/** Throws away the previous database, creates a fresh one and seeds base data. */
export function resetTestDb() {
  currentDb = createTestDb();
  actingUserId = null;
  return seedBaseData(currentDb);
}

/** The database the mocked `~/db` currently points at. */
export function getTestDb(): TestDb {
  if (!currentDb) {
    throw new Error("Call resetTestDb() before using the test database.");
  }
  return currentDb;
}

/** Chooses who `getCurrentUserId` says is logged in. `null` = nobody. */
export function actAs(user: { id: number } | null) {
  actingUserId = user ? user.id : null;
}

/** Stand-in for `~/db`: `db` always forwards to the current test database. */
export const dbModule = {
  db: new Proxy({} as TestDb, {
    get(_target, prop) {
      const target = getTestDb();
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
};

/** Stand-in for `~/lib/session`, driven by `actAs`. */
export const sessionModule = {
  getCurrentUserId: async (_request: Request) => actingUserId,
  getSession: async (_request: Request) => ({
    get: (key: string) => (key === "userId" ? actingUserId : undefined),
    set: () => {},
    unset: () => {},
  }),
  setCurrentUserId: async () => "",
  destroySession: async () => "",
  getDevCountry: async () => null,
  setDevCountry: async () => "",
};

const BASE_URL = "http://localhost:3000";

/**
 * The route args a test builds. Real route args carry more (matches, ...),
 * but the loaders and actions under test only read `request` and `params`.
 */
export type TestRouteArgs = {
  request: Request;
  params: Record<string, string>;
  context: Record<string, never>;
};

/** A loader or action, typed with its route's generated args. */
type RouteFn<Args extends { request: Request }, Result> = (
  args: Args
) => Result;

function invoke<Args extends { request: Request }, Result>(
  fn: RouteFn<Args, Result>,
  args: TestRouteArgs
) {
  // `Args` is the route's full generated args type; the test supplies only
  // the part the route reads.
  return Promise.resolve(fn(args as unknown as Args)) as Promise<
    Awaited<Result>
  >;
}

export function callLoader<Args extends { request: Request }, Result>(
  loader: RouteFn<Args, Result>,
  path: string,
  params: Record<string, string> = {}
) {
  const request = new Request(new URL(path, BASE_URL));
  return invoke(loader, { request, params, context: {} });
}

export function callAction<Args extends { request: Request }, Result>(
  action: RouteFn<Args, Result>,
  path: string,
  form: Record<string, string>,
  params: Record<string, string> = {}
) {
  const request = new Request(new URL(path, BASE_URL), {
    method: "POST",
    body: new URLSearchParams(form),
  });
  return invoke(action, { request, params, context: {} });
}

/**
 * Resolves to the HTTP status a route threw (`throw data(..., { status })`,
 * `throw redirect(...)` or a thrown `Response`). Fails if nothing was thrown.
 */
export async function rejectionStatus(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Response) return error.status;
    if (error && typeof error === "object" && "init" in error) {
      const init = (error as { init?: { status?: number } }).init;
      return init?.status ?? 200;
    }
    throw error;
  }
  throw new Error("Expected the route to throw, but it returned normally.");
}
