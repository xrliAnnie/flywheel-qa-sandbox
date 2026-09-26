# FLY-2405 起房服务 — 调研
Issue: FLY-2405 (https://linear.app/geoforge3d/issue/FLY-2405/载体起房服务-codex-runner-在沙箱里起不了-529-测试房launchctl-bootstrap-eio-看不到沙箱外进程)
日期: 2026-09-26
基于: exploration.md

---

本文只调研 exploration.md 推荐的方案 B(服务代跑 529 generalized e2e driver)需要回答的问题。
已批准的起房 / 拆房 / 告警值守房部分见 plan.md §1–§19,不重复。

## R1 沙箱里跑 driver 会静默判错吗?—— 会(已实证机制)

- Codex CLI 0.157.1 二进制内嵌的 Seatbelt 规则含 `(allow signal (target same-sandbox))`
  (`strings $(command -v codex) | grep "allow signal"` 实测命中)。即沙箱内进程只能给**同一沙箱**的进程发信号。
- 本机复现:沙箱外起一个 `sleep 30`,再用同型规则
  `sandbox-exec -p '(version 1)(allow default)(deny signal)(allow signal (target same-sandbox))' node -e 'process.kill(pid,0)'`
  ⇒ `EPERM`;同一 pid 在沙箱外探测 ⇒ 存活。
- driver `processAlive()`(`qa-529-generalized-e2e.mjs:237-245`)`catch {}` 吞掉所有异常返回 `false`
  ⇒ 沙箱内会把房内 Bridge 起的活 stub / runner 读成「死」,影响 `probeExecution`、`launchDrainSnapshot`、前次 run 收敛(`:268-283,358-383,457-530`)。
- 结论:「只把 pretrust 挪出沙箱」(方案 A)不够;driver 本身必须在沙箱外跑。
- 不在本单改 `processAlive` 的 EPERM 语义:driver 是被测资产,且一旦在沙箱外运行,EPERM 分支不再出现。实现期加一个**守卫测试**:服务起 driver 的环境里没有 Seatbelt(见 R5)。

## R2 driver 需要什么环境?

逐项读 `qa-529-generalized-e2e.mjs` 的外部依赖:

| 依赖 | 来源 | 沙箱外最小环境是否满足 |
|---|---|---|
| `/tmp/flywheel-test-slot-N/room-info.json` + `apiTokenPath`(0600) | 房 | 是(同用户) |
| `room.flywheelRepo` = 房源码目录,`git rev-parse HEAD == room.buildSha` | 服务的 `src/<room_id>`(plan §7.2) | 是;driver 从**同一目录**取,天然一致 |
| `<src>/packages/config/dist`、`packages/flywheel-comm/dist`、`better-sqlite3` | 房源码目录的 build 产物 | 是(prepare 已 `pnpm install` + `pnpm -r build`) |
| `~/.flywheel/comm/<project>/comm.db`、`<slotDir>/teamlead.db` 只读 | 房 | 是 |
| `node`、`git`、`tmux`、`gh`、`bash`、`python3` | PATH | 是(plan §7.3 已解析这些目录) |
| `gh` 认证(`--real` 清理自有 PR、查 PR 权威) | 宿主 `~/.config/gh` / keychain | 预期是(与 Lead 手工跑同源);**不传** `GH_TOKEN`;QA 验收实测 |
| `TMUX` / `TMUX_PANE` | driver 自己 `delete` | 最小环境本就没有 |
| 宿主 `~/.claude.json`、`~/.codex/config.toml`(pretrust) | `$HOME` | 是(沙箱外同用户) |

`strength-two-contract.ts:renderRerunCommand` 的复跑配方前缀是 `TMPDIR=/tmp/ TEST_REPLY_BY_ISSUE=1`。
drill 环境沿用 plan §7.3 白名单(已含 `TMPDIR=/tmp/`),另注入房 deploy 时记录的 `env` 白名单值
(`TEST_REPLY_BY_ISSUE` 等),让服务跑出的结果与复跑配方语义一致。

## R3 结果如何对齐 strength-two 证据合同?

- `evidence-run record` 需要 `--lane`、`--driver-exit-code`、`--local-copy`、`--rerun-spec`(`evidence-run.ts:229-271`)。
- drill 请求字段与 `GeneralizedRerunSpecV1.driver` 一一对应:`issue`(`^[A-Z]+-\d+$`)、`timeout_ms`(沿用合同的 `[10_000, 3_600_000]`,默认 900_000 = driver 默认 15 min)、`real`(⇔ lane `generalized_e2e_real`)。
- 服务返回 `driver_exit_code`(原样)与 `evidence_copy_dir`(操作目录下、房外、拆房不删),runner 直接拿去 record。
- 服务**不**替 runner 调 `evidence-run record`:record 绑定 runner 自己的 submission credential 与 QA attempt(记忆:必须在 qa-result 之前、由持凭据的 attempt 记);服务代记会把身份弄混。

## R4 drill 与已批准状态机 / 并发的关系

- 房处于 `ready` 时才能 drill;drill 是**房上的一次操作**,不改变 `qa_room.status`(房本身没坏,driver 失败是测试结论)。
- 已实现的表(`qa-room-store.ts:127-156`)`kind CHECK IN ('deploy','teardown')`、`audit.action CHECK IN ('deploy','teardown')`、`UNIQUE(room_id,kind,attempt)`:
  分支未合入、生产库无此表 ⇒ 直接改 `CREATE TABLE` 的 CHECK 为含 `'drill'`,**不需要**迁移脚本;
  实现期注意本机开发库若已建旧表,测试用临时库即可(C2 测试全部用临时库)。
- 并发:每房同时最多 1 个 drill;drill 进行中 runner 的 teardown ⇒ `409 drill_in_progress`(防止拆掉正在跑的测试、丢证据);Lead 的 teardown 可强制:先对 drill 进程组 SIGTERM→10s→SIGKILL、drill 记 `failed(cancelled_by_teardown)`,再照常拆。
- 负载门:drill **不**过服务负载门。`--real` 起的真 runner 由房内 Bridge 自己的 `RunnerAdmissionController` 按宿主 load 把关(同一旋钮),再加一层会双重排队。
- 墙钟:drill 操作上限 = `timeout_ms + 5 min`(driver 自己的收尾/清 PR 时间),超时同 plan §6.2 杀组,记 `failed(timeout)`。
- Bridge 重启恢复:与 deploy/teardown 同一 owner.json / receipt.json 协议(plan §7.5);drill 中断记 `failed(interrupted)`,房保持 `ready`(房的物理认领从未释放)。

## R5 怎样证明 driver 真的在沙箱外跑?

- 服务 spawn 用的是 Bridge 自身(launchd 起,F14)的子进程,环境对象由 Node 构造;Bridge 不在 Seatbelt 内 ⇒ 子进程也不在。
- 实现期守卫:包装器 drill 子命令在跑 driver 前做一次**直接针对本次故障的探针**:
  `mkdir "$HOME/.flywheel-qa-room-probe.<operation_id>" && rmdir` 同名目录(即 pretrust 那把锁所在的 `$HOME` 根);
  失败 ⇒ 判定执行者处在受限沙箱,**拒跑**(exit 96,drill 记 `failed(sandboxed_executor)`),并写一行
  `[qa-room-job] sandbox_probe=home_root_unwritable`。
  不用 `kill -0 <父 Bridge pid>` 当探针:沙箱若存在,父子同在一个沙箱,`same-sandbox` 规则会放行,探不出来。
  这把 R1 的静默判错变成响亮失败,也防「房中房」验收时外层误把服务跑在沙箱里。

## R6 证据先拷后拆

- driver 证据落 `<slotDir>/e2e-evidence/<runId>-<ts>/`;拆房删 `SLOT_DIR`。
- drill 结束(无论退出码)包装器把「本次操作开始后新出现的 `e2e-evidence/*` 目录」`cp -R` 到 `ops/<op_id>/evidence/`,写 `evidence/manifest.json`(文件、大小、sha256),再写 receipt。拷贝失败 ⇒ receipt 里 `evidence_copy=failed`,drill 操作仍 `succeeded`(driver 已跑完)但 `status` 明示,runner 不应拿它作 `--local-copy`。
- plan §8 拆房快照第 4 步追加 `e2e-evidence/`,作为第二份保险(覆盖 runner 在房里手工补跑之类场景)。

## R7 不做什么(边界)

- 不开放任意 driver / 任意 argv:服务端枚举 `driver` 只有 `qa529_generalized_e2e` 一个值,映射到固定相对路径 `scripts/qa-529-generalized-e2e.mjs`。
- 不改 driver 代码、不改 `runner-workspace-trust.sh`、不改 Codex 沙箱可写根。
- `codex:rescue`、Raya 仓 529 harness 仍按 plan §12 不走本服务。
