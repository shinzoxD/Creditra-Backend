-- Persist the off-chain utilized balance on credit_lines so draw/repay can
-- update state, ledger, and audit in one transaction without deriving the
-- figure solely from an eventually-consistent SUM of transactions.

ALTER TABLE credit_lines
ADD COLUMN utilized NUMERIC(28,8) NOT NULL DEFAULT 0;

COMMENT ON COLUMN credit_lines.utilized IS
  'Current utilized credit; mutated atomically with ledger and audit writes on draw/repay';
