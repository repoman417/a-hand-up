import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Anonymous asker accounts. Handle + password only — no real names,
// addresses, emails or phones are ever stored. The internal number is the
// only identifier the system uses to track asks and enforce limits.
export const accounts = sqliteTable("accounts", {
  createdAt: integer("created_at").notNull(),
  handle: text("handle").notNull().unique(),
  id: integer("id").primaryKey({ autoIncrement: true }),
  internalNumber: integer("internal_number").notNull().unique(),
  // Board-issued temp password (Nov 17, 2026): must_change_password is
  // set when the board resets the password; the asker must change it on
  // first login before doing anything else. temp_password_expires_at is
  // 24h after the reset, and is set to "now" the first time the temp
  // password logs in — so it expires after first login OR 24 hours,
  // whichever comes first.
  mustChangePassword: integer("must_change_password").notNull().default(0),
  passwordHash: text("password_hash").notNull(),
  tempPasswordExpiresAt: integer("temp_password_expires_at"),
});

// Asks. status: open | locked | met | withdrawn | expired | removed.
// The bill account number is stored here and is NEVER included in a public
// payload — it is shown only to the asker (their own ask) and to the giver
// who claimed the ask.
// Proof of payment (Fix 2): the giver submits a confirmation number and
// optionally a receipt image. proofConfirmation is shown to the asker, who
// confirms it cleared with the payee. The receipt image is shown blurred
// to the asker; the confirmation number is the readable part.
// Verified need (Fix 1): the asker may attach a bill photo (needProofPath)
// visible only to the board. needProofStatus: none | pending | verified |
// rejected. needVerified is set when all three board members approve.
// Gift cards (Nov 10, 2026): for Groceries asks the giver buys a gift
// card instead of paying a bill account. giftCardCode holds the card
// number + PIN the giver sends with the proof, shown readable to the
// asker only (ownAsk) — never in a public payload.
// Board removal (Nov 13, 2026): when all three board members agree an ask
// should come down, the board removes it with a reason. removedReason is
// shown to the asker on their own page next time they log in, with how to
// ask correctly — so a genuine asker learns instead of wondering where
// their ask went.
// Asker-confirm fallback (Nov 17, 2026): the giver paid but never
// uploaded proof, so the asker confirms with the confirmation number
// from their own bill. askerConfirmStatus: none | pending | verified |
// rejected. The ask only becomes met when the board verifies it (three
// of four approvals); a rejection lets the asker re-submit a corrected
// number.
export const asks = sqliteTable("asks", {
  accountId: integer("account_id").notNull(),
  accountNumber: text("account_number").notNull(),
  amountCents: integer("amount_cents").notNull(),
  askerConfirmation: text("asker_confirmation"),
  askerConfirmStatus: text("asker_confirm_status").notNull().default("none"),
  askerConfirmSubmittedAt: integer("asker_confirm_submitted_at"),
  category: text("category").notNull(),
  claimedAt: integer("claimed_at"),
  claimedByDevice: text("claimed_by_device"),
  createdAt: integer("created_at").notNull(),
  cutoffDate: text("cutoff_date"),
  dueDate: text("due_date"),
  giftCardCode: text("gift_card_code"),
  id: integer("id").primaryKey({ autoIncrement: true }),
  metAt: integer("met_at"),
  needProofPath: text("need_proof_path"),
  needProofStatus: text("need_proof_status").notNull().default("none"),
  needVerified: integer("need_verified").notNull().default(0),
  payee: text("payee").notNull(),
  proofConfirmation: text("proof_confirmation"),
  proofReceiptPath: text("proof_receipt_path"),
  proofSubmittedAt: integer("proof_submitted_at"),
  removedAt: integer("removed_at"),
  removedReason: text("removed_reason"),
  state: text("state").notNull(),
  status: text("status").notNull().default("open"),
});

// Board votes on verified need. One row per (ask, voter). Voters are the
// three board members: darin, maya, milo. Vote: approve | reject. All
// three must approve before the verified-need flag goes on; any reject
// marks the proof rejected.
export const needVotes = sqliteTable("need_votes", {
  askId: integer("ask_id").notNull(),
  createdAt: integer("created_at").notNull(),
  vote: text("vote").notNull(),
  voter: text("voter").notNull(),
});

// Sessions for signed-in askers. Token is a random UUID handed to the
// client; the client sends it as `Authorization: Bearer <token>`.
export const sessions = sqliteTable("sessions", {
  accountId: integer("account_id").notNull(),
  createdAt: integer("created_at").notNull(),
  token: text("token").primaryKey(),
});

// Forgot-password requests (Nov 17, 2026). No email exists and none is
// added: the request is tied to the browser/device that made it, via the
// X-Device-Token the client already sends (a UUID kept in localStorage).
// The board approves or rejects; then that same device can set a new
// password. status: pending | approved | rejected | used. decidedAt is
// when the board decided — an approval can be completed for 7 days.
export const passwordResets = sqliteTable("password_resets", {
  accountId: integer("account_id").notNull(),
  createdAt: integer("created_at").notNull(),
  decidedAt: integer("decided_at"),
  deviceToken: text("device_token").notNull(),
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status").notNull().default("pending"),
});

// Board votes on an asker-confirm (Nov 17, 2026). One row per
// (ask, voter). Voters are the four board members: darin, maya, milo,
// jason. Three distinct approvals verify the confirmation and the ask
// becomes met; any rejection rejects it.
export const askerConfirmVotes = sqliteTable("asker_confirm_votes", {
  askId: integer("ask_id").notNull(),
  createdAt: integer("created_at").notNull(),
  vote: text("vote").notNull(),
  voter: text("voter").notNull(),
});
