import { and, desc, eq, sql } from "drizzle-orm";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { db, UPLOAD_DIR } from "./db";
import { accounts, asks, needVotes, sessions } from "./schema";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CAP_CENTS = 50000; // $500 rolling total per asker per 30 days
const MIN_AMOUNT_CENTS = 500; // $5
const MAX_AMOUNT_CENTS = 50000; // $500
// A claim with no payment proof unlocks after about a day so someone else
// can try (agreed Fix 2). A proof the asker never acts on unlocks after
// 7 days, so a forgotten proof cannot lock an ask forever.
const CLAIM_PROOF_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROOF_STALE_MS = 7 * 24 * 60 * 60 * 1000;
// Board review token (env BOARD_TOKEN on Render). Without it the review
// endpoints stay closed — the board cannot vote until it is set.
const BOARD_TOKEN = process.env.BOARD_TOKEN || "";
const BOARD_VOTERS = ["darin", "maya", "milo"] as const;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
const UPLOAD_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

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

function boardToken(req: Request): string | null {
  const h = req.headers.get("x-board-token");
  return h && h.trim() ? h.trim() : null;
}

function requireBoard(req: Request): Response | null {
  if (!BOARD_TOKEN) {
    return err("Board review is not set up yet.", 503);
  }
  if (boardToken(req) !== BOARD_TOKEN) {
    return err("Board token required.", 401);
  }
  return null;
}

// Lazy maintenance, run on reads so no background job is needed:
// - a locked ask with no payment proof unlocks after about a day;
// - a proof the asker never acts on unlocks after 7 days;
// - an open ask older than 30 days expires off the board.
async function releaseStaleClaims(): Promise<void> {
  const t = now();
  await db
    .update(asks)
    .set({
      claimedAt: null,
      claimedByDevice: null,
      proofConfirmation: null,
      proofReceiptPath: null,
      proofSubmittedAt: null,
      status: "open",
    })
    .where(
      and(
        eq(asks.status, "locked"),
        sql`${asks.proofSubmittedAt} IS NULL`,
        sql`${asks.claimedAt} < ${t - CLAIM_PROOF_WINDOW_MS}`,
      ),
    );
  await db
    .update(asks)
    .set({
      claimedAt: null,
      claimedByDevice: null,
      proofConfirmation: null,
      proofReceiptPath: null,
      proofSubmittedAt: null,
      status: "open",
    })
    .where(
      and(
        eq(asks.status, "locked"),
        sql`${asks.proofSubmittedAt} IS NOT NULL`,
        sql`${asks.proofSubmittedAt} < ${t - PROOF_STALE_MS}`,
      ),
    );
}

async function expireOldAsks(): Promise<void> {
  await db
    .update(asks)
    .set({ status: "expired" })
    .where(
      and(
        eq(asks.status, "open"),
        sql`${asks.createdAt} < ${now() - THIRTY_DAYS_MS}`,
      ),
    );
}

// Store an uploaded image under the uploads dir. Returns the stored
// relative filename, or null when there is no file. Throws on bad type
// or oversize.
async function saveUpload(file: unknown): Promise<string | null> {
  if (!file || typeof file !== "object") return null;
  const f = file as File;
  if (typeof f.arrayBuffer !== "function" || !f.name) return null;
  const ext = extname(f.name).toLowerCase();
  if (!UPLOAD_TYPES[ext]) {
    throw new Error("Only image files (JPG, PNG, WebP, GIF) can be uploaded.");
  }
  if (f.size > MAX_UPLOAD_BYTES) {
    throw new Error("That image is too big — 5 MB max.");
  }
  const name = `${crypto.randomUUID()}${ext}`;
  const bytes = new Uint8Array(await f.arrayBuffer());
  writeFileSync(join(UPLOAD_DIR, name), bytes);
  return name;
}

function uploadContentType(name: string): string {
  return UPLOAD_TYPES[extname(name).toLowerCase()] || "application/octet-stream";
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
    needVerified: row.needVerified === 1,
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
    giftCardCode: row.giftCardCode,
    hasReceipt: !!row.proofReceiptPath,
    id: row.id,
    metAt: row.metAt,
    needProofStatus: row.needProofStatus,
    needVerified: row.needVerified === 1,
    payee: row.payee,
    proofConfirmation: row.proofConfirmation,
    proofSubmittedAt: row.proofSubmittedAt,
    removedAt: row.removedAt,
    removedReason: row.removedReason,
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
    await releaseStaleClaims();
    await expireOldAsks();
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
    await releaseStaleClaims();
    await expireOldAsks();
    // Accepts JSON, or multipart when the asker attaches a bill photo
    // (optional, board-only) as the `needProof` file field.
    let body: Record<string, unknown> = {};
    let needProofPath: string | null = null;
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      try {
        const form = await req.formData();
        for (const [k, v] of form.entries()) {
          if (typeof v === "string") body[k] = v;
        }
        needProofPath = await saveUpload(form.get("needProof"));
      } catch (e: any) {
        return err(e?.message || "Could not read the ask.", 400);
      }
    } else {
      body = await parseBody(req);
    }
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
          needProofPath,
          needProofStatus: needProofPath ? "pending" : "none",
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

  const askIdMatch = path.match(/^\/api\/asks\/(\d+)\/(withdraw|claim|submit-proof|confirm-paid|reject-proof|release)$/);
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
      await releaseStaleClaims();
      await expireOldAsks();
      // No self-claims (agreed Fix 3): the system quietly knows who owns
      // an ask. A signed-in asker claiming their own ask just hears the
      // ask isn't available — no names, no explanation.
      const account = await authedAccount(req);
      const claimed = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(asks)
          .where(eq(asks.id, askId))
          .limit(1);
        if (!row) return { error: "Ask not found.", status: 404 };
        if (account && row.accountId === account.id) {
          return { error: "This ask isn't available.", status: 403 };
        }
        if (row.status !== "open") {
          return {
            error: "This ask is no longer open — someone else may have claimed it.",
            status: 409,
          };
        }
        // $500 rolling cap, checked at claim time too (board ruling Nov 13,
        // 2026): the cap was only enforced at creation, so two open asks
        // from one account could both be claimed and met for over $500.
        // A claim that would push the asker over the cap is blocked.
        const cutoff = now() - THIRTY_DAYS_MS;
        const usedRows = await tx
          .select({
            total: sql<number>`coalesce(sum(${asks.amountCents}), 0)`,
          })
          .from(asks)
          .where(
            and(
              eq(asks.accountId, row.accountId),
              sql`(
                (${asks.status} = 'met' AND ${asks.metAt} >= ${cutoff})
                OR (${asks.status} = 'locked' AND ${asks.claimedAt} >= ${cutoff})
              )`,
            ),
          );
        const used = usedRows[0]?.total ?? 0;
        if (used + row.amountCents > CAP_CENTS) {
          return {
            error:
              "This ask can't be claimed right now — it would put the asker over the $500 limit for the last 30 days.",
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

    // Proof of payment (agreed Fix 2): the giver submits the payment's
    // confirmation number and, optionally, a receipt image. No more
    // one-click "I paid it" — a claim without proof unlocks after about
    // a day, and only the asker can mark the ask met, after checking the
    // confirmation number with the payee.
    if (method === "POST" && action === "submit-proof") {
      const device = deviceToken(req);
      if (!device) return err("This device could not be identified.", 400);
      await releaseStaleClaims();
      const [row] = await db
        .select()
        .from(asks)
        .where(eq(asks.id, askId))
        .limit(1);
      if (!row) return err("Ask not found.", 404);
      if (row.status !== "locked" || row.claimedByDevice !== device) {
        return err("This ask is not claimed by this device.", 403);
      }
      if (row.proofConfirmation) {
        return err("Payment proof is already submitted for this ask.", 409);
      }
      let confirmation = "";
      let giftCard = "";
      let receiptPath: string | null = null;
      const contentType = req.headers.get("content-type") || "";
      try {
        if (contentType.includes("multipart/form-data")) {
          const form = await req.formData();
          const c = form.get("confirmation");
          confirmation = typeof c === "string" ? c.trim() : "";
          const g = form.get("giftCard");
          giftCard = typeof g === "string" ? g.trim() : "";
          receiptPath = await saveUpload(form.get("receipt"));
        } else {
          const body = await parseBody(req);
          confirmation =
            typeof body.confirmation === "string"
              ? body.confirmation.trim()
              : "";
          giftCard =
            typeof body.giftCard === "string" ? body.giftCard.trim() : "";
        }
      } catch (e: any) {
        return err(e?.message || "Could not read the proof.", 400);
      }
      if (!confirmation || confirmation.length < 3 || confirmation.length > 64) {
        return err(
          "Add the payment confirmation number from the payee — the asker checks it with them.",
          400,
        );
      }
      if (giftCard && giftCard.length > 64) {
        return err("The gift card code must be 64 characters or fewer.", 400);
      }
      await db
        .update(asks)
        .set({
          giftCardCode: giftCard || null,
          proofConfirmation: confirmation,
          proofReceiptPath: receiptPath,
          proofSubmittedAt: now(),
        })
        .where(eq(asks.id, askId));
      return json({ ok: true });
    }

    // The ASKER confirms the payment cleared, after checking the
    // confirmation number with the payee. This is the only way an ask
    // becomes met now.
    if (method === "POST" && action === "confirm-paid") {
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
      if (row.status !== "locked" || !row.proofConfirmation) {
        return err(
          "There is no payment proof to confirm yet — the giver sends the confirmation number first.",
          409,
        );
      }
      await db
        .update(asks)
        .set({ metAt: now(), status: "met" })
        .where(eq(asks.id, askId));
      return json({ ok: true });
    }

    // The asker says the proof did not clear with the payee: the ask
    // goes back on the board for someone else, and the proof is cleared.
    if (method === "POST" && action === "reject-proof") {
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
      if (row.status !== "locked" || !row.proofConfirmation) {
        return err("There is no payment proof to reject.", 409);
      }
      await db
        .update(asks)
        .set({
          claimedAt: null,
          claimedByDevice: null,
          giftCardCode: null,
          proofConfirmation: null,
          proofReceiptPath: null,
          proofSubmittedAt: null,
          status: "open",
        })
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
    await releaseStaleClaims();
    await expireOldAsks();
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
        hasReceipt: !!row.proofReceiptPath,
        id: row.id,
        metAt: row.metAt,
        payee: row.payee,
        proofConfirmation: row.proofConfirmation,
        proofSubmittedAt: row.proofSubmittedAt,
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

  // -- Proof images: served only to someone entitled to see them --------
  const receiptMatch = path.match(/^\/api\/asks\/(\d+)\/receipt$/);
  if (method === "GET" && receiptMatch) {
    const askId = Number(receiptMatch[1]);
    const [row] = await db
      .select()
      .from(asks)
      .where(eq(asks.id, askId))
      .limit(1);
    if (!row || !row.proofReceiptPath) return err("Not found.", 404);
    const account = await authedAccount(req);
    const device = deviceToken(req);
    const isAsker = account && account.id === row.accountId;
    const isGiver = device && row.claimedByDevice === device;
    const isBoard = BOARD_TOKEN && boardToken(req) === BOARD_TOKEN;
    if (!isAsker && !isGiver && !isBoard) {
      return err("Not found.", 404);
    }
    const filePath = join(UPLOAD_DIR, row.proofReceiptPath);
    if (!existsSync(filePath)) return err("Not found.", 404);
    return new Response(readFileSync(filePath), {
      headers: { "Content-Type": uploadContentType(row.proofReceiptPath) },
    });
  }

  const needProofMatch = path.match(/^\/api\/asks\/(\d+)\/need-proof$/);
  if (method === "GET" && needProofMatch) {
    const askId = Number(needProofMatch[1]);
    const [row] = await db
      .select()
      .from(asks)
      .where(eq(asks.id, askId))
      .limit(1);
    if (!row || !row.needProofPath) return err("Not found.", 404);
    const account = await authedAccount(req);
    const isAsker = account && account.id === row.accountId;
    const isBoard = BOARD_TOKEN && boardToken(req) === BOARD_TOKEN;
    if (!isAsker && !isBoard) {
      return err("Not found.", 404);
    }
    const filePath = join(UPLOAD_DIR, row.needProofPath);
    if (!existsSync(filePath)) return err("Not found.", 404);
    return new Response(readFileSync(filePath), {
      headers: { "Content-Type": uploadContentType(row.needProofPath) },
    });
  }

  // -- Board review: verified need (agreed Fix 1) --------------------------
  // The board is Darin + Maya + Milo. All three vote on each attached bill
  // proof: amount matches, no personal info visible, allowed bill type.
  // All three approvals set the verified-need flag; any rejection rejects.
  if (method === "GET" && path === "/api/board/review") {
    const denied = requireBoard(req);
    if (denied) return denied;
    const rows = await db
      .select()
      .from(asks)
      .where(eq(asks.needProofStatus, "pending"))
      .orderBy(desc(asks.createdAt));
    const out = [];
    for (const row of rows) {
      const votes = await db
        .select()
        .from(needVotes)
        .where(eq(needVotes.askId, row.id));
      out.push({
        amount: dollars(row.amountCents),
        category: row.category,
        createdAt: row.createdAt,
        id: row.id,
        needProofStatus: row.needProofStatus,
        needVerified: row.needVerified === 1,
        payee: row.payee,
        state: row.state,
        votes: votes.map((v) => ({ vote: v.vote, voter: v.voter })),
      });
    }
    return json({ asks: out });
  }

  const voteMatch = path.match(/^\/api\/board\/review\/(\d+)\/vote$/);
  if (method === "POST" && voteMatch) {
    const denied = requireBoard(req);
    if (denied) return denied;
    const askId = Number(voteMatch[1]);
    const body = await parseBody(req);
    const voter = typeof body.voter === "string" ? body.voter : "";
    const vote = typeof body.vote === "string" ? body.vote : "";
    if (!(BOARD_VOTERS as readonly string[]).includes(voter)) {
      return err("Voter must be darin, maya, or milo.", 400);
    }
    if (vote !== "approve" && vote !== "reject") {
      return err("Vote must be approve or reject.", 400);
    }
    const [row] = await db
      .select()
      .from(asks)
      .where(eq(asks.id, askId))
      .limit(1);
    if (!row) return err("Ask not found.", 404);
    if (row.needProofStatus !== "pending") {
      return err("This proof is no longer awaiting review.", 409);
    }
    await db
      .insert(needVotes)
      .values({ askId, createdAt: now(), vote, voter })
      .onConflictDoUpdate({
        set: { createdAt: now(), vote },
        target: [needVotes.askId, needVotes.voter],
      });
    const votes = await db
      .select()
      .from(needVotes)
      .where(eq(needVotes.askId, askId));
    const approvals = votes.filter((v) => v.vote === "approve").length;
    const rejections = votes.filter((v) => v.vote === "reject").length;
    if (rejections > 0) {
      await db
        .update(asks)
        .set({ needProofStatus: "rejected" })
        .where(eq(asks.id, askId));
    } else if (approvals >= BOARD_VOTERS.length) {
      await db
        .update(asks)
        .set({ needProofStatus: "verified", needVerified: 1 })
        .where(eq(asks.id, askId));
    }
    const [updated] = await db
      .select()
      .from(asks)
      .where(eq(asks.id, askId))
      .limit(1);
    return json({
      needProofStatus: updated.needProofStatus,
      needVerified: updated.needVerified === 1,
      votes: votes.map((v) => ({ vote: v.vote, voter: v.voter })),
    });
  }

  // Board removal (Nov 13, 2026): when all three board members agree an
  // ask should come down, the board removes it with a reason. The reason
  // is stored on the ask and shown to the asker on their own page next
  // time they log in, with how to ask correctly — so a genuine asker
  // learns instead of wondering where their ask went. Only open asks can
  // be removed: a locked ask has a giver who may be paying right now, and
  // a met ask is already paid.
  const removeMatch = path.match(/^\/api\/board\/remove\/(\d+)$/);
  if (method === "POST" && removeMatch) {
    const denied = requireBoard(req);
    if (denied) return denied;
    const askId = Number(removeMatch[1]);
    const body = await parseBody(req);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return err("A reason is required — the asker sees it.", 400);
    }
    if (reason.length > 500) {
      return err("Reason must be 500 characters or fewer.", 400);
    }
    const [row] = await db
      .select()
      .from(asks)
      .where(eq(asks.id, askId))
      .limit(1);
    if (!row) return err("Ask not found.", 404);
    if (row.status === "removed") {
      return err("This ask is already removed.", 409);
    }
    if (row.status === "met") {
      return err("This ask is already met and cannot be removed.", 409);
    }
    if (row.status === "locked") {
      return err(
        "This ask is claimed right now — a giver may be paying it. Remove it once it is back on the board.",
        409,
      );
    }
    if (row.status !== "open") {
      return err("This ask can no longer be removed.", 409);
    }
    const removedAt = now();
    await db
      .update(asks)
      .set({ removedAt, removedReason: reason, status: "removed" })
      .where(eq(asks.id, askId));
    return json({
      ask: ownAsk({ ...row, removedAt, removedReason: reason, status: "removed" }),
    });
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
