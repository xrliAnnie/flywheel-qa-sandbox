# FLY-2180 cmux/session teardown CI 偶发红 — 调研
Issue: FLY-2180 (https://linear.app/geoforge3d/issue/FLY-2180/ci红-main-script-tests-挂在-cmuxsession-testfly-1759-reap-first-worktree)
日期: 2026-08-30
基于: exploration.md

## 1. CI 现场还原

### 1.1 红 run

`CI` run `33293218319`：

| 项 | 结果 |
| --- | --- |
| head | `3d87524754c3e91d6087b31753268a62a34416a1` |
| job | `99208427779` / `Script Tests 1/2 — cmux/session (shell suites)` |
| 失败 step | `Test — FLY-1759 reap-first worktree teardown` |
| mock descendant case | PASS |
| unsafe-root negative case | PASS |
| identity/census negative case | PASS |
| real shell/sleep case | FAIL before TERM |

关键时序：

```text
04:48:35.705  real shell/sleep case starts
04:48:35.923  identity/path changed before TERM
04:48:35.924  real process closure did not converge
```

失败发生在约 219ms 内，远早于 reaper 的 5 秒 TERM grace 或 2 秒 KILL verify，因此不是 teardown
timeout、僵尸收敛或工具安装问题。

### 1.2 同字节绿 run

`CI` run `33295771120`：

| 项 | 结果 |
| --- | --- |
| head | `b9070f30b109c4760139cf38f6770b459a820565` |
| job | `99215063345` |
| real shell/sleep case | `PASS: real non-Node child and descendant both exit` |
| shell suite summary | `PASS=4 FAIL=0` |
| removal contract | `PASS=7 FAIL=0` |

`git diff 3d8752475..b9070f30b` 显示 reaper 与两个 FLY-1759 shell test 均未改变。workflow 只在另一个
FLY-2121 step 中多枚举一条命令，不改变 FLY-1759 step、依赖或环境。

### 1.3 Ship workflow 更正

05:15:35Z 的 `Ship on :cool: Comment` run `33294296043` 权威状态是 success：它在 05:56Z 等到
exact-head CI verdict 后完成 merge。现有证据里没有同一 head 的第二个 teardown failure。

## 2. 代码数据流

真实 fixture 的关键路径：

```text
test shell
  └─ /bin/sh in worktree (writes its PID)
       └─ fork child, writes $! immediately
            └─ child shell chdir /
                 └─ shell-dependent last-command optimization
                      └─ /bin/sleep 300

handshake has 2 lines
  → test immediately calls reap_worktree_processes
  → lsof finds parent cwd in worktree
  → ps descendant closure adds child outside worktree
  → capture pid+lstart+command for both
  → before TERM, read the same triples again
```

`$!` 只同步 fork 产生的 PID。当前 handshake 没有任何事件证明 child 已完成最后一条 `exec`。dash 会把
background subshell 的最后一条命令 exec 到 `$!`，macOS bash 3.2 则可能保留 subshell并另起 sleep child；
所以原 fixture 同时有调度竞态和跨 shell PID 语义差异。若 Linux 首次 capture 看到 child shell command，
而 TERM 前复验看到 `/bin/sleep 300`，PID 与 lstart 相同但 command 不同，identity check 会返回 false。

生产逻辑随后把任何 mismatch 记成 `ambiguity=1`，不再发信号并返回非零：

```text
identity/path changed before TERM; refusing further signals
```

这与红 run 的聚合错误一致，但不是直接观测：同一错误也可能来自 lstart 漂移、ps 不可读或中途路径 guard
失败。现证据支持 command-transition 为首要假设；修复同时加入 observed-command 诊断，避免下次仍靠推断。

## 3. 与 FLY-1759 合同对照

FLY-1759 的 approved plan 与独立 QA 明确把 `pid+lstart+command` 三元组定义为误杀防线：command
变化、lstart 变化、identity 不可读都必须零信号 fail closed。真实 shell test 的职责是证明任意类型的
cwd-rooted parent 与已 chdir 的 descendant 能被回收，而不是测试“正在 exec 的进程可否被追杀”。

所以修复必须落在 fixture readiness：

- 不删除 command identity；
- 不新增 shell→sleep 进程类型特判；
- 不在 mismatch 后重试信号；
- 不把失败 case 静默 skip；
- 不降低 Ubuntu CI 的真实进程覆盖。

## 4. 最小实现缝

先把 fixture child 改为显式替换当前 subshell：

```bash
(cd / && exec /bin/sleep 300) &
```

这样 dash 与 macOS bash 3.2 上的 `$!` 都是最终 sleep 的 PID；仍需 readiness poll 消除 PID 写入到 exec
完成之间的短窗。在 `scripts/__tests__/test-reap-worktree-lib.test.sh` 内新增：

```bash
wait_for_process_command() {
  local ps_bin="$1" pid="$2" expected="$3"
  local attempts="${4:-100}" interval="${5:-0.05}" sleep_bin="${6:-sleep}"
  local command
  WAIT_FOR_PROCESS_COMMAND_LAST=""
  for _ in $(seq 1 "$attempts"); do
    command="$(TZ=UTC LC_ALL=C "$ps_bin" -p "$pid" -o command= 2>/dev/null \
      | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" || command=""
    WAIT_FOR_PROCESS_COMMAND_LAST="$command"
    [[ "$command" == "$expected" ]] && return 0
    "$sleep_bin" "$interval"
  done
  return 1
}
```

实现约束：

- `ps_bin` 参数化，hermetic test 不依赖宿主全局 ps；
- helper 只观测，不发信号；
- probe 数量有界为 100；总时长包含每次 `ps` 成本与 0.05 秒间隔，不宣称严格 5 秒（Linux 通常约 6 秒，
  macOS 每次 ps 较慢时可到约 18 秒）；
- expected 精确为 fixture 自己启动的 `/bin/sleep 300`，不是模糊进程名枚举；
- timeout 时打印 `WAIT_FOR_PROCESS_COMMAND_LAST` 与以记录 PID 为 parent 的全量 ps rows，明确 fail fixture并
  跳过 reaper，避免把 setup failure 报成 teardown failure；显式 exec 使 trap 记录的 child PID 正是 sleep，
  失败 cleanup 仍能回收它；
- 保持 Bash 3.2 可用，不用数组、`mapfile` 或 GNU-only 选项。

## 5. TDD 尺子

先在同一 shell suite 增加一个 mock readiness case。mock `ps` 严格要求 argv 为
`-p 201 -o command=`，前两次返回 `fixture-pre-exec`，第三次返回 `/bin/sleep 300`。在 helper 未实现时，
该 case 因找不到 readiness 行为而红；最小 helper 加入后，断言它消费三次采样再成功。第二个 case 让
目标永不出现，断言 helper 有界返回非零、保留最后观测值且 fixture gate 不调用 reaper。

本机可执行的尺子：

```bash
bash scripts/__tests__/test-reap-worktree-lib.test.sh
bash scripts/__tests__/test-worktree-removal-contract.test.sh
```

本机 sandbox 会让真实 case明确 SKIP，但 mock readiness 与现有三组 hermetic case 必须执行。Linux 真
case 的终证是 PR exact-head CI；不能用本机 skip 冒充它。

## 6. 预期改动面

| 文件 | 变更 |
| --- | --- |
| `scripts/__tests__/test-reap-worktree-lib.test.sh` | readiness helper、hermetic regression、真实 child exec-ready gate、诊断文本 |
| `engineering/doc/FLY-2180-cmux-session-teardown/*` | 本 issue 的 exploration/research/plan/progress |
| `engineering/doc/milestones/FLY-2180.md` | PR 创建前的 literal last commit |

明确不改：`.claude/orchestrator/lib/reap-worktree.sh`、`WorktreeManager.ts`、CI job graph、apt helper、
`CLAUDE.md`。
