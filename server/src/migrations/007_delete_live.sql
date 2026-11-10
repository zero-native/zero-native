-- Delete with a 30-day hold, and the "live on Play / App Store" mark (Pavan, 2026-11-10).
-- A store build marked live can't be deleted, nor can its built-in bundle (phones on it need it as a patch base).
-- Anything else can be marked for delete: hidden in the dashboard, removed by the server at delete_at (30 days after
-- the mark), with an undo until then. The serial stays taken for good.
ALTER TABLE store_builds
  ADD COLUMN live_at timestamptz,
  ADD COLUMN live_by text,
  ADD COLUMN delete_at timestamptz,
  ADD COLUMN delete_by text;
ALTER TABLE bundles
  ADD COLUMN delete_at timestamptz,
  ADD COLUMN delete_by text;
