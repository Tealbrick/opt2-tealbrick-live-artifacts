-- A link is approved either for a page that runs scripts (the owner read the "runs scripts" sentence) or for a page that does
-- not. scripts_ok = 0: the link always shows the scriptless render (CSP script-src 'none', scripts removed, data inlined), even
-- if a later version of the page gains scripts. FAIL CLOSED: the default is 0, so a link created without an explicit script
-- approval never runs scripts. Only createLink (after the sentence) and the owner's preview set 1.
ALTER TABLE la_link ADD COLUMN scripts_ok INTEGER NOT NULL DEFAULT 0 CHECK (scripts_ok IN (0, 1));
