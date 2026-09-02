# FLY-2237 房内 Bridge 循环 — 调研
Issue: FLY-2237 (https://linear.app/geoforge3d/issue/FLY-2237/529台架原语-缺保留在飞工人只循环房内-bridge的动作-reown-reconciler-类重启机制永远无法真机触发2211-三轮实证)
日期: 2026-09-01
基于: exploration.md

## 1. 现有 Bridge 启动合同

`scripts/test-deploy.sh:1710-1841` 是唯一真实启动入口，但当前以三段 inline `env ... npx tsx scripts/run-bridge.ts` 表示：

| 分支 | auth/reply 差异 | command 差异 |
|---|---|---|
| generalized | 独立 `TEAMLEAD_API_TOKEN` + `TEAMLEAD_INGEST_TOKEN`；集中 ambient scrub；可选 reply flags | 经 `qa_generalized_exec_with_ingest_token` 与 `qa-generalized-bridge-wrapper.sh` |
| reply-by-issue | master token + 三个 reply flags；scrub ambient ingest | 直接 `npx tsx` |
| default | scrub master/ingest 与三个 reply flags | 直接 `npx tsx` |

三段共享的显式集合包括：

- `TEAMLEAD_PORT`、`TEAMLEAD_DEFAULT_LEAD_AGENT`、`TEAMLEAD_DB_PATH`、`TEAMLEAD_URL`；
- `DISCORD_OWNER_USER_ID`、generic/named Discord bot tokens；
- `FLYWHEEL_PROJECTS`、`FLYWHEEL_PROJECTS_FILE`、`FLYWHEEL_SUMMARY_CONFIG_HOME`；
- `LINEAR_API_KEY`、`FLYWHEEL_RUNNER_START_POINT`；
- `FLYWHEEL_BIN_DIR=${SLOT_DIR}/bin`、`FLYWHEEL_HOOKS_DIR=${SLOT_DIR}/hooks`；
- `BRIDGE_EXTRA_ENV` 的所有动态隔离项。

`BRIDGE_EXTRA_ENV` 在 `scripts/test-deploy.sh:757-943,1043,1707-1710` 渐进组装。除三根 Codex scope 外，它还包含 mode-specific values，所以 cycle 不能仅凭 room-info 的少数字段重新推导。

## 2. credential 与 secret 生命周期

generalized master token 在 `${SLOT_DIR}/state/api-token` 以 mode 0600 持久化，供注入 issue 等外部动作使用；generalized ingest token 由 `qa_generalized_resolve_ingest_token` 生成，仅注入 Bridge child env。普通 slot 的 Discord token 与 Linear key来自 deploy 时 source 的 `~/.flywheel/.env`，且该文件并未 `set -a`，所以 test-deploy 必须逐项显式注入。

这说明 cycle 若只 source 当前 `.env` 会改变“同一房”的 credential authority，并且拿不到原 ingest token。进一步审计也排除了“只记录 test-deploy 的 set/unset delta”：delta 仍会继承 cycle 操作者的 `PATH`、`HOME`、普通分支 `TMPDIR`、`ANTHROPIC_API_KEY`、`GOOGLE_API_KEY`、`SUPABASE_*`、`TEAMLEAD_MAX_CONCURRENT_RUNNERS` 以及未来新增的 ambient `TEAMLEAD_*`/`FLYWHEEL_*`。正确合同必须是 test-deploy 当时解析出的**完整 child environment**，cycle 用 `env -i` 重放，不能再依赖第二个 shell 的 ambient state。

安全约束：

- spec 固定为 `${SLOT_DIR}/bridge-launch.json`，regular file、0600；slot dir 0700；
- spec 的 `environment` 是 final child env 的完整非 secret assignments；executor 只能 `env -i` 重放，禁止继承 cycle shell；`PWD`/`_`/`SHLVL` 等 process-generated keys 由 contract normalization 删除或固定；
- bearer/API/secret bytes 不进入 spec：分类器 deny-by-name，凡 env name（case-insensitive）含 `TOKEN|KEY|SECRET|PASSWORD|PASSWD|BEARER|CREDENTIAL|AUTH`，或在显式 additions list 中，都必须进入 `secretEnvironment`；该字段只记录 env name + `${SLOT_DIR}/state/bridge-env-secrets/<name>` path，secret files 各自 0600、parent 0700，executor 读值后作为 argv assignment 注入且从不打印；
- schema 只接受合法 env name、无 NUL/换行的值、绝对 cwd/log/secret path、正整数 slot/port；
- generalized ingest 新增自己的 slot-local secret file；现有 master API token path 可复用，但所有 mode 最终都由相同 secret-ref机制执行；
- deploy readiness 失败时保留 `bridge.log`，但显式删除尚未交付的 launch spec 与 `bridge-env-secrets`，避免诊断目录无限保留 credential；ready room 则由显式 teardown 删除；
- helper 通过 argv array 调用 `env -i`，不 `eval`、不 source 生成内容，避免 token/value 被当 shell syntax。

## 3. PID 与 ownership authority

当前 ready slot 同时把 live Bridge PID 写入：

- `${SLOT_DIR}/bridge.pid`；
- `/tmp/flywheel-test-slot-${SLOT}.lock/pid`；
- multi-Lead campaign 的每个 owner/borrowed lock PID（`qa_multilead_finalize_locks`）。

borrowed lock 另有 `campaign.json`，`test-teardown.sh` 会拒绝直接拆 borrowed slot。若 cycle 只更新 owner PID，下一次 claim 会看到 borrowed lock 的旧 PID已死并可能进入错误 stale 路径。因此 launch spec 应在 deploy 时列出完整 ownership PID file 集合；cycle 在 TERM 前验证它们全等于 old PID，在 new Bridge healthy 后逐个原子改写并读回验证。

另一个必须定义的状态是“old Bridge 已停、new Bridge 未 ready”。此时不能留下 dead numeric PID：`claim_slot` 会把它当 stale 并自动调用整房 teardown。采用显式 `cycle-failed` lock value + slot-local marker；`claim_slot` 与 `qa_multilead_claim_one` 看到它只能拒绝并要求 operator 显式 teardown，禁止自动 reclaim。`test-teardown.sh` 仍是 operator 明确选择后的恢复路径。

cycle 自身用 `${SLOT_DIR}/.bridge-cycle.lock` 串行化。lock 内记 operator PID；重复动作看到活 holder 时 fail closed，看到死 holder 时可安全回收。它不复用 slot ownership lock，因为后者必须持续表示 Bridge ownership。

## 4. TERM、端口与健康判据

`bridge.pid` 不是 listener authority。当前 `$!` 指向 `npx`/npm-exec wrapper，真正 bind port 的是 `tsx/node` 后代；仓内 `test-teardown.sh` 与 production `restart-services.sh` 都记录过只 kill `$!` 会留下 orphan listener。因此需求中的“SIGTERM 房 Bridge”必须解释为向**该 slot listener 对应的完整 run-bridge process tree**发送 SIGTERM，而非只 TERM pidfile。

cycle 的停止路径应：

1. 再次确认 `bridge.pid`、所有 ownership PID file 与 old wrapper PID一致；
2. 要求 `lsof` 可执行且 strict listener query 成功；结果先按 PID dedupe，再要求恰好一个 listening process；失败/denied 不得解释成“端口空”；
3. 对 `${bridgeUrl}/health` 做正向控制，并用 slot 专属 walker 从 listener 纯沿 PPID上行，收集每一层且必须精确到达 old wrapper PID；listener 已由 port ownership证明、wrapper已由`bridge.pid`/ownership locks证明，两端与祖先关系构成完整 membership proof，不依赖任何 argv/path form。不复用 production `collect_bridge_tree`，因为它为保护生产 restart 明确排除所有 `*worktrees/*` QA Bridge；
4. TERM 前先把全部 ownership locks 原子写成 `cycle-failed` 并安装 EXIT/signal trap；任何 SIGINT/TERM/异常退出都保留 sentinel，绝不留下 dead numeric cycle PID；
5. 逐个对 target tree PID 发送一次 SIGTERM；bounded poll 直到 target tree 全退出；
6. strict lsof 成功且 dedup 后无 listener，再用 Node 对 spec resolved `TEAMLEAD_HOST`（`127.0.0.1` 或 `::1`）+ port temporary bind 成功作为端口释放的正向证明；只看 `/health` down 不够；
7. timeout 时返回失败，不升级 KILL、不启动第二个 Bridge；若 old tree仍 live可恢复 old ownership PID，否则 sentinel 保持 `cycle-failed` 保护房内其余资源。

start 后的成功判据不只是 `/health`：new launcher PID live、strict lsof 取得 dedup 后唯一 listener、slot walker从listener沿真实PPID链精确到达new launcher PID，并且 `/health` 返回预期 healthy shape。port 已在 start 前正向 bind-proven free，所以旧 holder 不可能伪造新 health。executor 先真实 `cd "$cwd"`，command argv[0] 与 generalized wrapper内的 `npx` 都在 capture 时解析成 absolute path，禁止 cycle 时重新 PATH lookup；测试读取 live process real cwd，不以 `PWD` env 自证。初次 launch与cycle都append同一 `bridge.log`；test-deploy在首次launch前显式truncate一次，cycle写无secret boundary line再append child stdout/stderr，保留 `reown_watch_started → revive_started/succeeded` 跨 boot 时间线。

## 5. 不触碰 worker/daemon/tmux 的可执行证明

源码负面搜索只能证明“当前没看到命令”，不足以验证运行行为。公共 seam 的 hermetic E2E 应在同一个测试里：

- 用真实 `test-deploy.sh` fixture 启动真实形状的三层 stub Bridge：npx wrapper不`exec`，中层argv只含repo-relative `scripts/run-bridge.ts`，child listener argv只有tsx loader flags且**不含**`run-bridge.ts`；让每次启动记录三层PID、真实cwd、完整normalized env与boot ordinal。fixture必须有一臂把fake repo放在含`/worktrees/`的path，证明walker既不依赖production exclusion也不依赖argv path form；
- 启动三个独立 sentinel processes，分别代表在飞 worker、Codex daemon、tmux server；
- 调用真实 `scripts/test-cycle-bridge.sh <slot>`；
- 断言 old listener + wrapper tree 全部收到/响应 SIGTERM、端口正向 bind-proven free、new wrapper/listener PID不同且 tree/health identity闭合；
- 断言三类 sentinel PID 与 start identity 均未变化且仍 live；
- 断言 Lead supervisor PID未变化；
- 断言 initial/new normalized full env byte-for-byte一致，而不是只比较 spec 已 pin 的 key；另独立点名 master/ingest/Discord/Linear/projects、三根 Codex scope、BIN/Hooks、state/tmux/marker paths 均存在且 slot-local；
- 断言 owner/borrowed lock 与 `bridge.pid` 一致更新；
- 断言日志是 append 而非 truncate。

此外需要负向 guard 用例：PID/lock mismatch、缺失/宽权限/symlink/malformed spec、old health control 失败、lsof 缺失/denied/ambiguous、TERM timeout、new health timeout、SIGINT/TERM interruption、post-TERM `cycle-failed` 防自动 reclaim。每个失败必须证明未误杀 sentinel，也未调用 teardown/tmux/daemon cleanup。

## 6. 代码放置

建议新增 sourceable `scripts/lib/qa-slot-bridge.sh`，包含 validation/exec/slot-tree/TERM wait/health helpers；新增 `scripts/lib/qa-slot-bridge-spec.mjs capture`，让它作为原三条 assembled `env` 分支的 child 直接读取最终 `process.env`、deny-by-name拆 secret并原子写 spec，避免 Bash文本解析；新增 operator CLI `scripts/test-cycle-bridge.sh`。`test-deploy.sh` 负责定义已有三分支环境并通过同一 spec helper首次启动。

这样 source of truth 的层次是：

```text
test-deploy env composition
        ↓ write once
bridge-launch.json (slot-local, 0600)
        ↓ same helper
initial Bridge launch ── cycle Bridge launch
```

环境的业务组成仍只在 test-deploy；helper 不理解 alerts/roundtable/generalized，只捕获 test-deploy 已解析的 final child env、拆出 secret refs，并忠实 `env -i` 执行 spec。

## 7. 验证边界

实现阶段必须跑新增 shell suite、所有受影响且由 CI literal enumeration 管理的 test-deploy suites、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`。绝不 glob `scripts/__tests__/*.test.sh`：manual-only inventory 含 live Discord、cmux、launchd 与 host-mutating suites。新增 hermetic suite必须显式登记到 `.github/workflows/ci.yml`，并由 `ci-shell-suite-enumeration.test.sh`验证分类。若真实 529 slot 可用，额外执行 generalized room 的 cycle drill，保存 cycle stdout 与 append 后 bridge.log 片段，证明 boot pass 可被真机触发；该 drill 不代替 hermetic regression，也不在 implement 节点自行给 FLY-2211 QA 判 PASS。
