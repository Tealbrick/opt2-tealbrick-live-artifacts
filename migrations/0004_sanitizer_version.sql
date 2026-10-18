-- Which sanitizer rules produced la_version.served_html. A row whose version is older than the code's (or NULL: written by the first
-- release of the sanitizer, or restored from an older backup) is sanitized again when it is served, so a fix to the rules reaches
-- pages that are already stored.
ALTER TABLE la_version ADD COLUMN sanitizer_version INTEGER;
