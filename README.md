# A Hand Up — anonymous giving app

Small asks, paid directly. Someone with a small, real need (a light bill,
a furnace part, groceries) posts the ask, and a stranger pays the bill or
orders the part directly at the payee. No cash ever goes to the asker.

## The rules, in short

- Small asks only — $5 to $500.
- The giver pays the payee directly; the platform never touches the money.
- Anonymous both ways — no names, no images. Only the bill account number
  is shared, and only with the giver who claims the ask.
- A fulfilled ask disappears from the board for good.
- One met ask per bill account number per 30 days.
- $500 rolling total per asker per 30 days (met + currently-locked asks).
- Every ask shows a help-count badge: "First time asking" or
  "Helped 3 times before". No name, no account number.
- Free for the asker, always.

## Run locally

Requires [Bun](https://bun.sh) 1.x.

```sh
bun install
bun run build     # bundles the React client into ./public
bun run start     # serves the app on http://localhost:3000
```

Or in one step for development:

```sh
bun run dev
```

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on. Render sets this itself. |
| `DATABASE_PATH` | `./data/app.db` | Where the SQLite file lives. On Render, point it at the persistent disk (`/var/data/app.db` — see `render.yaml`). |

The database file is created automatically on first boot, including all
tables. No migration step.

## Test

```sh
# Terminal 1 — boot against a throwaway database:
rm -f /tmp/test-app.db
DATABASE_PATH=/tmp/test-app.db bun run dev

# Terminal 2 — run the end-to-end checks:
TEST_DB=/tmp/test-app.db BASE_URL=http://localhost:3000 bun run test
```

The test exercises the full loop: account creation, posting an ask,
the public board never leaking the account number, claim → confirm paid,
the proof strip, the per-bill 30-day rejection, the $500 rolling cap
($300 then $200), wrong-password login, wrong-device confirm, release,
withdraw, and the help-count badge.

## What is needed next (not part of this step)

1. A git repo for this project (GitHub or similar).
2. A Render account, with a card on file for the ~$7.25/mo
   (Starter web service $7 + 1 GB persistent disk $0.25).
3. Deploy from the repo with the included `render.yaml` blueprint
   (or create the web service by hand with the same settings:
   Bun environment, build `bun install && bun run build`,
   start `bun run start`, disk mounted at `/var/data`,
   `DATABASE_PATH=/var/data/app.db`).
4. Share the `*.onrender.com` link. A custom domain is optional later.

## Notes for the deployer

- The app has no owner credit anywhere — no names on the pages, in the
  code comments, or in the service name.
- The launch board starts empty. Do not seed it with test asks or test
  accounts; the first real ask is the first real ask.
- If the database file is ever lost, accounts, asks and totals are lost
  with it. That is why it lives on the persistent disk, never on the
  service's ephemeral filesystem.
