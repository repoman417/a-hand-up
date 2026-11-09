import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema";

export const DATABASE_PATH =
  process.env.DATABASE_PATH || "./data/app.db";

// Uploads (receipt images + bill proofs) live next to the database so they
// survive on the same disk. Never served publicly without an access check.
export const UPLOAD_DIR =
  process.env.UPLOAD_DIR || join(dirname(DATABASE_PATH), "uploads");

function openDb(path: string): BunSQLiteDatabase<typeof schema> {
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const sqlite = new Database(path);
  // Create tables directly (no migration tooling needed for this size).
  // Kept in sync with src/schema.ts by hand.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      internal_number INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      payee TEXT NOT NULL,
      category TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      account_number TEXT NOT NULL,
      state TEXT NOT NULL,
      due_date TEXT,
      cutoff_date TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      claimed_by_device TEXT,
      met_at INTEGER,
      proof_confirmation TEXT,
      proof_submitted_at INTEGER,
      proof_receipt_path TEXT,
      need_proof_path TEXT,
      need_proof_status TEXT NOT NULL DEFAULT 'none',
      need_verified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS need_votes (
      ask_id INTEGER NOT NULL,
      voter TEXT NOT NULL,
      vote TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (ask_id, voter)
    );
    CREATE INDEX IF NOT EXISTS idx_asks_status ON asks (status);
    CREATE INDEX IF NOT EXISTS idx_asks_account_number ON asks (account_number);
    CREATE INDEX IF NOT EXISTS idx_asks_account_id ON asks (account_id);
    CREATE INDEX IF NOT EXISTS idx_need_votes_ask ON need_votes (ask_id);
  `);
  // Migrate older databases that were created before the proof columns
  // existed: SQLite has no ADD COLUMN IF NOT EXISTS, so check first.
  const cols = sqlite
    .query(`PRAGMA table_info(asks)`)
    .all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  const addColumn = (name: string, ddl: string) => {
    if (!have.has(name)) sqlite.exec(`ALTER TABLE asks ADD COLUMN ${ddl}`);
  };
  addColumn("proof_confirmation", "proof_confirmation TEXT");
  addColumn("proof_submitted_at", "proof_submitted_at INTEGER");
  addColumn("proof_receipt_path", "proof_receipt_path TEXT");
  addColumn("need_proof_path", "need_proof_path TEXT");
  addColumn("need_proof_status", "need_proof_status TEXT NOT NULL DEFAULT 'none'");
  addColumn("need_verified", "need_verified INTEGER NOT NULL DEFAULT 0");
  return drizzle(sqlite, { schema });
}

export const db = openDb(DATABASE_PATH);
