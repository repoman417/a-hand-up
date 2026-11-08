// End-to-end checks for A Hand Up.
// Run against a booted server on a throwaway database:
//   rm -f /tmp/test-app.db
//   DATABASE_PATH=/tmp/test-app.db bun run dev
//   TEST_DB=/tmp/test-app.db BASE_URL=http://localhost:3000 bun run test
//
// Uses fake bill account numbers only — never a real one.

import { Database } from "bun:sqlite";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const TEST_DB = process.env.TEST_DB || "";
const D1 = "device-giver-one";
const D2 = "device-giver-two";
const D3 = "device-giver-three";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function req(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; device?: string } = {},
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.device) headers["X-Device-Token"] = opts.device;
  const res = await fetch(`${BASE}${path}`, {
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers,
    method: opts.method || "GET",
  });
  const data = await res.json().catch(() => ({}));
  return { data, status: res.status };
}

const DAY = 24 * 60 * 60 * 1000;

// 1 — proof strip starts at zero.
let r = await req("/api/proof");
check("proof strip zero state", r.data.metCount === 0 && r.data.totalDollars === 0);

// 2 — create an anonymous asker account; internal number starts at 1001.
r = await req("/api/accounts", {
  body: { handle: "testasker", password: "testpass123" },
  method: "POST",
});
check(
  "create account returns No. 1001 + token",
  r.status === 201 && r.data.internalNumber === 1001 && !!r.data.token,
  JSON.stringify(r.data),
);
const token = r.data.token as string;

// 3 — wrong password fails.
r = await req("/api/accounts/login", {
  body: { handle: "testasker", password: "wrongpassword" },
  method: "POST",
});
check("wrong-password login fails", r.status === 401, `status=${r.status}`);

// 4 — post ask A: $300 lights.
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-UTIL-001",
    amount: 300,
    category: "Utility bill",
    cutoffDate: "2026-11-18",
    dueDate: "2026-11-10",
    payee: "Test City Utilities",
    state: "Missouri",
  },
  method: "POST",
  token,
});
check("post ask A ($300) succeeds", r.status === 201 && r.data.ask?.status === "open", JSON.stringify(r.data));
const askA = r.data.ask?.id as number;

// 5 — public board payload never contains the account number or handle.
r = await req("/api/board");
const boardJson = JSON.stringify(r.data);
check(
  "public board has 1 open ask",
  Array.isArray(r.data.asks) && r.data.asks.length === 1,
  JSON.stringify(r.data),
);
check(
  "public board payload hides account number + handle",
  !boardJson.includes("TEST-UTIL-001") && !boardJson.includes("testasker"),
);
check(
  "board ask shows First time asking badge",
  r.data.asks?.[0]?.helpedLabel === "First time asking",
  JSON.stringify(r.data.asks?.[0]),
);

// 6 — claim as giver: the claim response DOES include the account number.
r = await req(`/api/asks/${askA}/claim`, { device: D1, method: "POST" });
check(
  "claim locks ask and reveals account number to giver",
  r.status === 200 && r.data.ask?.accountNumber === "TEST-UTIL-001",
  JSON.stringify(r.data),
);

// 7 — locked ask leaves the open board.
r = await req("/api/board");
check("locked ask leaves the board", Array.isArray(r.data.asks) && r.data.asks.length === 0);

// 8 — confirm paid.
r = await req(`/api/asks/${askA}/confirm-paid`, { device: D1, method: "POST" });
check("confirm paid succeeds", r.status === 200, `status=${r.status}`);

// 9 — proof strip counts it: 1 met, $300, state-only line.
r = await req("/api/proof");
check(
  "proof strip counts 1 met / $300",
  r.data.metCount === 1 && r.data.totalDollars === 300,
  JSON.stringify(r.data),
);
check(
  "proof recent line is state-only",
  r.data.recent?.[0]?.label === "Utility bill in Missouri" &&
    !JSON.stringify(r.data.recent).includes("TEST-UTIL-001"),
  JSON.stringify(r.data.recent),
);

// 10 — re-posting the same bill within 30 days is rejected.
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-UTIL-001",
    amount: 50,
    category: "Utility bill",
    payee: "Test City Utilities",
    state: "Missouri",
  },
  method: "POST",
  token,
});
check(
  "re-posting same bill rejected (per-bill 30-day)",
  r.status === 409 && /30 days/.test(r.data.error || ""),
  JSON.stringify(r.data),
);

// 11 — $300 met leaves $200: a $200 ask fits exactly.
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-GAS-002",
    amount: 200,
    category: "Utility bill",
    payee: "Test Gas Company",
    state: "Missouri",
  },
  method: "POST",
  token,
});
check("post ask B ($200) succeeds — $300 + $200 = $500 cap", r.status === 201, JSON.stringify(r.data));
const askB = r.data.ask?.id as number;

// 12 — locking B uses the rest of the cap: a $5 ask is rejected.
r = await req(`/api/asks/${askB}/claim`, { device: D2, method: "POST" });
check("claim ask B succeeds", r.status === 200, `status=${r.status}`);
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-OTHER-003",
    amount: 5,
    category: "Groceries",
    payee: "Test Grocery",
    state: "Missouri",
  },
  method: "POST",
  token,
});
check(
  "$500 rolling cap rejects a $5 ask while $200 is locked",
  r.status === 409 && /\$500/.test(r.data.error || ""),
  JSON.stringify(r.data),
);

// 13 — releasing B frees the cap; a $5 ask fits; withdraw works.
r = await req(`/api/asks/${askB}/release`, { device: D2, method: "POST" });
check("release ask B succeeds", r.status === 200, `status=${r.status}`);
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-OTHER-003",
    amount: 5,
    category: "Groceries",
    payee: "Test Grocery",
    state: "Missouri",
  },
  method: "POST",
  token,
});
check("post ask C ($5) succeeds after release", r.status === 201, JSON.stringify(r.data));
const askC = r.data.ask?.id as number;
r = await req(`/api/asks/${askC}/withdraw`, { method: "POST", token });
check("asker can withdraw their own open ask", r.status === 200, `status=${r.status}`);

// 14 — wrong device cannot confirm; the claiming device can.
r = await req(`/api/asks/${askB}/claim`, { device: D2, method: "POST" });
check("re-claim ask B succeeds", r.status === 200, `status=${r.status}`);
r = await req(`/api/asks/${askB}/confirm-paid`, { device: D3, method: "POST" });
check("wrong device cannot confirm paid", r.status === 403, `status=${r.status}`);
r = await req(`/api/asks/${askB}/confirm-paid`, { device: D2, method: "POST" });
check("claiming device confirms paid", r.status === 200, `status=${r.status}`);

// 15 — proof strip now: 2 met, $500.
r = await req("/api/proof");
check(
  "proof strip counts 2 met / $500",
  r.data.metCount === 2 && r.data.totalDollars === 500,
  JSON.stringify(r.data),
);

// 15b — account summary: $500 used, $0 left.
r = await req("/api/accounts/me", { token });
check(
  "account summary shows $500 used / $0 left",
  r.data.usedCents === 50000 && r.data.remainingCents === 0,
  JSON.stringify(r.data),
);

// 16 — help-count badge + cooldown expiry: seed a met ask from 40 days ago
// for a bill, then a second account posts on that bill. The badge must read
// "Helped 1 time before".
if (!TEST_DB) {
  console.log("SKIP  badge/cooldown-expiry checks (TEST_DB not set)");
} else {
  const sqlite = new Database(TEST_DB);
  const old = Date.now() - 40 * DAY;
  let seeded = false;
  for (let attempt = 0; attempt < 10 && !seeded; attempt++) {
    try {
      sqlite
        .query(
          `INSERT INTO asks (account_id, payee, category, amount_cents, account_number, state, status, created_at, met_at)
           VALUES (1, 'Old Test Utility', 'Utility bill', 5000, 'TEST-OLD-001', 'Missouri', 'met', ?, ?)`,
        )
        .run(old, old);
      seeded = true;
    } catch {
      await new Promise((res) => setTimeout(res, 200));
    }
  }
  check("seed old met ask (40 days ago)", seeded);

  r = await req("/api/accounts", {
    body: { handle: "testasker2", password: "testpass123" },
    method: "POST",
  });
  const token2 = r.data.token as string;
  check("create second account", r.status === 201 && !!token2, JSON.stringify(r.data));

  r = await req("/api/asks", {
    body: {
      accountNumber: "TEST-OLD-001",
      amount: 50,
      category: "Utility bill",
      payee: "Old Test Utility",
      state: "Missouri",
    },
    method: "POST",
    token: token2,
  });
  check(
    "re-post after 30-day cooldown succeeds",
    r.status === 201,
    JSON.stringify(r.data),
  );
  const askD = r.data.ask?.id as number;

  r = await req("/api/board");
  const d = (r.data.asks || []).find((a: any) => a.id === askD);
  check(
    "help-count badge reads Helped 1 time before",
    d?.helpedCount === 1 && d?.helpedLabel === "Helped 1 time before",
    JSON.stringify(d),
  );
}

// 17 — Yours page: each giver device sees the asks it claimed, as met.
r = await req("/api/yours", { device: D1 });
const claimedD1 = (r.data.claimed || []).map((a: any) => a.id);
check(
  "yours (giver 1) shows ask A as met",
  claimedD1.includes(askA),
  JSON.stringify(r.data.claimed),
);
r = await req("/api/yours", { device: D2 });
const claimedD2 = (r.data.claimed || []).map((a: any) => a.id);
check(
  "yours (giver 2) shows ask B as met",
  claimedD2.includes(askB),
  JSON.stringify(r.data.claimed),
);

// 18 — own asks list.
r = await req("/api/asks/mine", { token });
const mine = (r.data.asks || []).map((a: any) => `${a.id}:${a.status}`);
check(
  "own asks list shows A met, B met, C withdrawn",
  mine.includes(`${askA}:met`) &&
    mine.includes(`${askB}:met`) &&
    mine.includes(`${askC}:withdrawn`),
  JSON.stringify(mine),
);

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log("Failures:", failures.join("; "));
  process.exit(1);
}
