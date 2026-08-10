# FLY-1663 独立 QA 判决 · 第 2 轮（rework 复验）— FAIL（只剩一条，范围大幅收窄）

Issue: FLY-1663 (https://linear.app/geoforge3d/issue/FLY-1663/拆除-lead-lifecycle-层回归-launchd-原生根治非补丁)
日期: 2026-08-09
基于: qa-verdict.md（第 1 轮 FAIL，三条阻断）；本轮被验 head `fbf8993002153edd631c69c2330f90027284782f`（= `origin/flywheel-FLY-1663`，已含 `origin/main`）

## 判决

**FAIL** —— 但和上一轮不是一回事。**F1、F2 已真修好并逐条复验通过**，载体本身在真 launchd 上依旧全绿。
唯一还挡着的是 **F3**：529 房确实改造了，我也第一次拿到了「真 Claude Lead 跑在 v2 载体上」的实证，
但这个房间**跑不稳**（5 次完整 deploy 只成功 1 次），因此 plan 自己定的 Phase 0 硬门仍然无法可靠执行，
真 Discord 往返也没跑成。

---

## F1 已修复 ✅（验证方式本身可证伪）

修法对路：`fly1663-launchd-foundation.test.sh` 现在在 source `flywheel-daemon.sh` **之前**就
`export FLYWHEEL_STATE_DIR="$HOME/.flywheel"` + `export FLYWHEEL_DIR`，并加了 `assert_sandbox_write_path`
守卫，对 daemon 派生出来的每个写入根（`MANIFEST_DIR` / `PLIST_DIR` / `FLYWHEEL_BIN` / `PID_DIR`）逐个断言，
逃出沙箱就 `exit 99`。`cmux-v2` 与 `bridge-launchd` 同样补齐。

**复验（`/tmp/f1663qa/verify-f1.sh`）**：在**上一轮摧毁生产的那个完全相同的条件**下 —— 让套件继承一个
外部 `FLYWHEEL_STATE_DIR` —— 跑全部 5 个套件：

| 观测 | 结果 |
|---|---|
| 5 个套件 | 全绿（18 / 16 / 10 / 3 / 5，rc=0） |
| 继承的 state dir（诱饵，绝不指向生产） | **0 个文件** —— 套件完全忽略它 |
| 生产 `projects.json` / `manifests/` / `bin/` | sha256 **逐一未变** |

诱饵设计的意义：修好了 → 诱饵空；没修好 → fixture 落进**诱饵**（无害）而不是 `~/.flywheel`。
上一轮的"before"是实打实的（它真的打了生产），所以这是一组有判别力的前后对照，不是空过绿测。

## F2 已修复 ✅（10/10）

修法比我建议的更彻底，两处都动了：
1. **写 manifest 之前先探占用**：`tmux -S <sock> has-session`，有人在就 `fatal`；探针返回值必须精确为 1（无 server）才放行，其他 rc 一律 fail-closed。
2. **runtime 字段改由 server 内部发布**：conf 的 body-pane 第一条命令是 `wrapper --publish-and-start …`，
   先写 `pid`/`socketPath` 再 `exec` body —— 也就是 **exec 被证明成功之后**才落盘；发布失败就收掉 server 让 launchd 重来。

**复验（`/tmp/f1663qa/verify-f2.sh`，隔离沙箱）**

| 断言 | 结果 |
|---|---|
| 有 tty 的手工误跑（plan §5.4 点名场景） | rc=1 **fail-loud** |
| 报错文案 | `private socket already has a live tmux server; refusing a second carrier body` —— 不再是误导性的 `open terminal failed: not a terminal` |
| 无 tty（launchd 形态） | rc=1，同样的正确文案 |
| 两次失败运行后 `manifest.pid` | **逐字未变**（98380） |
| incumbent Lead | 未被打扰（server/body/child 全活） |
| `manifest.pid == launchd pid` | 保持 → **单 Lead 回滚资格未被破坏**（这是 §9.3 的安全网） |

Stage E 另外确认：跨多代重启后 `manifest.pid` 始终等于当前活着的 server，未知字段 `unknownFutureField` 逐字保留。

## 载体本体 ✅（Stage E 15/15，锚定尺子后）

| 项 | 结果 |
|---|---|
| 拓扑反例矩阵 | baseline / main 内多 window / body window 内多 pane / **多 session（两种）** / session 改名 —— 6/6 全部「body 死 → server 收口 → KeepAlive 21–24s 重拉」 |
| hook 隔离（R2 blocker-1 真正的考题） | 额外 pane **和** 额外 session 都活着（`exit-empty` 无法解释）时 SIGKILL body → `%0` hook 仍然收口 ✅ |
| 孤儿 | SIGKILL 路径后无残留子进程 |
| 新增的 PATH 修复（`bdec06fd`） | 我**故意**把 QA plist 的 PATH 设成 launchd 最小集（不含 `/usr/local/bin`），server 仍正确解析到 `/usr/local/bin/tmux` ✅ |

---

## F3 仍未过 ❌ —— 但性质变了

### 好消息：529 房真的改造了，而且我第一次拿到了真 Lead 实证

`test-deploy.sh` 现在把 slot Lead 起成 `launchd → wrapper-v2 → 私有 tmux → lead-body.sh`，
每 slot 独立 label `com.flywheel.qa.lead.slot-N.<agent>` + 独立 HOME/state/projects/env + teardown 注册表；
`FLYWHEEL_DELIVERY_SECRET_PATH` 也补上了（Bridge 侧 `:627`、Lead 侧 `:1167`）—— 上一轮拦住我的那个
"隔离 Bridge 会抹掉生产 delivery secret"的风险，已经消除。

**有一次完整跑通了，我盯着进程树看的**（04:03，`/tmp/f1663qa/logs/`）：

```
t=15s  pane: zsh -c exec /bin/bash …wrapper-v2.sh --publish-and-start …
         └── /bin/bash -p /opt/homebrew/Library/Homebrew/brew.sh shellenv
t=30s  manifest.pid=11173  ← 发布成功
       pane: /bin/bash …/packages/teamlead/scripts/lead-body.sh …
         └── claude --agent flywheel-test-2 --permission-mode bypassPermissions …
              ├── npm exec @upstash/context7-mcp
              ├── npm exec @playwright/mcp@latest
              ├── uv tool uvx … serena start-mcp-server
              ├── bun …/claude-plugins-official/discord/0.0.4/server.ts
              ├── node …/terminal-mcp/dist/index.js
              ├── node …/inbox-mcp/dist/index.js
              └── bun …/gbrain serve
```
test-deploy 自己也确认了：`Confirmed dev-channels prompt` → `Lead flywheel-test-2 ready (lease alive, PID 38102)`。

**这是本单第一份 §15.8 级别的能力证据**：真装配跑通、真 `claude` 起在 `%0`、7 个 MCP 全部加载、
Lead 达到 inbox-ready。载体能托住真 Lead 这件事，从"未验"变成"验过一次"。

### 坏消息：这个房间跑不稳，Phase 0 硬门仍然无法可靠执行

| 完整 `test-deploy.sh 2 --from-branch flywheel-FLY-1663` | 结果 |
|---|---|
| 03:49（默认预算） | FAIL `topology verification failed … manifestPid= socket=` |
| 03:54（`VERIFY_POLLS=1500`） | FAIL（~7 分钟） |
| 04:02（`VERIFY_POLLS=3000`） | **PASS 到 Lead ready**，随后死在隔离 Bridge（见下，非本 PR 问题） |
| 04:04（`VERIFY_POLLS=3000` + 短 TMPDIR） | FAIL（~14 分钟） |
| 04:20（`VERIFY_POLLS=6000` + 短 TMPDIR） | FAIL（~28 分钟） |

**5 次里成功 1 次。**

两条已确认的具体问题：

1. **默认预算就不够用（确定性缺陷）**：`qa_launchd_lead_verify`（`scripts/lib/qa-launchd-lead.sh:137`）默认
   `100 polls × 0.1s` ≈ **10 秒的 sleep 预算**；而我实测独立 bootstrap 同一个 label 的发布延迟是
   **~20 秒（3/3）**。也就是说按 shipped 默认值，529 房的 v2 Lead bootstrap 基本必然失败 ——
   我这唯一一次成功是靠手工把 `FLYWHEEL_QA_LEAD_VERIFY_POLLS` 调到 3000 才拿到的。

2. **登录 shell 被放进了每次 Lead 启动的关键路径**：tmux 用 `default-shell` 起 pane 命令，
   wrapper 的 conf 既没设 `default-shell` 也没设 `default-command`，所以 pane 走 `zsh -c`，
   而本机 `~/.zshenv:2` 是 `eval "$(/opt/homebrew/bin/brew shellenv)"`。
   我在启动瞬间抓到过 pane 的子进程就是 `/bin/bash -p …/brew.sh shellenv`（且映射了 Rosetta 运行时）。
   迁移之后，**每个生产 Lead 的每一次启动、每一次 KeepAlive 重拉，都要过一遍用户的 rc 文件**。
   这正是本单要根除的那类脆弱性：一个与 Flywheel 无关的用户配置卡住，Lead 就永远起不来，
   而 launchd 看到的 job 是"活着的"（tmux server 在），KeepAlive 不会救它。

**未能定因、我不瞎猜的部分**：会话后段该 label 从"3/3 在 ~20s 发布"变成"连续 4 次 120s 内不发布、
pane 存在但无子进程、pane 输出空白"。我没能在本次会话内定位这个转变的原因，**因此不对它下根因结论**。
这一条应由实现者复现定因。

**因此 F3 的结论**：房间交付了，能力证明拿到了一次，但**不可靠 → plan §9.1 的 Phase 0 与 §12.6 的
"真 launchd QA 硬门"仍然不能稳定执行**，15 个 Lead 的迁移不能从一个 5 次成 1 次的 QA 房出发。

### 仍然没做的：真 Discord 往返

因为没有一次完整 deploy 落地（唯一一次 Lead ready 之后死在 Bridge），**真 Discord N-to-N 没跑成**。
本单是 Discord-capable，所以这仍然是**缺口，不是豁免**。

（那次 Bridge 死亡**不是本 PR 的问题**：`listen EINVAL` 落在
`…/runner-state/<execId>/browser-tmp/tsx-501/40494.pipe` —— 我这个 Runner 的 `TMPDIR` 太长，
超了 macOS unix socket 路径上限的已知环境坑。我随后用短 TMPDIR 复跑排除了它，不计入 PR 账。）

---

## 我自己两处读数的更正（这轮）

1. **"extra-session 拓扑回归"是假警报。** 我第一次复跑 Stage A3 报了
   `A4[extra-session] server SURVIVED body death`。Stage D 的重复实验证明是**我的尺子在和 body 启动赛跑**：
   baseline 同样会失败，且失败那次 `child=` 是空的 —— 我根本没杀到东西。新的
   `--publish-and-start` 间接层把时序推后了，我原来的 `kidof(body)` 会抓到装配期的临时子进程。
   换成"等 body 在日志里登记了自己的 pid **且** 存在 ppid=body 的真子进程"之后，Stage E **15/15 全绿**。
   **载体没有拓扑回归，请不要去追这个幻影。**
2. **"manifest 里 `pid: null` 导致不发布"这条假设作废。** 我的 A/B 无效：
   `jq -c '{pid,socketPath}'` 对**缺失**的键同样打印 `null`，所以两个臂读数完全相同，无法区分。
   没有从它得出任何结论。

## 生产隔离与善后

- 载体 QA 只用隔离 label `com.flywheel.qa1663.a` + 沙箱 `/tmp/f1663qa`；529 QA 用 slot 2 的独立 label。
  所有 `launchctl` 都走 FLY-913 护栏的**受审计 bypass**（每次带真实理由），未绕过护栏。
- `scripts/test-teardown.sh 2` 已跑完：slot label 已消失，无 claude / tmux 残留。
- 我的沙箱 plist 已删除，无残留 label。
- 分支曾推到 QA sandbox repo（`flywheel-qa-sandbox`，非生产）以供 slot 克隆，remote 已从本地摘除。
- **生产 `~/.flywheel/projects.json` 自我 02:18 恢复后未再变动**（16 Lead，8102 字节，mtime 02:18:35）。
  本轮 5 个套件在诱饵条件下跑完，生产三处 sha 全部未变 —— 上一轮的事故没有重演。

## 建议（收敛得很近了）

1. `qa_launchd_lead_verify` 默认预算调到实测量级以上（观测发布延迟 ~20s，默认只给 ~10s）。
2. 把登录 shell 从 Lead 启动关键路径上摘掉：conf 里显式 `set -g default-shell /bin/bash`
   或设 `default-command`，别让用户 rc 文件决定 Lead 能不能起来。这条同时是**生产迁移的前置**，
   不只是 QA 房的事。
3. 复现并定因 529 房那段"从能起到起不来"的转变。
4. 上面三条落地后，跑一次完整 529 slot + **真 Discord 往返**（founder 侧走 Claude-in-Chrome），
   补齐 §15.2/15.3/15.8 里 Discord 往返、`--resume` 记忆延续、cmux 同 ref 重连三项。
5. 复跑本轮脚本回归：`/tmp/f1663qa/` 下 `verify-f1.sh`、`verify-f2.sh`、`stage-e.sh`
   （分别应为 5 套件全绿+诱饵空、10/10、15/15）。
