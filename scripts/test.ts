// End-to-end checks for A Hand Up.
// Run against a booted server on a throwaway database:
//   rm -f /tmp/test-app.db
//   DATABASE_PATH=/tmp/test-app.db BOARD_TOKEN=test-board-token bun run dev
//   TEST_DB=/tmp/test-app.db BOARD_TOKEN=test-board-token BASE_URL=http://localhost:3000 bun run test
//
// Uses fake bill account numbers only — never a real one.

import { Database } from "bun:sqlite";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const TEST_DB = process.env.TEST_DB || "";
const BOARD_TOKEN = process.env.BOARD_TOKEN || "";
const D1 = "device-giver-one";
const D2 = "device-giver-two";
const D3 = "device-giver-three";
const D4 = "device-giver-four";

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
  opts: { method?: string; body?: unknown; token?: string; device?: string; board?: string } = {},
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.device) headers["X-Device-Token"] = opts.device;
  if (opts.board) headers["X-Board-Token"] = opts.board;
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

// 8 — proof of payment: the giver submits the confirmation number, then
// the asker confirms it cleared. One-click "I paid it" is gone.
r = await req(`/api/asks/${askA}/submit-proof`, {
  body: { confirmation: "CONF-TEST-001" },
  device: D1,
  method: "POST",
});
check("giver submits payment proof", r.status === 200, `status=${r.status} ${JSON.stringify(r.data)}`);
r = await req(`/api/asks/${askA}/submit-proof`, {
  body: { confirmation: "CONF-FAKE-002" },
  device: D3,
  method: "POST",
});
check("wrong device cannot submit proof", r.status === 403, `status=${r.status}`);
r = await req(`/api/asks/${askA}/confirm-paid`, { method: "POST", token });
check("asker confirms payment cleared", r.status === 200, `status=${r.status}`);

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

// 14 — wrong device cannot submit proof; the claiming device can; then
// the asker confirms it cleared.
r = await req(`/api/asks/${askB}/claim`, { device: D2, method: "POST" });
check("re-claim ask B succeeds", r.status === 200, `status=${r.status}`);
r = await req(`/api/asks/${askB}/submit-proof`, {
  body: { confirmation: "CONF-TEST-002" },
  device: D3,
  method: "POST",
});
check("wrong device cannot submit proof for B", r.status === 403, `status=${r.status}`);
r = await req(`/api/asks/${askB}/submit-proof`, {
  body: { confirmation: "CONF-TEST-002" },
  device: D2,
  method: "POST",
});
check("claiming device submits proof for B", r.status === 200, `status=${r.status}`);
r = await req(`/api/asks/${askB}/confirm-paid`, { method: "POST", token });
check("asker confirms paid for B", r.status === 200, `status=${r.status}`);

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

// 19 — no self-claims: the asker cannot claim their own ask.
r = await req("/api/accounts", {
  body: { handle: "testasker3", password: "testpass123" },
  method: "POST",
});
const token3 = r.data.token as string;
check("create third account", r.status === 201 && !!token3, JSON.stringify(r.data));
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-SELF-001",
    amount: 50,
    category: "Utility bill",
    payee: "Self Test Utility",
    state: "Missouri",
  },
  method: "POST",
  token: token3,
});
check("post self ask succeeds", r.status === 201, JSON.stringify(r.data));
const askSelf = r.data.ask?.id as number;
r = await req(`/api/asks/${askSelf}/claim`, {
  device: "device-self",
  method: "POST",
  token: token3,
});
check(
  "self-claim blocked",
  r.status === 403 && /isn't available/.test(r.data.error || ""),
  JSON.stringify(r.data),
);
r = await req(`/api/asks/${askSelf}/claim`, {
  device: "device-stranger",
  method: "POST",
});
check("a stranger's device can claim the same ask", r.status === 200, JSON.stringify(r.data));

// 20 — asker rejects a proof: the ask goes back on the board.
r = await req(`/api/asks/${askSelf}/submit-proof`, {
  body: { confirmation: "CONF-REJECT-1" },
  device: "device-stranger",
  method: "POST",
});
check("proof submitted for rejection test", r.status === 200, JSON.stringify(r.data));
r = await req(`/api/asks/${askSelf}/reject-proof`, { method: "POST", token: token3 });
check("asker rejects the proof", r.status === 200, JSON.stringify(r.data));
r = await req("/api/board");
const backOn = (r.data.asks || []).find((a: any) => a.id === askSelf);
check(
  "rejected proof puts the ask back on the board",
  !!backOn,
  JSON.stringify(r.data.asks),
);

// 21 — stale-claim unlock (24h, no proof) + 30-day ask expiry.
if (!TEST_DB) {
  console.log("SKIP  stale-claim unlock + 30-day expiry checks (TEST_DB not set)");
} else {
  const sqlite = new Database(TEST_DB);
  const nowMs = Date.now();
  sqlite
    .query(
      `INSERT INTO asks (account_id, payee, category, amount_cents, account_number, state, status, created_at, claimed_at, claimed_by_device)
       VALUES (1, 'Stale Test Utility', 'Utility bill', 1000, 'TEST-STALE-001', 'Missouri', 'locked', ?, ?, 'device-stale')`,
    )
    .run(nowMs - 25 * 60 * 60 * 1000, nowMs - 25 * 60 * 60 * 1000);
  r = await req("/api/board");
  const stale = (r.data.asks || []).find((a: any) => a.payee === "Stale Test Utility");
  check(
    "stale 25h claim unlocks back onto the board",
    !!stale,
    JSON.stringify(r.data.asks),
  );
  sqlite
    .query(
      `INSERT INTO asks (account_id, payee, category, amount_cents, account_number, state, status, created_at)
       VALUES (1, 'Old Open Utility', 'Utility bill', 1000, 'TEST-EXP-001', 'Missouri', 'open', ?)`,
    )
    .run(nowMs - 31 * DAY);
  r = await req("/api/board");
  const expired = (r.data.asks || []).find((a: any) => a.payee === "Old Open Utility");
  check(
    "31-day-old open ask expires off the board",
    !expired,
    JSON.stringify(r.data.asks),
  );
  r = await req("/api/asks", {
    body: {
      accountNumber: "TEST-EXP-001",
      amount: 10,
      category: "Utility bill",
      payee: "Old Open Utility",
      state: "Missouri",
    },
    method: "POST",
    token: token3,
  });
  check(
    "re-posting an expired ask's bill succeeds",
    r.status === 201,
    JSON.stringify(r.data),
  );
}

// 22 — verified need: bill photo + three board votes.
if (!BOARD_TOKEN) {
  console.log("SKIP  verified-need checks (BOARD_TOKEN not set)");
} else {
  const form = new FormData();
  form.append("payee", "Verified Test Utility");
  form.append("category", "Utility bill");
  form.append("amount", "75");
  form.append("accountNumber", "TEST-VER-001");
  form.append("state", "Missouri");
  form.append(
    "needProof",
    new Blob(["fake-image-bytes"], { type: "image/png" }),
    "bill.png",
  );
  const upRes = await fetch(`${BASE}/api/asks`, {
    body: form,
    headers: { Authorization: `Bearer ${token3}` },
    method: "POST",
  });
  const upData = await upRes.json().catch(() => ({}));
  check(
    "post ask with bill photo succeeds",
    upRes.status === 201 && upData.ask?.needProofStatus === "pending",
    JSON.stringify(upData),
  );
  const askV = upData.ask?.id as number;

  r = await req("/api/board/review");
  check(
    "review queue without board token is denied",
    r.status === 401 || r.status === 503,
    `status=${r.status}`,
  );
  r = await req("/api/board/review", { board: BOARD_TOKEN });
  check(
    "review queue lists the pending proof",
    r.status === 200 && (r.data.asks || []).some((a: any) => a.id === askV),
    JSON.stringify(r.data),
  );
  for (const voter of ["darin", "maya"]) {
    r = await req(`/api/board/review/${askV}/vote`, {
      body: { vote: "approve", voter },
      board: BOARD_TOKEN,
      method: "POST",
    });
    check(`board vote ${voter} approve`, r.status === 200, JSON.stringify(r.data));
  }
  r = await req("/api/board/review", { board: BOARD_TOKEN });
  check(
    "two approvals leaves proof pending",
    (r.data.asks || []).some((a: any) => a.id === askV),
    JSON.stringify(r.data),
  );
  r = await req(`/api/board/review/${askV}/vote`, {
    body: { vote: "approve", voter: "milo" },
    board: BOARD_TOKEN,
    method: "POST",
  });
  check(
    "third approval verifies the need",
    r.status === 200 && r.data.needVerified === true,
    JSON.stringify(r.data),
  );
  r = await req("/api/board");
  const v = (r.data.asks || []).find((a: any) => a.id === askV);
  check(
    "board shows Verified need badge",
    v?.needVerified === true,
    JSON.stringify(v),
  );

  // A rejection turns a proof down.
  const form2 = new FormData();
  form2.append("payee", "Rejected Test Utility");
  form2.append("category", "Utility bill");
  form2.append("amount", "40");
  form2.append("accountNumber", "TEST-VER-002");
  form2.append("state", "Missouri");
  form2.append(
    "needProof",
    new Blob(["fake-image-bytes"], { type: "image/png" }),
    "bill.png",
  );
  const upRes2 = await fetch(`${BASE}/api/asks`, {
    body: form2,
    headers: { Authorization: `Bearer ${token3}` },
    method: "POST",
  });
  const upData2 = await upRes2.json().catch(() => ({}));
  const askV2 = upData2.ask?.id as number;
  check("post second ask with bill photo succeeds", upRes2.status === 201, JSON.stringify(upData2));
  r = await req(`/api/board/review/${askV2}/vote`, {
    body: { vote: "reject", voter: "maya" },
    board: BOARD_TOKEN,
    method: "POST",
  });
  check(
    "one rejection turns the proof down",
    r.status === 200 && r.data.needProofStatus === "rejected",
    JSON.stringify(r.data),
  );
  r = await req("/api/board/review", { board: BOARD_TOKEN });
  check(
    "rejected proof leaves the review queue",
    !(r.data.asks || []).some((a: any) => a.id === askV2),
    JSON.stringify(r.data),
  );
}

// 23 — gift-card code: a grocery giver sends the card number + PIN
// with the proof; only the asker sees it; rejecting clears it.
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-GROC-001",
    amount: 25,
    category: "Groceries",
    payee: "Test Grocery Store",
    state: "Missouri",
  },
  method: "POST",
  token: token3,
});
check("post grocery ask ($25) succeeds", r.status === 201, JSON.stringify(r.data));
const askG = r.data.ask?.id as number;
r = await req(`/api/asks/${askG}/claim`, { device: D4, method: "POST" });
check("claim grocery ask succeeds", r.status === 200, `status=${r.status}`);
r = await req(`/api/asks/${askG}/submit-proof`, {
  body: { confirmation: "CONF-GC-001", giftCard: "GC-TEST-1234-5678" },
  device: D4,
  method: "POST",
});
check("submit proof with gift card (JSON) succeeds", r.status === 200, JSON.stringify(r.data));
r = await req("/api/asks/mine", { token: token3 });
const mineG = (r.data.asks || []).find((a: any) => a.id === askG);
check(
  "asker sees gift card code on their own ask",
  mineG?.giftCardCode === "GC-TEST-1234-5678" &&
    mineG?.proofConfirmation === "CONF-GC-001",
  JSON.stringify(mineG),
);
r = await req("/api/board");
check(
  "public board payload never includes the gift card code",
  !JSON.stringify(r.data).includes("GC-TEST-1234-5678"),
);
r = await req(`/api/asks/${askG}/reject-proof`, { method: "POST", token: token3 });
check("asker rejects gift-card proof", r.status === 200, JSON.stringify(r.data));
r = await req("/api/asks/mine", { token: token3 });
const mineG2 = (r.data.asks || []).find((a: any) => a.id === askG);
check(
  "reject-proof clears gift card code and confirmation",
  mineG2?.giftCardCode == null && mineG2?.proofConfirmation == null,
  JSON.stringify(mineG2),
);
r = await req("/api/board");
check(
  "rejected gift-card ask is back on the board",
  (r.data.asks || []).some((a: any) => a.id === askG),
);
r = await req(`/api/asks/${askG}/claim`, { device: D4, method: "POST" });
check("re-claim grocery ask succeeds", r.status === 200, `status=${r.status}`);
r = await req(`/api/asks/${askG}/submit-proof`, {
  body: { confirmation: "CONF-GC-002", giftCard: "x".repeat(65) },
  device: D4,
  method: "POST",
});
check(
  "gift card code over 64 chars is rejected",
  r.status === 400,
  `status=${r.status}`,
);
const formG = new FormData();
formG.append("confirmation", "CONF-GC-003");
formG.append("giftCard", "GC-TEST-9999-0000");
const upResG = await fetch(`${BASE}/api/asks/${askG}/submit-proof`, {
  body: formG,
  headers: { "X-Device-Token": D4 },
  method: "POST",
});
check(
  "submit proof with gift card (multipart) succeeds",
  upResG.status === 200,
  `status=${upResG.status}`,
);
r = await req("/api/asks/mine", { token: token3 });
const mineG3 = (r.data.asks || []).find((a: any) => a.id === askG);
check(
  "multipart gift card code stored for asker",
  mineG3?.giftCardCode === "GC-TEST-9999-0000",
  JSON.stringify(mineG3),
);
r = await req(`/api/asks/${askG}/confirm-paid`, { method: "POST", token: token3 });
check("asker confirms gift-card ask met", r.status === 200, `status=${r.status}`);

// 24 — $500 cap enforced at claim time too (board ruling Nov 13, 2026):
// two open $300 asks from one account can both be created (nothing met
// or locked yet), but the second claim must fail — claiming both would
// put the asker at $600, over the cap.
r = await req("/api/accounts", {
  body: { handle: "testasker4", password: "testpass123" },
  method: "POST",
});
check("create fourth test account", r.status === 201, JSON.stringify(r.data));
const token4 = r.data.token as string;
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-CAP-001",
    amount: 300,
    category: "Utility bill",
    payee: "Test Cap Power One",
    state: "Missouri",
  },
  method: "POST",
  token: token4,
});
check("post first $300 cap ask succeeds", r.status === 201, JSON.stringify(r.data));
const askC1 = r.data.ask?.id as number;
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-CAP-002",
    amount: 300,
    category: "Utility bill",
    payee: "Test Cap Power Two",
    state: "Missouri",
  },
  method: "POST",
  token: token4,
});
check("post second $300 cap ask succeeds", r.status === 201, JSON.stringify(r.data));
const askC2 = r.data.ask?.id as number;
r = await req(`/api/asks/${askC1}/claim`, { device: D1, method: "POST" });
check("claim first cap ask succeeds", r.status === 200, `status=${r.status}`);
r = await req(`/api/asks/${askC2}/claim`, { device: D2, method: "POST" });
check(
  "second claim blocked — would put asker over the $500 cap",
  r.status === 409,
  `status=${r.status} ${JSON.stringify(r.data)}`,
);

// 25 — board removal (Nov 13, 2026): the board can remove an open ask
// with a reason; the asker sees the reason on their own page next login.
r = await req("/api/accounts", {
  body: { handle: "testasker5", password: "testpass123" },
  method: "POST",
});
check("create fifth test account", r.status === 201, JSON.stringify(r.data));
const token5 = r.data.token as string;
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-REM-001",
    amount: 50,
    category: "Utility bill",
    payee: "Test Remove Power",
    state: "Missouri",
  },
  method: "POST",
  token: token5,
});
check("post ask to remove succeeds", r.status === 201, JSON.stringify(r.data));
const askR = r.data.ask?.id as number;
r = await req(`/api/board/remove/${askR}`, {
  body: { reason: "Test removal reason." },
  method: "POST",
});
check("remove without board token is denied", r.status === 401, `status=${r.status}`);
r = await req(`/api/board/remove/${askR}`, {
  board: BOARD_TOKEN,
  body: {},
  method: "POST",
});
check("remove without a reason is rejected", r.status === 400, `status=${r.status}`);
r = await req(`/api/board/remove/${askR}`, {
  board: BOARD_TOKEN,
  body: {
    reason:
      "The account number was not a real one — for gas, pick Other, name the station, and the giver sends a gift card.",
  },
  method: "POST",
});
check(
  "board removes the ask with a reason",
  r.status === 200 && r.data.ask?.status === "removed",
  JSON.stringify(r.data),
);
r = await req("/api/board");
check(
  "removed ask is off the public board",
  !(r.data.asks || []).some((a: any) => a.id === askR),
);
r = await req("/api/asks/mine", { token: token5 });
const mineR = (r.data.asks || []).find((a: any) => a.id === askR);
check(
  "asker sees the removal reason on their own ask",
  mineR?.status === "removed" && (mineR?.removedReason || "").includes("gift card"),
  JSON.stringify(mineR),
);
r = await req(`/api/board/remove/${askR}`, {
  board: BOARD_TOKEN,
  body: { reason: "Again." },
  method: "POST",
});
check("removing twice is rejected", r.status === 409, `status=${r.status}`);
// askC1 is still locked from test 24; askB was confirmed met earlier.
r = await req(`/api/board/remove/${askC1}`, {
  board: BOARD_TOKEN,
  body: { reason: "Locked test." },
  method: "POST",
});
check("removing a locked ask is rejected", r.status === 409, `status=${r.status}`);
r = await req(`/api/board/remove/${askB}`, {
  board: BOARD_TOKEN,
  body: { reason: "Met test." },
  method: "POST",
});
check("removing a met ask is rejected", r.status === 409, `status=${r.status}`);

// 26 — Other guidance (majority vote Nov 13, 2026): an Other ask needs
// no bill account number; the gift-card proof works for Other; a bill
// ask still requires one.
r = await req("/api/accounts", {
  body: { handle: "testasker6", password: "testpass123" },
  method: "POST",
});
check("create sixth test account", r.status === 201, JSON.stringify(r.data));
const token6 = r.data.token as string;
r = await req("/api/asks", {
  body: {
    accountNumber: "",
    amount: 40,
    category: "Other",
    payee: "Test Gas Station",
    state: "Missouri",
  },
  method: "POST",
  token: token6,
});
check(
  "post Other gas ask with no account number succeeds",
  r.status === 201,
  JSON.stringify(r.data),
);
const askO1 = r.data.ask?.id as number;
r = await req("/api/asks", {
  body: {
    accountNumber: "",
    amount: 25,
    category: "Other",
    payee: "Test Grocery Store",
    state: "Missouri",
  },
  method: "POST",
  token: token6,
});
check(
  "second Other ask with no account number succeeds (no false dedup)",
  r.status === 201,
  JSON.stringify(r.data),
);
r = await req("/api/asks", {
  body: {
    accountNumber: "",
    amount: 50,
    category: "Utility bill",
    payee: "Test Utility",
    state: "Missouri",
  },
  method: "POST",
  token: token6,
});
check(
  "bill ask with no account number is still rejected",
  r.status === 400,
  `status=${r.status} ${JSON.stringify(r.data)}`,
);
r = await req("/api/board");
const boardO1 = (r.data.asks || []).find((a: any) => a.id === askO1);
check(
  "Other ask shows on the board as first time asking",
  boardO1?.helpedLabel === "First time asking",
  JSON.stringify(boardO1),
);
r = await req(`/api/asks/${askO1}/claim`, { device: D3, method: "POST" });
check("claim Other ask succeeds", r.status === 200, `status=${r.status}`);
r = await req(`/api/asks/${askO1}/submit-proof`, {
  body: { confirmation: "CONF-OTHER-001", giftCard: "GC-OTHER-1234" },
  device: D3,
  method: "POST",
});
check("submit gift-card proof for Other succeeds", r.status === 200, JSON.stringify(r.data));
r = await req("/api/asks/mine", { token: token6 });
const mineO1 = (r.data.asks || []).find((a: any) => a.id === askO1);
check(
  "asker sees the Other gift card code on their own ask",
  mineO1?.giftCardCode === "GC-OTHER-1234",
  JSON.stringify(mineO1),
);

// 27 — board password reset (unanimous Nov 17, 2026): the board issues
// a one-time temp password; it expires after first login or 24 hours,
// and the asker must change it before doing anything else.
r = await req("/api/accounts", {
  body: { handle: "testreset", password: "oldpass123" },
  method: "POST",
});
check("create reset-test account", r.status === 201 && !!r.data.token, JSON.stringify(r.data));
const resetToken0 = r.data.token as string;
r = await req("/api/board/reset-password", {
  body: { handle: "testreset" },
  method: "POST",
});
check("board reset without token is denied", r.status === 401, `status=${r.status}`);
r = await req("/api/board/reset-password", {
  board: BOARD_TOKEN,
  body: { handle: "nosuchhandle" },
  method: "POST",
});
check("board reset for unknown handle is 404", r.status === 404, `status=${r.status}`);
r = await req("/api/board/reset-password", {
  board: BOARD_TOKEN,
  body: { handle: "testreset" },
  method: "POST",
});
check(
  "board reset returns a temp password expiring in ~24h",
  r.status === 200 &&
    typeof r.data.tempPassword === "string" &&
    r.data.tempPassword.length === 12 &&
    r.data.expiresAt > Date.now() &&
    r.data.expiresAt <= Date.now() + 24 * 60 * 60 * 1000 + 60000,
  JSON.stringify(r.data),
);
const tempPw = r.data.tempPassword as string;
r = await req("/api/accounts/login", {
  body: { handle: "testreset", password: "oldpass123" },
  method: "POST",
});
check("old password stops working after a board reset", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/me", { token: resetToken0 });
check("old session dies on a board reset", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/login", {
  body: { handle: "testreset", password: tempPw },
  method: "POST",
});
check(
  "temp password logs in and forces a change",
  r.status === 200 && r.data.mustChangePassword === true && !!r.data.token,
  JSON.stringify(r.data),
);
const resetToken1 = r.data.token as string;
r = await req("/api/accounts/login", {
  body: { handle: "testreset", password: tempPw },
  method: "POST",
});
check("temp password cannot log in twice", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/me", { token: resetToken1 });
check("forced-change account cannot use other endpoints", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/password-status", { token: resetToken1 });
check(
  "password-status reports must-change",
  r.status === 200 && r.data.mustChangePassword === true,
  JSON.stringify(r.data),
);
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-RESET-001",
    amount: 10,
    category: "Utility bill",
    payee: "Test Reset Power",
    state: "Missouri",
  },
  method: "POST",
  token: resetToken1,
});
check("forced-change account cannot post an ask", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/change-password", {
  body: { newPassword: "newpass123" },
  method: "POST",
  token: resetToken1,
});
check("change password with the temp session succeeds", r.status === 200, JSON.stringify(r.data));
r = await req("/api/accounts/password-status", { token: resetToken1 });
check(
  "password-status clears after the change",
  r.status === 200 && r.data.mustChangePassword === false,
  JSON.stringify(r.data),
);
r = await req("/api/accounts/login", {
  body: { handle: "testreset", password: tempPw },
  method: "POST",
});
check("temp password stops working after the change", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/login", {
  body: { handle: "testreset", password: "newpass123" },
  method: "POST",
});
check(
  "new password logs in normally",
  r.status === 200 && r.data.mustChangePassword === false,
  JSON.stringify(r.data),
);
const resetToken2 = r.data.token as string;
r = await req("/api/board/reset-password", {
  board: BOARD_TOKEN,
  body: { handle: "testreset" },
  method: "POST",
});
check("second board reset succeeds", r.status === 200, JSON.stringify(r.data));
r = await req("/api/accounts/password-status", { token: resetToken2 });
check("second reset kills the previous session", r.status === 401, `status=${r.status}`);

// Temp password expiry (24h): seed an already-expired temp password.
if (!TEST_DB) {
  console.log("SKIP  temp-password expiry check (TEST_DB not set)");
} else {
  r = await req("/api/accounts", {
    body: { handle: "testreset2", password: "oldpass123" },
    method: "POST",
  });
  check("create second reset-test account", r.status === 201, JSON.stringify(r.data));
  r = await req("/api/board/reset-password", {
    board: BOARD_TOKEN,
    body: { handle: "testreset2" },
    method: "POST",
  });
  const tempPw2 = r.data.tempPassword as string;
  check("board reset for second account succeeds", r.status === 200, JSON.stringify(r.data));
  const sqlite = new Database(TEST_DB);
  sqlite
    .query(`UPDATE accounts SET temp_password_expires_at = ? WHERE handle = 'testreset2'`)
    .run(Date.now() - 1000);
  r = await req("/api/accounts/login", {
    body: { handle: "testreset2", password: tempPw2 },
    method: "POST",
  });
  check(
    "expired temp password is refused",
    r.status === 401 && /expired/.test(r.data.error || ""),
    JSON.stringify(r.data),
  );
}

// 28 — tally gap fix (Nov 17, 2026): a claimed ask shows "Claimed —
// waiting for proof" with the 24h countdown, and if the giver pays but
// never uploads proof, the asker confirms with their own bill's
// confirmation number; the board verifies before the tally moves.
r = await req("/api/accounts", {
  body: { handle: "testtally", password: "testpass123" },
  method: "POST",
});
check("create tally-test account", r.status === 201 && !!r.data.token, JSON.stringify(r.data));
const tokenT = r.data.token as string;
r = await req("/api/proof");
const metBefore = r.data.metCount as number;
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-TALLY-001",
    amount: 60,
    category: "Utility bill",
    payee: "Test Tally Power",
    state: "Missouri",
  },
  method: "POST",
  token: tokenT,
});
check("post tally ask ($60) succeeds", r.status === 201, JSON.stringify(r.data));
const askT = r.data.ask?.id as number;
r = await req(`/api/asks/${askT}/claim`, { device: "device-tally-1", method: "POST" });
check("claim tally ask succeeds", r.status === 200, `status=${r.status}`);
r = await req("/api/yours", { token: tokenT });
const mineT = (r.data.mine || []).find((a: any) => a.id === askT);
check(
  "yours shows the claimed ask with a 24h countdown",
  mineT?.status === "locked" &&
    typeof mineT?.claimExpiresAt === "number" &&
    mineT.claimExpiresAt > Date.now() &&
    mineT.claimExpiresAt <= Date.now() + 24 * 60 * 60 * 1000 + 60000,
  JSON.stringify(mineT),
);
r = await req(`/api/asks/${askT}/asker-confirm`, {
  body: { confirmation: "ab" },
  method: "POST",
  token: tokenT,
});
check("asker-confirm with too-short number is rejected", r.status === 400, `status=${r.status}`);
r = await req(`/api/asks/${askT}/asker-confirm`, {
  body: { confirmation: "CONF-ASKER-001" },
  method: "POST",
  token: tokenT,
});
check("asker confirms with their own bill's number", r.status === 200, JSON.stringify(r.data));
r = await req(`/api/asks/${askT}/asker-confirm`, {
  body: { confirmation: "CONF-ASKER-002" },
  method: "POST",
  token: tokenT,
});
check("asker-confirm while one is pending is rejected", r.status === 409, `status=${r.status}`);
r = await req("/api/board/review", { board: BOARD_TOKEN });
const acItem = (r.data.askerConfirms || []).find((a: any) => a.id === askT);
check(
  "review queue surfaces the asker-confirm",
  !!acItem && acItem.askerConfirmation === "CONF-ASKER-001",
  JSON.stringify(r.data.askerConfirms),
);
r = await req(`/api/board/review/${askT}/asker-confirm-vote`, {
  body: { vote: "approve", voter: "darin" },
  method: "POST",
});
check("asker-confirm vote without board token is denied", r.status === 401, `status=${r.status}`);
r = await req(`/api/board/review/${askT}/asker-confirm-vote`, {
  board: BOARD_TOKEN,
  body: { vote: "approve", voter: "bob" },
  method: "POST",
});
check("asker-confirm vote with a bad voter is rejected", r.status === 400, `status=${r.status}`);
r = await req(`/api/board/review/${askT}/asker-confirm-vote`, {
  board: BOARD_TOKEN,
  body: { vote: "approve", voter: "darin" },
  method: "POST",
});
check(
  "first approval leaves the confirm pending",
  r.status === 200 && r.data.askerConfirmStatus === "pending",
  JSON.stringify(r.data),
);
r = await req(`/api/board/review/${askT}/asker-confirm-vote`, {
  board: BOARD_TOKEN,
  body: { vote: "approve", voter: "maya" },
  method: "POST",
});
check(
  "second approval leaves the confirm pending",
  r.status === 200 && r.data.askerConfirmStatus === "pending",
  JSON.stringify(r.data),
);
r = await req(`/api/board/review/${askT}/asker-confirm-vote`, {
  board: BOARD_TOKEN,
  body: { vote: "approve", voter: "jason" },
  method: "POST",
});
check(
  "third approval verifies — ask met",
  r.status === 200 && r.data.askerConfirmStatus === "verified",
  JSON.stringify(r.data),
);
r = await req("/api/proof");
check(
  "tally moves by 1 after board verification",
  r.data.metCount === metBefore + 1,
  JSON.stringify(r.data),
);
r = await req("/api/asks/mine", { token: tokenT });
const mineT2 = (r.data.asks || []).find((a: any) => a.id === askT);
check(
  "verified asker-confirm shows the ask as met",
  mineT2?.status === "met",
  JSON.stringify(mineT2),
);

// Rejection path: a bad number is rejected, the asker re-submits.
r = await req("/api/accounts", {
  body: { handle: "testtally2", password: "testpass123" },
  method: "POST",
});
check("create second tally-test account", r.status === 201 && !!r.data.token, JSON.stringify(r.data));
const tokenT2 = r.data.token as string;
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-TALLY-002",
    amount: 40,
    category: "Utility bill",
    payee: "Test Tally Gas",
    state: "Missouri",
  },
  method: "POST",
  token: tokenT2,
});
check("post second tally ask ($40) succeeds", r.status === 201, JSON.stringify(r.data));
const askT2 = r.data.ask?.id as number;
r = await req(`/api/asks/${askT2}/claim`, { device: "device-tally-2", method: "POST" });
check("claim second tally ask succeeds", r.status === 200, `status=${r.status}`);
r = await req(`/api/asks/${askT2}/asker-confirm`, {
  body: { confirmation: "CONF-BAD-001" },
  method: "POST",
  token: tokenT2,
});
check("asker confirms with a bad number", r.status === 200, JSON.stringify(r.data));
r = await req(`/api/board/review/${askT2}/asker-confirm-vote`, {
  board: BOARD_TOKEN,
  body: { vote: "reject", voter: "maya" },
  method: "POST",
});
check(
  "one rejection rejects the confirm",
  r.status === 200 && r.data.askerConfirmStatus === "rejected",
  JSON.stringify(r.data),
);
r = await req("/api/asks/mine", { token: tokenT2 });
const mineT2b = (r.data.asks || []).find((a: any) => a.id === askT2);
check(
  "rejected confirm shows as rejected on the asker's page",
  mineT2b?.askerConfirmStatus === "rejected",
  JSON.stringify(mineT2b),
);
r = await req(`/api/asks/${askT2}/asker-confirm`, {
  body: { confirmation: "CONF-GOOD-001" },
  method: "POST",
  token: tokenT2,
});
check("asker re-submits a corrected number", r.status === 200, JSON.stringify(r.data));
for (const voter of ["darin", "maya", "milo"]) {
  r = await req(`/api/board/review/${askT2}/asker-confirm-vote`, {
    board: BOARD_TOKEN,
    body: { vote: "approve", voter },
    method: "POST",
  });
}
check(
  "corrected number verifies with three approvals",
  r.status === 200 && r.data.askerConfirmStatus === "verified",
  JSON.stringify(r.data),
);
r = await req("/api/proof");
check(
  "tally moves again after the corrected confirm",
  r.data.metCount === metBefore + 2,
  JSON.stringify(r.data),
);

// Asker-confirm is blocked once the giver's proof is already in, on an
// open ask, and for someone else's ask.
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-TALLY-003",
    amount: 30,
    category: "Utility bill",
    payee: "Test Tally Water",
    state: "Missouri",
  },
  method: "POST",
  token: tokenT2,
});
check("post third tally ask ($30) succeeds", r.status === 201, JSON.stringify(r.data));
const askT3 = r.data.ask?.id as number;
r = await req(`/api/asks/${askT3}/claim`, { device: "device-tally-3", method: "POST" });
check("claim third tally ask succeeds", r.status === 200, `status=${r.status}`);
r = await req(`/api/asks/${askT3}/submit-proof`, {
  body: { confirmation: "CONF-G-001" },
  device: "device-tally-3",
  method: "POST",
});
check("giver submits proof for third tally ask", r.status === 200, JSON.stringify(r.data));
r = await req(`/api/asks/${askT3}/asker-confirm`, {
  body: { confirmation: "CONF-ASKER-003" },
  method: "POST",
  token: tokenT2,
});
check(
  "asker-confirm blocked when the giver's proof is already in",
  r.status === 409,
  `status=${r.status}`,
);
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-TALLY-004",
    amount: 30,
    category: "Utility bill",
    payee: "Test Tally Sewer",
    state: "Missouri",
  },
  method: "POST",
  token: tokenT2,
});
check("post fourth tally ask ($30) succeeds", r.status === 201, JSON.stringify(r.data));
const askT4 = r.data.ask?.id as number;
r = await req(`/api/asks/${askT4}/asker-confirm`, {
  body: { confirmation: "CONF-ASKER-004" },
  method: "POST",
  token: tokenT2,
});
check("asker-confirm blocked on an open ask", r.status === 409, `status=${r.status}`);
r = await req(`/api/asks/${askT3}/asker-confirm`, {
  body: { confirmation: "CONF-ASKER-003" },
  method: "POST",
  token: tokenT,
});
check(
  "asker-confirm blocked for someone else's ask",
  r.status === 403,
  `status=${r.status}`,
);

// 29 — forgot password (Nov 17, 2026): no email; the request is tied to
// the device that made it, the board approves, then that same device
// sets a new password.
r = await req("/api/accounts", {
  body: { handle: "testforgot", password: "forgotpass1" },
  method: "POST",
});
check("create forgot-test account", r.status === 201 && !!r.data.token, JSON.stringify(r.data));
r = await req("/api/accounts/forgot-password", {
  body: { handle: "testforgot" },
  method: "POST",
});
check("forgot-password without a device is rejected", r.status === 400, `status=${r.status}`);
r = await req("/api/accounts/forgot-password", {
  body: { handle: "testforgot" },
  device: "device-forgot-1",
  method: "POST",
});
check("forgot-password request succeeds", r.status === 200, JSON.stringify(r.data));
r = await req("/api/accounts/forgot-password", {
  body: { handle: "testforgot" },
  device: "device-forgot-1",
  method: "POST",
});
check("a second pending request is rejected", r.status === 409, `status=${r.status}`);
r = await req("/api/accounts/forgot-password", {
  body: { handle: "nosuchhandle" },
  device: "device-forgot-1",
  method: "POST",
});
check(
  "forgot-password for an unknown handle answers generically",
  r.status === 200,
  `status=${r.status}`,
);
r = await req("/api/board/review", { board: BOARD_TOKEN });
const prItem = (r.data.passwordResets || []).find((x: any) => x.handle === "testforgot");
check(
  "review queue surfaces the reset request",
  !!prItem,
  JSON.stringify(r.data.passwordResets),
);
r = await req("/api/accounts/reset-password", {
  body: { handle: "testforgot", newPassword: "newforgot1" },
  device: "device-forgot-2",
  method: "POST",
});
check(
  "reset from a different device is refused",
  r.status === 403,
  `status=${r.status}`,
);
r = await req(`/api/board/review/password-reset/${prItem?.id}/decision`, {
  body: { decision: "approve" },
  method: "POST",
});
check("reset decision without board token is denied", r.status === 401, `status=${r.status}`);
r = await req(`/api/board/review/password-reset/${prItem?.id}/decision`, {
  board: BOARD_TOKEN,
  body: { decision: "maybe" },
  method: "POST",
});
check("reset decision with a bad value is rejected", r.status === 400, `status=${r.status}`);
r = await req(`/api/board/review/password-reset/${prItem?.id}/decision`, {
  board: BOARD_TOKEN,
  body: { decision: "approve" },
  method: "POST",
});
check(
  "board approves the reset request",
  r.status === 200 && r.data.status === "approved",
  JSON.stringify(r.data),
);
r = await req(`/api/board/review/password-reset/${prItem?.id}/decision`, {
  board: BOARD_TOKEN,
  body: { decision: "approve" },
  method: "POST",
});
check("deciding the same request twice is rejected", r.status === 409, `status=${r.status}`);
r = await req("/api/accounts/reset-password", {
  body: { handle: "testforgot", newPassword: "newforgot1" },
  device: "device-forgot-2",
  method: "POST",
});
check(
  "reset from a different device is still refused after approval",
  r.status === 403,
  `status=${r.status}`,
);
r = await req("/api/accounts/reset-password", {
  body: { handle: "testforgot", newPassword: "newforgot1" },
  device: "device-forgot-1",
  method: "POST",
});
check(
  "reset from the requesting device succeeds",
  r.status === 200 && !!r.data.token,
  JSON.stringify(r.data),
);
r = await req("/api/accounts/login", {
  body: { handle: "testforgot", password: "forgotpass1" },
  method: "POST",
});
check("old password stops working after the reset", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/login", {
  body: { handle: "testforgot", password: "newforgot1" },
  method: "POST",
});
check("new password logs in after the reset", r.status === 200, JSON.stringify(r.data));
r = await req("/api/accounts/reset-password", {
  body: { handle: "testforgot", newPassword: "anotherone1" },
  device: "device-forgot-1",
  method: "POST",
});
check("an approved reset cannot be used twice", r.status === 403, `status=${r.status}`);
// Rejection path: a new request, rejected by the board, cannot reset.
r = await req("/api/accounts/forgot-password", {
  body: { handle: "testforgot" },
  device: "device-forgot-1",
  method: "POST",
});
check("a new reset request succeeds after the first is used", r.status === 200, JSON.stringify(r.data));
r = await req("/api/board/review", { board: BOARD_TOKEN });
const prItem2 = (r.data.passwordResets || []).find((x: any) => x.handle === "testforgot");
r = await req(`/api/board/review/password-reset/${prItem2?.id}/decision`, {
  board: BOARD_TOKEN,
  body: { decision: "reject" },
  method: "POST",
});
check(
  "board rejects the second request",
  r.status === 200 && r.data.status === "rejected",
  JSON.stringify(r.data),
);
r = await req("/api/accounts/reset-password", {
  body: { handle: "testforgot", newPassword: "anotherone1" },
  device: "device-forgot-1",
  method: "POST",
});
check("a rejected reset cannot set a password", r.status === 403, `status=${r.status}`);

// 30 — change password while signed in (Nov 17, 2026): no old password
// needed; the signed-in session is the proof; other sessions die.
r = await req("/api/accounts", {
  body: { handle: "testchangepw", password: "changepass1" },
  method: "POST",
});
check("create change-password account", r.status === 201 && !!r.data.token, JSON.stringify(r.data));
const tokenC1 = r.data.token as string;
r = await req("/api/accounts/login", {
  body: { handle: "testchangepw", password: "changepass1" },
  method: "POST",
});
check("second login for change-password test", r.status === 200 && !!r.data.token, JSON.stringify(r.data));
const tokenC2 = r.data.token as string;
r = await req("/api/accounts/change-password", {
  body: { newPassword: "changedpass1" },
  method: "POST",
});
check("change password without a session is denied", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/change-password", {
  body: { newPassword: "short" },
  method: "POST",
  token: tokenC1,
});
check("change password rejects a short password", r.status === 400, `status=${r.status}`);
r = await req("/api/accounts/change-password", {
  body: { newPassword: "changedpass1" },
  method: "POST",
  token: tokenC1,
});
check("change password succeeds", r.status === 200, JSON.stringify(r.data));
r = await req("/api/accounts/me", { token: tokenC2 });
check("other sessions die on a password change", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/me", { token: tokenC1 });
check("the session that changed the password stays live", r.status === 200, JSON.stringify(r.data));
r = await req("/api/accounts/login", {
  body: { handle: "testchangepw", password: "changepass1" },
  method: "POST",
});
check("old password stops working after the change", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts/login", {
  body: { handle: "testchangepw", password: "changedpass1" },
  method: "POST",
});
check("new password logs in after the change", r.status === 200, JSON.stringify(r.data));

// 31 — board-only locked-asks view (unanimous Nov 17, 2026): claimed
// asks with their status and time left, no giver details.
r = await req("/api/board/locked");
check("locked view without board token is denied", r.status === 401, `status=${r.status}`);
r = await req("/api/accounts", {
  body: { handle: "testlocked", password: "testpass123" },
  method: "POST",
});
check("create locked-view account", r.status === 201 && !!r.data.token, JSON.stringify(r.data));
const tokenL = r.data.token as string;
r = await req("/api/asks", {
  body: {
    accountNumber: "TEST-LOCKED-001",
    amount: 45,
    category: "Utility bill",
    payee: "Test Locked Power",
    state: "Missouri",
  },
  method: "POST",
  token: tokenL,
});
check("post locked-view ask ($45) succeeds", r.status === 201, JSON.stringify(r.data));
const askL = r.data.ask?.id as number;
r = await req(`/api/asks/${askL}/claim`, { device: "device-locked-1", method: "POST" });
check("claim locked-view ask succeeds", r.status === 200, `status=${r.status}`);
r = await req("/api/board/locked", { board: BOARD_TOKEN });
const lockedItem = (r.data.asks || []).find((a: any) => a.id === askL);
const lockedJson = JSON.stringify(r.data);
check(
  "locked view lists the claimed ask with a countdown",
  !!lockedItem &&
    lockedItem.hasProof === false &&
    typeof lockedItem.claimExpiresAt === "number" &&
    lockedItem.claimExpiresAt > Date.now(),
  JSON.stringify(lockedItem),
);
check(
  "locked view hides account number, handle, and device",
  !lockedJson.includes("TEST-LOCKED-001") &&
    !lockedJson.includes("testlocked") &&
    !lockedJson.includes("device-locked-1"),
);
r = await req(`/api/asks/${askL}/submit-proof`, {
  body: { confirmation: "CONF-LOCK-001" },
  device: "device-locked-1",
  method: "POST",
});
check("giver submits proof for locked-view ask", r.status === 200, JSON.stringify(r.data));
r = await req("/api/board/locked", { board: BOARD_TOKEN });
const lockedItem2 = (r.data.asks || []).find((a: any) => a.id === askL);
check(
  "locked view shows proof sent",
  !!lockedItem2 && lockedItem2.hasProof === true,
  JSON.stringify(lockedItem2),
);
r = await req(`/api/asks/${askL}/confirm-paid`, { method: "POST", token: tokenL });
check("asker confirms locked-view ask met", r.status === 200, JSON.stringify(r.data));
r = await req("/api/board/locked", { board: BOARD_TOKEN });
check(
  "met ask leaves the locked view",
  !(r.data.asks || []).some((a: any) => a.id === askL),
  JSON.stringify(r.data.asks),
);

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log("Failures:", failures.join("; "));
  process.exit(1);
}
