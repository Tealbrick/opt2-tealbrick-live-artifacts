-- The sanitized page code of a version, stored when the version is written (versions are immutable). The viewer serves this
-- column; a row without it (written before this migration, or restored from an older backup) is sanitized at serve time.
ALTER TABLE la_version ADD COLUMN served_html BLOB;
