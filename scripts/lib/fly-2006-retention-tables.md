# Retention classification fragments

Add one `fly-2006-retention-tables/<database>/<table>.json` for a new table.
The JSON has exactly `database`, `table`, and `classification` (tab indentation,
trailing newline). No manifest or common-test edit is needed for a protected table.
Classification requires review; it is never inferred from the actual schema.
A new delete target also requires its independent execution policy and tests.

The loader requires both nonempty database directories. It rejects extra files
(including dotfiles and editor backups), symlinks, nested directories, invalid
JSON, invalid identities/classifications and duplicate database/table identities.
Errors identify the relative path without printing file contents. Keep tooling
artifacts outside this policy directory.

`loadRetentionSnapshot(root)` takes the fragment directory URL. The two source
inputs are fixed sibling files `fly-2006-retention-loader.mjs` and
`fly-2006-retention-registry.mjs`; all input paths are relative to their module
directory (`scripts/lib`). The versioned digest includes those sources and each
fragment's exact bytes. The registry holds one frozen snapshot; digest requests
recheck its inputs and require a fresh process after changes.

The activation field `registrySha256` now covers this entire closure. Receipt and
manifest schema versions remain unchanged; old activation and unfinished
inventory evidence fail validation. Reauthorization follows the existing
operations procedure; there is no automatic resigning. Completed receipts remain
historical evidence. Rollback must revert loader, fragments, facade, and digest
consumers together, then obtain newly authorized inventory/activation as needed.

Quota tables retain current pause, recovery, install, and delivery references.
No quota deletion policy is authorized by the fleet rotation change.

Initialization tests independently observe actual tables and reject unregistered
ones. They do not establish a complete production schema: historical and lazy
tables need feature-specific coverage, and strict inventory still rejects missing
required tables. Removing the old duplicate global fixture also removes its
cross-copy typo check for registered tables absent from initialization.
