# FLY-1663 拆除 Lead lifecycle 层，回归 launchd 原生 — 独立 QA 判决（FAIL）

Issue: FLY-1663 (https://linear.app/geoforge3d/issue/FLY-1663/拆除-lead-lifecycle-层回归-launchd-原生根治非补丁)
日期: 2026-08-09
基于: plan.md（design r5，founder 已批）；被验对象 = PR #794 head `c9e9777ac7684d5209bcd4ebdd58ba1e81d56778`（与 `origin/flywheel-FLY-1663` 逐字一致，已含 `origin/main` cd922b4f）

## 判决

**FAIL** —— 三条阻断项。载体（carrier）本身的机制在真 launchd 上验得很干净（36/37，含完整拓扑反例矩阵），
但 ① PR 自带的测试套件会摧毁生产舰队配置，② 载体启动失败会污染 FLY-247 运行时证据并**关掉单 Lead 回滚**，
③ plan 亲自定的 Phase 0 硬门（529 房 launchd 化 + 真机验证）未交付，全单没有任何"真 Lead 在 v2 上活着"的证据。

---

## 阻断项

### F1（阻断 · 严重）PR 自带的测试套件摧毁了生产舰队 SSOT

`scripts/__tests__/fly1663-launchd-foundation.test.sh` 文件头自称 "This suite is hermetic"。它不是。

| 事实 | 位置 |
|---|---|
| 只隔离了 HOME | 该套件 `:18` `export HOME="$SANDBOX/home"` |
| 把 fixture 写进 `$FLYWHEEL_STATE_DIR/projects.json` | 该套件 `:105` |
| 直到 149 行之后才隔离 STATE_DIR | 该套件 `:254` `export FLYWHEEL_STATE_DIR="$SHORT_STATE"` |
| `FLYWHEEL_STATE_DIR` 解析优先级 = **ENV > host.json > 默认** | `scripts/lib/host-config.sh`（套件 `:84` source 了 `flywheel-daemon.sh`，其 `:32` 调 `host_config_load`） |
| manifest / bin 也跟着 STATE_DIR 走 | `scripts/flywheel-daemon.sh:41,43` |

**每一个 Flywheel Runner 与 Lead 的 shell 都导出 `FLYWHEEL_STATE_DIR=~/.flywheel`**，所以在 Flywheel 内部跑这些测试
（也就是本仓开发与 QA 的常规方式）时，继承值压过沙箱 HOME，测试直接写生产。

**实际损伤（2026-08-09 01:22:37–40，由我本次运行该套件触发）**

| 对象 | 损伤 |
|---|---|
| `~/.flywheel/projects.json` | 8102 字节 / 7 项目 16 Lead → **135 字节 / 1 条假行** `{"projectName":"flywheel","leads":[{"agentId":"eng-lead","carrier":"v2"}]}` |
| `~/.flywheel/manifests/flywheel-eng-lead.json` | 新建假 manifest（`projectDir:"/tmp/flywheel"`） |
| `~/.flywheel/bin/flywheel-lead-wrapper.sh` / `-v2.sh` / `flywheel-lead-attach.sh` | 被重装进生产 bin（内容与仓库 canonical 一致，但这是 PR 自称"零生产改动"之外的真实生产写入） |

**因果铁证（无需复跑）**：那个假 manifest 里带着
`"socketPath": "/tmp/fly1663-sock.GhgDvt/sock/fw-flywheel-eng-lead-….sock"`，
而 `/tmp/fly1663-sock.XXXXXX` 这个目录名全仓**只有该套件 `:13` 会创建**。

**为什么这是严重级**：`claude-lead.sh` 的 companion 角色判定对 `notfound` 是 **fail-STOP**（`:332-360` 注释与实现，
Codex R4 BLOCKER-1 定的合同）。projects.json 只剩 1 条假行期间，**任何重启的 Lead 都会拒绝启动**，
launchd KeepAlive 会无限重试 —— 一次跑测试就能把整支舰队变成"重启即死"。

**已恢复**：从 `~/.flywheel/projects.json.bak-fly1627-effort-212428`（8102B）恢复。该备份不是盲取 ——
它的 16 条 model/effort/backend/companion 与**全部 16 份现网 manifest 逐条一致**（两个独立权威互证）。
恢复后在**终点**核实：Bridge `/api/fleet/snapshot` 的 `.projects[].leads` 重新读到 16 条。
损坏态留档 `~/.flywheel/projects.json.CORRUPTED-by-fly1663-test-20260809-0122`；
假 manifest 改名 `flywheel-eng-lead.json.BOGUS-fly1663-test-fixture-20260809`（未删除）。
损坏窗口内（01:22–02:18）无 Lead 进程死亡，17 个 Lead label 全部仍加载。

**同类风险**：`fly1663-cmux-v2`（导出 HOME、不导出 STATE_DIR）与 `fly1663-bridge-launchd`（两者都不导出）
属同一类；01:22:38–39 对生产 `~/.flywheel/bin/` 的写入即在同一次运行内发生。CI 里 `FLYWHEEL_STATE_DIR`
大概率未设、HOME 被沙箱化，所以 **CI 会绿 —— 这正是它没被发现的原因**。

**修法**：在 source `flywheel-daemon.sh` 之前就把 `FLYWHEEL_STATE_DIR`/`FLYWHEEL_DIR` 钉进沙箱，
并加一条"套件不得在沙箱外写任何文件"的守卫断言。

---

### F2（阻断迁移 · 中高）载体启动失败会污染 FLY-247 运行时证据，并**关掉单 Lead 回滚**

`scripts/flywheel-lead-wrapper-v2.sh:85` 在 `exec tmux -D`（`:145`）**之前**就把 `pid=$$` 写进 manifest。
plan §3.6 的论据是"exec 保 PID，`$$` 即最终 server PID" —— 该论据只在 exec **成功**时成立。
exec 失败时，manifest 永久留着一个死 PID。

**实测复现（Stage C，隔离沙箱）**

```
before: server=31306  manifest.pid=31306        ← 健康
第二次载体运行（有 tty）: RCMARK=0，未杀 incumbent，但 manifest.pid → 34230（已死）
第三次载体运行（无 tty，即 launchd 形态）: rc=1 "open terminal failed: not a terminal"，manifest.pid → 49438（已死）
after:  server=31306  manifest.pid=49438        ← 不匹配
```

**后果链（逐条读码确认）**
- `scripts/flywheel-fleet.sh:238-242`：`lpid != mpid` → `external-confirmed`
- `packages/teamlead/src/bridge/fleet-data.ts:373-376`：同判定（已有单测覆盖，`fleet-data.test.ts:311`）
- `scripts/flywheel-fleet.sh:1470`：`external-confirmed` + label loaded → **"refusing rollback (would take over an externally managed Lead)"**

也就是说：一次误跑 wrapper，就能让一个**完全健康**的 Lead 被判成外部托管，
从而**关掉 plan §9.3 的单 Lead 回滚** —— 而单 Lead 回滚正是整场 15 Lead 迁移唯一的安全网。
它会在该 Lead 下次正常重启时自愈，但 Lead 可以连跑数天。

**顺带证伪 plan §5.4 的措辞**："socket 被占 → `tmux -D` 自行 fail-loud 退出"。真实行为：
`tmux -D` 在 socket 已被占用时**退化成 client**去 attach —— 无 tty（launchd 形态）时 exit 1，
但报的是误导性的 `open terminal failed: not a terminal`（不是"socket 被占"）；
**有 tty（运维手工误跑，正是 §5.4 点名的场景）时 exit 0，并把运维的终端 attach 进那个活着的 Lead 的私有 server**。
没有破坏性（确实没有 kill-server，§5.4 前半句成立），但既不 fail-loud，也不是设计预期的行为。

**修法**：写 manifest 之前先做一次占用探针（如 `tmux -S <sock> has-session`），占用即 fail-stop；
或把 pid 的落盘挪到 server 确认起来之后。并把占用的报错讲人话。

---

### F3（阻断 · 按 plan 自己的门）PR-A 的"529 房 launchd 化 + 真机验证"未交付，全单没有真 Lead 证据

- `scripts/test-deploy.sh`（1685 行）与 `packages/qa-framework` 在本 PR **零改动**（`git diff --name-only origin/main...HEAD` 命中 0）。
- 二者对 v2 wrapper / launchd 载体**零引用**。
- plan §9.1 Phase 0 原话：「现 test-deploy.sh 直跑 claude-lead.sh 的形态**不能**代表新形态，QA 房需同步改造，**否则 Phase 0 是假 PASS**」。
- plan §14 PR-A 的交付物明列「529 QA 房 launchd 化改造与真机验证」。
- PR #794 的 Verification 清单里**没有任何一次真 Lead 运行** —— 全是单测与 shell 套件。
  §15.8 的能力正向门（Claude config/rules 加载、TUI 渲染、comm identity、每种 MCP、runner spawn/terminal action、git/auth）
  与 §15.2/15.3 里"Discord 往返 / cmux 同 ref 重连 / `--resume` 记忆延续"这几层**完全未验**。

plan §12.6 自己承认「新形态无先例 …… 所以 Phase 0 的真 launchd QA 与金丝雀观察窗是硬门，**不可跳**」。

---

## 已验证通过的部分（这是好消息，而且是本单风险最高的一段）

在**真 launchd** 上、用**完全隔离**的 label `com.flywheel.qa1663.a` + 沙箱 `/tmp/f1663qa` 跑的 Stage A v3：**36 passed / 1 failed**。

| 验收点 | 结果 | 证据 |
|---|---|---|
| §15.1 两层形态 | PASS | launchd job pid **就是** tmux server pid；`ps` 链 `1 → 62423 tmux -D → 64277 lead-body → 64599 child`；无 supervisor/authority/sweep 进程 |
| §15.4 拓扑反例矩阵 | PASS 5/5 | baseline / main 内多一个 window / body window 内多一个 pane / 多一个 session / session 被改名 —— 每种拓扑下 body 死 → server 收口 → KeepAlive 重拉（23–24s） |
| 反向（不得误杀） | PASS | 非 body pane 退出**不**杀 server |
| **fallback 层隔离**（R2 blocker-1 的真正考题） | PASS | Stage B：在**额外 pane + 额外 session 都活着**（`exit-empty` 无法解释）的前提下 SIGKILL body → `%0`-bound `pane-exited` hook 仍然收口。`show-options -g pane-exited` 确认已注册 |
| §15.3 kickstart | PASS | `kickstart -k` 干净收割 server+body+child，零孤儿，随即回来 |
| §5 防双 body | PASS | launchd 拒绝同 label 重复加载（rc=5） |
| §15.7 安全（负向） | PASS | server 全局 env 无 `TEAMLEAD_API_TOKEN`/`OPENAI_API_KEY`/`FLYWHEEL_COMM_DB`；只有自己的 `DISCORD_BOT_TOKEN`；`TMUX`/`TMUX_PANE` 确实 absent |
| env provenance 三段矩阵 | PASS | body pane 侧 `TMUX_PANE=%0`、`TMUX=<本私有 socket>`，且 body 侧同样拿不到 Bridge/OpenAI 凭证 |
| 陈旧 socket 文件 | PASS | 盘上残留 socket **文件**不阻塞下次启动 |
| PR 自带 FLY-1663 shell 套件 | 43/43 | 但见 F1 |

## 对我自己两处读数的更正

1. 我一度报「pane-exited hook 未注册」。那是**尺子坏了** —— `show-hooks -g` 不带参数只列 hook 名。
   `show-options -g pane-exited` 显示它注册着，Stage B 进一步证明它真的会触发。结论反过来：**hook 是好的**。
2. 我一度把 Bridge fleet snapshot 读成「0 leads」。那是**查错了 JSON 路径**（`.leads` 而非 `.projects[].leads`）。
   该读数已作废，不作为任何证据引用。

## 诚实边界（未测的部分，以及为什么）

- **没有跑真 Discord N-to-N。** 本单**是** Discord-capable（Lead 的存活/relay/founder 交互全挂在这层），
  所以这是**缺口，不是豁免**。我没有手工搭 529 房的 launchd 化版本，原因是
  `scripts/test-deploy.sh` 里**没有设置 `FLYWHEEL_DELIVERY_SECRET_PATH`**（grep 零命中），
  按既有教训，隔离 Bridge 不设它会抹掉生产 delivery secret —— 在生产正跑、且刚被 F1 伤过一次的当口，
  这个风险不能接受。这块工作的正确归属是 PR-A 自己（见 F3）。
- **没有在 v2 载体下跑过真 `claude`。** 因此 §15.8 能力正向门未验。
- 拓扑矩阵用的是与 `lead-body.sh` **同形状**的替身脚本（子进程 + wait + `tmux kill-server`），
  不是真装配路径。载体机制的结论成立；真装配能否在 v2 下跑通仍未知。
- `flywheel-fleet.sh:1470` 拒绝回滚这一步是**读码 + 现有单测**确认的，我没有对生产 label 实跑回滚。
  前置条件（manifest.pid 不匹配）是我在隔离沙箱里真复现出来的。

## 生产隔离声明

我的载体 QA 全程只用隔离 label `com.flywheel.qa1663.a` + 沙箱 `/tmp/f1663qa`，
未触碰任何生产 launchd job、生产 socket、生产 plist。
`launchctl` 调用走 FLY-913 护栏的**受审计 bypass**（每次带真实理由，落审计 + 告警），未绕过护栏。
收尾已 bootout 该 QA label 并清理。

唯一的生产改动是 **F1 造成的损伤与我对它的恢复**，全部在上文逐条留档。

## 建议

1. 先修 F1（测试隔离），因为它现在就在伤生产，且任何人复跑都会再伤一次。
2. 修 F2（pid 落盘时机 + 占用探针 + 报错文案），因为它会在迁移窗口里关掉唯一的回滚安全网。
3. 补 F3（529 房 launchd 化 + 真 Lead 真 Discord 验收），这是 plan 自己定的 Phase 0 硬门。
4. 三条修完后重跑本判决的 Stage A/B/C（脚本留在 `/tmp/f1663qa/stage-a3.sh`、`stage-b.sh`、`stage-c.sh`），
   载体那 36 项应当保持全绿。
