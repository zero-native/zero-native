-- Store update rules per channel. A rule is for the phones of one channel: a staging rule never reaches a production
-- phone (the phone's check names its channel). Rules made before this belong to production.
ALTER TABLE store_rules ADD COLUMN channel text NOT NULL DEFAULT 'production';
ALTER TABLE store_rules DROP CONSTRAINT store_rules_app_os_version_key;
ALTER TABLE store_rules ADD CONSTRAINT store_rules_app_os_channel_version_key UNIQUE (app, os, channel, version);
