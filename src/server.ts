import { and, desc, eq, sql } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db";
import { accounts, asks, sessions } from "./schema";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CAP_CENTS = 50000; // $500 rolling total per asker per 30 days
const MIN_AMOUNT_CENTS = 500; // $5
const MAX_AMOUNT_CENTS = 50000; // $500

export const CATEGORIES = [
  "Utility bill",
  "Groceries",
  "Part or repair",
  "Rent",
  "Medical",
  "Other",
] as const;

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "District of Columbia", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
  "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota",
  "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
  "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = () => Date.now();

function dollars(cents: number): number {
  return Math.round(cents) / 100;
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  })}`;
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

function deviceToken(req: Request): string | null {
  const h = req.headers.get("x-device-token");
  return h && h.trim() ? h.trim() : null;
}

async function authedAccount(req: Request) {
  const token = bearerToken(req);
  if (!token) return null;
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.token, token))
    .limit(1);
  if (!session) return null;
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, session.accountId))
    .limit(1);
  return account ?? null;
}

// How many times this bill account number has had an ask met (all time).
async function helpedCount(accountNumber: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(asks)
    .where(
      and(
        eq(asks.accountNumber, accountNumber),
        eq(asks.status, "met"),
      ),
    );
  return rows[0]?.n ?? 0;
}

function helpedLabel(count: number): string {
  if (count === 0) return "First time asking";
  if (count === 1) return "Helped 1 time before";
  return `Helped ${count} times before`;
}

// Rolling $500 usage for an asker: met asks (last 30 days) + locked asks.
async function rollingUsedCents(accountId: number): Promise<number> {
  const cutoff = now() - THIRTY_DAYS_MS;
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${asks.amountCents}), 0)` })
    .from(asks)
    .where(
      and(
        eq(asks.accountId, accountId),
        sql`(
          (${asks.status} = 'met' AND ${asks.metAt} >= ${cutoff})
          OR (${asks.status} = 'locked' AND ${asks.claimedAt} >= ${cutoff})
        )`,
      ),
    );
  return rows[0]?.total ?? 0;
}

// Public shape of an open ask. The bill account number, the asker's handle
// and internal number, and the account id NEVER appear here.
async function publicAsk(row: typeof asks.$inferSelect) {
  const count = await helpedCount(row.accountNumber);
  return {
    amount: dollars(row.amountCents),
    category: row.category,
    createdAt: row.createdAt,
    cutoffDate: row.cutoffDate,
    dueDate: row.dueDate,
    helpedCount: count,
    helpedLabel: helpedLabel(count),
    id: row.id,
    payee: row.payee,
    state: row.state,
  };
}

function ownAsk(row: typeof asks.$inferSelect) {
  return {
    accountNumber: row.accountNumber,
    amount: dollars(row.amountCents),
    category: row.category,
    createdAt: row.createdAt,
    cutoffDate: row.cutoffDate,
    dueDate: row.dueDate,
    id: row.id,
    metAt: row.metAt,
    payee: row.payee,
    state: row.state,
    status: row.status,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Static assets (built by `bun run build` into ./public)
// ---------------------------------------------------------------------------

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
let indexHtml: string | null = null;
let appJs: string | null = null;
if (existsSync(join(PUBLIC_DIR, "index.html"))) {
  indexHtml = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
}
if (existsSync(join(PUBLIC_DIR, "app.js"))) {
  appJs = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // -- Static ---------------------------------------------------------------
  if (method === "GET" && path === "/") {
    if (!indexHtml) {
      return new Response("App not built yet — run `bun run build`.", {
        status: 500,
      });
    }
    return new Response(indexHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }
  if (method === "GET" && path === "/app.js") {
    if (!appJs) {
      return new Response("App not built yet — run `bun run build`.", {
        status: 500,
      });
    }
    return new Response(appJs, {
      headers: { "Content-Type": "application/javascript" },
    });
  }

  // -- Health ---------------------------------------------------------------
  if (method === "GET" && path === "/api/health") {
    return json({ ok: true });
  }

  // -- Public board ---------------------------------------------------------
  if (method === "GET" && path === "/api/board") {
    const rows = await db
      .select()
      .from(asks)
      .where(eq(asks.status, "open"))
      .orderBy(desc(asks.createdAt));
    const out = [];
    for (const row of rows) out.push(await publicAsk(row));
    return json({ asks: out });
  }

  // -- Public proof strip ----------------------------------------------------
  if (method === "GET" && path === "/api/proof") {
    const totals = await db
      .select({
        count: sql<number>`count(*)`,
        total: sql<number>`coalesce(sum(${asks.amountCents}), 0)`,
      })
      .from(asks)
      .where(eq(asks.status, "met"));
    const metCount = totals[0]?.count ?? 0;
    const totalCents = totals[0]?.total ?? 0;
    const recentRows = await db
      .select()
      .from(asks)
      .where(eq(asks.status, "met"))
      .orderBy(desc(asks.metAt))
      .limit(5);
    const recent = recentRows.map((row) => ({
      amount: dollars(row.amountCents),
      // State only — never town, name, handle, internal number, or account
      // number.
      label: `${row.category} in ${row.state}`,
      paidAgo: row.metAt ? relativeTime(row.metAt) : "",
    }));
    return json({
      metCount,
      recent,
      totalDollars: dollars(totalCents),
    });
  }

  // -- Accounts --------------------------------------------------------------
  if (method === "POST" && path === "/api/accounts") {
    const body = await parseBody(req);
    const handle =
      typeof body.handle === "string" ? body.handle.trim() : "";
    const password =
      typeof body.password === "string" ? body.password : "";
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(handle)) {
      return err(
        "Pick a handle of 3–30 letters, numbers, dots, dashes or underscores.",
      );
    }
    if (password.length < 6) {
      return err("Password needs at least 6 characters.");
    }
    const taken = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`lower(${accounts.handle}) = ${handle.toLowerCase()}`)
      .limit(1);
    if (taken.length > 0) {
      return err("That handle is already taken. Pick another one.", 409);
    }
    const maxRow = await db
      .select({ m: sql<number>`coalesce(max(${accounts.internalNumber}), 1000)` })
      .from(accounts);
    const internalNumber = (maxRow[0]?.m ?? 1000) + 1;
    const passwordHash = await Bun.password.hash(password, {
      algorithm: "bcrypt",
      cost: 10,
    });
    const [created] = await db
      .insert(accounts)
      .values({ createdAt: now(), handle, internalNumber, passwordHash })
      .returning();
    const token = crypto.randomUUID();
    await db
      .insert(sessions)
      .values({ accountId: created.id, createdAt: now(), token });
    return json(
      { handle: created.handle, internalNumber, token },
      201,
    );
  }

  if (method === "POST" && path === "/api/accounts/login") {
    const body = await parseBody(req);
    const handle =
      typeof body.handle === "string" ? body.handle.trim() : "";
    const password =
      typeof body.password === "string" ? body.password : "";
    const [account] = await db
      .select()
      .from(accounts)
      .where(sql`lower(${accounts.handle}) = ${handle.toLowerCase()}`)
      .limit(1);
    if (!account) return err("Wrong handle or password.", 401);
    const ok = await Bun.password.verify(password, account.passwordHash);
    if (!ok) return err("Wrong handle or password.", 401);
    const token = crypto.randomUUID();
    await db
      .insert(sessions)
      .values({ accountId: account.id, createdAt: now(), token });
    return json({
      handle: account.handle,
      internalNumber: account.internalNumber,
      token,
    });
  }

  if (method === "POST" && path === "/api/accounts/logout") {
    const token = bearerToken(req);
    if (token) {
      await db.delete(sessions).where(eq(sessions.token, token));
    }
    return json({ ok: true });
  }

  if (method === "GET" && path === "/api/accounts/me") {
    const account = await authedAccount(req);
    if (!account) return err("Sign in first.", 401);
    const used = await rollingUsedCents(account.id);
    const metRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(asks)
      .where(and(eq(asks.accountId, account.id), eq(asks.status, "met")));
    return json({
      handle: account.handle,
      helpedCount: metRows[0]?.n ?? 0,
      internalNumber: account.internalNumber,
      remainingCents: CAP_CENTS - used,
      usedCents: used,
    });
  }

  // -- Asks ------------------------------------------------------------------
  if (method === "POST" && path === "/api/asks") {
    const account = await authedAccount(req);
    if (!account) return err("Sign in first.", 401);
    const body = await parseBody(req);
    const payee = typeof body.payee === "string" ? body.payee.trim() : "";
    const category =
      typeof body.category === "string" ? body.category : "";
    const accountNumber =
      typeof body.accountNumber === "string"
        ? body.accountNumber.trim()
        : "";
    const state = typeof body.state === "string" ? body.state : "";
    const dueDate =
      typeof body.dueDate === "string" && body.dueDate ? body.dueDate : null;
    const cutoffDate =
      typeof body.cutoffDate === "string" && body.cutoffDate
        ? body.cutoffDate
        : null;
    const amount =
      typeof body.amount === "number" ? body.amount : Number(body.amount);

    if (!payee || payee.length > 120) {
      return err("Name the place to pay (the payee).");
    }
    if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
      return err("Pick what kind of ask this is.");
    }
    if (!Number.isFinite(amount) || amount < 5 || amount > 500) {
      return err("Amount must be between $5 and $500.");
    }
    if (!accountNumber || accountNumber.length > 64) {
      return err("The bill account number is required.");
    }
    if (!US_STATES.includes(state)) {
      return err("Pick the state the bill is in.");
    }
    if (dueDate && !DATE_RE.test(dueDate)) {
      return err("Due date must be a date.");
    }
    if (cutoffDate && !DATE_RE.test(cutoffDate)) {
      return err("Cutoff date must be a date.");
    }
    const amountCents = Math.round(amount * 100);

    // All limit checks and the insert happen in one transaction.
    const result = await db.transaction(async (tx) => {
      const cutoff = now() - THIRTY_DAYS_MS;

      // One met ask per bill account number per 30 days.
      const metRows = await tx
        .select()
        .from(asks)
        .where(
          and(
            eq(asks.accountNumber, accountNumber),
            eq(asks.status, "met"),
          ),
        )
        .orderBy(desc(asks.metAt))
        .limit(1);
      const lastMet = metRows[0];
      if (lastMet?.metAt && lastMet.metAt >= cutoff) {
        const again = new Date(lastMet.metAt + THIRTY_DAYS_MS);
        return {
          error: `This bill already had an ask met in the last 30 days. One met ask per bill account number per 30 days — you can post it again after ${again.toLocaleDateString("en-US")}.`,
          status: 409,
        };
      }

      // One open ask per bill at a time.
      const openRows = await tx
        .select({ id: asks.id })
        .from(asks)
        .where(
          and(
            eq(asks.accountNumber, accountNumber),
            sql`${asks.status} IN ('open', 'locked')`,
          ),
        )
        .limit(1);
      if (openRows.length > 0) {
        return {
          error:
            "There is already an open ask for this bill account number. One ask per bill at a time.",
          status: 409,
        };
      }

      // $500 rolling total per asker per 30 days (met + locked).
      const usedRows = await tx
        .select({
          total: sql<number>`coalesce(sum(${asks.amountCents}), 0)`,
        })
        .from(asks)
        .where(
          and(
            eq(asks.accountId, account.id),
            sql`(
              (${asks.status} = 'met' AND ${asks.metAt} >= ${cutoff})
              OR (${asks.status} = 'locked' AND ${asks.claimedAt} >= ${cutoff})
            )`,
          ),
        );
      const used = usedRows[0]?.total ?? 0;
      if (used + amountCents > CAP_CENTS) {
        const remaining = CAP_CENTS - used;
        return {
          error: `That would put you over the $500 limit for the last 30 days. You have ${formatDollars(remaining)} left — a smaller ask will fit.`,
          status: 409,
        };
      }

      const [created] = await tx
        .insert(asks)
        .values({
          accountId: account.id,
          accountNumber,
          amountCents,
          category,
          createdAt: now(),
          cutoffDate,
          dueDate,
          payee,
          state,
          status: "open",
        })
        .returning();
      return { ask: ownAsk(created), status: 201 };
    });

    if ("error" in result && result.error) {
      return err(result.error, result.status);
    }
    return json({ ask: (result as { ask: unknown }).ask }, 201);
  }

  if (method === "GET" && path === "/api/asks/mine") {
    const account = await authedAccount(req);
    if (!account) return err("Sign in first.", 401);
    const rows = await db
      .select()
      .from(asks)
      .where(eq(asks.accountId, account.id))
      .orderBy(desc(asks.createdAt));
    return json({ asks: rows.map(ownAsk) });
  }

  const askIdMatch = path.match(/^\/api\/asks\/(\d+)\/(withdraw|claim|confirm-paid|release)$/);
  if (askIdMatch) {
    const askId = Number(askIdMatch[1]);
    const action = askIdMatch[2];

    if (method === "POST" && action === "withdraw") {
      const account = await authedAccount(req);
      if (!account) return err("Sign in first.", 401);
      const [row] = await db
        .select()
        .from(asks)
        .where(eq(asks.id, askId))
        .limit(1);
      if (!row) return err("Ask not found.", 404);
      if (row.accountId !== account.id) {
        return err("That is not your ask.", 403);
      }
      if (row.status === "locked") {
        return err(
          "This ask is already claimed — a giver may be paying it right now. If they pay, it lands as a credit on the next bill. You can withdraw it once it is back on the board.",
          409,
        );
      }
      if (row.status !== "open") {
        return err("This ask can no longer be withdrawn.", 409);
      }
      await db
        .update(asks)
        .set({ status: "withdrawn" })
        .where(eq(asks.id, askId));
      return json({ ok: true });
    }

    if (method === "POST" && action === "claim") {
      const device = deviceToken(req);
      if (!device) return err("This device could not be identified.", 400);
      const claimed = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(asks)
          .where(eq(asks.id, askId))
          .limit(1);
        if (!row) return { error: "Ask not found.", status: 404 };
        if (row.status !== "open") {
          return {
            error: "This ask is no longer open — someone else may have claimed it.",
            status: 409,
          };
        }
        await tx
          .update(asks)
          .set({
            claimedAt: now(),
            claimedByDevice: device,
            status: "locked",
          })
          .where(eq(asks.id, askId));
        return { row };
      });
      if ("error" in claimed && claimed.error) {
        return err(claimed.error, claimed.status);
      }
      const row = (claimed as { row: typeof asks.$inferSelect }).row;
      // The giver sees the account number now — they need it to pay the
      // payee directly.
      return json({
        ask: {
          accountNumber: row.accountNumber,
          amount: dollars(row.amountCents),
          category: row.category,
          cutoffDate: row.cutoffDate,
          dueDate: row.dueDate,
          id: row.id,
          payee: row.payee,
          state: row.state,
        },
      });
    }

    if (method === "POST" && action === "confirm-paid") {
      const device = deviceToken(req);
      if (!device) return err("This device could not be identified.", 400);
      const [row] = await db
        .select()
        .from(asks)
        .where(eq(asks.id, askId))
        .limit(1);
      if (!row) return err("Ask not found.", 404);
      if (row.status !== "locked" || row.claimedByDevice !== device) {
        return err("This ask is not claimed by this device.", 403);
      }
      await db
        .update(asks)
        .set({ metAt: now(), status: "met" })
        .where(eq(asks.id, askId));
      return json({ ok: true });
    }

    if (method === "POST" && action === "release") {
      const device = deviceToken(req);
      if (!device) return err("This device could not be identified.", 400);
      const [row] = await db
        .select()
        .from(asks)
        .where(eq(asks.id, askId))
        .limit(1);
      if (!row) return err("Ask not found.", 404);
      if (row.status !== "locked" || row.claimedByDevice !== device) {
        return err("This ask is not claimed by this device.", 403);
      }
      await db
        .update(asks)
        .set({ claimedAt: null, claimedByDevice: null, status: "open" })
        .where(eq(asks.id, askId));
      return json({ ok: true });
    }
  }

  // -- Yours: asks this device claimed + the signed-in asker's own asks -----
  if (method === "GET" && path === "/api/yours") {
    const device = deviceToken(req);
    let claimed: unknown[] = [];
    if (device) {
      const rows = await db
        .select()
        .from(asks)
        .where(
          and(
            eq(asks.claimedByDevice, device),
            sql`${asks.status} IN ('locked', 'met')`,
          ),
        )
        .orderBy(desc(asks.createdAt));
      claimed = rows.map((row) => ({
        // Account number is shown only while the giver still needs it to
        // pay — once met, it is no longer needed here.
        accountNumber: row.status === "locked" ? row.accountNumber : null,
        amount: dollars(row.amountCents),
        category: row.category,
        cutoffDate: row.cutoffDate,
        dueDate: row.dueDate,
        id: row.id,
        metAt: row.metAt,
        payee: row.payee,
        state: row.state,
        status: row.status,
      }));
    }
    const account = await authedAccount(req);
    let mine: unknown[] = [];
    if (account) {
      const rows = await db
        .select()
        .from(asks)
        .where(eq(asks.accountId, account.id))
        .orderBy(desc(asks.createdAt));
      mine = rows.map(ownAsk);
    }
    return json({ claimed, mine });
  }

  return err("Not found.", 404);
}

Bun.serve({
  fetch: async (req) => {
    try {
      return await handle(req);
    } catch (e) {
      console.error(e);
      return err("Something went wrong on our side. Try again.", 500);
    }
  },
  hostname: "0.0.0.0",
  port: PORT,
});

console.log(`A Hand Up listening on http://localhost:${PORT}`);
console.log(`Database: ${process.env.DATABASE_PATH || "./data/app.db"}`);
