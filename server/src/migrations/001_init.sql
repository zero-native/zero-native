-- zn-updates first schema (docs/zn-updates-server.md §3). Append-only where it matters: pointers are never changed or
-- deleted (the highest seq is what a channel serves); bundles keep their facts, only their marks change.

CREATE TABLE apps (
  id text PRIMARY KEY,                       -- the zn app id (zn-bundle.json "app"), e.g. zerobill
  name text NOT NULL,
  public_keys jsonb NOT NULL DEFAULT '[]',   -- base64 SPKI DER, main key first, the offline backup second
  -- Store facts per OS, e.g. {"android":{"packages":{"com.example.app":"production"}},
  --   "ios":{"appStoreId":"1234567890","bundles":{"com.example.app.ios":"production"}}}: which store package is which channel
  store jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  app text NOT NULL REFERENCES apps(id),
  name text NOT NULL,                        -- staging, production, ...
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app, name)
);

-- One serial line per app, shared by OTA bundles and store builds' built-in bundles: bigger = newer, never reused.
CREATE TABLE serials (
  app text NOT NULL REFERENCES apps(id),
  serial int NOT NULL,
  kind text NOT NULL,                        -- bundle | store
  bundle_sha256 text,                        -- the bytes it was taken for (same bytes + same requires = same serial)
  requires_line text,
  taken_by text NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app, serial)
);
CREATE UNIQUE INDEX serials_same_bytes ON serials (app, bundle_sha256, requires_line) WHERE kind = 'bundle';

CREATE TABLE bundles (
  app text NOT NULL REFERENCES apps(id),
  serial int NOT NULL,
  id text NOT NULL,                          -- <app>_<serial>
  bundle_sha256 text NOT NULL,
  requires jsonb NOT NULL,
  zip_path text NOT NULL,
  zip_sha256 text NOT NULL,
  zip_size int NOT NULL,
  manifest jsonb NOT NULL,                   -- the signed manifest, exactly what phones get
  git_commit text NOT NULL,
  git_subject text NOT NULL DEFAULT '',
  git_dirty boolean NOT NULL,
  built_by text NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  stable_at timestamptz,
  stable_by text,
  stable_note text,
  customer_title text,                       -- what customers see for this update; empty = a silent fix
  note text,
  PRIMARY KEY (app, serial),
  UNIQUE (app, id)
);

CREATE TABLE store_builds (
  id serial PRIMARY KEY,
  app text NOT NULL REFERENCES apps(id),
  os text NOT NULL,                          -- android | ios
  channel text NOT NULL,
  label text NOT NULL,                       -- "production AAB", "staging APK", ...
  version_code int NOT NULL,                 -- Android versionCode; iOS build number
  version_name text NOT NULL,                -- "1.7.0"
  builtin_serial int NOT NULL,               -- the serial stamped into its built-in bundle (from `serials`)
  builtin_sha256 text NOT NULL,
  -- What this build can run (registry, bytecode, hostApi, modules): sent by the CLI if it knows, else learned from the
  -- first phone check that runs this build (its built-in serial), which is exact.
  capabilities jsonb,
  family text,                               -- a hash of the capabilities: builds that can run the same bundles
  git_commit text NOT NULL,
  git_dirty boolean NOT NULL,
  built_by text NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app, builtin_serial)
);

CREATE TABLE pointers (
  app text NOT NULL REFERENCES apps(id),
  channel text NOT NULL,
  seq int NOT NULL,
  target text NOT NULL,                      -- a bundle id, or BUILT_IN (the kill switch)
  rollout int NOT NULL,
  priority text NOT NULL,                    -- normal | high
  kind text NOT NULL,                        -- publish | rollback | rollout | kill
  reason text,
  pointer jsonb NOT NULL,                    -- the signed pointer, exactly what phones get
  published_by text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app, channel, seq),
  FOREIGN KEY (app, channel) REFERENCES channels(app, name)
);

-- Play / App Store update rules (same meaning as the RN backend's STORE_UPDATE rows): phones below the version are
-- asked to update. Test rows count only for phones whose own version is a test row.
CREATE TABLE store_rules (
  id serial PRIMARY KEY,
  app text NOT NULL REFERENCES apps(id),
  os text NOT NULL,
  version int NOT NULL,                      -- Android versionCode; iOS "1.6.2" as 1006002 (see storeRules.ts)
  critical int NOT NULL,                     -- 0 nothing, 1 optional, 2 forced
  is_test boolean NOT NULL DEFAULT false,
  title text,                                -- optional text for the app's own update screen
  message text,
  note text,
  by text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app, os, version)
);

-- Stats: one row per phone per day, events counted per day. Kept 35 days.
CREATE TABLE installs_daily (
  day date NOT NULL,
  app text NOT NULL,
  channel text NOT NULL,
  install text NOT NULL,                     -- SHA-256 of the install id (never the id itself)
  running text NOT NULL,                     -- bundle id, or built-in:<id>
  checks int NOT NULL DEFAULT 1,
  PRIMARY KEY (day, app, channel, install)
);

CREATE TABLE events_daily (
  day date NOT NULL,
  app text NOT NULL,
  channel text NOT NULL,
  bundle text NOT NULL,
  kind text NOT NULL,
  detail text NOT NULL DEFAULT '',
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, app, channel, bundle, kind, detail)
);

CREATE TABLE errors (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  app text NOT NULL,
  channel text NOT NULL,
  bundle text NOT NULL,
  kind text NOT NULL,
  detail text,
  stack text,
  sha text
);
CREATE INDEX errors_recent ON errors (app, at DESC);

CREATE TABLE activity (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  app text,
  by text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX activity_recent ON activity (app, at DESC);
