import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

export const DATABASE_PATH =
  process.env.DATABASE_PATH || "./data/app.db";

function openDb(path: string): BunSQLiteDatabase<typeof schema> {
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
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
      met_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asks_status ON asks (status);
    CREATE INDEX IF NOT EXISTS idx_asks_account_number ON asks (account_number);
    CREATE INDEX IF NOT EXISTS idx_asks_account_id ON asks (account_id);
  `);
  return drizzle(sqlite, { schema });
}

export const db = openDb(DATABASE_PATH);
