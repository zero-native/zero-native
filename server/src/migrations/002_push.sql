-- "Check for an update now" pushes (src/push.ts): which Firebase project sends them, and the longest wait per channel.
-- {} = no pushes for this app.
ALTER TABLE apps ADD COLUMN push jsonb NOT NULL DEFAULT '{}';
