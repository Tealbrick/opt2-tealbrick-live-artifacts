-- A link is approved either for a page that runs scripts (the owner read the "runs scripts" sentence) or for a page that does
-- not. scripts_ok = 0: the link always shows the scriptless render (CSP script-src 'none', scripts removed, data inlined), even
-- if a later version of the page gains scripts. Links that exist before this migration keep what they had (1).
ALTER TABLE la_link ADD COLUMN scripts_ok INTEGER NOT NULL DEFAULT 1 CHECK (scripts_ok IN (0, 1));
