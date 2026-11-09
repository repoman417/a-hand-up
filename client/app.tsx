import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15000;

function getDeviceToken(): string {
  let t = localStorage.getItem("ahu-device");
  if (!t) {
    t = crypto.randomUUID();
    localStorage.setItem("ahu-device", t);
  }
  return t;
}

function getAuthToken(): string | null {
  return localStorage.getItem("ahu-token");
}

function setAuthToken(token: string | null) {
  if (token) localStorage.setItem("ahu-token", token);
  else localStorage.removeItem("ahu-token");
}

async function fetchJSON(path: string, opts: RequestInit = {}): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(opts.headers as Record<string, string> | undefined),
    };
    const token = getAuthToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    headers["X-Device-Token"] = getDeviceToken();
    const res = await fetch(path, { ...opts, headers, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        (data && data.error) || `Request failed (${res.status}).`,
      );
    }
    return data;
  } catch (e: any) {
    if (e && e.name === "AbortError") {
      throw new Error("The request timed out. Check your connection and try again.");
    }
    throw e;
  }
}

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

const CATEGORIES = [
  "Utility bill",
  "Groceries",
  "Part or repair",
  "Rent",
  "Medical",
  "Other",
];

function money(n: number): string {
  return `$${Number(n).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  })}`;
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  const parts = d.split("-");
  if (parts.length !== 3) return d;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const m = Number(parts[1]);
  return `${months[m - 1] || ""} ${Number(parts[2])}, ${parts[0]}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BoardAsk = {
  id: number;
  payee: string;
  category: string;
  amount: number;
  state: string;
  dueDate: string | null;
  cutoffDate: string | null;
  helpedCount: number;
  helpedLabel: string;
  createdAt: number;
};

type ProofData = {
  metCount: number;
  totalDollars: number;
  recent: { label: string; amount: number; paidAgo: string }[];
};

type ClaimedAsk = {
  id: number;
  payee: string;
  category: string;
  amount: number;
  state: string;
  dueDate: string | null;
  cutoffDate: string | null;
  accountNumber: string | null;
  status: string;
  metAt: number | null;
};

type OwnAsk = {
  id: number;
  payee: string;
  category: string;
  amount: number;
  state: string;
  dueDate: string | null;
  cutoffDate: string | null;
  accountNumber: string;
  status: string;
  metAt: number | null;
  createdAt: number;
};

type MeData = {
  handle: string;
  internalNumber: number;
  helpedCount: number;
  usedCents: number;
  remainingCents: number;
};

type View = "board" | "ask" | "yours" | "how";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card">
      <div className="error">{message}</div>
      <button className="btn" onClick={onRetry}>Try again</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open Asks board
// ---------------------------------------------------------------------------

function BoardView({ onClaimed }: { onClaimed: () => void }) {
  const [asks, setAsks] = useState<BoardAsk[] | null>(null);
  const [proof, setProof] = useState<ProofData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<number | null>(null);
  const [claimed, setClaimed] = useState<Record<number, any>>({});
  const [claimError, setClaimError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [board, proofData] = await Promise.all([
        fetchJSON("/api/board"),
        fetchJSON("/api/proof"),
      ]);
      setAsks(board.asks);
      setProof(proofData);
    } catch (e: any) {
      setError(e.message || "Could not load the board.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function claim(ask: BoardAsk) {
    setClaimError(null);
    setClaimingId(ask.id);
    try {
      const data = await fetchJSON(`/api/asks/${ask.id}/claim`, {
        method: "POST",
      });
      setClaimed((prev) => ({ ...prev, [ask.id]: data.ask }));
      setAsks((prev) => (prev || []).filter((a) => a.id !== ask.id));
      onClaimed();
    } catch (e: any) {
      setClaimError(e.message || "Could not claim this ask.");
    } finally {
      setClaimingId(null);
    }
  }

  async function confirmPaid(askId: number) {
    try {
      await fetchJSON(`/api/asks/${askId}/confirm-paid`, { method: "POST" });
      setClaimed((prev) => {
        const next = { ...prev };
        delete next[askId];
        return next;
      });
      await load();
    } catch (e: any) {
      setClaimError(e.message || "Could not confirm the payment.");
    }
  }

  async function release(askId: number) {
    try {
      await fetchJSON(`/api/asks/${askId}/release`, { method: "POST" });
      setClaimed((prev) => {
        const next = { ...prev };
        delete next[askId];
        return next;
      });
      await load();
    } catch (e: any) {
      setClaimError(e.message || "Could not release this ask.");
    }
  }

  if (error) return <LoadError message={error} onRetry={load} />;
  if (!asks || !proof) return <div className="card empty">Loading the board…</div>;

  return (
    <div>
      <div className="card proof">
        <h2>
          {proof.metCount} {proof.metCount === 1 ? "need" : "needs"} met so far
          {proof.metCount > 0 && ` — ${money(proof.totalDollars)} paid straight to payees`}
        </h2>
        {proof.metCount === 0 ? (
          <p className="zero">
            0 needs met so far — the first need met will show up here.
          </p>
        ) : (
          <ul>
            {proof.recent.map((r, i) => (
              <li key={i}>
                {r.label} — paid {r.paidAgo} ({money(r.amount)})
              </li>
            ))}
          </ul>
        )}
      </div>

      {claimError && <div className="error">{claimError}</div>}

      {Object.entries(claimed).map(([id, ask]) => (
        <div className="card" key={`claimed-${id}`}>
          <h3>You&rsquo;re helping: {ask.payee}</h3>
          <p className="meta">
            {ask.category} — {money(ask.amount)} — {ask.state}
            {ask.dueDate ? ` — due ${fmtDate(ask.dueDate)}` : ""}
            {ask.cutoffDate ? ` — cutoff ${fmtDate(ask.cutoffDate)}` : ""}
          </p>
          <div className="pay-box">
            <p style={{ marginTop: 0 }}>
              Pay the bill directly at the payee — their website, app, phone,
              or in person. Use this account number:
            </p>
            <p>
              Account number: <code>{ask.accountNumber}</code>
            </p>
            <p>
              No cash goes to the asker, ever. Once you&rsquo;ve paid, come
              back here and confirm so the ask leaves the board for good.
            </p>
          </div>
          <div className="btn-row">
            <button className="btn" onClick={() => confirmPaid(ask.id)}>
              I paid it
            </button>
            <button className="btn secondary" onClick={() => release(ask.id)}>
              Payment didn&rsquo;t go through
            </button>
          </div>
        </div>
      ))}

      {asks.length === 0 && Object.keys(claimed).length === 0 && (
        <div className="card empty">No open asks right now.</div>
      )}

      {asks.map((ask) => (
        <div className="card" key={ask.id}>
          <div className="ask-head">
            <h3>{ask.payee}</h3>
            <span className="amount">{money(ask.amount)}</span>
          </div>
          <p className="meta">
            {ask.category} — {ask.state}
            {ask.dueDate ? ` — due ${fmtDate(ask.dueDate)}` : ""}
            {ask.cutoffDate ? ` — cutoff ${fmtDate(ask.cutoffDate)}` : ""}
          </p>
          <span className="badge">{ask.helpedLabel}</span>
          <div className="btn-row">
            <button
              className="btn"
              disabled={claimingId === ask.id}
              onClick={() => claim(ask)}
            >
              {claimingId === ask.id ? "Claiming…" : "I can help with this"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth panel (askers only — givers never need an account)
// ---------------------------------------------------------------------------

function AuthPanel({ onAuthed }: { onAuthed: (me: MeData) => void }) {
  const [mode, setMode] = useState<"login" | "create">("login");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const path =
        mode === "create" ? "/api/accounts" : "/api/accounts/login";
      const data = await fetchJSON(path, {
        body: JSON.stringify({ handle, password }),
        method: "POST",
      });
      setAuthToken(data.token);
      const me = await fetchJSON("/api/accounts/me");
      onAuthed(me);
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>{mode === "create" ? "Create an asker account" : "Sign in"}</h2>
      <p>
        Askers need an account so the limits can be enforced — one met ask
        per bill per 30 days, and $500 total per 30 days. It&rsquo;s just a
        handle and a password. No real name, address, email, or phone — ever.
        Givers never need an account at all.
      </p>
      <form onSubmit={submit}>
        <label>
          Handle
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="e.g. porchlight22"
            autoComplete="username"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 6 characters"
            autoComplete={mode === "create" ? "new-password" : "current-password"}
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "create"
                ? "Create account"
                : "Sign in"}
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setMode(mode === "create" ? "login" : "create")}
          >
            {mode === "create"
              ? "I already have an account"
              : "I need an account"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ask for help
// ---------------------------------------------------------------------------

function AskView({ me, onAuthed }: { me: MeData | null; onAuthed: (me: MeData) => void }) {
  const [payee, setPayee] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [state, setState] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [cutoffDate, setCutoffDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!me) return <AuthPanel onAuthed={onAuthed} />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    setBusy(true);
    try {
      await fetchJSON("/api/asks", {
        body: JSON.stringify({
          accountNumber,
          amount: Number(amount),
          category,
          cutoffDate: cutoffDate || null,
          dueDate: dueDate || null,
          payee,
          state,
        }),
        method: "POST",
      });
      setDone(true);
      setPayee("");
      setAmount("");
      setAccountNumber("");
      setState("");
      setDueDate("");
      setCutoffDate("");
    } catch (err: any) {
      setError(err.message || "Could not post your ask.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          Signed in as <strong>{me.handle}</strong> — account{" "}
          <strong>No. {me.internalNumber}</strong>. That number is only for
          enforcing the limits; it is never shown to anyone.
        </p>
        <p>
          You&rsquo;ve used {money(me.usedCents / 100)} of your $500 in the
          last 30 days — {money(me.remainingCents / 100)} left. You&rsquo;ve
          been helped {me.helpedCount}{" "}
          {me.helpedCount === 1 ? "time" : "times"}.
        </p>
      </div>
      <div className="card">
        <h2>Ask for help</h2>
        <p>
          Small asks only — $5 to $500. A giver pays the payee directly; no
          cash ever comes to you. Your bill account number is shown only to
          the giver who claims your ask, never on the public board.
        </p>
        <form onSubmit={submit}>
          <label>
            Place to pay (payee)
            <input
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder="e.g. City Utilities, or the store for the part"
            />
          </label>
          <label>
            What kind of ask is this?
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Amount (dollars)
            <input
              type="number"
              min={5}
              max={500}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 120"
            />
          </label>
          <label>
            Bill account number <span className="hint">(required — only the claiming giver sees it)</span>
            <input
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder="The account number on the bill"
              autoComplete="off"
            />
          </label>
          <label>
            State the bill is in
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Choose a state…</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Due date <span className="hint">(optional)</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
          <label>
            Cutoff date <span className="hint">(optional — when the power, or the help, runs out)</span>
            <input
              type="date"
              value={cutoffDate}
              onChange={(e) => setCutoffDate(e.target.value)}
            />
          </label>
          {error && <div className="error">{error}</div>}
          {done && (
            <div className="notice">
              Your ask is on the board. If a giver pays it, it disappears
              from the board for good — and if you cover it yourself first,
              you can take it down from the Yours page.
            </div>
          )}
          <div className="btn-row">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Posting…" : "Post my ask"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Yours
// ---------------------------------------------------------------------------

function YoursView({ me }: { me: MeData | null }) {
  const [claimed, setClaimed] = useState<ClaimedAsk[] | null>(null);
  const [mine, setMine] = useState<OwnAsk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchJSON("/api/yours");
      setClaimed(data.claimed);
      setMine(data.mine);
    } catch (e: any) {
      setError(e.message || "Could not load your page.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function confirmPaid(id: number) {
    try {
      await fetchJSON(`/api/asks/${id}/confirm-paid`, { method: "POST" });
      setNotice("Thank you — that need is met, and the ask is off the board for good.");
      await load();
    } catch (e: any) {
      setError(e.message || "Could not confirm the payment.");
    }
  }

  async function release(id: number) {
    try {
      await fetchJSON(`/api/asks/${id}/release`, { method: "POST" });
      setNotice("Released — the ask is back on the board for someone else to help with.");
      await load();
    } catch (e: any) {
      setError(e.message || "Could not release this ask.");
    }
  }

  async function withdraw(id: number) {
    try {
      await fetchJSON(`/api/asks/${id}/withdraw`, { method: "POST" });
      setNotice("Your ask is down. If a giver had already paid it, it would have landed as a credit on the next bill.");
      await load();
    } catch (e: any) {
      setError(e.message || "Could not withdraw this ask.");
    }
  }

  if (error) return <LoadError message={error} onRetry={load} />;
  if (!claimed || !mine) return <div className="card empty">Loading…</div>;

  return (
    <div>
      {notice && <div className="notice">{notice}</div>}
      <h2>Asks you&rsquo;re helping</h2>
      {claimed.length === 0 ? (
        <div className="card empty">
          Nothing claimed on this device yet. When you claim an ask from the
          Open Asks board, it shows up here with the payment details.
        </div>
      ) : (
        claimed.map((ask) => (
          <div className="card" key={ask.id}>
            <div className="ask-head">
              <h3>{ask.payee}</h3>
              <span className="amount">{money(ask.amount)}</span>
            </div>
            <p className="meta">
              {ask.category} — {ask.state}
              {ask.dueDate ? ` — due ${fmtDate(ask.dueDate)}` : ""}
              {ask.cutoffDate ? ` — cutoff ${fmtDate(ask.cutoffDate)}` : ""}
            </p>
            <p>
              Status:{" "}
              <span className={`status ${ask.status}`}>
                {ask.status === "locked"
                  ? "Claimed — waiting on your payment"
                  : "Met — thank you"}
              </span>
            </p>
            {ask.status === "locked" && ask.accountNumber && (
              <div className="pay-box">
                <p style={{ marginTop: 0 }}>
                  Pay the payee directly using this account number:
                </p>
                <p>
                  Account number: <code>{ask.accountNumber}</code>
                </p>
              </div>
            )}
            {ask.status === "locked" && (
              <div className="btn-row">
                <button className="btn" onClick={() => confirmPaid(ask.id)}>
                  I paid it
                </button>
                <button className="btn secondary" onClick={() => release(ask.id)}>
                  Payment didn&rsquo;t go through
                </button>
              </div>
            )}
          </div>
        ))
      )}

      <h2>Your asks</h2>
      {!me ? (
        <div className="card empty">
          Sign in from the Ask for help page to see your own asks here.
        </div>
      ) : mine.length === 0 ? (
        <div className="card empty">You haven&rsquo;t posted an ask yet.</div>
      ) : (
        mine.map((ask) => (
          <div className="card" key={ask.id}>
            <div className="ask-head">
              <h3>{ask.payee}</h3>
              <span className="amount">{money(ask.amount)}</span>
            </div>
            <p className="meta">
              {ask.category} — {ask.state}
              {ask.dueDate ? ` — due ${fmtDate(ask.dueDate)}` : ""}
              {ask.cutoffDate ? ` — cutoff ${fmtDate(ask.cutoffDate)}` : ""}
            </p>
            <p>
              Status: <span className={`status ${ask.status}`}>{ask.status}</span>
              {" — "}account number: <code>{ask.accountNumber}</code>
            </p>
            {ask.status === "open" && (
              <div className="btn-row">
                <button className="btn danger" onClick={() => withdraw(ask.id)}>
                  Take this ask down (I covered it myself)
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

function HowView() {
  return (
    <div className="card how">
      <h2>How it works</h2>
      <p>
        Someone with a small, real need — a light bill, a furnace part,
        groceries — posts the ask. A stranger pays the bill or orders the
        part directly. No cash ever goes to the asker.
      </p>
      <h3>The rules, plainly</h3>
      <ul>
        <li>
          <strong>Small asks only — $5 to $500.</strong> A light bill, a
          $15 furnace part, groceries. Not big money.
        </li>
        <li>
          <strong>No cash to the asker, ever.</strong> The giver pays the
          utility or vendor directly, or orders the part and has it shipped.
          That is the guarantee against scams.
        </li>
        <li>
          <strong>Anonymous both ways.</strong> No names, no images — only
          the bill account number is shared, and only with the giver who
          claims the ask. Nobody can pressure anybody later, and nobody owes
          anybody anything once a bill is paid.
        </li>
        <li>
          <strong>A fulfilled ask disappears.</strong> Once a bill is paid,
          the ask leaves the board, so many givers cannot pay the same bill.
          If you cover your own need first, take your ask down — and if a
          giver pays it anyway, it just lands as a credit on the next bill.
        </li>
        <li>
          <strong>Verification is the payment itself.</strong> The money
          went to the actual utility or vendor — that is the proof. Any place
          that does not allow third-party payments simply cannot be used
          here.
        </li>
        <li>
          <strong>Free for the asker, always.</strong> It might help you get
          a need met, it might not, but it is totally free to try. That is
          the whole pitch — no fine print.
        </li>
      </ul>
      <h3>Keeping it honest</h3>
      <ul>
        <li>
          One met ask per bill account number per 30 days. Each bill has its
          own clock.
        </li>
        <li>
          $500 total per asker per 30 days. One bill met is a hand up, not a
          life-changing event.
        </li>
        <li>
          Every ask shows how many times that bill has been helped before —
          &ldquo;First time asking&rdquo; or &ldquo;Helped 3 times
          before.&rdquo; No name, no account number. Givers choose who to
          help, and the count helps the help spread to more people.
        </li>
        <li>
          Askers sign in with just a handle and a password. No real names or
          addresses are stored anywhere.
        </li>
      </ul>
      <h3>Why this version is out now</h3>
      <p>
        This version does one thing, and it does it right now: direct giving.
        You pick a bill, you pay it straight to the people who sent it, and
        the payment itself is the proof that somebody was helped. It
        doesn&rsquo;t need a lawyer, a board, or a bank account to work —
        because the platform never touches the money at all.
      </p>
      <p>
        The need is now. People are choosing between the light bill and
        groceries today, not after the paperwork is finished. So this part is
        out in the world helping people while the rest of it gets built
        properly, in the right order, with the right people checking the
        work.
      </p>
      <h3>The general fund — later, lawyer first</h3>
      <p>
        Later, there will be a general fund for people who want to give
        without picking one bill — and for the platform&rsquo;s own costs.
        That part needs a nonprofit registration, a board of directors, and a
        lawyer before a single dollar moves, and it will not launch until
        that groundwork is done. No single person will ever be able to sign
        for the fund alone.
      </p>
      <p>
        For now: one bill, one giver, paid directly. That&rsquo;s the whole
        app — and it&rsquo;s enough to start.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

function App() {
  const [view, setView] = useState<View>("board");
  const [me, setMe] = useState<MeData | null>(null);
  const [boardTick, setBoardTick] = useState(0);

  useEffect(() => {
    if (!getAuthToken()) return;
    fetchJSON("/api/accounts/me")
      .then((data) => setMe(data))
      .catch(() => {
        setAuthToken(null);
        setMe(null);
      });
  }, []);

  async function signOut() {
    try {
      await fetchJSON("/api/accounts/logout", { method: "POST" });
    } catch {
      // best effort
    }
    setAuthToken(null);
    setMe(null);
  }

  return (
    <div>
      <header>
        <div className="wrap">
          <h1>A Hand Up</h1>
          <p>Small bills. Paid directly. No cash ever touches the asker.</p>
          <p className="welcome">
            Welcome in — pull up a chair. Somebody here needs a hand, and
            somebody else can give it.
          </p>
        </div>
      </header>
      <nav>
        <div className="wrap">
          <button
            className={view === "board" ? "active" : ""}
            onClick={() => setView("board")}
          >
            Open Asks
          </button>
          <button
            className={view === "ask" ? "active" : ""}
            onClick={() => setView("ask")}
          >
            Ask for help
          </button>
          <button
            className={view === "yours" ? "active" : ""}
            onClick={() => setView("yours")}
          >
            Yours
          </button>
          <button
            className={view === "how" ? "active" : ""}
            onClick={() => setView("how")}
          >
            How it works
          </button>
          {me && (
            <button className="right" onClick={signOut}>
              Sign out ({me.handle})
            </button>
          )}
        </div>
      </nav>
      <main>
        {view === "board" && (
          <BoardView
            key={boardTick}
            onClaimed={() => setBoardTick((t) => t + 1)}
          />
        )}
        {view === "ask" && <AskView me={me} onAuthed={setMe} />}
        {view === "yours" && <YoursView me={me} />}
        {view === "how" && <HowView />}
      </main>
      <footer>
        Free for the asker, always. It might help you get a need met, it
        might not — but it is totally free to try.
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
