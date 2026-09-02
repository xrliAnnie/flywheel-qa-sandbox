# FLY-2238 Fable 单旋钮与自动更新 — 实施计划
Issue: FLY-2238 (https://linear.app/geoforge3d/issue/FLY-2238/模型-fable-全面升级-51builtin-aliasrunner-defaultconfigyaml模板-revision)
日期: 2026-09-01
基于: research.md

## 锁定结果

模型版本只存在于 registry authority。Repo builtin 固定今天同步出的 `claude-fable-5-1` / `[1m]`，只在 overlay 缺席或失效时兜底；未来 Fable 升级由既有 updater shuttle 自动更新 `~/.flywheel/models.json`，不再修改 consumer code。Resolver、self-hosting YAML 与 live template 全部保存 `fable`。

Workflow template revision 保存 alias；`materializeWorkflowRun()` 是唯一 canonicalization 边界，run snapshot pin 当时 canonical，既有 run 与节点 launch 永不重解析。只迁 live `tpl_code`；retired/unbound `tpl_eng_heavy` 明确不迁。

完整验收链时序由 Lead 锁定：

> merge → 班车部署新 writer → Lead 执行幂等 publication → 读回 published manifest 的 design model 原文为 `fable` → 新铸 run snapshot 解析出当时 canonical → issue 才算 done。

本 implement node 只负责代码、测试、runbook、review 与 PR，不越权 merge/deploy/执行 successor；PR handoff 必须明确链路尚待上述 post-deploy governed steps，不能把“代码已装好”报告成 issue-terminal done。

## 已确认的公开测试 seam

1. `getModelConfigSnapshot()`：registry/binding/legacy/collision；
2. repo config → `resolveRoleAdapter()` → Claude runner argv；
3. management CAS stage/apply → published manifest readback；
4. `materializeWorkflowRun()` → immutable run snapshot；
5. one-shot sync orchestration：只 mock Anthropic、Keychain、filesystem failure 与 notification process boundary；
6. existing updater invocation：每次一次 sync，失败不影响原 launchd/fetch/deploy cycle。

以下严格按一个 failing spec → 最小实现 → green 的纵切片执行；不批量先写所有测试，循环内不做额外 refactor。

## Step 1 — RED/GREEN：5.1 fallback、legacy、same-id overlay

在 `packages/config/src/__tests__/model-config.test.ts` / `model-tiers.test.ts` 逐条推进：

1. RED：无 overlay 时分别断言 `fable` 与 heavy 精确解析到 `claude-fable-5-1`，`fable-1m` / `fable[1m]` 精确解析到 `claude-fable-5-1[1m]`；旧 5 / 5[1m] 预期 accepted、dispatchable、non-selectable。
2. GREEN：
   - `MODEL_IDS.FABLE` / `FABLE_1M` 改为 5.1；
   - export 稳定 consumer spelling（例如 `MODEL_ALIASES.FABLE = "fable"`）；
   - current labels 改 `Fable 5.1` / `Fable 5.1 (1M)`；
   - 增旧 5 base/1M legacy entries 与 dispatch lookup acceptance，不给 alias/tier/selectability，但明确保留人类可读 `Fable 5` / `Fable 5 (1M)` labels。
3. RED：用 Founder 当前 overlay 精确形状（same id、只有版本化 aliases、没有 `contextWindowTokens`）证明 `fable` 与 builtin window metadata都会丢失；断言合并后 alias恢复且 base/1M分别保留 builtin `contextWindowTokens:1000000`。
4. GREEN：`mergeModels()` 对同 canonical id做 builtin-first merge：aliases stable union，overlay未显式提供的 optional builtin metadata（当前为 `contextWindowTokens`）继续保留，overlay显式合法值才覆盖；provider/runtime/surfaces等既有 configured metadata保持覆盖。跨 id collision仍使整个 models segment fail-safe ignored。

聚焦 gate：

```bash
pnpm --filter flywheel-config exec vitest run src/__tests__/model-config.test.ts src/__tests__/model-tiers.test.ts src/__tests__/model-registry.test.ts src/__tests__/runner-label.test.ts
pnpm --filter flywheel-config typecheck
```

第一批小提交只含 registry fallback/legacy/overlay tests 与最小代码。

## Step 2 — RED/GREEN：future-id family binding 单旋钮

1. RED：临时 `models.json` 同时含 builtin 5.1 与 synthetic 5.2 entries，`bindings.fable = "claude-fable-5-2"`；断言 reserved `fable` aliases 只归 5.2，`fable-1m` 归已注册 5.2[1m]，heavy 若保存 `fable` 也解析到 5.2，旧 5.1 canonical 仍 accepted。
2. GREEN：扩展既有 bindings parse/apply，family bind 必须全有或全无：
   - 验证 target 是 Claude registry entry；
   - 先验证 base 与 `${base}[1m]` 都已注册且 surface/vendor 合法；只有全部通过才从所有 entries 移除 reserved aliases，并把 base/1M aliases 成对赋给两个 targets；
   - default binding 是 builtin `MODEL_IDS.FABLE`；
   - snapshot 对外暴露解析后的 family binding，所有判断使用同一 immutable generation。
3. RED/GREEN negative guards：未知 binding、缺 1M target、跨 family/vendor/surface target、malformed bindings 都保留完整 builtin family binding并产生 warning；`fable-1m` / `fable[1m]` 必须继续解析到 builtin 1M，绝不产生半绑定或消失的 alias。

复跑 Step 1 focused gate；提交 family authority binding。

## Step 3 — RED/GREEN：bounded auto-latest sync

新增 `packages/teamlead/src/account-heal/fable-model-sync.ts` 与 compiled CLI entry，复用 `readKeychainMonitorCredential()`。

依次纵切：

1. RED：Models API 给 5.9、5.10、旧 5 与 `[1m]`/坏 suffix；期望 exact base filter + 数值段比较选 5.10，并从选中 `ModelInfo.max_input_tokens` 取得 context window。
2. GREEN：实现 exact regex、safe integer segments 与 zero-padded lexicographic numeric comparison；不使用字符串比较或 response order 作最终裁决。candidate 的 `max_input_tokens` 必须是正 safe integer；缺失/非法时不自动升级，避免为 resume safety 猜窗口。
3. RED：candidate 高于 current；期望保留所有旧 model entries，追加 base + synthetic `[1m]`，两个新 entry 都显式 `dispatch: true`（因此包含 dispatch + managed surfaces）并保存 API-derived `contextWindowTokens`，设置 `bindings.fable`，令 `tiers.heavy="fable"`，不把 reserved aliases 写进新 entry。
4. GREEN：给 registry entry/config parser 增可选、正 safe integer `contextWindowTokens`；最小纯 transform 的版本化 aliases/labels 从已验证 numeric segments 生成，输出交给真实 registry validator 前不宣告成功。Builtin 当前 Fable 5.1/1M window 用同一 API 字段取证并固定为 fallback metadata。
5. RED/GREEN：same/lower candidate 为 `unchanged`；same version但 authority仍是 Founder当前旧 shape时，`normalized` 必须补齐 binding、dispatch、heavy alias与 API-derived `contextWindowTokens`，不算升级也不通知。
6. RED/GREEN：200 malformed、401/403/429/5xx、timeout/network、missing/expired credential 全部返回 retained 状态，authority bytes 不变。
7. RED/GREEN：models path 必须 owner-owned regular non-symlink 0600；同目录 0600 temp 完整写 + fsync + atomic rename + directory fsync。rename 前注入失败时原 bytes/mode/inode target 不变，temp 被清理。
8. RED/GREEN：rename 后强制让 `getModelConfigSnapshot()` 从该 authority fresh reload，只有 `getDispatchCanonical("fable") === candidate`、`tiers.heavy.id === candidate` 且 candidate base/1M registry entries的 `contextWindowTokens`都等于 API-derived safe integer才返回 `updated|normalized`并允许相应后续动作；registry segment被 warning/fail-safe丢弃或 metadata缺失时，用同样安全写协议恢复先前 bytes，fresh reload证明旧 resolution恢复，再返回 verification failure，绝不留下坏 authority或发成功通知。
9. RED/GREEN：token/header/response body 永不进入结果、argv、日志或 notification payload。

公开 orchestration test 注入 `fetchFn`、credential reader、file ops failure seam 与 notifier；不 mock内部 selector/transform。

## Step 4 — RED/GREEN：复用 shuttle 与既有 notification layer

1. 扩展现有 informational alert contract，增加 truthful `model_family_updated` kind：TS union、shell allowlist/informational set、kind contract/copy 与 contract tests同步；不新增 transport、queue、daemon 或直连 Discord。
2. CLI 仅在 canonical 真前进且 atomic write 已成功后，通过既有 `lead-alert.sh` 发 public old/new ids 与 `source=anthropic_models_api`；signature 绑定 family+old+new，重复执行由 no-op/dedup 保证只通知一次。通知失败不回滚已成功 authority，但留脱敏 warning。
3. 在 `scripts/update-flywheel.sh` 的既有 singleton invocation 内调用 compiled sync CLI 恰好一次；不存在 dist、credential/API/file/notification failure 都不改变 updater 的原 cycle return semantics。
4. 扩展已有 `scripts/__tests__/update-flywheel-sources.test.sh`：
   - scheduled caught-up、scheduled deploy、urgent token 三类 invocation 各断言一次；
   - sync failure 后 launchd pass 与 fetch/deploy 仍照旧；
   - updated 只触发一次现有 alert route；
   - 不增加任何 launchd plist/timer/QueueDirectories。

聚焦 gate：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fable-model-sync.test.ts src/__tests__/LeadAlertNotifier.test.ts src/bridge/__tests__/kind-contract.test.ts
bash scripts/__tests__/update-flywheel-sources.test.sh
```

提交 bounded sync + existing shuttle/notification wiring。

## Step 5 — RED/GREEN：所有 current-Fable consumer、resume 与 pricing

1. RED：runner resolver 无 model fallback 的 source spelling 是 exported `fable` alias，输出 canonical 5.1；project role `model: fable` 同结果。`resolveLeadLaunchSelection()` 的 absent/invalid fallback 也必须从同一 snapshot 的 `fable` binding 取得当代 canonical，而不是 `MODEL_IDS.FABLE`。
2. GREEN：`RUNNER_DEFAULT_MODEL` 引用 family alias；Lead launch fallback、fleet console effective display 与 model-policy null semantics 都通过 snapshot family binding，不再把 canonical current id复制进 consumer。
3. RED/GREEN：`.flywheel/config.yaml` 保存 `roles.runner.model: fable`，更新注释为“配置 alias、spawn 前 canonicalize”。
4. RED：真实 repo config 经 `ConfigLoader` + resolver + Claude launch seam，期望 argv 唯一 `--model claude-fable-5-1`；未知 alias 在 spawn 前 fail-loud。该 spec 必须把 `FLYWHEEL_MODELS_CONFIG` 指向 hermetic fixture、每例 reset snapshot cache，并分别覆盖无 overlay与 Founder same-id overlay；禁止读取会被 shuttle 改写的 ambient home authority。
5. GREEN：只补最小测试适配，不在 runner 内再做第二次 family lookup。
6. RED/GREEN：给 `scripts/validate-model-policy.mjs` 增一个输出当前 snapshot Fable binding + context window 的窄命令；`scripts/flywheel-fleet.sh` 的 null/pre-image从该 authority取得，不再写旧 full id。扩展既有 `scripts/__tests__/fly1496-model-policy.test.sh`（它已在 CI），不新增重复 root suite。
7. RED/GREEN：解决 `claude-lead.sh` 的 dist-unavailable availability seam，而不把 full id搬到另一个脚本：
   - 新增 dependency-free、version-free 的小型 receipt helper；每次正常 `lead-model-launch` resolve成功后，把实际 canonical、registry提供的 `contextWindowTokens`、snapshot revision与时间戳以 owner-only 0600 temp + fsync + rename写到 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state/lead-model-authority.json`，与既有 resume state-root convention一致；
   - resolver/config dist缺失时，从该 receipt读取最后一次已成功验证的 canonical，而不是调用同样依赖 config dist的 validator；receipt model/window/schema/mode/owner任一非法则 fail-loud，绝不省略 `--model`继承 account 1M default，也不猜版本；
   - `_lead_session_model_from_decision` 与 `_launch_claude`在 pre-resolve缺失/非法时必须读取同一 receipt generation；前者不能保留自己的旧 full-id fallback。测试先用正常 resolve在自定义 `FLYWHEEL_STATE_DIR`下铸 receipt，再移走两个 dist seam，证明 gate model/window与 launcher `--model`都是同一 last-good值；另测无/坏 receipt使 gate unknown/park且 launcher fail-loud。这覆盖实际 mid-deploy退化窗口，同时不复制版本 authority。
8. RED/GREEN：`lead-session-resume-gate.sh` 对当前 launch canonical读取匹配的 trusted receipt/registry `contextWindowTokens`；Fable 5.1与 synthetic 5.10 fixture都使用各自 API-derived值，`[1m]`变体继续走 canonical metadata。receipt缺失、model不匹配、malformed near-match或未来 API没给window一律保持 unknown/park，绝不把5的QA测量外推到所有未来版本。同步更新原注释，说明 window来自 Anthropic Models API而非 family猜测；test还要断言 receipt实际落在 resume gate解析的 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}` root。
9. RED/GREEN：token pricing 保持现有 `Record<string, ModelRate>` API，增加 reserved config key `claude-fable-*`：exact per-id override > configured family override > builtin family fallback。Builtin 同时精确列出 Founder确认同价的5与5.1，未来5.10使用 family fallback时按10/50估算但 warn-once，直到 operator用同一 JSON schema覆写 exact/family rate；真正未知 family仍 warning/$0。HTML label/color改为 family-aware formatter，显示 `Fable 5.1` / `Fable 5.10 · 1M`并沿用 family color。
10. RED/GREEN：`packages/teamlead/lead-rules-base/model-routing.md` 只教稳定 `fable` / `fable-1m` aliases，描述为“当前 Fable family”，移除会把新工作 pin 回 legacy 5 的 full-id示例。

聚焦 gate：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/role-adapter-resolver.test.ts <repo-config-argv-spec>
pnpm --filter flywheel-claude-runner exec vitest run test/TmuxAdapter.test.ts test/ClaudeRunner.test.ts
pnpm --filter flywheel-token-usage exec vitest run src/__tests__/pricing.test.ts src/__tests__/render-html.test.ts
bash packages/teamlead/scripts/__tests__/lead-session-resume-gate.test.sh
bash scripts/__tests__/fly1496-model-policy.test.sh
```

新增的 package-local resume suite 显式登记到 `.github/workflows/ci.yml`；复跑 `scripts/__tests__/ci-shell-suite-enumeration.test.sh`，保证新增/扩展 shell suite既不漏 CI也不破坏 root suite分类。

提交 consumer aliases + argv acceptance。

## Step 6 — RED/GREEN：template alias publication 与 run pin

### Writer

1. RED：management desired `{provider:"anthropic", model:"fable", effort:<current>}` 应通过 CAS publication，readback manifest 的目标 node `model === "fable"`。
2. GREEN：只在 workflow DAG writer 保留 trim 后 validated spelling；`applyManagementDagEdit()` 写 `input.desired.model`，projection 回显 persisted spelling。Lead/runner/cron writers 继续现状。
3. RED/GREEN negative guards：unknown alias/provider mismatch/unsupported effort 拒绝且 revision/publication/audit 零 residue；stale revision/digest conflict 不创建 orphan revision。

### Materialization

4. RED：alias template在 authority 5.1下 materialize run A，直接断言 persisted snapshot bytes的 manifest/model与 resolved dispatch 都是 literal canonical `claude-fable-5-1`，不是 `fable`；随后 test authority bind到 synthetic 5.2，先对 run A实际调用 `resolveNodeDispatchAtLaunch()`，必须仍返回 snapshot 5.1，再 materialize run B得5.2。
5. GREEN：`materializeWorkflowRun()` 每次只捕获一个 model snapshot；在 `buildWorkflowRunSnapshotV2()` 前，让所有 v2 executable node通过该 snapshot的 workflow surface resolver变成 canonical manifest，再给它们传入 `dispatchPinned:true` receipt。这样 pinned branch本身返回 canonical，后续 spawn不可能把 alias拿到 live registry重解析。保留 legacy snapshots没有该 bit时的既有 live-template fallback，不 retroactively改旧 run。
6. RED/GREEN：deliberate pin分支记录新的 `source:"pinned_snapshot"`，保留 `snapshot_fallback`只表示真实 mutable lookup failure，并同步 StateStore union/comment/fixtures。新 run的后续 attempt/rework/admission audit都保持 snapshot canonical；旧 full-id template/run继续兼容，retired template不能 materialize；`tpl_eng_heavy` fixture/current production revision不迁。
7. 行为 consequence 明示：blanket pin使 runtime与 management console既有 `consequence:"new-run"`承诺一致；模板 republish只影响新 run，不能再热修进行中的 run，坏模型载体必须重启/重铸。把该 consequence加入 management copy、tests 与 PR body。

### 幂等 post-deploy publication command

8. 新增一个只调用 Bridge management HTTP 的 operator CLI；绝不加载 StateStore/DB。建议一行：

```bash
node packages/teamlead/dist/bin/publish-fable-template-alias.js --template tpl_code --node eng_design
```

CLI 从 `FLYWHEEL_BRIDGE_URL` → `BRIDGE_URL` → `TEAMLEAD_PORT`/9876 解析 loopback base URL，并为 stage/apply 显式发送与 request Host byte-matching 的 `Origin: <base.origin>`；拒绝非 loopback base。每次重新读 authoritative target/revision/digest与当前 effort：

- 已是 `fable`：验证 published readback 后 `no_op` 成功；
- 仍是旧 pin：stage desired alias，完成现有 consequence acknowledgement，apply 一次；CAS conflict 时有界重新读取后，仅在仍需迁移时重试；
- 完成后必须从 template revisions/read model 断言 current published manifest 的 `eng_design.model === "fable"`；
- 首次 management publication 会按既有合同把 `tpl_code.seed_owner` 从 `system` 变为 `founder`，从而停止后续 seed auto-update；这是 Founder 指定治理 lane 的已接受结果，CLI/PR receipt 必须显式读回并报告，不能静默发生；
- 重复执行不新增 revision、不改其他 node、不泄露 confirm token；
- 任一不确定/unsupported response fail-closed，绝不 fallback 到 SQL。

临时 StateStore/HTTP harness 覆盖缺 Origin 403、CLI same-origin成功、首次 publish + seed ownership receipt、重复 no-op、CAS race、malformed response 和 unrelated-node preservation。

## Step 7 — 全仓验证、review、PR 与 post-deploy runbook

实现完成后逐项：

```bash
pnpm --filter flywheel-config test:run
pnpm --filter flywheel-claude-runner test:run
pnpm --filter flywheel-teamlead test:run
pnpm --filter flywheel-token-usage test:run
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/update-flywheel-sources.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
git diff origin/main...HEAD --check
```

若本分支新增其他 `scripts/__tests__/*.test.sh`，逐个单独执行。再做 production-code literal audit：允许 builtin current/legacy registry ids与历史 fixtures/docs；禁止 resolver/YAML/live-template seed 或其他 current-Fable consumer 保存 full id。

进入 `code_review` 后按 Codex author contract 新开 `review_code` gate + `request-review --type code`；每个 blocking finding 修复、focused/full gates后用全新 question id 重审。APPROVED advisories 通过唯一 report channel 转 Lead。

PR 描述必须原样包含：

- 上述一行幂等 publication 命令；
- merge → shuttle deploy → publish → persisted alias readback → new-run snapshot verification 时序；
- 明确 `tpl_eng_heavy` retired/unbound、未迁；
- 明确 template change是 `new-run` only；进行中 run不再接受 republish hot-fix，需重启/重铸；
- post-deploy 新铸正常 `tpl_code` run 的验证判据：published manifest design node 原文 `fable`，template `seed_owner=founder` consequence receipt明确，run snapshot 同 node canonical等于当时 `getModelConfigSnapshot().getDispatchCanonical("fable")` 且 `dispatchPinned=true`；该 run 后续 launch/admission audit仍是同一 canonical，旧 run snapshot不变；
- 当前 implement PR 完成不等于 issue-terminal done，Lead 执行并保存上述 production receipts 后才闭环。

最后创建 `engineering/doc/milestones/FLY-2238.md`，作为 literal last commit；之后不再运行会提交 progress 的命令。Push/open PR 后只运行 `complete --route needs_review --pr <NUMBER>`，不 dispatch QA、不 request ship、不 merge、不 deploy。

## 完成审计

- [ ] builtin fallback/labels = 5.1；old Fable 5 base/1M legacy accepted + non-selectable。
- [ ] same-id overlay 保留 builtin aliases与未显式覆盖的 window metadata；future-id `bindings.fable` 接管 family aliases且跨-id guard仍有效。
- [ ] sync 数值单调、携带 API-derived context window、atomic/fail-safe、shuttle一次调用、成功一次既有通知。
- [ ] 所有 runtime/default/routing consumer用 family authority；Lead dist退化读 last-good receipt，resume gate只信任模型匹配的 window metadata，token pricing/HTML 对未来 numeric Fable ids不需逐版改代码。
- [ ] resolver/YAML/template 保存 `fable`；runner argv 与 run snapshot只保存 materialized canonical；hermetic argv tests不读 ambient authority。
- [ ] template authority 改变只影响新 run；新 snapshot bytes先 canonicalize再 `dispatchPinned`，实际 mid-run launch/admission不漂移且 source为 `pinned_snapshot`。
- [ ] `tpl_eng_heavy` 不迁；`tpl_code` publication CLI 幂等、same-origin、只走 Bridge CAS，并报告 seed-owner consequence。
- [ ] focused/full gates、structured code review、milestone-last-commit、PR/Lead report齐全。
- [ ] post-deploy production receipts按锁定时序补齐后，issue 才可 terminal done。
