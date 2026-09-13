# FLY-2459 Codex 部门 Lead — 代码审查记录
Issue: FLY-2459 (https://linear.app/geoforge3d/issue/FLY-2459)
日期: 2026-09-11
基于: plan.md、migration-decision.md、implementation-evidence.md

## R1 处置

有效 gate `aff24609-7063-4c80-9744-b83f205f9b3b` / request `3b4b7a15-650b-4784-82ea-fecc4024d189` 对 `d2a8255781ad15283a0a545464811990d977e5d7` 返回 `reviewVerdict=CHANGES_REQUESTED`。旧执行体的 job d66e7da3 已作废，不作为当前审查证据。

修复提交 `92698c90c` 仅处理两条 HIGH：

- `migration-source-carrier-command-never-matches`：旧 v2 wrapper 的 launchd PID 已 exec 为前台 tmux；检查改为绝对 tmux 路径及本 Lead 的 canonical socket、精确 tmux.conf、完整参数串。拒绝旧 bash 假夹具、其他 binary/socket/config 和额外参数；原 PID/start、原配置/manifest/plist、lease 身份与重复观测检查保留。
- `migration-activation-command-unnormalized-path`：只接受现有两种可信 launcher 的完整 argv 拼写（规范 dist 与 generic scripts/../dist）。避免对整段 ps 文本作路径归一化而吞掉额外参数；继续拒绝外部 root、headless runtime 和额外参数，原 assertion/lease/旧 owner 已退出验证保留。

TDD：source 用真实 tmux 参数形状先获得 2 failed/8 passed（包括旧 bash 错误被接受），修复后 10 passed；activation 的 generic 参数先获得 1 failed/9 passed，修复后通过。新增两个执行型测试从仓库 launcher 读取实际 exec 语句，用私有临时替身捕获 argv，再交给 observer 验证；没有启动真实 tmux/Lead、没有访问生产服务。

最终复核：六个迁移/进程/生命周期/执行器/verifier 测试文件 45 passed、exit 0；四个新增 shell suites 全部 exit 0；`pnpm lint` exit 0（15 warnings），`pnpm -r build` exit 0。日志 `/tmp/fly2459-r1-{source-red,source-green,activation-red,activation-green,focused-final,lint,build}.log` 与 `/tmp/fly2459-r1-shell-{migration,load,wave,env}.log`。初次捕获测试继承 shell 初始化噪声，已改用最小环境，最终复核无该噪声。

原 `pnpm test:packages:run` exit 1 维持原记录；遵从 Lead 7029315a 的不重跑聚合裁定，不能宣称全包绿。精确最终头 CI 仍待 PR。

## 非阻塞 follow-ups（仅归档，未修）

遵从 Lead 指令 `1d2cc26e-2b0f-4078-800f-75911b53f986`：只修 blocking，最多 R3；不改 pinned plan，advisories 在此保留供后续治理。

| findingKey | 严重性 | 剩余问题 |
| --- | --- | --- |
| list-runners-reparses-projects-per-row | MEDIUM | list_runners 对每行重复读取和验证 registry，有热路径性能成本。 |
| migrated-lead-missing-body-observation | LOW | 迁移成功目标跳过普通 restart 后没有 body observation/detail，波次统计展示不完整。 |
| unreachable-fly350-companion-mix-messages | LOW | generic capability 拒绝先发生，旧 FLY-350 的特定错误文案不可达。 |
| runner-actions-marker-leniency | LOW | 非 0/1 marker 仍 fail closed，但两个 MCP 入口的诊断精确度不同。 |

## 后续门

修复后需新 R2 审查。通过后创建 PR、核验最终精确头 CI、执行 needs_review 交接并 park。尚未执行生产迁移或真实浏览器验收；这些不由本记录冒充完成。

## R2 APPROVED 与 CI 接线修复

Gate `60e39dc4-2503-40cf-8d36-c70cb019634d` / request `074ec32e-0a60-48eb-8ddf-c7be2025f235` 对 `53fefb6fd50cac8192e0a3fad935add09ba12404` 返回 `reviewVerdict=APPROVED`、`reviewerVerdict=APPROVED`，无 HIGH。除原四条外新增 MEDIUM `restore-poll-throws-on-transient-carrier-state`：回滚 bootstrap 后探测到短暂 bash/no-pid 状态会抛异常而不是继续等待，可能浪费一次班车，下轮可自愈。此 advisory 只归档并报告 Lead，不纳入本轮修复，不更改 pinned plan。

PR #1162 的 CI run `34590690444` Quick Gate 在 build/lint 前失败：`ci-structure.test.sh` 的固定 step inventory 没有登记已加入 workflow 的 FLY-2459 step。该失败在本地原样复现（`/tmp/fly2459-ci-structure-red.log`），补一个名称后结构检查与 shell/Node enumeration 均 exit 0（`/tmp/fly2459-ci-{structure,enumeration}-green.log`）。只补登记，不删测试、不放宽检查、不改变产品行为。此修复造成新 HEAD，R2 对旧头的批准不能代替最终头审查；交接前补最终头的审查与 CI。

### 同次 CI 的其余本单清单/夹具遗漏

- Script Tests 3/5：旧 `canonical-lead-identity.test.sh` stub 缺 `codexCapabilities.runnerActionsEnabled`，strict jq 合同正确拒绝。更新 stub 为实际默认 false 的独立能力投影，并清理继承 marker；原 production shell 不变。CI 和本地先红（2 passed/9 failed），修复后 11 passed/0 failed。
- Unit heavy：`kill-path-inventory.test.ts` 漏记新 migration config-lock 的三个机械命中。审计后仅登记 `child.kill(SIGTERM)` 为既有 out-of-scope（只终止自建的短期 Python 配置锁子进程）、两个 signal-0 存活探测；不改 scanner、分类规则或 mutation 边界。本地先 1 failed/4 passed，补三项后 5 passed。
- Script Tests 2/5：新 `lib/lead-backend-migration.sh` 已加入 payload 白名单，但 FLY-1062 打包路径审计表缺 disposition。补 guarded operations closure 一行，保留 updater/锁/admission 与单目标 lifecycle 授权说明；原 X1 检查不变。CI 27 passed/1 failed，补齐后本地 28 passed/0 failed。

相关日志 `/tmp/fly2459-ci-{canonical-red,canonical-green,kill-red,kill-green,package-green}.log`。这些是本单接线遗漏，不归类为宿主并发假红。原 CI run 仍按实际失败留档，修复后的本地绿色不替代最终头 CI。

## R3 APPROVED 与授权的最后 R4

R3 gate `5e1f2c8e-3ffd-47b8-adc3-792bb92be896` / request `404a2665-15b2-4fe8-982c-abfa9c80f45e` 对 `ebf8fc50dea5b645424a21d642836c13c9b89f3d` APPROVED。CI run `34592040517` 已结束：Quick Gate 与 Script Tests 2/5 失败，其余 11 个底层 job 全通过，汇总仍红。

Lead 回答 `94d9d3b1-a8bd-45db-97c4-78567495577a`、`9e4a4ac0-bb3b-4976-88cc-e5863bf2a926`、`626043fc-f851-41a3-9f59-dbf251768a0e` 授权把以下遗漏同批修完，完整本地 Quick Gate 和真实 packaging smoke 通过后只推一次，冻结并发起 R4；R4 非 APPROVED 则原样报告，不自行 R5。该授权取代此前最多 R3 的轮次限制，不授权 advisory 扩修。

- FLY-1645：仅登记 runner-actions.ts 的 question relay_state 消费路径。执行正例与无关路径、旧域 API 负例；扫描规则不变。
- FLY-2006：精确登记 evidence 的 workflow_run_event read 与 runner-actions 的 mailbox read 为 candidate_guarded。测试验证实际源码扫描、漏项失败和外部路径拒绝；不改变保留策略或缺失证据拒绝行为。
- 打包 secret scanner：未发布 export 从 `./runner-start-key` 改名 `./runner-start`，同步三处 import；内部文件、函数和算法不变。原名称被通用 token 启发式误报；不改 scanner、不编码或拆分逃逸。
- Gate4：仅登记编译产物中既有静态迁移 href 的精确行。正例通过，追加 fetch/clone 或改变 href 仍拒绝；真实渲染函数测试验证渲染不触发 fetch/open。未改生产 HTML，真浏览器验收仍交 QA。

本地完整 Quick Gate 按 ci.yml 的每个 run step 原样执行，全部 exit 0（含 frozen install、build、结构/枚举、根 Node suites、typecheck、lint、residue 和 retention）。相关行为测试 3 文件 55 passed；Gate4 masking 13 passed/0 failed。日志 `/tmp/fly2459-r4-quick-gate.log`、`/tmp/fly2459-r4-focused.log`、`/tmp/fly2459-r4-href-green.log`。首次真实 packaging smoke 被宿主 ~/.npm 缓存权限拒绝，使用独立临时 npm cache 重跑，不修改全局权限。

真实 packaging smoke 随后完整运行到 21 passed/2 failed：旧 generalized Codex/Raya fixture 的空 auth 文件不满足本单新增的只读 auth-link truth preflight。已报告 Lead（dbe4bd9c-7f06-4631-8470-d3f135492873），同批仅补测试准备：私有 synthetic registry、0600 synthetic truth、两个真实 symlink；移除原夹具的空输出 inspector stub，改走安装产物的真实 inspector。新增未链接 auth 仍被拒绝的负例。生产 auth/preflight/launcher 均未改。

链接夹具首次重跑仍 22 passed/2 failed，进一步定位到旧空输出 stub 遮住真实 inspector；移除该测试 stub 后再运行完整 smoke。所有中间失败保留，不以部分通过替代最终结果。

最终本地验证：真实 packaging smoke **24 passed/0 failed、exit 0**（`/tmp/fly2459-r4-package-smoke-inspector.log`），包含安装后全部 bare imports、native sqlite、隔离 Bridge health、Claude/Codex dry-run、真实 Raya 注册/preflight、未链接 auth 拒绝、summary 越权拒绝。完整 Quick Gate 再次逐 step exit 0（`/tmp/fly2459-r4-quick-gate.log`）。临时假身份不访问宿主真实凭据或生产服务。后续冻结新头，需 R4 APPROVED 与新 CI 全绿才交接。


## Engine conflict rework — implement attempt 2 (2026-09-11)

Request `rework:930fa9671329a08d41ded173a318c5bd2677890e33988e2d6987936bc671bf46` invalidates implement/QA from `ec6921379110965f3aac99918e72f04d23d08ddc`. That prior head has CI run 34594328858 all green. Current TURN is implement epoch 7. Merge `404b85aa9` incorporates origin/main `ca869ad6d638cf9aec34f0ed321a20bd1e6c4c09` without rebasing.

Two conflicts resolved by retaining both sides: package exports include session-terminal and lead-backend-migration-runtime; sendDetailed retains main recipient resolution/result shape and this branch's stable instruction ID plus atomic insertion/state clearing. Mailbox fixtures now register actual UUID session receipts. Main-only write behavior produced six expected failures; combined behavior passed all 28 send/recipient tests. The action fixtures similarly needed CommDB receipt identities for main's send/respond admission; their initial two failures became 40/40 passing action/context/config tests. No admission guard was weakened.

Local lint and recursive build exit 0; all four added shell suites exit 0. The full package run started before Lead's directed-only instruction and exited 1 with two config scan timeouts (5s/15s), 813 config tests passed. Those two files separately pass 38/38; this does not make the aggregate green. Logs: `/tmp/fly2459-rework-{red,green,mcp,mcp-green,lint,final-lint,build,packages,config-timeouts}.log`. New-head review and exact-head CI are required; historical reviews cannot approve this merge.

Lead instruction `dc97e1ab-223d-4eef-996f-6efc8dfa6dd1`: freeze during review, only blocking fixes, at most R3; complete needs_review only after review APPROVED and exact-head CI green. If completion returns 409 with park_wake, do not park or retry; report and wait. Production remains outside this phase.


## Conflict rework R1 — blocking migration wave correction

Gate `3d9e94e8-c300-40bd-8415-e2974d8cc636`, request `adeedf33-3ad0-4c74-925b-d95c69957ae2`, reviewed head `a34478e97289e66138294c47bd3aefe5c7feb214`: CHANGES_REQUESTED. Its exact-head CI run `34645477308` subsequently completed success.

HIGH `migration-intent-wedges-updater-wave` confirmed: the entry checked the intent deployment SHA before distinguishing terminal state, and the shell only accepted deployed_unverified. Correction preserves mutation authority at the planned SHA. A separate read-only inspection binds to the current checkout, same restart owner/admission window, unchanged intent and receipt, and existing live source/target observers. Untouched stale plans or held static preflight with the original live source, proved source-restored failures, and completed migrations with intact target files/identity/process return typed skipped. Ordinary wave then restarts both target and peers; only an activation performed in the current invocation suppresses the target duplicate restart. Partial/unknown state, missing or conflicting artifacts, dead/unproven owners, changed intent/receipt or lost window authority remain fail closed. No automatic migration retry, abort API, verifier call, intent retirement or production action was added.

RED: coordinator tests 5 failed/2 passed; shell wave safe-skip case failed. GREEN details recorded in the final milestone after verification.

Non-blocking findings retained for Lead follow-up, not changed:

- `resident-patrol-excludes-runner-leads` (MEDIUM): Residency patrol still requires canSpawnRunners === false, silently excluding codexRunnerActions Leads
- `lead-actions-tool-drift-guard-removed` (MEDIUM): FLY-350 MED-4 load-time drift guard between registered tool names and LEAD_ACTIONS_TOOLS was deleted with no replacement
- `link-truth-inspect-ignores-lead-binding` (MEDIUM): --inspect returns before the --lead authority binding and launchd fence, so callers passing --lead get no binding check
- `restart-authority-now-requires-node-comm-cli` (MEDIUM): Generic Codex restart authority replaced a pure-jq registry check with a node CLI spawn on a guessed path
- `gateway-runner-context-retains-action-secrets` (LOW): The frozen runner-action context env captures every broker-served secret, not just the coordinates it needs
- `classify-4xx-without-json-body-as-unknown` (LOW): A 4xx refusal with an empty or non-JSON body is reported as `unknown` rather than `refused`
- `preflight-no-longer-repairs-codex-home-link` (LOW): Generic Codex preflight became read-only, dropping the last automatic codex-home link repair on that lane
