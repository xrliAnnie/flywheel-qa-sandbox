# FLY-2190 Rosetta 退场前把载体换成原生 — 实施计划

Issue: FLY-2190 (https://linear.app/geoforge3d/issue/FLY-2190/全舰-16-个-lead-的载体是-x86-64-only-的-tmux跑在-rosetta-上-rosetta-退场那天载体直接起不来)
日期: 2026-08-30
基于: research.md

## 0. 范围

| 段 | 内容 | 破坏性 | 本单是否执行 |
|---|---|---|---|
| **S0** | **宿主选择门**：先 ship 并部署那个「求值 post-S1 PATH 实际选中什么」的 fail-closed 检查 | 无 | ✅ 是（**必须先于 S1 单独交付并部署**） |
| **S1** | 统一仓库内 PATH 声明为原生 Homebrew 优先 | 无（部署后下次启动生效） | ✅ 是（**以 S0 已生效为前置**） |
| **S2** | 加 PATH 顺序守卫，防止再次分叉 | 无 | ✅ 是 |
| **S3** | tmux 3.7c cutover（W2 运维窗口） | **有** | ❌ **否** — 本单只交付**顺序约束与待解决问题清单**，不交付可执行 runbook |

**为什么必须有 S0（R4 #1）**：本仓库是**自部署**的 —— `scripts/update-flywheel.sh` 在 `deployed-sha != origin/main` 时自动部署，其路径先 `ff-only` 快进**活的 checkout**（`:138` 一带），再调 `restart-services.sh`（`:144`）；而 `scripts/launchd/com.flywheel.bridge.plist:9` 与 `com.flywheel.voice-bridge.plist:9` **直接指向该 checkout 里的 wrapper 文件**，且 `KeepAlive` 为真。

后果：**放在 S1 同一个 commit 里的门根本跑不到** —— 当时在跑的是旧更新器字节，它不知道有这个门，会先快进再重启；KeepAlive 也可能在任何检查之前就让进程带着新 PATH 起来。

所以「无条件合入 S1」这句话在本仓库是**假的**：合入约等于部署。门必须**先自己成为已部署的字节**，S1 才能合入。

**理由只有「到期」一条。本单不声称任何性能收益**（继承 founder 边界：被翻译的是 shell / python 这类短命进程，开销未测量）。

### 0.0 S1+S2 不解除 Rosetta 到期风险（归属声明，R2 #8）

**必须写在最前面，防止本单的 PR 合入被误读成「这件事做完了」。**

S1+S2 交付后，全舰 tmux 仍然是 x86_64 的 3.5a，**Rosetta 退场那天 16 个 Lead 依然起不来**。本单真正消除的是「PATH 顺序错乱」这一半，以及一条防止它复发的守卫；核心的 tmux 替换（S3）仍未做。

因此：

- FLY-2190 **在 S1+S2 的 PR 合入后不得关闭**；或者等价地，必须在合入时创建一张承接 S3 的阻塞 issue，带明确 owner、期限，以及退出条件 = P1–P7 全解 + runbook 经评审 + founder 授权执行。
- 实施节点的 PR 可以完成它自己界定的范围；**伞形风险不得被标记为已解决**。
- 这一条由 A9 验收。

### 0.0.1 可复用资产已经存在 —— 但没有任何 S3 变更被授权

FLY-1944 已经 ship 了 S3 需要的大部分工装，这是 Lead 指出的、真实且重要的省工点。**但必须把三件不同性质的东西分开**，否则「只差 link」这种说法会被读成「快好了」：

**(a) 已装好的可复用资产 —— 现成可用，无需再造**

| 资产 | 位置 |
|---|---|
| arm64 tmux 3.7c 二进制 | `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`（Aug 20 已装） |
| cutover 事务工具箱 | `scripts/host-terminal-cutover.sh`（收据 / 预算闸 / 静止证明 / 准入暂停 / 三证 census / 回滚闭包构建与演练） |
| 同构版本门 | `scripts/qa-tmux-3.7c-compat.sh`、`packages/claude-runner/test/tmux-3.7c-exact.gate.ts` |
| 宿主工具链护栏 | `scripts/hooks/flywheel-restart-guard.py` |

**(b) 尚待构建/演练的准备性证据 —— 可以在开窗口前做，不改变生产行为**

- 两侧 bottle 预取，使 `preflight-receipt` 的 `missingBottleCount` 为 0
- `build-closure` 构建 3.5a 回滚闭包（`~/.flywheel/backup/tmux-3.5a-closure` 目前不存在）
- `rehearse-rollback` 在隔离 socket 上演练该闭包

**(c) 仅在执行期发生的生产变更 —— ⛔ 未授权，不得提前做**

- **`brew link` arm64 tmux。这不是准备动作。** 它一旦生效，**立即**改变所有已经是原生优先的 carrier（cmux watcher、tick 脚本、若 S1 已部署则还有全部 Lead/Bridge）所选中的 tmux client，把机器推入 P4 尚未验证的混合态。它受 P1/P4/P5 与 founder 授权约束。
- 逐个/整体重启 tmux server。

> **⛔ DO NOT LINK。** 在 P1–P7 全部解决、runbook 经评审、且拿到 founder 授权之前，任何人不得执行 `brew link` arm64 tmux。

**关于 cutover receipt 的一处措辞纠正**：`~/.flywheel/state/host-terminal-cutover.json` 不存在，**不是「还差一个文件」**。receipt 是事务**运行时的产出物**，不是可以先创建来让宿主「就绪」的前置条件。它现在不存在，正确的含义是「这个事务从未运行过」。

**所以**：(a) 的复用价值是真的，不要重造；但 S3 的**流程设计**缺口是 §3.2 的 P1–P7，与 (a) 是否齐备无关。

### 0.1 R1 评审后对本单主张的两处收回

R1 评审证伪了 R1 版 plan 的两个过度主张，此处显式收回：

1. **收回「S1 零风险」。** S1 改的不只是 `python3` 与 `tmux`：两个 bin 目录有 373 个同名条目，其中 **372 个在两侧解析到不同的 realpath**（只有 `node` 两侧指向同一目标，因此 founder「node 原生、最贵那部分没被翻译」的判断仍然成立）。
   *措辞精度*：已测定的是「解析到不同路径」，**不是**「内容或行为不同」——其中有些是脚本而非二进制，两侧也可能功能等价。风险在于**解析结果会变**，需要逐个登记的是**被 Flywheel 实际消费的**那些，见 §1.5。
2. **收回「S3 已可滚动执行」。** R1 版把「可逐个 Lead 滚动」写成了既成结论。滚动变体至少缺三样**基础性**的东西——事务保证、非 Lead server 的处置、混合态下可执行的回滚——**且这不是全部**：§3.2 的 P1–P7 是完整清单，P4（混合版本命令面门）、P5（运行时 client 状态）、P6（消费者矩阵）、P7（启动架构溯源）同样是阻塞项。本单据实把 S3 降级为**约束 + 待办**，不假装它是 runbook。

## 1. S1 — 统一 PATH 顺序

把每一处 `/usr/local/bin:/opt/homebrew/bin` 改为 `/opt/homebrew/bin:/usr/local/bin`。其余路径段位置与内容一律不动。

### 1.1 生产/运维改动点（10 处）

| # | 文件:行 | 角色 |
|---|---|---|
| 1 | `packages/claude-runner/src/tmux-server-environment.ts:21` | **tmux server 出生环境的权威 PATH** — 每个 Lead / runner 及全部子进程继承 |
| 2 | `scripts/lib/tmux-server-rescue.sh:534` | `canonical_path` — 同一份 PATH 的第二个真源，**必须与 #1 同步** |
| 3 | `scripts/flywheel-lead-wrapper-v2.sh:82` | 16 个 Lead 的载体；`:362` 把这份 PATH 原样注入 server env |
| 4 | `scripts/flywheel-bridge-wrapper.sh:54` | Bridge（`restart-storm-gate.py` 在此运行） |
| 5 | `scripts/flywheel-voice-bridge-wrapper.sh:45` | voice bridge |
| 6 | `scripts/flywheel-quota-monitor-wrapper.sh:35` | quota monitor |
| 7 | `scripts/restart-services.sh:33` | 重启编排 |
| 8 | `packages/teamlead/scripts/templates/flywheel-codex-lead-wrapper-mufasa-tui.sh:37` | Codex Lead TUI 模板 |
| 9 | `packages/teamlead/scripts/rollback-codex-lead-mufasa-tui.sh:117` | `FLYWHEEL_ROLLBACK_TMUX_PATH` 默认值（操作员脚本） |
| 10 | `scripts/launchd/com.flywheel.updater.plist:18` | 独立更新器 plist |

**另有 1 处 QA 平价点**（不计入生产数，但必须同改，否则 QA 测的不是生产形状）：`scripts/lib/qa-launchd-lead.sh:71`。

#1 与 #2 是同一份字符串的两个副本。本单只做同步改序，**不**合并它们（独立重构，超出「到期」这一理由）；S2 守卫保证今后不分叉。
**#9 是 #8 的契约镜像**（该文件自述「必须与 wrapper 逐字同序」），必须与 #8 同轮改，否则回滚脚本探测的 tmux 与运行时不是同一个。

#### 1.1.1 第 12 处：一个 PATH 无关的硬编码点，会造成分裂而非干净切换

消费者 sweep 查出一处**不在上表、且不受 PATH 顺序影响**的声明：

```
packages/flywheel-comm/src/commands/qa-result.ts:363
  ["/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/usr/bin/gh"]   ← 硬编码首命中列表，Intel 优先
```

它用 `resolveOptionalTrustedBinary` 取首个存在者，然后在 `:210` 封一个 `PATH: dirname(gh):/usr/bin:/bin` 的密封环境。后果：S1 之后**其他所有消费者都切到 `gh` 2.97.0 arm64，唯独 qa-result 的 GitHub 凭据路径仍钉在 2.74.2 x86_64**。

这是全仓唯一会产生**分裂状态**（而非干净切换）的地方。

**处置：必须改成原生优先。不提供「写注释说明保留 Intel 优先」这个选项。** 理由：本单的唯一理由就是「Rosetta 到期」，而保留 `/usr/local/bin/gh` 在前意味着这条 GitHub 凭据路径**在 Rosetta 消失那天照样会挂** —— 尽管原生 CLI 就在旁边。用一句代码注释「处置」一个到期风险是自相矛盾的。

配套要求：

- 加一个**确定性测试**断言默认候选选择的顺序（不是只测「能选到某个 gh」）。
- 把这个**非 PATH 的优先级列表**纳入 S2 的守卫注册表与发现闭包，使它不能悄悄回退。
- 万一将来发现确有 Intel-only 的兼容需求，那要作为**单独有主、带过期时间、带证据、且必须配原生 fallback** 的例外来处理，而不是一条注释。

*（同文件 `:348` 的 `git` 候选列表是 `/usr/bin` 优先，且 `git` 两侧都不在 Homebrew bin 内，不受影响。）*

### 1.2 测试同步点（6 处，pin 了旧顺序）

`packages/claude-runner/test/runner-env-isolation.real-tmux.test.ts:119`、`packages/claude-runner/test/codex-runner-tui-window.test.ts:629`、`packages/teamlead/src/lead-backends/codex/__tests__/tui-window.test.ts:129`、`packages/teamlead/src/bridge/__tests__/tmux-environment-scrub.test.ts:101` 与 `:188`、`scripts/__tests__/tmux-server-rescue.test.sh:1103`。

**不改**：`scripts/__tests__/lead-alert-dirs.test.sh:70`、`codex-log-guard.test.sh:99`、`lead-alert-founder-timezone.test.sh:89` —— 三处把 fake bin 放最前，两个 Homebrew 前缀只是兜底，顺序无作用。

**已原生优先、无需改但须纳入守卫注册表**：`scripts/flywheel-cmux-autostart.sh:27`、`scripts/meeting-notes-tick.sh:12`、`scripts/xiaohongshu-learning-tick.sh:19`、`scripts/com.flywheel.log-janitor.plist:17`（由 `scripts/install-log-janitor.sh` 安装），以及 5 个 `scripts/launchd/` plist（voucher-watch、daily-digest、token-usage-daily、codex-log-guard、bridge-liveness-probe）。

### 1.3 注释更正（2 处）

- `scripts/flywheel-cmux-autostart.sh:20-27`：现注释称「`tmux` (/usr/local/bin)」且自称「Mirrors the Lead launch wrapper」—— S1 后两句都不成立。
- `scripts/launchd/com.flywheel.updater.plist:12-15`：关于 `/usr/local` 承载 node 的措辞已过期（`/usr/local/bin/node` 实为指向 `/opt/homebrew/bin/node` 的 symlink）。

### 1.4 S1 的 TDD 顺序

1. **RED**：先加 S2 守卫用例（§2.3），此刻应对 10 处生产声明全部报违规 —— 证明守卫真在读这些文件。
2. **GREEN**：改 10 处生产 + 1 处 QA + 6 处测试断言 + 2 处注释，守卫转绿。
3. **回归**：§1.2 涉及的四个 vitest 套件 + `bash scripts/__tests__/tmux-server-rescue.test.sh` + `bash scripts/__tests__/check-global-path-hygiene.test.sh`。
4. **overlap 冒烟**（§1.5）。
5. **阳性对照**：临时把任意一处改回 Intel 优先，守卫必须 RED；恢复后转绿。必须真跑并留证据 —— 永远绿的守卫等于没有守卫。

### 1.5 overlap 清点（R1 #5，必做）

**已测定的事实**（本 runner 2026-08-30 实测）：

| 项 | 值 |
|---|---|
| 两个 bin 目录同名条目 | 373 |
| 其中解析到同一目标（无害） | **1**（仅 `node`） |
| 两侧 `readlink -f` 解析到**不同 realpath**（解析结果会变） | **372** |

372 个里绝大多数是 Flywheel 不调用的库工具（`SvtAv1EncApp`、`certutil`、`brotli` …）。要登记的是**被 Flywheel 实际消费的**那些。

**方法学更正（R2 #2）**：R2 版曾按「我想得到的命令」列白名单查，得出「只有 4 个」——**方法本身是错的，也确实漏了承重项**（`ffmpeg`）。已改用正确方法并跑完：取 372 个会变的名字作为词表，**反向** grep 整个 `packages/` + `scripts/`，再对每个命中回溯它属于哪个 carrier 的进程树。

**Sweep 方法（可复现，实施时必须重跑）**：
1. 取词表 = 372 个两侧 `readlink -f` 不同的 basename；
2. `grep -rwF -f <词表>` 扫 `packages/` + `scripts/`，排除 `node_modules`、`dist`、测试；
3. 每个命中回溯到它属于哪个 carrier 的进程树，判定是否启动关键路径。

**文件类型枚举器（R4 #3，S1 的 sweep 与 S2 的发现闭包共用同一份）**：
必须覆盖 —— shell（`*.sh`、`*.bash`）、**Python（`*.py`）**、JS/TS 全族（`*.js`、`*.cjs`、`*.mjs`、`*.ts`、`*.tsx`、`*.mts`、`*.cts`）、`*.plist`、以及**无扩展名但带 shebang 的可执行文件**。

本 runner 首轮 sweep 的类型集是 `*.sh *.ts *.js *.mjs *.plist`，**漏了 `.py`、无扩展名 wrapper 与 `.cjs/.mts/.cts`** —— 而 `restart-storm-gate.py` 这类 Python 自身也会派生子进程。已就此做了一次只读反查：当前 Python 文件里**只出现已知的 overlap 词**，未发现第九个 carrier 命令；但**这只是一次抽查，不构成边界证明**，实施时必须用完整枚举器重跑。

**实施时重跑此 sweep**：新命中**增行**；若某行消失，必须写明原因，不得默认删除。

**Sweep 结果**：372 个名字里，真正作为命令出现在 Flywheel 代码中的**只有 8 个**。（`ffprobe` 零消费者 —— 只出现在 `product/`、`engineering/` 的 doc spike 里，不在 `packages/`/`scripts/`；`digest`/`conflict`/`trust` 等是英文词或标识符误命中。）

**这个「8」的完整性边界（R3 #5，必须与结论一起读）**：它是**静态发现的、仓库代码自己拥有的**命令名。它**不包含**：
- **agent 在 Bash 工具里动态敲的命令** —— Lead/Runner 的 Claude 与 Codex 会话每天大量跑 `gh`、`python3`、`git` 等，继承 carrier #1 的 PATH。这是本次改动**最大的行为面，且不可 grep**；
- **依赖库自己派生的命令** —— 例如 `@discordjs/voice` / `prism-media` 自行从 PATH 找 `ffmpeg`。

**关于「今天都在 /usr/local 解析」的精确化**：已核实 `~/.local/bin` 与 `~/.npm-global/bin` 不含这 8 个中的任何一个。但**这只对 Intel 优先的 A 组 carrier 成立**；已经是原生优先的 B 组（cmux watcher、tick 脚本、log-janitor）**今天就从 `/opt/homebrew/bin` 解析它们**（见 §1.5.1）。S1 的效果是把 A 组对齐到 B 组，不是「全机从 Intel 翻到原生」。

| 命令 | Intel 侧 | 原生侧 | 关键消费点 | 是否启动关键路径 |
|---|---|---|---|---|
| `python3` | 3.14.6 x86_64 | 3.14.5 arm64 | `scripts/restart-storm-gate.py`（由 bridge / voice-bridge / quota-monitor / cmux-autostart 四个 wrapper 在 exec 前调用，**rc 126/127 = 刹车不可用 ⇒ fail-loud 拒绝启动**）；`scripts/lib/lead-restart-lifecycle.sh:319,410`（Lead 重启标记 + plist 权威校验，硬失败）；`install-restart-guard.sh:33` 与 `claude-lead.sh:1225` 把 `python3 <hook>` **逐字写进 `~/.claude/settings.json`**，每次 Bash 调用/每次 Stop 都触发；`codex-lead-tui-home.sh` 11 处 fail-closed TOML 组装 | **是（多处硬门）** |
| `npx` | npm 11.16.0 | npm 11.9.0 | `scripts/flywheel-bridge-wrapper.sh:286` = `exec npx tsx scripts/run-bridge.ts` — **这就是 Bridge 的启动方式本身**；`flywheel-voice-bridge-wrapper.sh:125` 同理 | **是（Bridge / voice-bridge 的 boot）** |
| `gh` | 2.74.2 x86_64 (2025-06-17) | 2.97.0 arm64 (2026-07-31) | `CodexTmuxAdapter.ts:379`（`gh auth token`，Runner 凭据，失败即 fail-closed 无法推送）；`land-executor.ts` 十余处；`summary-delivery.ts`；`ship-ci-guard.ts`。**另有最大的一块：Lead/Runner 的 agent 自己在 Bash 里跑 `gh`**，继承 carrier #1 的 PATH，不可 grep | Runner 关键；Bridge 运行时 |
| `ffmpeg` | 8.1.2 x86_64 | 8.1.1 arm64 (`--enable-neon`) | `voice-bridge/src/config.ts:354` → `preflight.ts:30`（`verifyPlaybackStack`，**任何 bot 加入语音前抛错即拒绝启动**）。`voice-core` 的 `config.ts:85`/`MicCapture` 只在 POC CLI 路径上，**不在 carrier 树内** | **是（voice-bridge 启动硬门）** |
| `ffplay` | 8.1.2 x86_64 | 8.1.1 arm64 | 仅 `voice-core/src/config.ts:84` → `StreamPlayer`，POC CLI only | 否 |
| `npm` | 11.16.0 | 11.9.0 | `scripts/release/shell-prepare.mjs:64` | 否（发布工具，carrier 不可达） |
| `openssl` | 3.6.2 x86_64 | 3.6.3 arm64 | `scripts/fly2045-pin-archive.sh:67,179` —— `sha256sum`/`shasum` 之后的**第三 fallback** | 否 |
| `brew` | Intel | 原生 | `provision-fleet-host.sh:277`、`flywheel-setup.sh:1285` | 否（**两处都不在 carrier 树内**；其余匹配是报错文案。`host-terminal-cutover.sh:361-362` 已正确地钉绝对路径，不依赖 PATH） |

已确认**不 overlap / 不受影响**：`tmux` 与 `pnpm` 只存在于 `/usr/local/bin`（仍可解析，只是排位靠后）；`node` 两侧指向同一目标；`jq`/`git`/`curl` 在 `/usr/bin`；`cmux`/`tsx`/`claude`/`codex`/`sqlite3`/`plutil`/`launchctl` 等为单侧或系统自带。

**验收分两类，不要混为一谈**（R3 #5）：

**类别一 —— carrier 树内，必须冒烟**（每项记录 before/after 的解析路径 + 版本 + 架构三元组）：

- `python3` —— 已实测：零第三方依赖；两套 hook 测试在 arm64 下 221/0 与 108/0 全绿。**另需补**：`restart-storm-gate.py` 在 arm64 下的**真实刹车路径**（刹车持有 / 恢复 / 错误分支），不是 `--help`。
- `npx` —— **必须真跑仓库实际的 `npx tsx` 引导**（Bridge / voice-bridge 各一次），`npm --version` 不能代替。
  ⚠️ **必须 hermetic 且有界**：这条引导命令就是生产 Bridge 的启动方式本身，冒烟时**绝不能真的拉起第二个生产 Bridge**（端口/socket/状态库都会撞）。用隔离的 state dir + 立即退出的探针形态。
  不对称已登记：`/usr/local/lib/node_modules` 有 npm/pnpm/expo-cli，`/opt/homebrew/lib/node_modules` **只有 npm**。
  📎 记录形态例外（R4 #5）：`npx` 选中的是一个 **JS 入口脚本**，不是 Mach-O 二进制。它这一行记的应是**脚本身份 + 实际解释器（`node`）的路径与架构**，架构一栏对脚本本身标「不适用」—— 不要假装那个脚本是 arm64。
- `gh` —— 覆盖实际在用的子命令族：`pr`（view/list/create/comment/checks/merge/close，20 处）、`api`（11 处）、`repo`（view/clone，6 处）、`run view`、`auth token`。
  **只对只读形态真跑**；**mutating 的动词/参数形态用 `--help` 或 hermetic 测试验证外形**，不要真的建 PR/发评论。
  ⚠️ **`gh auth token` 的 stdout 必须丢弃** —— 只断言退出码，凭据不得进入收据、日志或任何留档产物。
- `ffmpeg` —— 走 voice-bridge `preflight.verifyPlaybackStack` 的真实路径。
  ⚠️ **但要知道它的局限**：`verifyPlaybackStack` 最终只跑 `ffmpeg -version`，只能证明「探针过了」，**证明不了 `prism-media` 真正需要的解码/转码链**。因此**另需一条功能性冒烟**：用原生 arm64 ffmpeg 真跑一次 mp3→opus 的转码，验证 `libopus`/`libmp3lame` 链路可用。两个构建对这些能力的配置已核为一致（原生侧另有 `--enable-neon`）。

**类别二 —— 已判定不在 carrier 树内，只需留档分类，不做冒烟**：`ffplay`（仅 POC CLI）、`openssl`（第三 fallback）、`brew`（两处均不可达 carrier）。**这个判定本身是 sweep 的产出，必须留档，不得默认省略。**

> **Lead 裁示 ③ 追加（2026-08-30，answer `914de24f`）**：`npm` 的静态分类仍是「唯一仓库消费点 `scripts/release/shell-prepare.mjs:64` 不在 carrier 树内」，不把它冒充为 carrier 风险；但实施时必须额外做一条**有界 hermetic 的 `shell-prepare` 生产读点抽验**：(1) 用 post-S1 PATH 记录 `command -v npm` 与 `npm --version`；(2) 在 `mktemp -d` 下以有界超时运行 `node scripts/release/shell-prepare.mjs --out <tmp>/stage --allow-placeholder`；(3) 断言 stdout 恰一行可解析 JSON、`.stagedPath` 在 `<tmp>/stage` 内、且恰有一个非空 `.tgz`；(4) 记录退出码后删除整个临时根。这条验证真实 `npm pack` 消费路径与产物形状，**不**声称是 publish E2E，也不写入默认 `~/.flywheel/publish-staging`。

**范围外但已登记的相关观察**：语音真正的热路径是 `@discordjs/voice` + `prism-media`，它们**自己**从 PATH 找 `ffmpeg`；`preflight.ts` 只是显式探针。该 runner 的 worktree 未安装 `node_modules`，**未能验证**这一条，据实记录为未验证项。

#### 1.5.1 S1 是在消除一个今天就存在的不一致，不是引入新变化

`scripts/flywheel-cmux-autostart.sh:40` 调用的是**同一个** `restart-storm-gate.py` 刹车，但该文件的 PATH 声明（`:27`）已经是原生优先。也就是说**此刻**：

- cmux watcher 的刹车跑在 **arm64 python 3.14.5** 上；
- Bridge / voice-bridge / quota-monitor 的同一个刹车跑在 **x86_64 python 3.14.6** 上。

同一个承重脚本、同一台机器、两个解释器 —— 这个分裂**今天就在生产里**。

**这条证据的强度要说准（R3 #6）**：它是一个**已存在的收敛点观察**，说明 arm64 python 事实上已在执行这个刹车脚本，因此 S1 的方向是**收敛**而非引入新形态。但它**不是健康证明** —— 「没听说出事」不等于该脚本的刹车持有 / 恢复 / 错误分支在 arm64 下被真正执行过，也完全不覆盖其他 python 消费者（那些持久化 hook、`lead-restart-lifecycle.sh` 的硬失败点、`codex-lead-tui-home.sh` 的 TOML 组装）。**它不免除 §1.5 类别一要求的真实刹车路径冒烟，也不免除那 329 个测试的证据。**

`flywheel-cmux-autostart.sh` 因此必须进 S2 的守卫注册表（它已在 §1.2 的「已原生优先」批次内），确保它不会反向漂移成唯一还跑 Intel python 的 job。

### 1.6 S1 的边界与部署门（R2 #1）

**必须区分「合入」与「部署」。** R1 版用「S1 不重启任何东西」论证它无害，这个论证不成立：S1 自己不重启，但 launchd 的班车、KeepAlive 拉起、或操作员的任何一次重启，都会让某个服务带着新 PATH 起来。如果那一刻 `/opt/homebrew/bin/tmux` 已 link，该进程就成为 3.7c client，而机上全是 3.5a server —— 落进 §3.1 允许但**尚未验证**的那条边（P4 未过）。

今天宿主恰好是安全的（`/opt/homebrew/bin/tmux` 不存在，`/usr/local/bin/tmux` 是 3.5a），**但那是可漂移的宿主状态，不是本 plan 的不变量**。因此：

| 动作 | 条件 |
|---|---|
| **合入并部署 S0**（宿主选择门本身） | 先做。它自己不改任何 PATH，安全 |
| **合入 S1**（PATH 改序） | **以「S0 已经是已部署的活字节」为前置** —— 在自部署仓库里合入约等于部署，见 §0 |
| **每次可能消费新 PATH 的重启** | S0 的门当场求值，不通过则 fail-closed |

#### S0 的门规格（R3 #4 + R4 #1/#2）

只查「`/opt/homebrew/bin/tmux` 是否存在」不够 —— 它漏掉更早的 `$HOME/.local/bin` / `$HOME/.npm-global/bin` 遮蔽，也不证明 post-S1 的 carrier PATH 实际会选中什么。门必须**用 S1 之后的那条确切 PATH 求值**，记录：

- 宿主标识、目标部署 SHA、生成时间戳与失效时长、所绑定的部署事务
- 在该 PATH 下 `command -v tmux` 的结果
- 对该结果**直接做路径规范化**（`readlink -f` 一类），再对规范化后的目标跑 `tmux -V` 与 `file`

> **不要在这里用 `extract_tmux_image`（R4 #2）。** `host-terminal-cutover.sh:278-294` 的 `extract_tmux_image(pid)` 接的是**活 tmux 进程的 PID** 并对它跑 `lsof`；本门手里只有 `command -v` 得到的**路径名**，没有 PID，传路径名不工作。而且该文件是命令分发脚本，不是可 source 的函数库。
> 我在纠正 R1 #8 的 `lsof | head -1` 问题时把这个原语套用到了它不适用的场景 —— 这里正确的做法就是规范化路径本身。（§3.4 里对**活 server 普查**的场景仍然用 `extract_tmux_image`，那里确实有 PID，两者不要混。）

**通过条件 = 实际选中的正是 3.5a x86_64 那个二进制**，而不是「某个 symlink 不存在」。

**挂载点 —— 主挂载点必须在 carrier wrapper 内部（R5 #1）**

R4 版把挂载点列为「更新器 ff 前 + 重启事务内 + 手动 `restart-services.sh`」，同时又承诺「每次可能消费新 PATH 的重启」都求值。**这两者矛盾**：Bridge / voice-bridge / quota-monitor 的 launchd job 都是 `KeepAlive=true` 且直接指向活 checkout 里的 wrapper —— **崩溃重启或 launchd 重试会直接启动 wrapper，不经过上述任何一个脚本**，而且可能发生在 ff 之后、事务复核之前，或收据过期/宿主漂移之后。

正确的主挂载点已有现成先例：**`restart-storm-gate.py` 的位置**。它是 FLY-1501 的重启风暴刹车，就挂在**每个 carrier wrapper 内部、真正启动服务之前**，fail-closed（见 `scripts/flywheel-bridge-wrapper.sh:169-176`：`"$RESTART_STORM_GATE_BIN" gate bridge || RESTART_STORM_RC=$?`）。launchd 拉起的就是 wrapper 本身，所以这个位置**天然覆盖 KeepAlive 直接出生**。

| # | 挂载点 | 覆盖什么 |
|---|---|---|
| **1（主）** | **每个受影响 carrier wrapper 内部**，紧邻其第一条 PATH 敏感命令之前，与 `restart-storm-gate.py` 同一区段 | **一切出生路径**，含 KeepAlive / 崩溃重试 / launchd 重启 |
| 2 | 更新器 fast-forward 之前 | 尽早失败，缩小窗口 |
| 3 | 重启事务内、converge / 服务拉起紧邻之前 | 事务内复核 |
| 4 | 手动 `restart-services.sh` 路径 | 人工路径 |

必须覆盖的 wrapper：`flywheel-bridge-wrapper.sh`、`flywheel-voice-bridge-wrapper.sh`、`flywheel-quota-monitor-wrapper.sh`、`flywheel-lead-wrapper-v2.sh`，**以及 §1.6.1 查出的两个脱管 Codex wrapper**。

**放置位置的正确表述（R6 #4）**：挂在**该 wrapper 第一次做 tmux 选择或 exec 服务之前**。不要照抄 `restart-storm-gate.py` 的字面位置 —— Lead 与 Codex wrapper 本来就没有那个刹车，而 Bridge 的刹车是**刻意**放在单实例前置检查之后的。位置语义是「真正启动之前」，不是「和刹车挨着」。

沿用 `restart-storm-gate.py` 的错误处理纪律：**退出码必须在 errexit 豁免的 `|| rc=$?` 里捕获** —— 裸非零会带着门的状态杀掉 wrapper，launchd 会把「门按住了」误读成「崩溃」。

#### 1.6.1 🔴 活舰队 census：两个生产 Lead 的 wrapper 不在源码管理里（R6 #1）

对 `~/Library/LaunchAgents/com.flywheel.lead.*.plist` 做只读普查（16 个 job），结果：

| wrapper | Lead 数 | 仓库内是否存在 | 已安装文件的 PATH |
|---|---|---|---|
| `flywheel-lead-wrapper-v2.sh` | 14 | ✅ `scripts/` 下有 | 由 §1.1 #3 覆盖 |
| `flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh` | 1（`growth-mufasa-lead`） | ❌ **`packages/` 与 `scripts/` 下都不存在** | `:55` **Intel 优先** |
| `flywheel-codex-lead-wrapper-codex-infra-bot.sh` | 1（`flywheel-codex-infra-bot-lead`） | ❌ **同样不存在** | `:34` **Intel 优先** |

**这是一个覆盖漏洞，也是一个治理问题**：这两个是**脱离源码管理的生产资产**。而 §1.1 #8 改的 `packages/teamlead/scripts/templates/flywheel-codex-lead-wrapper-mufasa-tui.sh` **不是** mufasa plist 实际选中的那个文件（活的是 `-fullaccess` 变体）。

后果：若不处置，**16 个 Lead 里有 2 个既拿不到 S0 也拿不到 S1** —— 而 plan 却在声称覆盖全舰。

**处置（二选一，实施时定）**：
- (a) 把这两个实际 wrapper 形态**纳入源码管理**，并接上受测的 converge/install 权威；或
- (b) 把这两个 plist **迁到源码管理的通用 carrier** 上。

无论选哪个：两个活类都必须进 S0 挂载点、S1 改动点、S2 注册表、§1.5 消费者 sweep 与 A0。**已安装字节的更新必须是原子的，且在受影响 job 被允许重启之前完成。**

**A0 必须做 fail-closed 的 launchd plist census**（不能靠我这份清单）：枚举每个生产 Lead plist 选中的 wrapper 路径，逐个要求它**映射到已注册的源码**、且**已部署字节含 S0 挂载**。出现未知的、或与源码漂移的已安装 wrapper → **RED**。这样「清单是否覆盖活舰队」就成了机器判据，而不是靠人列全。

任一入口拿不到收据、或收据无效/过期/绑定的 host 与 SHA 对不上 → **拒绝启动**（fail-closed）。

**门本身要测**：user-bin 遮蔽、收据过期、host 漂移、SHA 不匹配，**以及逐个 supervisor/出生类各一条**（KeepAlive 直接拉起必须有独立用例）。

**若这套 wrapper 改造被判过重**，唯一可接受的替代是：部署事务**先 unload/暂停全部受影响的 KeepAlive job**，待绑定的门通过后再恢复。**不接受**的是保留「每次重启都会检查」这句话却只挂那三个脚本。

#### S0 的具体产物（命名固定，防止两个实施者造出不兼容的证据格式，R5 #4）

| 项 | 约定 |
|---|---|
| 门脚本 | `scripts/host-tmux-selection-gate.sh`，子命令形态与 `restart-storm-gate.py` 对齐（`gate <carrier>`） |
| 覆盖变量 | `FLYWHEEL_HOST_TMUX_GATE_BIN`（与 `FLYWHEEL_RESTART_STORM_GATE_BIN` 同构，供测试注入） |
| 收据位置 | `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/host-tmux-selection.json`（**注意**：必须用 `FLYWHEEL_STATE_DIR` 而非写死 `$HOME`，否则隔离台架会写进生产状态根） |
| 收据字段 | `schemaVersion` / `hostId` / `targetSha` / `generatedAt` / `expiresAt` / `boundTransaction` / `selectedPath` / `canonicalPath` / `tmuxVersion` / `architecture` / `verdict` |
| 有效期 | 短于一个部署窗口；过期即 fail-closed。**部署/重启边界必须当场重新求值**，不得沿用早先收据 |
| 写入契约 | 与既有 receipt 一致：`mktemp` + `chmod 600` + 原子 `mv`；父目录 `0700`；路径为 symlink 或非普通文件即 die |
| 测试文件 | `scripts/__tests__/host-tmux-selection-gate.test.sh`（门自身逻辑）+ 在既有 wrapper 测试中加各 carrier 的挂载点断言 |
| 收据字段（补） | 另加 `carrier` 与 `mountPoint`（R6 #4）—— 多个 wrapper 并发出生时会写同一个收据路径，没有这两个字段就无法分辨证据出自哪个挂载点，且会互相覆盖。同时要定义**独立 KeepAlive 出生**场景下 `targetSha` / `boundTransaction` 取什么值（那次出生不属于任何部署事务） |
| 覆盖变量的约束 | `FLYWHEEL_HOST_TMUX_GATE_BIN` **仅限 hermetic 测试**，或对生产目标做校验 —— 否则一个来自 `.env` 的值就能静默把 fail-closed 的门替换掉（R6 #4） |

#### S0 必须进打包运行时闭包（R6 #2）

`scripts/package-onboard.sh` 用**白名单**决定哪些文件进 payload（现含 `flywheel-bridge-wrapper.sh`、`flywheel-lead-wrapper-v2.sh`、`restart-storm-gate.py`）。**如果打包出去的 wrapper 调用了新门，而 payload 里没有门本体，那些 carrier 直接起不来**（fail-closed 会把「门缺失」判为拒绝启动 —— 这正是设计意图，但缺的原因是打包漏了，不是宿主有问题）。

因此必须一并做：

1. 把 `host-tmux-selection-gate.sh` 加入 `PO_SCRIPT_FILES`；
2. 在 `engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md` 补它的处置行（该打包流程要求每个运行时条目都有一行）；
3. 扩展 assembled-payload 与 `packaged-seams.test.sh` 的断言（后者已在验证既有的门闭包）；
4. 固定门的默认查找路径；若任何 wrapper 从 `~/.flywheel/bin` 解析它，还要加进 `converge-flywheel-bin.sh` 的拷贝闭包及其漂移/权限测试。

**A0 必须同时覆盖 monorepo 与 `.flywheel-prebuilt` 两种执行形态。**

**替代方案**（若 S0 的挂载点改造被判过重）：显式暂停自动部署与 KeepAlive 消费，在 founder 授权的事务里完成 S1 部署。**但「无条件合入 S1」这个说法不能保留。**

若门不通过，S1 不得部署，也不得允许任何服务重启带上新 PATH，直到二者之一成立：(a) P4 混合版本门通过；(b) founder 授权把宿主恢复到旧 client 状态。

在该门成立的前提下，**S1+S2 可以独立推进，S3 保持 parked**。

其余边界：

- S1 生效后裸 `tmux` 的解析取决于 `/opt/homebrew/bin/tmux` 是否已 link：未 link 则不变；已 link 则变 3.7c client。
- **对「两种中间态都安全」的收窄表述**：已验证的只是 3.7c client 与 3.5a server 之间的**握手与 `list-sessions`**（research §2）。生产命令面（attach、control mode、`new-window`、`send-keys`、hook 管理、kill 族）**未验证**。plan 不为「长期停留在混合态」背书。
- 两侧 Homebrew python patch 版本对齐属宿主维护动作，不在本单范围。

## 2. S2 — PATH 顺序守卫

founder 原话：「保留一条检查：将来 provisioning 新机器时，PATH 里原生 Homebrew 必须排在 Intel 之前」。

### 2.1 载体与挂载点（R1 #7 修正）

R1 评审证伪了 R1 版的挂载点结论，此处更正：

| 挂载点 | R1 版声称 | 实测 |
|---|---|---|
| `scripts/converge-flywheel-bin.sh:653` | 会运行 | ✅ **属实** —— 真的 `bash "$HYGIENE_CHECK"`，违规置 `rc=1` |
| `scripts/package-onboard.sh:100` | provisioning 时会跑 | ❌ **不实** —— 那只是一份**打包文件清单**，把脚本装进 payload，并不执行它 |

因此 S2 **不能**只靠「装机时自动跑」。挂载点定为：

1. **CI（唯一被本单认定为生效的挂载点）**：`.github/workflows/ci.yml:607` 已枚举 `check-global-path-hygiene.test.sh`，新用例随之每次 PR 都跑。这是本单保证「顺序不再分叉」的地方。
2. **`converge-flywheel-bin.sh`：本单不把它算作 S2 的挂载点。** 现调用点（`:653-658`）只以可选 `--alert` 调用**全局态**扫描，既不传 repo 根也不传源码树模式；打包 payload 里也没有完整的源码注册表，源码模式在那里无法 fail-closed 地默认生效。要把它变成真挂载点，需要明确的 CLI 与调用点改动（含 monorepo / packaged 两种形态的检测与测试）—— 那是额外工作，**本单显式撤回 converge 作为 S2 挂载点**，只留 CI。
3. **provisioning：不声称自动生效**（开放项，不在本单实现）。

因此 A3 必须断言**源码模式真的产出了判定**，而不是断言「旧的全局扫描调用点存在」或「脚本被列进了打包清单」。

仍然扩展 `scripts/check-global-path-hygiene.sh` 而非新建脚本（它已是只读扫描器 + `exit 1` 形状，`--alert` 走**现成**的 `lead-alert.sh` 管道，满足「新 alert kind 走现有管道=允许；新守护 daemon/新通知通道=禁止」）。但必须解决 R1 #7 指出的两个不匹配：

- **模式分离**：现有检查针对「全局配置里的临时路径」，新规则针对「仓库源文件里的 PATH 顺序」，两者的输入根不同。新规则走**显式的源码树模式**（校验过的 repo 根 + 注册表），不与全局扫描混在一条输出里。
- **告警语义**：现有 `bin_integrity_drift` 告警文案讲的是 temp/worktree 引用，套用到 PATH 顺序违规会给出错误的修复指引。新规则必须有自己的文案。

### 2.2 判据

- **规则**：任何**同时**含 `/opt/homebrew/bin` 与 `/usr/local/bin` 的**优先级声明**中，`/opt/homebrew/bin` 必须先出现。只含其一不判违规。
- **不读运行时 `$PATH`** —— 它随调用者漂移，做不成稳定判据。
- 判据实现放进 `scripts/lib/path-hygiene.sh`（既有单一真源），供扫描器与测试共用。
- **CLI**：明确为 `check-global-path-hygiene.sh --source-tree <已校验的 repo 根>`。CI 调用这个形态，A3 观察的是**它的判定**。

#### 2.2.1 发现文法与例外模型（R3 #3，没有这一节守卫跑不通）

「全仓扫同时含两个前缀的行」这条规则**在当前树上直接跑会炸**：仓库里已经存在大量合法的双前缀行 —— 三个故意 Intel 优先的 fake-bin 测试 fixture（`lead-alert-dirs`、`codex-log-guard`、`lead-alert-founder-timezone`）、原生优先的测试 fixture、提到两个前缀的**注释**、非 PATH 的**候选数组**（`qa-result.ts` 的 gh/git 列表）、QA 探针、以及 `engineering/doc/` 下的历史证据文档。字面扫描要么把它们全标红，要么无声地长出一堆临时排除项 —— 两种都不可接受。

因此必须显式定义：

1. **源根与文件类型**：只扫 `packages/` 与 `scripts/`（含 `scripts/launchd/`），文件类型用 §1.5 那份**共用枚举器**（shell / Python / JS-TS 全族 / plist / 无扩展名 shebang 可执行文件）。**`engineering/doc/` 与 `product/doc/` 一律不扫** —— 历史文档记录的是当时的事实，不该被今天的规则判违规。
   *（R4 #3：早先版本这里只列了 `.sh/.ts/.mjs/.plist`，连 `.js` 都没有 —— 那样一个新写的 JS 或 Python 声明就能绕过守卫，而 plan 却在宣称发现闭包。必须与 §1.5 用同一份枚举器。）*
2. **候选文法**：只有**优先级声明**才是候选 —— `export PATH=…` / `PATH=…` 赋值、plist 的 `<key>PATH</key>` 对应 `<string>`、以及 TS 里赋给 `PATH:` 的模板串。**注释行不是候选**；**非 PATH 的候选数组不按此文法匹配**（它们走下面的显式登记）。
3. **三分类，未知一律 fail-closed**：每个被发现的候选必须落进其一 ——
   - *受守卫的优先级声明* → 适用原生优先规则；
   - *明确无关* → 必须在**例外注册表**中登记（路径 + 行形态 + 理由），例如三个 fake-bin fixture（前缀是 fake bin，两个 Homebrew 段只是兜底，顺序无作用）；
   - *违规*。
   - **未登记且不匹配已知形态 = 违规**（不是「忽略」）。
4. **非 PATH 优先级列表也要有发现闭包**（R5 #4）：`qa-result.ts:363` 的 gh 候选数组按 §1.1.1 纳入守卫，用它自己的断言形态（不套 PATH 文法）。
   但**仅登记这一个已知数组是不够的** —— 那会让未来新写的、同形状的数组落在闭包之外。发现种子必须能识别**「同时含两个前缀字面量的候选数组/列表」这一形态本身**，对**未注册**的新实例判违规。配套负例：新造一个 `qa-result` 形状的双前缀候选数组 → RED。

**测试必须覆盖**（缺一即视为守卫未完成）：注释行不误报 / 候选数组不按 PATH 文法误报 / 三个故意的 fake-bin fixture 不误报 / `engineering/doc/` 下的历史文档不误报 / **新建一个未注册的生产声明 → RED** / 未知形态 → RED（fail-closed）/ `qa-result.ts` 候选数组反序 → RED。

**新增负例必须跨文件类型**（R4 #3）：未注册的新声明至少要各造一个 **Python 形态**、一个 **JS 形态**、一个**无扩展名 shebang wrapper** 形态。否则闭包可能只是因为测试恰好用了被扫描的后缀才通过。

**注册表 + 发现闭包缺一不可**：注册表只能证明已列文件仍守规矩，挡不住新增文件；发现闭包只能找到候选，挡不住已知文件被悄悄改序。两者一起才构成守卫。注册表须显式含 §1.1 的 10 处、**`scripts/lib/qa-launchd-lead.sh`**（否则 A1 承诺的 10+1 不成立）、§1.2 的「已原生优先」批次、以及 `qa-result.ts` 的候选数组。

### 2.3 测试用例（`scripts/__tests__/check-global-path-hygiene.test.sh`）

| 用例 | 期望 |
|---|---|
| 原生优先的声明 | PASS |
| Intel 优先的声明 | **违规** |
| 只含 `/opt/homebrew/bin` / 只含 `/usr/local/bin` | PASS |
| 同文件多条声明，其一 Intel 优先 | **违规**，报出具体行 |
| plist `<string>` 形态 | 与 shell 形态同判 |
| 文件不可读 / 注册表列出的文件缺失 | **违规**（fail-closed） |
| **新建未注册的混合前缀声明文件** | **违规**（发现闭包，R2 #3） |
| QA 平价点 `scripts/lib/qa-launchd-lead.sh` 违规 | **违规**（必须在注册表内） |
| **阳性对照**：真实生产文件之一临时改回 Intel 优先 | 扫描器 RED |

最后一条是防空过的关键：用例必须**同时**覆盖自造 fixture 与真实生产文件 —— 只喂自造输入只能证明分类器能分类，证明不了它真在读生产文件。

### 2.4 S2 边界

守卫只管**仓库内的声明**，不检查宿主 `/etc/paths` 或用户 shell rc（§4 明确不做）。只报不修。

## 3. S3 — cutover：顺序约束与待解决问题（本单不执行，也不交付 runbook）

**R1 评审的三条 BLOCKER 全部指向同一件事：R1 版把一个尚未设计完的滚动流程写成了可照做的 runbook。** 本单据实收回，改为交付两样东西：一条已被实测钉死的**顺序约束**，和一份 S3 开工前**必须先解决的问题清单**。

### 3.1 顺序约束（已被实测钉死，任何 S3 方案都必须满足）

依据 research §2 的实测。**表述限定在实测过的那一对具体版本上** —— 实验只覆盖 3.5a 与 3.7c 这一对的一个命令，不构成「client 版本 >= server 版本」这样的语义化版本律（R2 #5）：

```
不变量（就 3.5a / 3.7c 这一对而言）：
  任何相关的 3.5a client —— 无论是被 PATH 选中的，还是以绝对路径调用的 ——
  都不得指向一个存活的 3.7c server。
  （协议危险与 client 怎么被找到无关，所以不变量不能只覆盖 PATH 这一条路径。
    P5 的证明范围必须相应覆盖绝对路径调用点，例如
    FLYWHEEL_LEAD_V2_TMUX_BIN / FLYWHEEL_CMUX_ATTACH_TMUX_BIN 之类的 pin。）

推论 A  升级方向：在创建任何 3.7c server 之前，每一类相关 client
        都必须被钉住或被证明为 3.7c（见 P5）。
推论 B  回滚方向：必须先让所有 3.7c server 消失，才能把 client 降回 3.5a。
        ——「先 unlink 再收拾 server」是错的：剩下的裸 client 回落 3.5a 后
           控制不了仍存活的 3.7c server（R1 #3）。
附加条件：即便是被允许的那条边（3.7c client → 3.5a server），
        也只有在 P4 通过后才可用于生产，不是现在就成立。
```

**已验证的强度**：3.7c client 对 3.5a server 的**握手与 `list-sessions`** 为 rc=0；反向为 rc=1 且 server 存活。**未验证**：attach、control mode、`new-window`、`send-keys`、hook 管理、kill 族等生产命令面。现阶段只能说「握手与 `list-sessions` 已验证」，**不能说「工作正常」**（R1 #4）。

### 3.2 S3 开工前必须先解决的问题（本单不解决，逐条登记）

| # | 问题 | 为什么阻塞 |
|---|---|---|
| P1 | **滚动变体缺事务保证** | `host-terminal-cutover.sh` 是收据与有界命令工具箱，**不是**九步状态机，也没有 per-Lead 滚动操作。FLY-1944 原 W2 是整机事务：暂停准入 → 两次零快照证明静止 → 停全部 supervisor → 权威普查 → 停旧 server → 改链接 → 引导服务 → 验证 → 恢复准入。滚动变体要么保留整机事务，要么**定义并实现**每批次的完整事务（含跨窗口的收据续期/重入），并对其做测试。**散文式断言「旧脚本已支持滚动」不算复用。** |
| P2 | **只重启 Lead 达不到验收标准** | 实测机上 44 个 tmux 进程 / 20 个活 server，Lead 只占其中一部分；另有 default、atlas、runner、QA 残留与未归属 server（FLY-1944 exploration 记录过「52 个活 server 中约 36 个未归属」）。而验收要求 `ps` 里不再有 Intel tmux。必须先做权威普查 + 按 owner/supervisor 分类，给每一类明确的迁移/停止/白名单残留处置。**若最终决定只做 Lead，就必须收窄验收标准并显式保留残余的 Rosetta 到期风险 —— 那不满足本 issue 的原始诉求。** |
| P3 | **混合态下的回滚不可执行** | `build-closure` 只造 wrapper、`rehearse-rollback` 只在隔离 socket 上演练，**脚本不安装该 wrapper、不用它重启 Lead、不执行回滚**；900s 是常规步骤前检查的预留额度，不是已实现的回滚事务。且在 `/opt/homebrew/bin/tmux` 仍 link 且排在前面时，光有 3.5a 闭包也无法让重启后的 Lead 选中它。回滚必须按推论 B 写出确切命令序。 |
| P4 | **混合版本门缺失** | 需要一个 fail-closed 的混合版本门：起一个 3.5a server，用 3.7c client 驱动生产命令面（含 Lead/cmux attach 路径与 `pane-exited` 清理命令）。现有 `qa-tmux-3.7c-compat.sh` 是**同构** 3.7c 门，只能当终态门，证明不了中间态。 |
| P5 | **运行时 client 状态未证明** | 合并/部署 SHA 不等于每个存活 client 都已是 3.7c：Bridge、Runner、helper、pane、tmux server 环境都可能保留旧 PATH（R1 #6）。第一个 server 升级前，必须让 S1 完全 converge，并对每一类长寿命 client 证明其**实际选中的** tmux 路径与版本，或先让这些类静止/重启。 |
| P6 | **消费者矩阵不完整** | 无生产运行时要求版本恰为 3.5a，但 3.5a 特定行为假设散布在 `scripts/flywheel-cmux-sync.sh`、`scripts/test-cmux-sync-hooks-integration.sh`、`packages/claude-runner/src/TmuxAdapter.ts`、`packages/teamlead/src/bridge/tmux-lookup.ts` 与 edge-worker 真机测试。现有 3.7c 门只覆盖 cmux 与 claude-runner，未覆盖 teamlead / edge-worker / flywheel-comm / core。每个版本敏感族要么对 3.7c 实跑，要么给出「与协议无关」的测试锚点。 |
| P7 | **启动架构溯源 / CPU 偏好未纳入事务**（R2 #6） | exploration §2.1–2.2 实测：从 x86 偏好的父进程启动 **arm64** tmux，其 universal 子 shell 仍然 `proc_translated=1`；`arch -arm64` 重置该偏好且可传递。生产被认为安全，依据是「Lead server PPID=1 且 launchd 原生」—— **这是一条推断，且必须在每一个 server 类与每一条重启路径上分别成立**。§3.4 只能在批次**之后**发现坏结果；事务必须在破坏性动作**之前**证明启动链。要求：对每个 supervisor / 启动路径分类，要求原生 launchd 或显式 arch 重置，跑一次子进程 `proc_translated=0` 的阳性对照，并记录父进程与启动身份。现有 census 的 preflight 记录了镜像架构与 PPID，**但不记录被继承的子进程 slice 偏好** —— 需扩展。 |

### 3.3 护栏语义（R1 #10 修正）

R1 版称「走护栏自带的 Lead/founder 授权路径」—— 不准确。实测语义：

- `flywheel-restart-guard.py` 的 brew 拦截（P5 类）**只在存在 `FLYWHEEL_EXEC_ID` 时触发**；无该变量的 Lead/founder 上下文放行并写一条审计行。
- Runner 侧存在 `FLYWHEEL_RESTART_GUARD_BYPASS=<reason>` 通用前缀，但它要求审计写入**与**严格告警投递双双成功 —— 这是**可审计旁路**，不是「Lead/founder 批准」。
- 滚动 cutover 需要的 `launchctl kickstart` / `bootout` 属 P1 类，在 Claude Bash 中同样被拦。
- 附带实测：本 runner 一条**纯只读**的文件名比较命令，因文本中出现 `brew` 字面量被拦下（未绕过，改写后重跑）。护栏偏保守，S3 设计时要把这一点算进去。

**结论**：S3 的授权必须是 runbook 级的外部 founder 授权前置，**不能声称 hook 提供了授权**。执行上下文与确切的审计旁路合同要在 S3 方案里写明。

### 3.4 验收标准（对 founder 原始方向的一处补充与一处纠错）

founder 给的两条：① Lead shell 里 `proc_translated` 读到 0；② `ps` 里不再有 `/usr/local/bin/tmux`。

**补充第 3 条**：实验 F2 证明「shell 原生」不蕴含「shell 里跑的东西原生」——一个完全原生的 shell exec 一个 x86_64-only 的 `python3`，那个进程照样 `proc_translated=1`。验收必须同时覆盖 hook 实际解析到的解释器。

**纠错（R1 #8）**：R1 版给的取像命令 `lsof -p $p | awk '$4=="txt"' | head -1` **重现了 FLY-1944 已经避开的 bug** —— Rosetta 进程可能暴露多个 `txt` 条目，第一行不权威。必须复用 `host-terminal-cutover.sh:278-296` 的 `extract_tmux_image`（白名单形状 + 阳性对照），不要自造。

同时，per-Lead 验证仅查 `proc_translated` 不足以证明该 Lead 健康。每批次后应机器化记录：launchd PID 与启动身份、socket 归属、Lead body 健康、cmux/`--verify-sidebar` 判定，落成收据。终局判定 = 权威全 server 普查 + 全 Lead 健康/视图检查。

### 3.5 回滚

按 §3.1 推论 B。确切命令序属 P3，本单不给 —— 给一个未经验证的回滚序比不给更危险。

## 4. 明确不做

- 不在本单执行 S3，也不交付「照着做」的 S3 runbook（R1 收回）。
- 不重写 `host-terminal-cutover.sh`；若 S3 需要滚动能力，那是对它的**受测扩展**，不是散文断言。
- 不动 `/etc/paths`、不改用户 shell rc、不碰 Homebrew 全局配置。Lead 不读用户 rc（`flywheel-lead-wrapper-v2.sh:281-284`），修仓库代码就够。
- 不合并 `tmux-server-environment.ts:21` 与 `tmux-server-rescue.sh:534` 两个 PATH 真源 —— 独立重构；本单同步 + 加守卫防分叉。
- 不把 50+ 个裸 `tmux` 调用收敛到统一解析层 —— 跨 5 个包的大重构，与「到期」这一理由不成比例。独立 issue 候选。
- 不对齐两侧 Homebrew python patch 版本 —— 宿主维护动作。
- 不声称任何性能收益。
- 不在本单让 provisioning 自动执行 S2 守卫（§2.1 开放项）。
- **不把 `converge-flywheel-bin.sh` 算作 S2 的挂载点**（§2.1 显式撤回）—— 让它跑源码模式需要额外的 CLI/调用点改动与双形态测试，本单不做。
- 不在本单关闭 FLY-2190 的伞形风险（§0.0）。

## 4.5 实施前必须先定的四件事（Codex R7 APPROVED 时附带的非阻塞注记）

设计评审在 R7 判定 **APPROVED — ready to implement**，同时留了四条实施注记。它们不是正确性或安全缺陷，但**必须在动手前定下来**，否则实施中会产生前后不一致的产物：

1. **先定 §1.6.1 的处置，再回头统一计数。** 目前 §1.1 仍写「10 处生产点」、其中 v2-wrapper 那行仍描述为覆盖全部 16 个 Lead，而 §1.4 / §2.2 / A1 也都还是「10+1」的框架。**两个脱管 Codex wrapper 的处置一旦选定，注册表、RED/GREEN 预期与验收计数都要按最终的受管 carrier 集合改一遍。**
2. **§1.6.1 二选一的推荐**：优先选 **(a) 把两个真实 wrapper 形态纳入源码管理 + 受测的 install/converge 权威**。选 (b) 迁到别的 carrier 是一次涉及后端行为的更大改动，只有在能给出**等价行为证明**时才选。
3. **`host-tmux-selection-gate.sh` 的生产查找路径要钉成一个字面量。** 现在 plan 要求「固定默认路径」，但又把 state-bin 拷贝闭包写成条件性的。**选定 monorepo/prebuilt 路径或 state-bin 路径之一，并让对应的打包/converge 测试无条件生效。**
4. **定义单一收据文件的覆写语义。** 多个 carrier 出生会写同一个路径：要么明确声明它**只代表最近一次成功检查**，要么改成**每 carrier 一份收据**（若后续验收或审计需要同时持有全部挂载点的证据）。

## 5. 验收总表

| # | 条款 | 判定方式 |
|---|---|---|
| A1 | 10 处生产 + 1 处 QA 的 PATH 声明全部原生优先 | **由注册表感知的扫描器判定**（不用裸 grep —— 裸 grep 会命中 §1.2 三个故意不改的测试 fixture，给不出零命中判据） |
| A1b | **`qa-result.ts:363` 的分裂点已改成原生优先**（§1.1.1） | 候选列表顺序已改；有确定性测试断言默认选择顺序；该列表已进 S2 守卫注册表。**「写注释保留 Intel 优先」不是可接受的通过方式** |
| A2 | 守卫能抓到 Intel 优先的声明 | 阳性对照：真实生产文件临时改回一处 → RED；恢复 → GREEN。必须留证据 |
| A3 | 守卫**真的被调用**，且跑的是新的源码模式 | CI（`.github/workflows/ci.yml:607` 枚举的测试文件）实跑并产出源码模式判定。**不以「converge 旧调用点存在」或「被列进 package-onboard 打包清单」充数** —— 实测前者只跑全局态扫描、后者只是打包 |
| A4 | **carrier 树内**的 overlap 命令冒烟全绿，加 Lead 要求的 `npm` 非 carrier 读点抽验（§1.5） | `python3`（含真实刹车路径）、`npx`（hermetic 引导，不得拉起第二个生产 Bridge）、`gh`（只读真跑 + mutating 形态用 `--help`/hermetic，`auth token` 输出丢弃）、`ffmpeg`（preflight + **mp3→opus 功能链**）；另按 §1.5 以隔离 `--out` + 有界超时真跑 `shell-prepare` 的 `npm pack`，断言单 JSON / 单一非空 tgz / 产物只在临时根，并清理。`npm` 仍如实标注为「非 carrier，Lead 加验」。每项记录 before/after 三元组。**任一项不绿即停** |
| A4a | **carrier 树外**的判定已留档（§1.5 类别二） | `ffplay`/`openssl`/`brew` 各有明确的不可达理由，且 sweep 方法与排除规则已记录、可复现重跑（`npm` 按 Lead 裁示 ③ 已上移到 A4 抽验） |
| **A0** | **S0 已是活字节，四个挂载点真的会拦，且覆盖整个活舰队**（R5 #2 / R6 #1 #2） | ① `deployed-sha` 对应的活字节已含 S0；② 逐个真实入口跑通，**含 KeepAlive 直接出生**；③ 收据缺失 / 过期 / 宿主不符 / SHA 不符 / user-bin 遮蔽 五种情形**各自 fail-closed 拒绝启动**；④ **launchd plist census 全绿** —— 每个生产 Lead plist 选中的 wrapper 都映射到已注册源码且已部署字节含 S0 挂载，未知或漂移 = RED（§1.6.1）；⑤ monorepo 与 `.flywheel-prebuilt` 两种形态都验。**A0 未过，S1 不得合入** |
| A4b | **S1 部署收据**（R2 #1 / R3 #4 / R4 #2） | 用 post-S1 的确切 PATH 求值，记录宿主标识、目标 SHA、时间戳与失效时长、绑定的部署事务、`command -v tmux` 的结果，并对该结果**直接做路径规范化**后跑 `tmux -V` 与 `file`。**不要用 `extract_tmux_image`** —— 它要 PID，本门只有路径名（§1.6）。**通过条件 = 实际选中的正是 3.5a x86_64** |
| A5 | 现有 tmux 相关套件回归绿 | §1.4 第 3 条列出的套件 |
| A6 | CI 在绑定头上为绿 | 拉该 head 的 CI 结论，不以本地绿代替 |
| A7 | S3 的顺序约束与 P1–P7 待办清单完整、经设计评审 | §3 完整 |
| A8 | founder HTML 已发布并报 Lead | 节点完成契约 |
| A9 | **伞形风险未被误标为已解决**（R2 #8） | FLY-2190 在 S1+S2 PR 后保持 open，或已创建承接 S3 的阻塞 issue（含 owner、期限、P1–P7 退出条件） |

S3 的执行结果**不在本单验收范围**；S1+S2 完成**不等于** Rosetta 到期风险解除（§0.0）。

## 6. 风险与未决

| 风险 | 处置 |
|---|---|
| FLY-1944 阶段 2 门状态未确认 | 已向 Lead 非阻塞提问；本单不重开 FLY-1944 验收，把它列为 S3 前置。若 Lead 另有裁示，按 design-correction 增量修正 |
| `gh` 跨 13 个月升版影响 21 个生产文件 | A4 冒烟；不绿即停 |
| `npm` 降 minor（11.16.0 → 11.9.0） | sweep 判定其唯一消费点 `scripts/release/shell-prepare.mjs:64` **不在 carrier 树内**，不把它冒充为 carrier 风险；按 Lead 裁示归 A4 额外抽验：post-S1 `npm --version` + 有界 hermetic 的 `shell-prepare --out <tmp>` 真实 pack，断言单 JSON / 单非空 tgz / 临时根内产物并清理。真正 carrier 关键的是 `npx`（Bridge / voice-bridge boot），仍独立冒烟 |
| arm64 python 是 3.14.5（低于 Intel 3.14.6） | 已实测 329 测试全绿、零第三方依赖；版本对齐列为宿主维护动作 |
| 两个 PATH 真源今后再分叉 | S2 守卫覆盖两者 |
| S1 部署后、S3 前的长期混合态 | **联合不变量，不要只记 S0（R6 #3）**：S0 只在**每个被检查的边界**（wrapper 出生 / 更新器 ff 前 / 重启事务 / 手动重启）证明「此刻选中的是 3.5a」——它是**时点观察，不是持续保护**。检查间隔内的保护来自另外三件事：**⛔ DO NOT LINK**、`restart-guard` 对受管执行路径的拦截、以及任何宿主变更都需 founder 授权。<br>**已在运行的进程不会再经过 wrapper** —— 比如活着的 Bridge，以及 Lead server `tmux.conf` 里 `pane-exited` hook 的裸 `tmux` 调用；一次事后的 link 变更会改变它们的解析而 S0 察觉不到。若要对任意的出生后漂移主张技术保护，就必须**钉住已验证的 tmux client**（或对每一次 client 解析设门）——当前的收据给不了这个保证。此禁令是 A0/A4b 的运行前提，一直有效到 S3 的 P4/P5 启动 |
| 守卫空过（永远绿） | A2 阳性对照 + §2.2 发现闭包用例，两者都是硬性要求 |
| 守卫被新增文件绕开 | §2.2 发现闭包（注册表单靠自身挡不住新增文件） |
| **S1+S2 合入被误读为「到期风险已解除」** | §0.0 归属声明 + A9 验收；FLY-2190 保持 open 或建立带 owner 的承接 issue |
