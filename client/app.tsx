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

// Multipart (file upload) variant: no JSON content-type — the browser sets
// the boundary. Auth + device headers still go along.
async function fetchForm(path: string, form: FormData): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    const token = getAuthToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    headers["X-Device-Token"] = getDeviceToken();
    const res = await fetch(path, {
      body: form,
      headers,
      method: "POST",
      signal: ctrl.signal,
    });
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

function getBoardToken(): string | null {
  return localStorage.getItem("ahu-board-token");
}

function setBoardToken(token: string | null) {
  if (token) localStorage.setItem("ahu-board-token", token);
  else localStorage.removeItem("ahu-board-token");
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
  needVerified: boolean;
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
  proofConfirmation: string | null;
  proofSubmittedAt: number | null;
  hasReceipt: boolean;
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
  needVerified: boolean;
  needProofStatus: string;
  proofConfirmation: string | null;
  proofSubmittedAt: number | null;
  giftCardCode: string | null;
  hasReceipt: boolean;
  removedAt: number | null;
  removedReason: string | null;
};

type MeData = {
  handle: string;
  internalNumber: number;
  helpedCount: number;
  usedCents: number;
  remainingCents: number;
};

type View = "board" | "ask" | "yours" | "how" | "review";

// Plain words for an ask's status on the asker's own page — never the raw
// word "locked".
function statusLabel(status: string): string {
  if (status === "open") return "Open — on the board";
  if (status === "locked") return "Claimed — a helper has it right now";
  if (status === "met") return "Met — thank you";
  if (status === "withdrawn") return "Withdrawn";
  if (status === "expired") return "Expired — off the board after 30 days";
  if (status === "removed") return "Removed by the board";
  return status;
}

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
// Payment proof form (giver side) — shared by the board and Yours views
// ---------------------------------------------------------------------------

function ProofForm({ askId, category, onSubmitted, onError }: {
  askId: number;
  category: string;
  onSubmitted: () => void;
  onError: (msg: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [giftCard, setGiftCard] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const form = new FormData();
      form.append("confirmation", confirmation);
      if (giftCard.trim()) form.append("giftCard", giftCard.trim());
      if (file) form.append("receipt", file);
      await fetchForm(`/api/asks/${askId}/submit-proof`, form);
      onSubmitted();
    } catch (err: any) {
      onError(err.message || "Could not send the proof.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>
        Payment confirmation number
        <input
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder="The confirmation number from the payee"
          autoComplete="off"
        />
      </label>
      {category === "Groceries" && (
        <label>
          Gift card number + PIN
          <span className="hint">
            {" "}(for grocery asks — the asker sees this and uses it to spend the card)
          </span>
          <input
            value={giftCard}
            onChange={(e) => setGiftCard(e.target.value)}
            placeholder="The gift card number and PIN"
            autoComplete="off"
          />
        </label>
      )}
      <label>
        Receipt photo <span className="hint">(optional — helps the asker check it)</span>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
      </label>
      <div className="btn-row">
        <button className="btn" type="submit" disabled={busy || !confirmation.trim()}>
          {busy ? "Sending…" : "Send payment proof"}
        </button>
      </div>
    </form>
  );
}

// A claimed ask on the giver side: pay details, proof form, cancel.
function GiverClaimCard({ ask, onReleased, onProofSubmitted, onError }: {
  ask: ClaimedAsk;
  onReleased: () => void;
  onProofSubmitted: () => void;
  onError: (msg: string) => void;
}) {
  async function release() {
    try {
      await fetchJSON(`/api/asks/${ask.id}/release`, { method: "POST" });
      onReleased();
    } catch (e: any) {
      onError(e.message || "Could not release this ask.");
    }
  }

  return (
    <div className="card">
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
          <p>
            No cash goes to the asker, ever. Once you&rsquo;ve paid, send the
            confirmation number below so the asker can check it with the
            payee — that&rsquo;s what takes the ask off the board.
          </p>
        </div>
      )}
      {ask.status === "locked" && (
        <>
          {ask.proofConfirmation ? (
            <div className="notice">
              Proof sent — confirmation <code>{ask.proofConfirmation}</code>.
              Waiting for the asker to confirm it cleared with the payee.
            </div>
          ) : (
            <ProofForm
              askId={ask.id}
              category={ask.category}
              onSubmitted={onProofSubmitted}
              onError={onError}
            />
          )}
          <div className="btn-row">
            <button className="btn secondary" onClick={release}>
              Cancel this claim
            </button>
          </div>
        </>
      )}
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
      setClaimed((prev) => ({
        ...prev,
        [ask.id]: {
          ...data.ask,
          hasReceipt: false,
          proofConfirmation: null,
          proofSubmittedAt: null,
          status: "locked",
        },
      }));
      setAsks((prev) => (prev || []).filter((a) => a.id !== ask.id));
      onClaimed();
    } catch (e: any) {
      setClaimError(e.message || "Could not claim this ask.");
    } finally {
      setClaimingId(null);
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
        <p className="cap-note">
          Up to $500 in help every 30 days, so more neighbors can get
          support — and when you&rsquo;re able, you can help the next person.
        </p>
        <p className="cap-note">
          Help isn&rsquo;t guaranteed — it depends on a neighbor choosing to
          give. You may get nothing, and that&rsquo;s okay.
        </p>
      </div>

      {claimError && <div className="error">{claimError}</div>}

      {Object.entries(claimed).map(([id, ask]) => (
        <GiverClaimCard
          key={`claimed-${id}`}
          ask={ask}
          onReleased={() => {
            setClaimed((prev) => {
              const next = { ...prev };
              delete next[Number(id)];
              return next;
            });
            load();
          }}
          onProofSubmitted={() => {
            setClaimed((prev) => ({
              ...prev,
              [Number(id)]: {
                ...(prev as any)[Number(id)],
                proofConfirmation: "sent",
              },
            }));
          }}
          onError={(msg) => setClaimError(msg)}
        />
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
          {ask.needVerified && (
            <span className="badge verified">Verified need</span>
          )}
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
  const [needProof, setNeedProof] = useState<File | null>(null);
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
      if (needProof) {
        const form = new FormData();
        form.append("payee", payee);
        form.append("category", category);
        form.append("amount", amount);
        form.append("accountNumber", accountNumber);
        form.append("state", state);
        form.append("dueDate", dueDate || "");
        form.append("cutoffDate", cutoffDate || "");
        form.append("needProof", needProof);
        await fetchForm("/api/asks", form);
      } else {
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
      }
      setDone(true);
      setPayee("");
      setAmount("");
      setAccountNumber("");
      setState("");
      setDueDate("");
      setCutoffDate("");
      setNeedProof(null);
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
          <label>
            Photo of the bill <span className="hint">(optional — only the board sees it, never public)</span>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setNeedProof(e.target.files?.[0] || null)}
            />
          </label>
          <p className="hint">
            If you attach a bill photo, cover or blur your name and address
            first — just the payee and the amount need to show. The board
            checks it and marks your ask &ldquo;Verified need&rdquo; when it
            all lines up.
          </p>
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

// Image served behind an access check: fetched with the same auth and
// device headers as the API, then shown from a blob URL.
function AuthedImage({ src, alt, blurred, extraHeaders }: {
  src: string;
  alt: string;
  blurred?: boolean;
  extraHeaders?: Record<string, string>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    const ctrl = new AbortController();
    (async () => {
      try {
        const headers: Record<string, string> = {};
        const token = getAuthToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
        headers["X-Device-Token"] = getDeviceToken();
        Object.assign(headers, extraHeaders || {});
        const res = await fetch(src, { headers, signal: ctrl.signal });
        if (!res.ok) throw new Error("load failed");
        const blob = await res.blob();
        if (alive) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed) return <p className="hint">Image could not be loaded.</p>;
  if (!url) return <p className="hint">Loading image…</p>;
  return (
    <img
      src={url}
      alt={alt}
      style={blurred ? { filter: "blur(6px)", maxWidth: "100%" } : { maxWidth: "100%" }}
    />
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

  // The asker confirms the giver's proof cleared with the payee.
  async function askerConfirm(id: number) {
    try {
      await fetchJSON(`/api/asks/${id}/confirm-paid`, { method: "POST" });
      setNotice("Thank you — that need is met, and the ask is off the board for good.");
      await load();
    } catch (e: any) {
      setError(e.message || "Could not confirm the payment.");
    }
  }

  // The asker says the proof did not clear: the ask goes back on the board.
  async function rejectProof(id: number) {
    try {
      await fetchJSON(`/api/asks/${id}/reject-proof`, { method: "POST" });
      setNotice("That proof didn't clear — the ask is back on the board for someone else to help with.");
      await load();
    } catch (e: any) {
      setError(e.message || "Could not reject the proof.");
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
          <GiverClaimCard
            key={ask.id}
            ask={ask}
            onReleased={() => {
              setNotice("Released — the ask is back on the board for someone else to help with.");
              load();
            }}
            onProofSubmitted={() => load()}
            onError={(msg) => setError(msg)}
          />
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
              Status: <span className={`status ${ask.status}`}>{statusLabel(ask.status)}</span>
              {" — "}account number: <code>{ask.accountNumber}</code>
            </p>
            {ask.needVerified && (
              <p><span className="badge verified">Verified need</span></p>
            )}
            {ask.status === "removed" && ask.removedReason && (
              <div className="pay-box">
                <p style={{ marginTop: 0 }}>
                  The board removed this ask. Their reason:
                </p>
                <p style={{ marginTop: 0 }}><strong>{ask.removedReason}</strong></p>
                <p>
                  If this was a genuine need, you can post a new ask any
                  time — see &ldquo;How it works&rdquo; for how to ask for
                  gas, food, and other needs.
                </p>
              </div>
            )}
            {ask.status === "locked" && ask.proofConfirmation && (
              <div className="pay-box">
                <p style={{ marginTop: 0 }}>
                  Payment proof sent — confirmation number:{" "}
                  <code>{ask.proofConfirmation}</code>
                </p>
                {ask.giftCardCode && (
                  <p style={{ marginTop: 0 }}>
                    Gift card code: <code>{ask.giftCardCode}</code>
                    {" "}— spend this at the store; it is shown to you only.
                  </p>
                )}
                <p>
                  Check that number with the payee. If it cleared, confirm
                  it below and the ask comes off the board for good.
                </p>
                {ask.hasReceipt && (
                  <AuthedImage
                    src={`/api/asks/${ask.id}/receipt`}
                    alt="Payment receipt (blurred)"
                    blurred
                  />
                )}
                <div className="btn-row">
                  <button className="btn" onClick={() => askerConfirm(ask.id)}>
                    Confirm it cleared
                  </button>
                  <button className="btn secondary" onClick={() => rejectProof(ask.id)}>
                    That didn&rsquo;t clear
                  </button>
                </div>
              </div>
            )}
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
// Board review — verified need (Fix 1)
// ---------------------------------------------------------------------------

type ReviewAsk = {
  id: number;
  payee: string;
  category: string;
  amount: number;
  state: string;
  createdAt: number;
  needProofStatus: string;
  needVerified: boolean;
  votes: { voter: string; vote: string }[];
};

function ReviewView() {
  const [token, setToken] = useState(getBoardToken() || "");
  const [asks, setAsks] = useState<ReviewAsk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voter, setVoter] = useState("darin");
  const [removeId, setRemoveId] = useState("");
  const [removeReason, setRemoveReason] = useState("");

  async function boardFetch(path: string, opts: RequestInit = {}): Promise<any> {
    const headers: Record<string, string> = {
      "X-Board-Token": token,
      "X-Device-Token": getDeviceToken(),
      ...(opts.headers as Record<string, string> | undefined),
    };
    if (opts.body && typeof opts.body === "string") {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  async function load() {
    setError(null);
    setNotice(null);
    try {
      const data = await boardFetch("/api/board/review");
      setAsks(data.asks);
    } catch (e: any) {
      setError(e.message || "Could not load the review queue.");
      setAsks(null);
    }
  }

  async function vote(askId: number, vote: "approve" | "reject") {
    setError(null);
    try {
      const data = await boardFetch(`/api/board/review/${askId}/vote`, {
        body: JSON.stringify({ vote, voter }),
        method: "POST",
      });
      setNotice(
        data.needVerified
          ? "All three agreed — that ask is now marked Verified need."
          : data.needProofStatus === "rejected"
            ? "Rejected — that proof will not be marked verified."
            : "Vote recorded.",
      );
      await load();
    } catch (e: any) {
      setError(e.message || "Could not record the vote.");
    }
  }

  function saveToken() {
    setBoardToken(token || null);
    load();
  }

  // Board removal (Nov 13, 2026): only after all three board members
  // agree in conversation. The reason is shown to the asker on their own
  // page next time they log in, with how to ask correctly.
  async function removeAsk() {
    setError(null);
    setNotice(null);
    const id = Number(removeId);
    if (!Number.isInteger(id) || id <= 0) {
      setError("Enter the ask number to remove.");
      return;
    }
    if (!removeReason.trim()) {
      setError("A reason is required — the asker sees it.");
      return;
    }
    try {
      await boardFetch(`/api/board/remove/${id}`, {
        body: JSON.stringify({ reason: removeReason.trim() }),
        method: "POST",
      });
      setNotice(`Ask ${id} removed. The asker will see the reason on their page.`);
      setRemoveId("");
      setRemoveReason("");
      await load();
    } catch (e: any) {
      setError(e.message || "Could not remove the ask.");
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Board review</h2>
        <p>
          Bill photos attached to asks, for the board — Darin, Maya, and
          Milo. All three vote on each one: the amount matches, no personal
          info shows, and it&rsquo;s an allowed bill type. All three
          approvals mark the ask &ldquo;Verified need&rdquo;; any rejection
          turns it down.
        </p>
        <label>
          Board token
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste the board token"
            autoComplete="off"
          />
        </label>
        <div className="btn-row">
          <button className="btn" onClick={saveToken}>Load the queue</button>
        </div>
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
      </div>
      {asks && asks.length === 0 && (
        <div className="card empty">Nothing waiting for review.</div>
      )}
      {asks && asks.map((ask) => (
        <div className="card" key={ask.id}>
          <div className="ask-head">
            <h3>{ask.payee}</h3>
            <span className="amount">{money(ask.amount)}</span>
          </div>
          <p className="meta">{ask.category} — {ask.state}</p>
          <AuthedImage
            src={`/api/asks/${ask.id}/need-proof`}
            alt="Bill photo for review"
            extraHeaders={{ "X-Board-Token": token }}
          />
          <p>
            Votes:{" "}
            {ask.votes.length === 0
              ? "none yet"
              : ask.votes.map((v) => `${v.voter}: ${v.vote}`).join(", ")}
          </p>
          <label>
            Voting as
            <select value={voter} onChange={(e) => setVoter(e.target.value)}>
              <option value="darin">Darin</option>
              <option value="maya">Maya</option>
              <option value="milo">Milo</option>
            </select>
          </label>
          <div className="btn-row">
            <button className="btn" onClick={() => vote(ask.id, "approve")}>
              Approve
            </button>
            <button className="btn secondary" onClick={() => vote(ask.id, "reject")}>
              Reject
            </button>
          </div>
        </div>
      ))}
      <div className="card">
        <h2>Remove an ask</h2>
        <p>
          Only after all three board members agree in conversation. The
          reason is shown to the asker on their own page next time they log
          in, with how to ask correctly — so a genuine asker learns instead
          of wondering where their ask went.
        </p>
        <label>
          Ask number
          <input
            value={removeId}
            onChange={(e) => setRemoveId(e.target.value)}
            placeholder="e.g. 11"
            autoComplete="off"
          />
        </label>
        <label>
          Reason — the asker sees this
          <textarea
            value={removeReason}
            onChange={(e) => setRemoveReason(e.target.value)}
            placeholder="Why this ask came down, and how to ask it correctly."
            rows={3}
          />
        </label>
        <div className="btn-row">
          <button className="btn danger" onClick={removeAsk}>
            Remove this ask
          </button>
        </div>
      </div>
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
          <strong>A fulfilled ask disappears.</strong> Once a bill is paid
          and the asker confirms the payment&rsquo;s confirmation number
          with the payee, the ask leaves the board, so many givers cannot
          pay the same bill. If you cover your own need first, take your
          ask down — and if a giver pays it anyway, it just lands as a
          credit on the next bill.
        </li>
        <li>
          <strong>Verification is the payment itself, with proof.</strong>
          The giver sends the payment&rsquo;s confirmation number — and a
          receipt photo if they have one. The asker checks that number with
          the payee and confirms it cleared. No proof, no &ldquo;paid.&rdquo;
          A claim with no proof unlocks after about a day, so someone else
          can try. Any place that does not allow third-party payments
          simply cannot be used here.
        </li>
        <li>
          <strong>Verified need.</strong> An asker can attach a photo of
          the bill — name and address covered first, just the payee and
          the amount showing. The board — Darin, Maya, and Milo, all three
          voting — checks it and marks the ask &ldquo;Verified
          need&rdquo; when the amount matches and nothing personal shows.
        </li>
        <li>
          <strong>Asks live for 30 days.</strong> An ask stays on the board
          for 30 days, even past its due date — a late payment still helps
          the next bill. After 30 days it expires off the board.
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
        the payment itself — with the confirmation number to prove it — is
        the proof that somebody was helped. It doesn&rsquo;t need a lawyer
        or a bank account to work — because the platform never touches the
        money at all. A small board — Darin, Maya, and Milo — checks bill
        photos and payment proofs.
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
          <button
            className={view === "review" ? "active" : ""}
            onClick={() => setView("review")}
          >
            Board review
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
        {view === "review" && <ReviewView />}
      </main>
      <footer>
        Free for the asker, always. It might help you get a need met, it
        might not — but it is totally free to try.
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
