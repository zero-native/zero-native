-- OTA patches (docs/ota-patches.md §3, §5). One row per patch zip: it turns the bundle `from_sha256` (an older bundle,
-- or a store build's built-in bundle) into the bundle `to_id`. The zip is stored at <app>/patches/<to id>/<from sha>.zip.
CREATE TABLE patches (
  app text NOT NULL REFERENCES apps(id),
  to_id text NOT NULL,                       -- the bundle the patch makes: <app>_<serial>
  from_id text NOT NULL,                     -- the base bundle's id (an OTA bundle, or a store build's built-in bundle)
  from_sha256 text NOT NULL,                 -- the base's bundle SHA-256: the phone's own SHA must match it
  path text NOT NULL,
  sha256 text NOT NULL,                      -- SHA-256 of the patch zip
  size int NOT NULL,
  made_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app, to_id, from_sha256)
);

-- A store build's built-in bundle, uploaded as a zip (the same format as a release zip), is a base for patches.
-- Stored at <app>/bases/<bundle sha>.zip. A store build made before this has none (its phones get full zips).
ALTER TABLE store_builds ADD COLUMN base_path text, ADD COLUMN base_size int;
