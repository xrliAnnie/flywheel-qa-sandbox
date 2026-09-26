import json,pathlib,subprocess,hashlib,datetime,collections,re,shlex
root=pathlib.Path.cwd(); out=root/'engineering/doc/FLY-2886-voice-brain-agent/evidence';raw=json.loads(pathlib.Path('/tmp/fly2886-scope-raw.json').read_text())
excluded={
'packages/claude-runner/test/kill-path-inventory.test.ts':'Parent-directory matches enumerate unchanged reapers/tmux lookup; no changed production file is read.',
'packages/config/src/__tests__/flag-truth.test.ts':'Parent-directory hit is a comment pointing to unrelated delivery-secret test.',
'packages/teamlead/src/__tests__/bridge-child-process-census.test.ts':'Reads unchanged child-process-census.json; common directory alone is not a changed-file consumer.',
'packages/teamlead/src/__tests__/fly2121-legacy-name-guard.test.ts':'Parent-directory strings construct synthetic rogue/compatibility fixtures, not changed production sources.',
'packages/teamlead/src/__tests__/fly247-bash-suites.test.ts':'Only parent-directory match is a repository-root navigation comment.',
'packages/teamlead/src/__tests__/fly574-bash-suites.test.ts':'Only parent-directory match is a repository-root navigation comment.',
'packages/teamlead/src/__tests__/pane-live-region-fly927-echo.test.ts':'Only parent-directory hit is a synthetic pane-text line naming unchanged LeadAlertNotifier.ts.',
'packages/teamlead/src/__tests__/report-hosting-secrets.test.ts':'Directory hits import unchanged report-hosting-secrets.ts/vercel-hosting-api.ts.',
'packages/teamlead/src/__tests__/required-wall-clock-thresholds.test.ts':'Directory hits list unrelated unchanged ship-judgment test thresholds.',
'scripts/__tests__/auto-narrow-rollback-precheck.test.sh':'StateStore.ts is a synthetic temporary repository fixture; this test does not read current StateStore.ts.',
'scripts/__tests__/ci-structure.test.sh':'Directory hits point to unchanged review-governance-docs/fly1135-doc-sentinel tests.',
'scripts/__tests__/fly-1867-playwright-orphan-census.test.sh':'Directory hits create synthetic source.ts fixtures for dist freshness, not changed files.',
'scripts/__tests__/fly-2026-browser-idle-census.test.sh':'Directory hits name unchanged browser-idle/census/reaper sources.',
'scripts/__tests__/flywheel-log-janitor.test.sh':'Directory hits read unchanged workflow-ledger-states.ts/operational-terminal-status.ts.',
'scripts/__tests__/flywheel-log-rotate.test.sh':'Directory hits enumerate unchanged log rotation entrypoints and BridgeEventLoopGuard.ts.',
'scripts/__tests__/lead-alert-strict-delivery.test.sh':'Directory hit reads unchanged LeadAlertNotifier.ts.',
'scripts/__tests__/legacy-swap-broadcast-retirement.test.sh':'Directory hits create synthetic fleet-sensors.ts temporary git fixtures.',
'scripts/__tests__/package-gate.test.mjs':'Filename config.ts occurs only as suffix in vitest.config.ts; unrelated package-gate config test.',
'scripts/__tests__/r4-window.test.sh':'Filename manifest.ts is only a substring of unrelated manifest.tsv.',
'scripts/__tests__/rollback-r4.test.sh':'Filename manifest.ts is only a substring of unrelated manifest.tsv.',
'scripts/__tests__/teamlead-shards.test.mjs':'Filename config.ts occurs only as suffix in unchanged vitest.config.ts.',
'scripts/__tests__/test-deploy-generalized.test.sh':'Directory hit imports unchanged bridge-exit-marker.ts.',
}
excluded.update({
'scripts/test-deploy.sh':'Operational deployment/restart helper, not a hermetic test harness; outside authorized local verification.',
'scripts/test-restart-services.sh':'Operational service restart helper, not a hermetic test harness; outside authorized local verification.',

'packages/agent-team-transport/src/__tests__/grep-gate.test.ts':'cli.ts is only a suffix of unchanged agent-team-transport-cli.ts.',
'packages/agent-team-transport/src/claude/__tests__/ClaudeCodeAdapter.test.ts':'plugin.ts appears only in a historical comment; no changed module import.',
'packages/claude-runner/test/TmuxAdapter.test.ts':'plugin.ts appears in behavior-mirroring comments/test names; no changed module import.',
'packages/edge-worker/src/__tests__/cipher-dimensions.test.ts':'session.ts refers to unrelated auth/session.ts fixture.',
'packages/edge-worker/src/__tests__/resolveBridgeUrl.test.ts':'config.ts refers to unchanged teamlead config defaults, not changed voice-codex config.ts.',
'packages/teamlead/scripts/test-fly26-rules-split.sh':'plugin.ts appears only in route-prefix comment, not as changed-source input.',
'packages/teamlead/src/__tests__/account-selfheal-bytecompat.test.ts':'plugin.ts occurs only in explanatory account-selfheal comments; no changed-source input.',
'packages/teamlead/src/__tests__/quota-ignition-red-lines.test.ts':'plugin.ts occurs only in comments describing copied composition; test imports unchanged quota modules.',
'packages/teamlead/src/bridge/__tests__/lead-patrol-config.test.ts':'config.ts is a suffix in unchanged lead-patrol-config.ts.',
'packages/teamlead/src/xiaohongshu-write/__tests__/offline-configuration.test.ts':'config.ts is a suffix in unchanged scripts/xhs/assemble-config.ts.',
'packages/voice-bridge/src/__tests__/assistant-wiring.test.ts':'cli.ts refers to voice-bridge CLI in a comment, not changed voice-codex CLI.',
'packages/voice-bridge/src/__tests__/eleven-config.test.ts':'config.ts refers to voice-bridge assistant config, not changed voice-codex config.',
})
def test_file(f):return bool(re.search(r'(?:\.test|\.spec)\.(?:[cm]?[jt]sx?|sh|py)$',f) or re.search(r'(?:^|/)test[-_][^/]+\.(?:sh|py)$',f)) and '/fixtures/' not in f
def package(f):return '/'.join(f.split('/')[:2]) if f.startswith('packages/') else 'scripts' if f.startswith('scripts/') else 'other'
changed_tests=sorted(f for f in raw['changedFiles'] if test_file(f) and (root/f).is_file())
retained={}; exclusions={}; match_counts=collections.Counter()
for row in raw['productionFiles']:
 for m in row['matches']:
  path=m['path']
  if path.endswith('/tmux-viewer.macos.test.ts'):
   disposition='exclude';reason='Explicit approved exclusion: plan.md section 9, line 322, **/tmux-viewer.macos.test.ts.'
  elif not m['isTest']:
   disposition='exclude';reason='Non-test source, documentation, registry, fixture, or operational script; not an executable test consumer. Production dependency edges remain for scoped import-graph selection.'
  elif path in excluded and path not in changed_tests:
   disposition='exclude';reason=excluded[path]
  else:
   disposition='retain';reason='Direct changed-source/import consumer or repository structural guard reading the changed source root.'
   retained.setdefault(path,{'path':path,'package':package(path),'reasons':set(),'productionFiles':set()})['productionFiles'].add(row['file']);retained[path]['reasons'].add('literal-consumer')
  m['disposition']=disposition;m['reason']=reason;match_counts[disposition]+=1
  if m['isTest'] and disposition=='exclude':exclusions[path]=reason
for f in changed_tests:
 if f.endswith('/tmux-viewer.macos.test.ts'):continue
 retained.setdefault(f,{'path':f,'package':package(f),'reasons':set(),'productionFiles':set()})['reasons'].add('changed-test')
# Packaging and retention inputs are changed even though they are not production TS grep queries.
supplemental={
'scripts/__tests__/package-onboard.test.sh':'Changed public export/new runtime modules require payload path/manifest regression checks.',
'scripts/__tests__/gate4-allowlist-masking.test.sh':'Gate 4 exact-line registration/negative masking regression coverage.',
'scripts/__tests__/package-onboard-smoke.test.sh':'Packaged runtime asset resolution smoke coverage, including Codex home assets.',
'packages/teamlead/src/__tests__/fly-2413-retention-registry.test.ts':'Two added protected-current/reference table classification fragments.',
'scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs':'StateStore/session_events readers require retention registration guard coverage.',
}
for f,reason in supplemental.items():
 retained.setdefault(f,{'path':f,'package':package(f),'reasons':set(),'productionFiles':set()})['reasons'].add('supplemental-registration');retained[f]['supplementalReason']=reason
entries=[]
for f,t in sorted(retained.items()):
 t['reasons']=sorted(t['reasons']);t['productionFiles']=sorted(t['productionFiles']);entries.append(t)
current_head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
current_changed=set(subprocess.check_output(['git','diff','--name-only',raw['mergeBase'],'--'],text=True).splitlines()+subprocess.check_output(['git','ls-files','--others','--exclude-standard'],text=True).splitlines())
prod=[r['file'] for r in raw['productionFiles']]
drift=[r['file'] for r in raw['productionFiles'] if hashlib.sha256((root/r['file']).read_bytes()).hexdigest()!=r['sha256']]
current_prod=sorted(f for f in current_changed if re.search(r'\.(?:tsx?|mts|cts)$',f) and not test_file(f) and not any(p in pathlib.PurePosixPath(f).parts for p in ('__tests__','test','tests','fixtures')) and (root/f).is_file())
raw['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();raw['completionHead']=current_head;raw['sourceDriftDuringDiscovery']=drift;raw['newProductionFilesDuringDiscovery']=sorted(set(current_prod)-set(prod));raw['retainedTests']=entries;raw['excludedTestMatches']=[{'path':f,'reason':r} for f,r in sorted(exclusions.items())];raw['approvedExclusion']={'pattern':'**/tmux-viewer.macos.test.ts','source':'engineering/doc/FLY-2886-voice-brain-agent/plan.md:322'};raw['introducedShellTests']=[f for f in raw['changedFiles'] if f.startswith('scripts/__tests__/') and f.endswith('.test.sh')];raw['retentionConsumerCheck']=json.loads(pathlib.Path('/tmp/fly2886-retention-inventory-check.json').read_text());raw['perPackage']={}
for pkg in sorted(set(map(package,prod))|set(t['package'] for t in entries)):
 raw['perPackage'][pkg]={'changedProductionTs':[f for f in prod if package(f)==pkg],'retainedTests':[t['path'] for t in entries if t['package']==pkg]}
old_path=pathlib.Path('/tmp/fly2886-retained-tests.txt');old=set(old_path.read_text().splitlines()) if old_path.exists() else set();raw['newlyDiscoveredTestsSincePrevious']=sorted(set(retained)-old)
raw['summary']={'changedProductionTs':len(prod),'retainedTests':len(entries),'literalConsumerTests':sum('literal-consumer' in t['reasons'] for t in entries),'changedTests':len(changed_tests),'excludedTestFiles':len(exclusions),'retainedShellTests':sum(f.endswith('.sh') for f in retained),'retainedNodeTests':sum(f.endswith('.mjs') for f in retained),'matchDispositionCounts':dict(match_counts)}
out.mkdir(parents=True,exist_ok=True)
(out/'related-test-scope.json').write_text(json.dumps(raw,ensure_ascii=False,separators=(',',':'))+'\n')
for name,files in [('retained-tests.txt',sorted(retained)),('retained-shell-tests.txt',sorted(f for f in retained if f.endswith('.sh'))),('retained-node-tests.txt',sorted(f for f in retained if f.endswith('.mjs'))),('changed-production-ts.txt',prod)]:
 (out/name).write_text('\n'.join(files)+'\n')
for pkg,items in raw['perPackage'].items():
 slug=pkg.replace('/','-')
 for prefix,key in [('changed-production','changedProductionTs'),('retained','retainedTests')]:
  (out/(prefix+'-'+slug+'.txt')).write_text('\n'.join(items[key])+ ('\n' if items[key] else ''))
lines=['# FLY-2886 related verification scope','',f"Discovery merge-base: `{raw['mergeBase']}` (`git merge-base origin/main HEAD`). Discovery HEAD: `{raw['head']}`; completion HEAD: `{current_head}`. Working-tree edits and untracked sources are included. Generated {raw['completedAt']}.",'',f"Scope: {len(prod)} production TypeScript files; {len(entries)} retained executable test paths ({raw['summary']['retainedShellTests']} shell, {raw['summary']['retainedNodeTests']} Node); {len(exclusions)} excluded test matches. This is an inventory, not execution evidence. No test suite was run to create it.",'',
'## Exact discovery commands','',
'```sh','git merge-base origin/main HEAD','git rev-parse HEAD','git diff --name-only -z "$(git merge-base origin/main HEAD)" --','git ls-files --others --exclude-standard -z','python3 engineering/doc/FLY-2886-voice-brain-agent/evidence/related-test-discover.py','node scripts/fly-2006-retention-consumer-gate.mjs > /tmp/fly2886-retention-inventory-check.json','python3 engineering/doc/FLY-2886-voice-brain-agent/evidence/related-test-finalize.py','```','',
'For every existing changed production `.ts`, `.tsx`, `.mts`, or `.cts` file, the script contributes three fixed-string queries: repository-relative full path, filename, and parent directory. It runs their union in one batched `git grep -lF -z --untracked --exclude-standard -e QUERY ... -- .` call; the first pass also ran each query individually. This avoids rescanning the large tree 3N times without broadening matches. Generated inventory artifacts are excluded using the explicit pathspecs stored in the exact `batchedCommands` argv in the JSON. Tests, test helpers/fixtures under test directories, and deleted files are excluded from the production-input set. The exact production-input SHA-256, every query and its batch command argv, every matched path and disposition, and test matching lines are retained in `related-test-scope.json`.', '',
'Changed tests are independently retained even when import specifiers use `.js` and literal `.ts` grep cannot discover them. Direct source/import consumers, changed tests, and repository guards that actually scan changed source roots are retained. Shared directory names alone do not retain unrelated tests. Excluded matches below are comment-only, synthetic fixtures, suffix collisions, or specific unchanged siblings; non-test matches remain enumerated in JSON. Import-graph selection is still necessary: literal grep alone does not prove the complete transitive test graph.','',
'## Snapshot stability','',f"Production files edited during scan: {', '.join('`'+f+'`' for f in drift) or 'none'}. Newly added production paths after scan input: {', '.join('`'+f+'`' for f in raw['newProductionFilesDuringDiscovery']) or 'none'}. A later production path/content change requires rechecking this inventory; this snapshot is not exact-head CI evidence.",'',
'## Package manifests and registration','',
'- `packages/teamlead/package.json` adds the `./voice-capability` export to `dist/voice-capability.js` / `.d.ts`. Existing `files: [dist, ...]`, `PO_PACKAGES`, and `node_modules/flywheel-teamlead/dist/*` payload allowlist cover the new modules. Voice-core and voice-codex already participate in PO_PACKAGES and have matching dist globs. No new runtime asset root is introduced.',
'- Read-only `git diff --unified=0 MERGE_BASE -- packages/**/*.ts packages/*/package.json` added-line scan for `git\\s+clone|xrliannie/|package-onboard` found no candidate repository-access lines. Gate 4 matches normalized exact lines, so compiled payload checks remain required; this source scan is not a payload gate pass.',
'- Retain `bash scripts/__tests__/package-onboard.test.sh`, `bash scripts/__tests__/gate4-allowlist-masking.test.sh`, and `bash scripts/__tests__/package-onboard-smoke.test.sh`. They are listed, not executed here. Package assembly/gates must use fresh affected dist output.',
'- Two new `scripts/lib/fly-2006-retention-tables/teamlead/capability_target_lock{_waiters,s}.json` fragments use `protectedCurrentOrReference`. The local retention fragment guide explicitly requires no shared manifest/test edit for protected tables. Both fragments have the exact three-field schema.',
'- Read-only `node scripts/fly-2006-retention-consumer-gate.mjs` completed exit 0: `ok: true`, 101 consumers, zero errors. Its full result is in the machine JSON. Retention registry/consumer regression tests remain retained.',
'- No new or modified `scripts/__tests__/*.test.sh` files exist in the merge-base-to-working-tree diff. Newly discovered shell consumers are existing tests omitted by the old TypeScript-only inventory; list below.',
'- No missing package payload/retention registration was identified by these bounded read-only checks. Runtime capability catalog policy is covered by its changed manifest tests and remains the implementation owner’s responsibility.','',
'## Approved exclusion','',
'Always exclude `**/tmux-viewer.macos.test.ts`, as explicitly approved in `plan.md` section 9 (line 322). This exception applies to subsequent related/import-graph selection even if literal grep does not match that test.','',
'## Excluded executable-test matches','',
'| Path | Reason |','| --- | --- |']
for f,reason in sorted(exclusions.items()):lines.append(f'| `{f}` | {reason} |')
lines+=['','## Retained shell and Node checks','','Run only the explicitly retained checks when authorized; no aggregate/full-suite command is prescribed.','', '```sh']
for f in sorted(retained):
 if f.endswith('.sh'):lines.append('bash '+shlex.quote(f))
 elif f.endswith('.mjs'):lines.append('node --test '+shlex.quote(f))
lines+=['```','','## Per-package production inputs and retained test paths','','Each package also has `changed-production-PACKAGE.txt` and `retained-PACKAGE.txt` machine lists. Use package-relative paths for explicit Vitest invocations. Teamlead Bridge checks require isolated `FLYWHEEL_CODEX_HOMES_ROOT=/tmp/fly2886-related-homes`; its test setup additionally creates per-test temporary roots. Do not execute one huge related command from this document. Divide the retained paths by the bounded validation batches owned by the root agent.']
for pkg,items in raw['perPackage'].items():
 lines+=['',f'### {pkg}','','Changed production TypeScript:','', '```text',*items['changedProductionTs'],'```','','Retained tests:','','```text',*items['retainedTests'],'```']
(out/'related-test-scope.md').write_text('\n'.join(lines)+'\n')
print(json.dumps(raw['summary'],indent=2));print('drift',drift);print('added',raw['newProductionFilesDuringDiscovery'])
