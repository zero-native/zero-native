-- Dashboard sign-in (src/session.ts). `bun run updates dashboard` asks for a one-time code with the admin token; the
-- browser trades it for a session cookie. Only SHA-256 hashes are kept, never the code or the session id itself.
CREATE TABLE login_codes (
  code_hash text PRIMARY KEY,
  by text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
