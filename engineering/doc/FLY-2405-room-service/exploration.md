# FLY-2405 起房服务 — 探索
Issue: FLY-2405 (https://linear.app/geoforge3d/issue/FLY-2405/载体起房服务-codex-runner-在沙箱里起不了-529-测试房launchctl-bootstrap-eio-看不到沙箱外进程)
日期: 2026-09-26
基于: 无(本单首轮设计 doc tier = plan_only,审计写在 plan.md §1;本次重派 tier = full,补本文与 research.md)

---

## 0. 为什么有这份文档

- 首轮设计(plan.md R3 APPROVED)只覆盖「起房 / 拆房 / 告警值守房」。
- 2026-09-26 17:0xZ Lead 重开本单并追加范围:**Codex 沙箱写不了 `~/.claude.json.lock`**
  (`scripts/lib/runner-workspace-trust.sh pretrust-dual` 用 `mkdir $HOME/.claude.json.lock` 做锁),
  ⇒ Codex QA 体跑不了 `scripts/qa-529-generalized-e2e.mjs --real`。
  Lead 原话:「起房服务要能代跑 e2e driver(或沙箱外完成 pretrust)」。
- 实现体 16:39Z 撞 Codex 额度退出,WIP 已原样推到 `22c94c810`;本次设计节点只做**范围增量**,不推翻已批准部分,也不动 WIP 代码。

## 1. 问题陈述(新增部分)

一句话:起房服务解决了「沙箱里起不了房、拆不干净房」,但 529 的核心用法是「起房 → 在房里跑
generalized e2e driver → 拆房」,中间这一步在 Codex 沙箱里**同样跑不通**,所以 Codex QA 体仍然离不开
Lead 手工。

## 2. 现状观察(读码)

| # | 事实 | 位置 |
|---|---|---|
| E1 | driver `--real` 在 POST `/api/runs/start` 之前调用 `bash <room.flywheelRepo>/scripts/lib/runner-workspace-trust.sh pretrust-dual <hostRepo>-<issue>`,并在 step 0 用返回的 canonical 路径核对 worktree 绑定 | `scripts/qa-529-generalized-e2e.mjs:643-649,768-795` |
| E2 | `pretrust-dual` 写两处宿主状态:`~/.claude.json`(锁 `~/.claude.json.lock`,mkdir 锁在 `$HOME` 根)与 `~/.codex/config.toml`(锁 `~/.codex/config.toml.lock`) | `scripts/lib/runner-workspace-trust.sh:100-106,189-195,291-297` |
| E3 | Codex runner 的 Seatbelt 可写根 = `flywheelRoot`、gate marker 目录、CommDB 目录、`sandboxCwd`、git 目录;**不含 `$HOME` 根,不含 `~/.codex`** | `packages/claude-runner/src/codex-daemon-adapter-helpers.ts:30-46`、`CodexTmuxAdapter.ts:1423,1566` |
| E4 | driver 的进程存活探测 `processAlive(pid)` = `process.kill(pid, 0)`,**任何异常都当作「死」**;被探测的 stub / runner 进程由房内 Bridge 在沙箱外起 | `scripts/qa-529-generalized-e2e.mjs:237-245,268-283` |
| E5 | driver 另用 `tmux display-message` 探 pane 存活、`gh pr view/close` 清自己开的 PR、写 `/tmp/flywheel-test-slot-N/stub-control/*.exit.json`、证据写 `<slotDir>/e2e-evidence/` | 同文件 `:206-265,560-580,673` |
| E6 | driver 退出码:0 = 1–9 步全过;20 = 已知 F2 PR 权威诊断;`STUB_FATAL_DIAGNOSIS_EXIT` = stub 致命诊断;其他非 0 = 失败 | 同文件 `:49-60` |
| E7 | strength-two 证据合同已把 driver 编进复跑配方:`lane ∈ {generalized_e2e_stub, generalized_e2e_real}`,`driver = {issue, timeoutMs ∈ [10s, 1h]}`,复跑命令 = `test-deploy.sh … && node scripts/qa-529-generalized-e2e.mjs <slot> --issue X [--real] --timeout-ms N`;`evidence-run record` 需要 `--driver-exit-code` 与 `--local-copy` | `packages/flywheel-comm/src/strength-two-contract.ts:48-49,256-293`、`commands/evidence-run.ts:229-271` |
| E8 | Bridge 自己 spawn runner 时已经做 pretrust(Blueprint 对真实 worktree 发 `pretrustWorkspace`,Claude 写 `~/.claude.json`、Codex 写 execution-scoped `CODEX_HOME`);driver 的宿主双写是 FLY-1961 加的「POST 前兜底」 | `packages/edge-worker/src/Blueprint.ts:3035-3038`;FLY-1961 plan |
| E9 | 拆房 `rm -rf SLOT_DIR` ⇒ `<slotDir>/e2e-evidence/` 会随房消失;plan §8 快照清单目前不含它 | plan.md §8;`test-teardown.sh` |

## 3. 关键洞察

1. **不只是一把锁的问题。** 就算把 pretrust 搬出沙箱,driver 在沙箱里仍有 E4:沙箱内 `kill(pid, 0)`
   打沙箱外进程会被拒(与「沙箱内 `ps` 看不到沙箱外进程」同源,F1),driver 把拒绝读成「死」,
   ⇒ 前次 run 收敛、launch drain、stub 存活判断都可能**静默判错**,而不是报错。
   这正是记忆里「静默失败比报错更危险」的形状。
   (推断等级:读码 + F1 同源现象;实现期用一个沙箱内探针测试钉实,见 research.md R4。)
2. 所以「只代做 pretrust」是补一个洞、留一个更隐蔽的洞;**「代跑整个 driver」**才让 driver 回到它被设计时的运行环境(沙箱外、同一用户、看得见房内所有进程)。
3. plan §12 已把「房内白名单 driver 脚本」列为 follow-up;本次增量就是把它**收窄到唯一一个 driver**
   (`qa-529-generalized-e2e.mjs`)提前做掉,动作集合仍是固定、schema 化的,不变成通用执行口。

## 4. 候选方案

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A 只代做 pretrust** | 服务加 `room pretrust --issue X`:Bridge 在沙箱外跑 `pretrust-dual`;driver 加 `--pretrusted <path>` 跳过自调 | 改动最小 | E4 仍在:沙箱内 driver 的存活探测静默判死;tmux / gh 行为仍依赖沙箱放行;driver 要加新开关(改被测脚本语义) |
| **B 代跑 driver(推荐)** | 服务加 `room drill --room <id> --issue X [--real] [--timeout-ms N]`:Bridge 在沙箱外、最小环境、从房自己的源码目录跑 driver;runner 只读结果与证据 | 一次解决 E1–E5;driver **一行不改**;结果与复跑配方(E7)一一对应;Codex / Claude 同路 | 服务多一种操作(drill),多一个并发/拆房互斥规则;driver 失败时 runner 不能交互式调试(看日志即可) |
| C 放宽 Codex 沙箱可写根 | 把 `$HOME/.claude.json*`、`~/.codex` 加进 writable roots | 零服务改动 | 扩大所有 Codex runner 的写面(`~/.claude.json` 是全机 Claude 状态);E4 不解;违背「不给 runner 扩权」 |
| D 只让 Claude 体跑 driver | 规则层面:需要 driver 的 QA 节点指派 Claude 体 | 零代码 | 违背 founder 选 A 的「Codex / Claude 一视同仁」;额度紧时 Codex 是主力 |

## 5. 推荐

**方案 B**,并补两个配套:

- 拆房快照(plan §8)把 `<slotDir>/e2e-evidence/` 纳入;drill 结束时服务也把本次 driver 新产生的证据目录**先拷**到 drill 操作目录(`~/.flywheel/state/qa-rooms/<room_id>/ops/<op_id>/evidence/`),runner 用它作 `evidence-run record --local-copy`(记忆:先拷后拆)。
- runner 指引:要跑 529 generalized e2e 一律 `flywheel-comm room drill`;直接 `node scripts/qa-529-generalized-e2e.mjs` 只留给 Lead / 沙箱外人工。

## 6. 待确认 / 假设

- 假设 H1:沙箱外最小环境里 `gh` 靠宿主已登录状态(`~/.config/gh` / keychain)可用——与 Lead 手工跑 driver 相同;实现期 QA 验收里实测(research R3)。
- 假设 H2:driver 在 `--real` 下的宿主 pretrust 与 Blueprint 自身 pretrust 重复但无害(E8);本单**不**删 driver 的 pretrust(不改被测脚本)。
- 非阻塞问题(不等回复):若 Lead 更想要方案 A 的最小改动,可在评审时改判;B 是 A 的超集(pretrust 随 driver 一起在沙箱外发生)。
