-- With the sanitized page (0003) the write also stores whether the page runs scripts and, when it does, the scriptless variant
-- (scripts and event handlers removed). A row without them is judged and rendered at serve time.
ALTER TABLE la_version ADD COLUMN served_runs_scripts INTEGER;
ALTER TABLE la_version ADD COLUMN served_plain_html BLOB;
