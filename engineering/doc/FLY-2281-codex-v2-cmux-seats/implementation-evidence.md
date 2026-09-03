# FLY-2281 Codex v2 cmux 座位持续死行 — 实施证据
Issue: FLY-2281 (https://linear.app/geoforge3d/issue/FLY-2281/cmux-codex-v2-%E5%BA%A7%E4%BD%8Dflywheel-codex-infra-bot-lead-growth-mufasa-leadcmux)
日期: 2026-09-03
基于: plan.md

## 结论

实现提交 `bbf4ee6bb` 把 `FLYWHEEL_CMUX_ATTACH_TMUX_BIN` 纳入 watcher 的持久化运行时契约：
watcher 按 inherited-first 规则读取单个 `.env` key，验证绝对路径、安全字节与 executable，
每个 pass 固化一个 snapshot，并让 command builder、历史 variants、普通 carrier classifier 与
birth-record classifier 四个 consumer 共用该值。有效 pin 会进入新 surface 的 immutable
`processTitle`，因此 workspace UUID、surface UUID、kind、target、token 可被 birth census 精确
恢复；非法 pin 阻止 pinned view 创建/variants，但不阻断 private Lead 与历史 unpinned 解析。

没有修改 `title_source_authorized`、receipt/UUID/CAS guard、verifier verdict、launchd plist、
view helper 或生产状态；实施期间没有 restart、deploy、merge、close/rebuild live workspace。

## 现场只读证据与归因边界

- 当前两个受影响 Lead 已在修复前由 watcher 自愈，workspace 98/99、terminal surface、tmux
  client 与 committed receipt 均存在。因此“当前 `--verify-sidebar` 绿”不能单独证明本修复。
- `tmux list-clients` 得到 client PID 52686 与 56815；`lsof -a -d txt` 对两者都证明实际二进制
  为 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`。
- 当前 persisted `processTitle` 仍是未 pinned helper command，而 FLY-2264 已把同一原生 tmux
  路径写入 `.env`。这直接证明 watcher 的持久化 command identity 缺口。
- 上述证据证明结构性缺口及其修复；由于未修复 watcher 后来也成功重建 workspace 98/99，
  不能把原始 1.3 万条 refusal episode 的全部触发条件只归因于 pin 缺失。QA 应以 pinned
  `processTitle` 和 birth/receipt UUID 归因为判据，而非只看已自愈的当前绿态。

## TDD 证据

### Cycle 1：持久化 pin 与 command consumers

先只编辑 `scripts/test-cmux-sync.sh`，运行：

```text
/bin/bash scripts/test-cmux-sync.sh
Results: 580 passed, 1 failed
```

唯一新增失败为 `cmux_attach_tmux_bin_cache_prime: command not found`，旧 builder 继续生成未 pinned
helper command。实现 reader/cache/episode alert，并接入 builder、variants、普通 classifier 后，
修正一条错误地要求 tokenized command 逐字出现在 tokenless canonical variants 的 fixture 断言；
随后新增独立 prime-order RED（581 passed, 1 failed），证明五类 pass 尚未接线。完成接线后的
最终结果：

```text
/bin/bash scripts/test-cmux-sync.sh
Results: 582 passed, 0 failed
```

最终 case 覆盖 persisted/inherited/unset、relative/non-executable/single-quote invalid、原子替换
后的 per-pass snapshot、四 consumer 同步切换、token/kind/target round-trip、Lead/unpinned 兼容、
同 episode 去重与恢复后 re-arm，以及 bootstrap/additive/once/converge/verify prime 顺序。

### Cycle 2：pinned processTitle birth authority

先只编辑 `scripts/__tests__/fly1944-birth-adoption.test.sh`，隔离 env 与 session state 后运行：

```text
FLYWHEEL_ENV_FILE=/dev/null /bin/bash scripts/__tests__/fly1944-birth-adoption.test.sh
FLY-1944 birth adoption: 20 passed, 1 failed
```

唯一失败为 pinned `processTitle` 对应 birth row 为空。第四个 parser 接入同一 resolver 后：

```text
FLYWHEEL_ENV_FILE=/dev/null /bin/bash scripts/__tests__/fly1944-birth-adoption.test.sh
FLY-1944 birth adoption: 21 passed, 0 failed
```

新增 row 逐字段验证：
`ref|workspace_uuid|title_b64|surface_uuid|view|target_b64|token`。

## 聚焦回归与负向守卫

以下命令均使用 `FLYWHEEL_ENV_FILE=/dev/null /bin/bash`，全部 exit 0：

| Suite | 结果 |
| --- | --- |
| `fly1884-view-attach.test.sh` | PASS |
| `fly1884-attach-recovery.test.sh` | 10 passed, 0 failed |
| `fly1884-node-presence.test.sh` | 22 passed, 0 failed |
| `fly1944-attach-protocol.test.sh` | 10 passed, 0 failed |
| `fly1944-birth-adoption.test.sh` | 21 passed, 0 failed |
| `fly1944-dead-view-rebuild.test.sh` | 5 passed, 0 failed |
| `fly2048-cmux-convergence.test.sh` | 14 passed, 0 failed |
| `fly1944-helper-reap.test.sh` | 14 passed, 0 failed |

重点负向证明包括：unknown pinned command 不获 authority、legacy token cardinality fence 保留、
close 仍经过 exact-ref/UUID seam、helper TERM/KILL 仍受 ancestry 与 durable intent 限制、
generation flip/foreign surface/unreadable topology 均为零 mutation。

静态审计：production 中只有 `_read_cmux_attach_tmux_bin` 调用
`load_flywheel_env_value FLYWHEEL_CMUX_ATTACH_TMUX_BIN`；四个 consumer 只调用 resolver；
`git diff` 对 `title_source_authorized`、ledger/receipt guard 和 verifier verdict 无修改。

## 全仓门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | exit 0；14 条既有 warning/info 均不在本任务文件 |
| `pnpm -r build`（首次） | exit 2；worktree 未安装 `node_modules`，Node types/proper-lockfile 无法解析 |
| `pnpm install --frozen-lockfile` | exit 0；lockfile 未变，仅恢复本地依赖 |
| `pnpm -r build`（重跑） | exit 0；22/22 workspace build 完成 |
| `pnpm test:packages:run` | exit 1；core 219/221，唯一失败为 2 个真实 Terminal.app `osascript` tests，沙箱无法连接 `com.apple.hiservices-xpcservice` |

精确 package gate 的失败与本分支文件无关，但不能记为全绿。补偿验证：

- core 排除唯一真实 GUI 文件：19 files、219 tests 全绿；
- config 顺序执行：45 files、702 tests 全绿（并行补偿时同一 drift scan 曾因资源竞争超过 5s）；
- claude-runner：39 files、971 tests 全通过、2 skip，但 272s 后 Vitest worker 报一次
  `Timeout calling onTaskUpdate`，进程仍 exit 1；
- edge-worker：其余 1255 tests 通过，唯一失败由 runner 注入的
  `FLYWHEEL_STATE_DB_PATH` 覆盖 fixture；同时 unset `TEAMLEAD_DB_PATH` 与
  `FLYWHEEL_STATE_DB_PATH` 后，失败文件 10/10 通过。

这些 runner/GUI 环境限制已通过 non-blocking `flywheel-comm ask` 报告 Lead（question
`d1b89860-bfad-43fb-b431-c3063df4b8bd`）。Lead 确认 Terminal.app/AppleEvents 是 resident
host 无 GUI/XPC 的已知限制，core 非 GUI 219/219 可计本地门，worker RPC timeout 继续按
环境记录；不得修改测试或另找 gate runner 绕过，最终硬门为最终 head 的 GitHub CI 全绿。

## 本地 Codex rescue 审查尝试

按实现节点要求通过 `codex:rescue` companion 提交只读审查（job
`task-mtl9o1ll-key7z7`），没有调用 raw `codex exec`。该 job 在读取仓库或生成任何审查结论前
失败：本机 `sandbox-exec` 无法应用 companion 的文件系统 sandbox，返回 status 71
（`sandbox_apply: Operation not permitted`）。因此本地 rescue 没有 PASS/FAIL verdict，也没有
可消费 finding；后续 blocking review 由随后注册的跨模型 `review_code` gate 承担。

## 跨模型代码审查

request-driven cross-family review 在冻结 head
`979c52ba47c420f82eece587be75a31efbdf6773` 第一轮 `APPROVED`：gate
`547e5268-5c4e-49fc-80b9-ed38c8786d33`，request
`ca5e2b49-29c3-4c52-b7ba-b42cd55d2ea3`，没有 HIGH/blocking finding。

审查保留 3 个 MEDIUM 与 3 个 LOW advisory：更多直接 source sync 脚本的 shell fixture 可进一步
隔离 host `.env`；失效的版本化 Cellar pin 会按本计划锁定的 fail-closed 策略暂停 view 生命周期，
并让既有 pinned command 暂时失去分类；此外可后续加强未 prime 入口诊断、避免 ops verify 内重
prime，以及拒绝 symlink `.env`。这些建议已通过 `ask --report` 发给 Lead；本节点没有借 advisory
改变已批准的 invalid-pin、legacy classifier 或文件范围合同。

## QA handoff

合入并由独立 updater 正常部署后，QA 应检查两个 title：

```bash
scripts/flywheel-cmux-sync.sh --verify-sidebar \
  --target flywheel-codex-infra-bot-lead \
  --target growth-mufasa-lead --json
```

除两行 `PASS`、client/render/committed receipt 外，还必须从 cmux session JSON 证明两行
`processTitle` 含有效 persisted pin，并证明 receipt UUID 与 birth census workspace UUID 一致，
没有 `receipt-uuid-unattributable` warning。再观察至少两个 watcher 周期没有新的对应 title
`view-dead` / `topology proof refused` episode。

回滚为 revert `bbf4ee6bb`；无 schema/data migration，现有 ledger/receipt 无需迁移。
