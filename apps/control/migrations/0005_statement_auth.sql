-- The billing mailbox's sender-authentication evidence (shadow, owner decision 2026-10-10): the SPF / DKIM /
-- DMARC / ARC verdicts the receiving server recorded on each accepted email, domains only (never a full
-- address). Read to decide what to enforce once real filter forwards have been seen. NULL for hand entries.
ALTER TABLE statement ADD COLUMN auth TEXT;
