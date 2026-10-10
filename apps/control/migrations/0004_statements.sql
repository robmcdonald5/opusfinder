-- The Cost page's ledger of what each vendor actually charged (owner decision 2026-10-10: statements from the
-- vendors' own invoice emails, no hand-maintained price table). One row per email the billing address
-- received, or per manual entry. Times are ISO-8601 UTC strings; dates (charged_on, period_start) YYYY-MM-DD;
-- month (YYYY-MM) is the month the charge is filed under: its service period's when the invoice states one,
-- else the charge date's. NULL until the charge date is known.
--   status: recorded (counted), review (waiting for the owner: amount unread, unknown currency, …),
--   duplicate (same charge already recorded), ignored (not a bill: e.g. Gmail's forwarding confirmation),
--   excluded (the owner chose not to count it).
-- note holds why a row needs review or was ignored; for Gmail's forwarding confirmation it holds the code,
-- which only the owner's page shows.
CREATE TABLE statement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('email', 'manual')),
  message_id TEXT UNIQUE,
  sender TEXT,
  subject TEXT,
  vendor TEXT,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('usage', 'credits', 'subscription', 'domain', 'other')),
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency TEXT,
  charged_on TEXT,
  period_start TEXT,
  month TEXT CHECK (month IS NULL OR month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('recorded', 'review', 'duplicate', 'ignored', 'excluded')),
  note TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;

CREATE INDEX statement_month ON statement (month, status);
