# FLY-2281 Codex v2 cmux 座位持续死行 — 实施计划
Issue: FLY-2281 (https://linear.app/geoforge3d/issue/FLY-2281/cmux-codex-v2-%E5%BA%A7%E4%BD%8Dflywheel-codex-infra-bot-lead-growth-mufasa-leadcmux)
日期: 2026-09-03
基于: research.md

## 目标与架构

让 launchd watcher 在未继承 `FLYWHEEL_CMUX_ATTACH_TMUX_BIN` 时，安全读取 FLY-2264
已经写入 `FLYWHEEL_ENV_FILE` 的原生 tmux 绝对路径，并把它注入所有新建/修复的 cmux
view surface command。生成器、历史 variants、普通 carrier classifier 与独立 birth-record
classifier 四个 consumer 共用一个受校验的 per-pass snapshot；现有 UUID receipt、birth
proof、topology authorization、verifier 规则保持不变。

有效的 persisted pin 从“写在 `.env` 但 watcher 看不到”变为 attach command 与 birth
authority join 的 canonical 输入。显式继承值继续优先，完全未配置继续使用历史 helper
command；非空错误配置不允许创建/派生 pinned view，却不毒死与该 pin 无关的 Lead/legacy
carrier parse。错误配置每个 process episode 只写一次日志并发一个有界去重告警。

## 文件边界

| 文件 | 计划改动 |
| --- | --- |
| `scripts/test-cmux-sync.sh` | 隔离真实 `.env`；新增 FLY-2281 regression，覆盖 persisted/inherited/unset/invalid、per-pass snapshot、去重告警与 command parse round-trip |
| `scripts/__tests__/fly1944-birth-adoption.test.sh` | 隔离真实 `.env`；新增只有 persisted pin 时 pinned `processTitle` 仍产出 exact birth row 的 regression |
| `scripts/flywheel-cmux-sync.sh` | 新增 attach-tmux reader/cache/episode alert；四个 consumer 接入；所有 relevant pass 在 mutation/census 前 prime snapshot |
| `engineering/doc/FLY-2281-codex-v2-cmux-seats/implementation-evidence.md` | 记录 RED/GREEN、聚焦测试、全仓门禁与审查证据 |
| `engineering/doc/milestones/FLY-2281.md` | PR literal last commit，记录交付与 QA 边界 |

明确不改：`title_source_authorized`、`reconcile_prepared_ledger`、birth/UUID/CAS guards、
`--verify-sidebar` 判定、`scripts/flywheel-view-attach.sh`、launchd plist、production `.env`、
live watcher/workspaces/ledger、`CLAUDE.md`。

## 不变量

1. `load_flywheel_env_value` 仍是读取单个 key 的唯一 parser；不得 source 整份 `.env`。
2. 优先级为有效 inherited value → persisted value → 未配置。继承值为空时可读取 persisted
   value，与现有 parser 语义一致。
3. 非空 pin 必须是绝对路径、不含单引号/CR/LF、当前可执行。任何一项失败都标记 snapshot
   invalid；view builder/variants 返回非零，不得退回未 pin create。
4. 历史未 pin helper、直接 `tmux attach`、pin 后 direct/helper variants 继续被识别，保证
   rolling upgrade 能恢复已有 raw/prepared workspace。
5. 新 command 的 token 格式与 parse round-trip 不变；pinned `processTitle` 必须在 birth
   census 中保留 exact workspace UUID、surface UUID、kind、target、token。
6. 同一 additive/bootstrap/once/converge/verify pass 只读一次配置；中途 `.env` 原子替换只在
   下一次 prime 后可见，create 与后续 guard/birth join 永远消费同一 snapshot。
7. invalid view pin 不得阻断与 pin 无关的 private Lead/unpinned carrier classifier；同一 invalid
   config episode 只写一条 WARN、发一个 `_alert_cmux_cleanup` 去重告警，恢复后重新 armed。
8. topology/receipt mutation 仍只由既有精确 source window、generation、ref、UUID 或 birth
   proof 授权；同名 title 永远不新增 mutation authority。
9. 本节点只交付代码、测试、文档和 PR；不 restart、deploy、merge 或 dispatch QA。

## 第一批：RED/GREEN — 锁定 persisted pin 与 command consumer

编辑 `scripts/test-cmux-sync.sh`：

1. 在 source production 脚本之前，把 `FLYWHEEL_ENV_FILE` 指向临时空文件，避免开发机真实
   `.env` 改写既有默认命令断言。
2. 新增 `test_fly2281_persisted_attach_tmux_bin_reaches_command_consumers`，用临时 executable
   `tmux-a`、`tmux-b` 和临时 env file 覆盖：
   - unset inherited + env file `tmux-a`：`build_attach_command` 必须含
     `FLYWHEEL_CMUX_ATTACH_TMUX_BIN='<tmux-a>'`；
   - `managed_view_command_variants` 必须同时包含 pinned helper variant，并继续包含历史
     unpinned helper/direct variants；
   - `_cmux_carrier_classify` 经 `managed_view_command_parse` 必须把 pinned token command
     解析回 exact view、kind=`view`、exact token；
   - prime snapshot 后把 env file 从 `tmux-a` 原子替换为 `tmux-b`：builder、variants、
     classifier 本 pass 仍只见 `tmux-a`；重新 prime 后四者统一只见 `tmux-b`；
   - inherited `tmux-b` + env file `tmux-a`：snapshot 只使用 `tmux-b`，证明 override precedence；
   - env file 不含 key：输出保持历史 unpinned helper command；
   - relative、不可执行、含单引号三个非空 persisted value：prime 标记 invalid，builder、
     variants 非零，不允许悄悄 fallback；普通 Lead/unpinned carrier parse 仍可工作；
   - 对同一 invalid value 连续 prime/调用多次只产生一条 WARN 与一个 alert；恢复为有效值后
     latch 清空，再次 invalid 会开启新 episode。
3. 用例结束恢复隔离的空 env file，避免污染其余数百条 case。
4. 在既有 FLY-1884 command-variant block 附近调用该 test。

先运行：

```bash
/bin/bash scripts/test-cmux-sync.sh
```

预期只有新 FLY-2281 case RED，具体差异为 persisted `tmux-a` 未进入 generated command；
保留完整 RED 摘要到 `implementation-evidence.md`。在看见该预期失败前不改 production 代码。

随后实现最小 reader/cache（见第二批），只把
`managed_view_command_variants`、`_cmux_carrier_classify`、`build_attach_command` 接到
snapshot，重跑本 case 至 GREEN。此时先不接 birth reader，进入下一独立 RED。

## 第二批：RED/GREEN — birth authority 第四个 consumer

### 2.1 RED

编辑 `scripts/__tests__/fly1944-birth-adoption.test.sh`：在 source production 脚本前使用
空临时 `FLYWHEEL_ENV_FILE`；新增一条真实 `_cmux_attach_birth_records_uncached` fixture：

- inherited pin unset，临时 `.env` 含有效 executable；
- workspace JSON 提供 exact ref + UUID；`list-pane-surfaces` 提供 exact workspace UUID +
  单 terminal surface UUID；session JSON 的同一 surface 持久化 pinned helper command + token；
- 先 prime pin snapshot，再运行 birth census；预期唯一 row 逐字段等于
  `ref|workspace_uuid|title_b64|surface_uuid|view|target_b64|token`。

运行：

```bash
FLYWHEEL_ENV_FILE=/dev/null bash scripts/__tests__/fly1944-birth-adoption.test.sh
```

预期新 case RED（第四 reader 的 `tmux_bin` 为空，row 缺失），既有 cases 继续 GREEN。

### 2.2 GREEN：单一 reader + immutable pass snapshot

在 `load_flywheel_env_value` 后新增以下内部职责（函数名可按仓库风格微调，语义锁定）：

- `_read_cmux_attach_tmux_bin`：复用 `load_flywheel_env_value`，立即把
  `FLYWHEEL_ENV_VALUE` 复制到本地/专用 read result 并清空该通用 global；验证 absolute、
  single-quote/CR/LF-free、executable，区分 unset/valid/invalid。
- `cmux_attach_tmux_bin_cache_prime`：在父 shell 里把一次 read 固化为
  `CACHE_READY=1 + CACHE_VALUE` 或 `CACHE_READY=2`；每次 prime 前 reset，成功/未配置会 re-arm
  invalid episode。
- `resolve_cmux_attach_tmux_bin`：cache ready 时只返回 snapshot；pass 外 cache=0 时按需读一次。
- `_cmux_attach_tmux_bin_reject`：process-local signature latch；同一 reason + value hash 只
  `log` 一次，并用 `_alert_cmux_cleanup` 发
  `cmux_cleanup|attach-tmux-bin-invalid|reason=<reason>|value_sha256=<hash>`；不把配置值当 secret
  注入 command/output。恢复后 latch 清空。

所有赋值必须使用不会吞 resolver rc 的两行形式：

```bash
local attach_tmux_bin
attach_tmux_bin=$(resolve_cmux_attach_tmux_bin) || return 1
```

四个 consumer 的策略：

- `managed_view_command_variants`：函数体开始以 resolver 取得 `attach_tmux_bin`；resolver
  非零则整函数非零。保留现有四类 variants 的输出次序与内容。
- `_cmux_carrier_classify`：调用 Python 前取得相同值；invalid 时只把 `tmux_bin` 视为空，
  让与 view pin 无关的 Lead/unpinned grammar 继续工作，但绝不承认未知 pinned command。
- `build_attach_command`：以 resolver 取得相同值并删除本地重复校验；helper 的既有绝对
  路径/危险字符/executable 校验与 alert 保持原样。
- `_cmux_attach_birth_records_uncached`：以同一 snapshot 把有效 pin传入独立 Python grammar；
  invalid 时仍解析 Lead/unpinned births，但 pinned birth 没有 authority。有效 persisted pin
  必须使 2.1 fixture 得到 exact birth row。

在 `sync_additive_bootstrap`、`sync_additive`、`sync_once`、两轮
`converge_runners_with_handover` 与 `_verify_sidebar_once` 外层（实际函数名按现有调用点）中，
都必须在 `cmux_attach_birth_cache_prime`、任何 title reconcile/create/verify 前 prime pin。
既有 birth cache prime 继续读取本轮同一 pin snapshot。event-driven create 复用最近一次 watcher
pass snapshot，下一次 60s pass 才接收 `.env` 原子替换。

运行：

```bash
/bin/bash -n scripts/flywheel-cmux-sync.sh scripts/test-cmux-sync.sh \
  scripts/__tests__/fly1944-birth-adoption.test.sh
/bin/bash scripts/test-cmux-sync.sh
FLYWHEEL_ENV_FILE=/dev/null bash scripts/__tests__/fly1944-birth-adoption.test.sh
```

预期全部 GREEN，包含 pinned birth row、snapshot consistency、invalid episode suppression。
随后提交一个小代码批次并更新 progress。

## 第三批：聚焦回归与安全反例

运行与本故障因果链直接相关的已存在 suites：

```bash
FLYWHEEL_ENV_FILE=/dev/null bash scripts/__tests__/fly1884-view-attach.test.sh
FLYWHEEL_ENV_FILE=/dev/null bash scripts/__tests__/fly1884-attach-recovery.test.sh
FLYWHEEL_ENV_FILE=/dev/null bash scripts/__tests__/fly1884-node-presence.test.sh
FLYWHEEL_ENV_FILE=/dev/null bash scripts/__tests__/fly1944-attach-protocol.test.sh
FLYWHEEL_ENV_FILE=/dev/null bash scripts/__tests__/fly1944-birth-adoption.test.sh
FLYWHEEL_ENV_FILE=/dev/null bash scripts/__tests__/fly1944-dead-view-rebuild.test.sh
FLYWHEEL_ENV_FILE=/dev/null bash scripts/__tests__/fly2048-cmux-convergence.test.sh
```

并做静态边界审计：

```bash
rg -n 'FLYWHEEL_CMUX_ATTACH_TMUX_BIN' scripts/flywheel-cmux-sync.sh
git diff origin/main...HEAD -- scripts/flywheel-cmux-sync.sh scripts/test-cmux-sync.sh
```

`fly1446-cmux-roster.test.sh` 属于 manual-only fleet/operator fixture，不作为 hermetic 本地门禁；
roster 不变量由 `test-cmux-sync.sh` 现有 mock cases 与独立 QA 的 public verifier 覆盖。

验收：production 脚本中只有 `_read_cmux_attach_tmux_bin` 读取配置；四个 consumer 只消费
resolver snapshot；两份 argv grammar 都由 pinned command/birth-row executable tests 覆盖；
`title_source_authorized`、receipt/birth mutation guards 与 verifier verdict 逻辑 diff 必须为空。
若任一负向 suite 失败，先判断是否是 fixture env 泄漏；真正行为回归才补最小反例并进入下一轮
RED→GREEN，绝不为测试放宽生产规则。

## 第四批：全仓验证

先查 Lead inbox，再执行精确 gates：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

本计划不新增 `scripts/__tests__/*.test.sh` 文件，所以没有新增 shell 文件需要登记；新增行为
分别位于 CI 已执行的 `scripts/test-cmux-sync.sh` 与
`scripts/__tests__/fly1944-birth-adoption.test.sh`。仍保留第三批所有聚焦 shell 结果。

把命令、exit code、passed/failed counts、关键 negative guard 写入
`implementation-evidence.md`，提交并 push。任何 unrelated baseline failure 必须以命令和
日志证据明确区分，不能伪记为本任务 PASS。

## 第五批：代码审查、milestone 与 PR

1. `stage set code_review`，使用仓库支持的 `codex:rescue` review-only 路径审查
   `origin/main...HEAD`；不得用 raw `codex exec`。
2. 注册新的 `review_code` gate 与 `request-review --type code`，轮询结构化
   `reviewVerdict`。CHANGES_REQUESTED 时先补/确认 RED、修复、重跑聚焦与全仓 gates、
   commit/push，再开全新的 review round。APPROVED 的 advisories 用 `ask --report` 转 Lead。
3. review 通过后再次查 inbox；若 `origin/main` 已前进，rebase 后必须重跑第三、四批并为
   新 head 重新 code review。
4. 创建 `engineering/doc/milestones/FLY-2281.md`，内容包括根因、实现、测试、review、PR
   和独立 QA 的 production 验收命令；该文件必须是 literal last commit。此后不再运行会
   commit `progress.md` 的命令，也不再改代码。
5. push 并创建 PR。PR body 含 Linear issue、根因/修复摘要、RED→GREEN 证据、完整 test
   plan；不 merge、不 deploy、不请求 ship approval、不 dispatch QA。
6. 通过 `complete --route needs_review --pr <NUMBER>` 结束 implement 节点。

## 回滚与 QA handoff

代码回滚是 revert FLY-2281 implementation commit；无 schema/data migration，无需状态迁移。
回滚后 production 会恢复到 watcher 只认 inherited pin 的旧行为，已有 receipt/ledger 仍由
旧 guards 管理。

独立 QA 在合入和正常部署后负责：

```bash
scripts/flywheel-cmux-sync.sh --verify-sidebar \
  --target flywheel-codex-infra-bot-lead \
  --target growth-mufasa-lead --json
```

两行必须同时证明 roster present、tmux/view pane alive、`client-count>=1`、render available、
receipt committed，最终 `PASS`。QA 还应观察至少两个 watcher 周期，确认没有新的这两个
title 的 `view-dead` / `topology proof refused` episode。实现节点不自行重启 watcher制造绿灯。

## 完成清单

- [ ] 新 case 在 baseline 上按预期 RED，且不是 harness/fixture 错误。
- [ ] persisted pin 进入 builder、variants、普通 classifier、birth-record classifier；inherited override 优先。
- [ ] pinned `processTitle` 产出 exact UUID/surface/kind/target/token birth row。
- [ ] 同 pass immutable snapshot 与下一 pass reload 都由测试证明。
- [ ] unset 保持 legacy command；三个 invalid value 阻断 view build/variants，但不毒死 Lead/unpinned parse。
- [ ] invalid episode 只记一次 WARN/alert，恢复后重新 armed。
- [ ] token/kind/target parse round-trip 通过，历史 variants 仍可识别。
- [ ] prepared UUID、birth adoption、dead-view rebuild、roster/verifier suites 全绿。
- [ ] `title_source_authorized`、receipt/birth guards、verifier 无 diff。
- [ ] lint、recursive build、package tests 全绿。
- [ ] code review 对最终 implementation head APPROVED；advisories 已报告 Lead。
- [ ] milestone 是 literal last commit；PR 已创建；未 merge/deploy/dispatch QA。
