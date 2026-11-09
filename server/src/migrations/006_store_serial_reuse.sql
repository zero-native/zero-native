-- One bundle = one serial = one SHA-256 (also for a store build's built-in bundle).
-- Before: the same-bytes rule held only between OTA bundles; a store build always took a new number.
-- Now a store build's serial records its bytes too, and any serial of the app (bundle or store) with the same bytes
-- and needs is given back. Serials made before this have no bytes recorded (NULLs are never equal), so nothing clashes.
DROP INDEX serials_same_bytes;
CREATE UNIQUE INDEX serials_same_bytes ON serials (app, bundle_sha256, requires_line);

-- Two store builds (for example an AAB and an IPA, or two builds of the same JS) can have the same built-in serial.
-- The same build recorded twice (same OS, channel, version code and serial) is still one row.
ALTER TABLE store_builds DROP CONSTRAINT store_builds_app_builtin_serial_key;
ALTER TABLE store_builds ADD CONSTRAINT store_builds_same_build_key UNIQUE (app, os, channel, version_code, builtin_serial);
