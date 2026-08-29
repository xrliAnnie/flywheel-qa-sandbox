# Dependency Build Policy (FLY-153)

## Why this exists

Workspace `package.json` pins two pnpm 10+ allowlists that gate transitive
package install / postinstall scripts:

```json
"pnpm": {
  "onlyBuiltDependencies": ["better-sqlite3"],
  "ignoredBuiltDependencies": ["esbuild", "protobufjs"]
}
```

The lists are a **deliberate security stance**: by default, no transitive
dependency is allowed to run install scripts (which would otherwise execute
arbitrary code at `pnpm install` time, expanding our supply-chain attack
surface). Each name in the allowlists is an explicit audit decision.

## How the two lists differ

| List | Effect |
|------|--------|
| `onlyBuiltDependencies` | Permit-list. The named packages MAY run their install / postinstall scripts. Everything else is blocked. |
| `ignoredBuiltDependencies` | Silence-list. The named packages are blocked AND pnpm suppresses the "ignored build scripts" warning for them. Use this when we have audited the package and decided we don't need its build script to run. |

Adding a name to `onlyBuiltDependencies` is a **trust** decision (the
script will run with full `node` privileges). Adding a name to
`ignoredBuiltDependencies` is a **noise-suppression** decision (we have
intentionally chosen not to run the script and want the install log clean).

## Current entries

### `onlyBuiltDependencies`

- **`better-sqlite3`** — Native SQLite binding used by `flywheel-comm` (CommDB) and `inbox-mcp`. Without the install script (`prebuild-install || node-gyp rebuild`) the `.node` file never lands and Bridge / Lead crash with `Could not locate the bindings file` at first DB write. Audited 2026-05-13 (FLY-153).

### `ignoredBuiltDependencies`

- **`esbuild`** — postinstall fetches a platform-specific binary. pnpm's own platform-dep mechanism handles this independently, so the postinstall is a no-op for our usage. Suppressed to keep `pnpm install` quiet. Audited 2026-05-13.
- **`protobufjs`** — postinstall sets up some lazy paths. Not load-bearing for our consumers (gRPC tools / proto codegen are not on hot paths). Audited 2026-05-13.

## Adding a new native / build-script dependency

When you add a package whose `install` or `postinstall` script must run:

1. Add the package name to `pnpm.onlyBuiltDependencies` in workspace `package.json`.
2. Add a one-line audit note here under "Current entries", with the date and the issue number that introduced the dep.
3. Run `rm -rf node_modules && pnpm install` and verify the script actually ran (e.g. for native modules check for `node_modules/.pnpm/<pkg>@*/node_modules/<pkg>/build/Release/<binary>.node`). Existing worktrees that already installed with the old policy may need `pnpm install --force` to re-evaluate build-script approvals.
4. Run `bash scripts/test-deploy.sh --mode mirror 1` end-to-end to confirm the QA framework preflight is happy. The preflight in `scripts/test-deploy.sh` keeps a defense-in-depth direct-compile path for `better-sqlite3` specifically; new deps don't get that fallback unless added to the preflight too.

When a transitive package emits an "ignored build scripts" warning that you're sure you don't need:

1. Audit what the script does. Check the package's repo / changelog / npm entry.
2. If the script is non-load-bearing for our usage, add the name to `pnpm.ignoredBuiltDependencies`.
3. Note it here with the audit date.

**Never just delete the `onlyBuiltDependencies` field** — that reverts to "all install scripts run", expanding the supply-chain surface back to whatever pnpm 10+ tightened against in the first place.

## Future-proofing: pnpm 11 migration

pnpm 11 moves the build-policy fields out of workspace `package.json`
into `pnpm-workspace.yaml` and replaces both allow/silence lists with
`allowBuilds`, a map where `true` permits scripts and `false` blocks them
without leaving an unreviewed-build warning. When we upgrade:

1. Convert the two arrays into `pnpm-workspace.yaml`:
   ```yaml
   allowBuilds:
     better-sqlite3: true
     esbuild: false
     protobufjs: false
   ```
2. Delete the `pnpm.onlyBuiltDependencies` / `pnpm.ignoredBuiltDependencies` blocks in workspace `package.json`.
3. Update this doc.

## Historical context

`onlyBuiltDependencies: []` (empty allowlist) was added on 2026-03-06 in
commit `21efb9c` ("chore(teamlead): spike — verify sql.js + @slack/bolt on
macOS arm64"). At that time better-sqlite3 wouldn't compile on Node v25 on
macOS arm64, so the spike switched the teamlead StateStore to `sql.js`
(WASM) and locked down all native compiles as a security measure. The
empty allowlist was an "explicit no native compile" stance.

Then `flywheel-comm` (2026-03-22, GEO-206) and `inbox-mcp` (2026-04-06,
FLY-47/62) added `better-sqlite3` back as a runtime dep without updating
the allowlist. FLY-115 (2026-04-18) added `pnpm rebuild better-sqlite3`
to `scripts/test-deploy.sh` as a workaround — but `pnpm rebuild` also
respects `onlyBuiltDependencies`, so the workaround was a silent no-op.
Production users had the binary already from earlier installs. Fresh
worktrees (created by `git worktree add` for QA) hit the bug every time.

FLY-153 fixes this by allowlisting `better-sqlite3` here and keeping a
defense-in-depth direct-compile path in `scripts/test-deploy.sh` for the
QA framework specifically.
