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

// Asks. status: open | locked | met | withdrawn.
// The bill account number is stored here and is NEVER included in a public
// payload — it is shown only to the asker (their own ask) and to the giver
// who claimed the ask.
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
  id: integer("id").primaryKey({ autoIncrement: true }),
  metAt: integer("met_at"),
  payee: text("payee").notNull(),
  state: text("state").notNull(),
  status: text("status").notNull().default("open"),
});

// Sessions for signed-in askers. Token is a random UUID handed to the
// client; the client sends it as `Authorization: Bearer <token>`.
export const sessions = sqliteTable("sessions", {
  accountId: integer("account_id").notNull(),
  createdAt: integer("created_at").notNull(),
  token: text("token").primaryKey(),
});
