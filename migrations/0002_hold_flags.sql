-- A hold text that was rendered for a call that did not match the page (it says "Do not approve") marks the call's input
-- digest. An approval of such a hold never runs: the call is refused with page_changed even if the page matches later.
CREATE TABLE la_hold_flag (
  input_digest TEXT PRIMARY KEY,            -- sha256 of the call input (the SDK's inputDigest)
  at INTEGER NOT NULL
);
