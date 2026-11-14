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

// Route args carry more than tests care about (context, matches, ...); the
// loaders and actions here only read `request` and `params`.
type RouteFn = (args: any) => unknown;

export function callLoader<F extends RouteFn>(
  loader: F,
  path: string,
  params: Record<string, string> = {}
) {
  const request = new Request(new URL(path, BASE_URL));
  return Promise.resolve(
    loader({ request, params, context: {} } as Parameters<F>[0])
  ) as Promise<Awaited<ReturnType<F>>>;
}

export function callAction<F extends RouteFn>(
  action: F,
  path: string,
  form: Record<string, string>,
  params: Record<string, string> = {}
) {
  const request = new Request(new URL(path, BASE_URL), {
    method: "POST",
    body: new URLSearchParams(form),
  });
  return Promise.resolve(
    action({ request, params, context: {} } as Parameters<F>[0])
  ) as Promise<Awaited<ReturnType<F>>>;
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
