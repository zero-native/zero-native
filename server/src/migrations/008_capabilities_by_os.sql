-- A phone's capabilities were learned into every store build with the same built-in serial and bytes, whatever its OS
-- (model.ts learnCapabilities, fixed 2026-11-12): an Android phone filled an IPA's row. Clear the rows whose learned
-- facts are for another OS (a phone that sends no OS is an Android one), so a phone of the right OS fills them again.
-- Pavan's go, 2026-11-12 (on ZeroBill it is only IPA 1.6.2 (1)).
UPDATE store_builds
   SET capabilities = NULL, family = NULL
 WHERE capabilities IS NOT NULL
   AND COALESCE(capabilities->>'os', 'android') <> os;
