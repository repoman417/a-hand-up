import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Anonymous asker accounts. Handle + password only — no real names,
// addresses, emails or phones are ever stored. The internal number is the
// only identifier the system uses to track asks and enforce limits.
export const accounts = sqliteTable("accounts", {
  createdAt: integer("created_at").notNull(),
  handle: text("handle").notNull().unique(),
  id: integer("id").primaryKey({ autoIncrement: true }),
  internalNumber: integer("internal_number").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
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
export const asks = sqliteTable("asks", {
  accountId: integer("account_id").notNull(),
  accountNumber: text("account_number").notNull(),
  amountCents: integer("amount_cents").notNull(),
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
