# FLY-1439 插件收据核销 producer 独立真机验收 — 验收报告
Issue: FLY-1439 (https://linear.app/geoforge3d/issue/FLY-1439/qafly-1437-独立真机验收-插件收据核销-producerfork-pr-17-bb0a1509)
日期: 2026-07-23
基于: plan.md

## 0. Verdict

**整体 verdict：PASS。**

被测 fork PR #17 @ `bb0a150989c0d7477bbb03543052c87ee229d368` 的五项 producer 能力
全部验收通过，且此前唯一阻塞项 **G0.4 生产无害硬门已由受控观察窗口归因关闭**。

本报告是两个独立 exec 的合并结论：

| exec | 角色 | 产出 |
|---|---|---|
| `7af14cc5-eab9-41be-a129-eec5addd0936` | 真机验收执行 | S1–S5 五场景真机证据；G0.4 判 FAIL-CLOSED（provenance 不足） |
| `5514bd71-1165-4f95-becf-aa05cf5fa39b` | 独立 QA 复核（本节点） | 复验可证伪核心；受控观察窗口关闭 G0.4；出 verdict |

两个 exec 都**不是** `3870740d`（接管评审者 / R1 HIGH 修复 commit `bb0a1509` 的作者），
也都未参与 FLY-1437 producer 实现。独立性边界成立。

**verdict 前 head 复核**：fork PR #17 与 feature branch `feat/FLY-1437-chat-receipt-producer`
仍精确指向 `bb0a150989c0d7477bbb03543052c87ee229d368`（`gh pr view 17` 实测）。head 未漂移。

## 1. 证据分层 —— 哪些我独立复验，哪些我继承

Lead 口径 3：逐条标注。

### 1.1 本节点（5514bd71）独立复验项

| # | 复验项 | 方法 | 结果 |
|---|---|---|---|
| I1 | 被测物就是 PR head | 自建 shallow fetch `bb0a1509` 到全新目录，与 7af14cc5 的 pinned checkout 做 `diff -rq` | **byte-identical**，前一 exec 的 mutation 全部已还原，测的确实是 PR 字节 |
| I2 | 172 测试口径 | 在**我自己的** fresh clone 里 `bun install` + `bun test` | **172 pass / 0 fail / 411 expect()，8 files** —— 与 7af14cc5 和 codex 评审员的数字三方一致 |
| I3 | 无空过绿 | 源码扫 `test.skip/todo/only/failing/skipIf/xit/xdescribe`；跑测输出扫 skip/todo | **零命中**，8 个测试文件全跑 |
| I4 | 测试是 load-bearing | **我自己设计的 4 个 mutation**（非重放上轮的） | **4/4 全部让套件变红**（见 §3） |
| I5 | `Message.reference` 四形态 | 对真实现直接探针：matching / null / **omitted** / wrong | 4/4 行为正确；实测 discord.js 类型确为 `MessageReference \| null`，即 `null` 就是真运行时形态，**不存在「显式 null 冒充省略字段」** |
| I6 | G0.4 归因 | 受控观察窗口 + 原始 JSON 前后全文 | **归因成立**，见 §2 |
| I7 | 生产无害现状 | 重跑 `capture-production-snapshot.sh`，与 pre-QA / post-teardown 三方对比 | 12 项中 11 项**逐字节相同**；唯一漂移项已归因 |
| I8 | 主仓改动 default-off | 读 **25 个活 Lead 进程的真实 env**（不是读代码默认值） | **全部 25 个 `CLAUDE_CONFIG_DIR` 未设** → seam 解析回 `$HOME/.claude`，与 main 行为一致 |
| I9 | 主仓守卫测试 | 直接跑 6 个新增/受影响套件 | **37 passed / 0 failed** |
| I10 | 主仓回归面 | 跑**全部 47 个**引用被改脚本的 shell 套件 | 43 pass / 4 fail，4 个全部经 main-HEAD 对照证明为 **pre-existing**（见 §5.3） |
| I11 | build / typecheck / lint | 本机跑 CI Quick Gate 等价命令 | build PASS、typecheck PASS、**tracked 源码 lint 0 error**（见 §5.2） |
| I12 | fork 侧 code review 硬门 | 读 `ce6a89e4` 的 code-review.md | **Codex xhigh 2 轮 APPROVED @ bb0a1509**，R1 HIGH（settle 非 write-ahead）已修 |
| I13 | 两条 advisory | 各自独立复现（见 §6） | 均复现，定级维持 |

### 1.2 继承自 7af14cc5 的项（未由本节点重跑）

经 Lead 明确批准（不必从零重跑 5 场景）：全量重跑不为任何被阻塞项增加证伪力，
且 4 个 QA slot 当前全被其他 issue 占用（slot1 fly1356-e2e / slot2、3 FLY-1393 /
slot4 FLY-1375），真机重跑本就不可调度。

| 场景 | 结论 | 证据锚点（commit `a4b62162` 及后续，`evidence/` 目录） |
|---|---|---|
| S1 全周期 + patrol 零重发 | PASS | `s1-m1-db-and-no-resend.json`、`s1-m2-patrol-and-cleanup.json`、`s1-s2-summary.md` |
| S2 三个崩溃窗 + 幂等 | PASS | `s2a-*`、`s2b-*`、`s2c-*`（含 `s2c-crash-timing.txt` 1457ms 杀窗） |
| S3 记账失败不拦消息 | PASS | `s3-summary.md`、`s3-m6-advisory.json`、`s3-m8-drain.json` |
| S4 companion/stock 零变化 | PASS | `s4-summary.md`、`s4-db-delta.json`、`s4-m9-shim-calls.json` |
| S5 测试真实性 | PASS | `s5-summary.md`、`s5-bun-test.txt` —— **本节点 I2/I3/I4 已独立复验其核心断言** |

## 2. G0.4 归因 —— 阻塞项如何关闭

### 2.1 上一轮为何 FAIL-CLOSED（结论正确）

teardown 后 12 项生产快照里 11 项逐字节相同，唯一漂移是全局
`~/.claude/plugins/known_marketplaces.json` 的 hash（`2441ff58…` → `5e8d70a9…`）。
上一轮**只保存了整文件 hash，没有保存原始 JSON**，也没有捕获写入者身份，因此
无法把该刷新归因到 QA 之外。在当时的证据下判 FAIL-CLOSED 是正确的克制。

### 2.2 本节点做的受控观察窗口

QA slot 已于 04:46 PDT（11:46Z）完全 teardown：`/tmp/flywheel-test-slot-1` 不存在、
端口 19871 关闭、无 FLY-1439 slot 进程存活。在这个**零 QA 活动**的窗口里：

```
t0  2026-07-23T12:34:24Z   cp 原始全文 → g0.4-control-t0-raw.json   sha ac42da6f…
                           （文件自身内容时间戳 lastUpdated=12:09:06.421Z）
    ── 期间无任何 FLY-1439 QA 活动 ──
    2026-07-23T12:37:25Z   文件自己变了（inode 332666517 → 332960477，原子改名写）
t1  2026-07-23T12:38:56Z   cp 原始全文 → g0.4-control-t1-raw.json   sha 3278e783…
                           （lastUpdated=12:37:25.132Z）
```

**口径 1 —— 字节级正匹配（不是「大体一致」）**

```
$ diff t0-raw.json t1-raw.json
<     "lastUpdated": "2026-07-23T12:09:06.421Z"
>     "lastUpdated": "2026-07-23T12:37:25.132Z"
```

差异行总数 = **2**（一个字段、一个取值）。进一步做结构证明：只把
`claude-plugins-official.lastUpdated` 一个键 mask 掉后，两份文件
**byte-identical**（`cmp` 无差异）。即 `source` / `repo` / `installLocation` /
其余 5 个 marketplace 条目**零字节漂移**。口径 1 满足。

**口径 2 —— before/after 原文的 provenance**

两份 JSON 都是本节点从自己的 shell 对生产文件
`~/.claude/plugins/known_marketplaces.json` 做的 `cp` 逐字节拷贝，无编辑、无重新
序列化。每次拷贝同时记录了**源文件**的 sha256 / mtime / inode
（`g0.4-control-t{0,1}-meta.txt`）；归档 JSON 回算 sha256 与记录值一致，因此
存档字节 = 观察到的字节。全部归档进 `evidence/`。

**完整变化序列**（该文件今天的四个取值）：

| sha256 | 来源 | QA 是否在跑 |
|---|---|---|
| `2441ff58…` | pre-QA 快照 | — |
| `5e8d70a9…` | post-teardown 快照 | 是（QA 窗口内） |
| `ac42da6f…` | 12:09:06Z | **否** |
| `3278e783…` | 12:37:25Z（t0→t1，原文已存） | **否** |

**结论**：`known_marketplaces.json` 携带一个**自己会动的 ambient 时间戳**，由 Claude Code
的 marketplace metadata 刷新写入。QA 窗口内看到的漂移，与 QA 彻底停机后仍在继续发生
的漂移是**同一 delta class**。没有任何 QA 可控的生产面发生变化。

补充事实（削弱 QA 为写入者的可能）：隔离 Lead 走的是
`CLAUDE_CONFIG_DIR=/tmp/flywheel-test-slot-1/claude-config`，其 plugin 读写落在隔离
根下；且漂移只发生在**官方** marketplace 条目的时间戳上，不是被测的 fork 条目。

### 2.3 13:00Z 复核

重跑 `capture-production-snapshot.sh`，与 pre-QA、post-teardown 三方对比：
`installed_plugins` / active cache `server.ts` / cache `.fork-sha` / marketplace
`server.ts` / marketplace `.fork-sha` / fork repo HEAD / fork repo status /
delivery marker / delivery secret 内容 hash 与 mode —— **全部逐字节相同**，
teardown 后 73 分钟仍无任何新增漂移。唯一变动项依旧只有那一个时间戳。

**G0.4：PASS（归因关闭）。**

## 3. 独立 mutation 灵敏度（本节点自设计）

不重放上一轮的 mutation，改为直接打 producer 的核心不变量：

| mutation | 打击的不变量 | 结果 |
|---|---|---|
| X1 `sentMessageCarriesReference` 恒返 `true` | **安全关键**：任意回复都能销账 | 172 → **1 fail**（`settles only from the reference Discord persisted on the returned message`） |
| X2 删掉 settle write-ahead 落盘 | codex R1 HIGH 的修复本体 | 172 → **3 fail** |
| X3 notify 后不再调 `complete()` | 收据卡在 pending | 172 → **1 fail** |
| X4 begin 失败不再落 recovery intent | 崩溃恢复腿 | 172 → **4 fail** |

4/4 命中，且每个 mutation 后工作树都完整还原（`git status` 干净）。
套件对每一条腿都是 load-bearing，不是空过绿。

## 4. 验收矩阵

| 验收项 | 结果 | 关键证据 |
|---|---|---|
| 1. 全周期 + patrol 零重发 | **PASS** | M1 真入站 `1529794572199133256` → delivered；真回复 `1529794587093237810` 带正确 reference → processed；等满 5 分钟 resend/alert 均 0。M2 阳性对照 2 分钟后真产生 r1 child + Lead 可见提醒（排除「patrol 根本没跑」的空绿） |
| 2. 崩溃恢复 + 幂等 | **PASS** | S2a begin 失败时 0700/0600 intent 落盘、DB 零行，恢复后唯一建账；S2b complete barrier 后 2.788ms 杀窗重投；S2c settle CLI 已进入时 write-ahead intent 在盘，1457ms 内杀 MCP，重启重放为 processed，同 evidence 再 settle 字节幂等 |
| 3. 记账失败不拦消息 | **PASS** | M6 ENOTDIR 下真消息到 Lead、DB 零行、专属 advisory 恰一条；M7 健康链完整 processed；M8 可写 spool 记 attempts 并恢复后 redelivery |
| 4. companion/stock 零变化 | **PASS** | companion=true 同 launcher 真收发 M9，DB/shim/spool/advisory delta 全 0；stock 三段运行时字符串与 fork-main 字节兼容 |
| 5. 172 测试口径真实 | **PASS** | 本节点 fresh clone 独立复现 **172/0/411, 8 files**、零 skip；**自设计 4 mutation 4/4 变红**；`Message.reference` 四形态独立核验 |
| **G0.4 生产无害** | **PASS** | 受控观察窗口证明唯一漂移项是自走时间戳；11/12 字段 teardown 后 73 分钟仍逐字节不变 |

## 5. 主仓侧（PR #689）与 CI

### 5.1 CI 红是**非代码原因**，不可当作缺陷也不可当作绿

PR #689 @ `240b7a96` 的 9 个 CI job 全红。逐个查 check-run annotation，
**9/9 的失败原因都是同一句**：

> `The job was not started because an Actions budget is preventing further use.`

即 GitHub Actions 配额被阻断，job **根本没启动**，零代码信号
（`evidence/q7-ci-actions-budget-block.txt`）。这是账务/基建问题，需 founder 侧处理。

### 5.2 本机补跑 CI 等价门

| 门 | 结果 |
|---|---|
| `pnpm build` | **PASS** |
| `pnpm typecheck` | **PASS** |
| `pnpm lint` | tracked 源码（`biome check packages scripts`，2233 文件）**0 error / 15 warning**。本机 `pnpm lint` 报 812 error 是 **untracked 本地残留**所致：`.pnpm-store/`（830MB）与 `.flywheel/runs/…/plugin-pinned/`，二者均由 `.git/info/exclude` 排除，CI 全新 checkout 不存在。17 个报错文件**全部 untracked**，与本分支改动**零重叠** |
| shell 语法 | 9 个被改 `.sh` 全部 `bash -n` PASS |
| `git diff --check` | 代码路径 **CLEAN**；仅 doc/evidence 的 markdown 有行尾空格（markdown 硬换行 + 逐字捕获输出），CI 未设该门 |

### 5.3 47 个 shell 回归套件 —— 4 个失败全部 pre-existing

跑遍所有引用 `claude-lead.sh` / `test-deploy.sh` / `install-restart-guard.sh`
的套件：**43 pass / 4 fail**。对 4 个失败做 main-HEAD 对照
（把 3 个被改生产脚本 `git checkout main --` 回退后重跑，跑完还原、工作树干净）：

| 失败套件 | 分支上 | main 生产脚本对照 | 判定 |
|---|---|---|---|
| `fly231-companion-launch-plan.test.sh` | 47 passed / 5 failed | **47 passed / 5 failed（同）** | pre-existing（golden 漂移来自 FLY-1426/1437 的 receipt env，与本分支无关） |
| `lead-alert-external-kind.test.sh` | 6 passed / 1 failed | **6 passed / 1 failed（同）** | pre-existing |
| `test-reply-enforcer-install.sh` | rc=5 | **rc=5（同）** | pre-existing |
| `test-auto-approve.sh` | rc=5 | — | **非测试**：它是需要参数的 CLI 工具，被我的文件名通配误收，输出即 `Usage:`。我的 harness 问题，非缺陷 |

**本分支未引入任何 shell 回归。**

（过程注记：首轮我用 `timeout` 包了每个测试，macOS 无该命令，47/47 全 rc=127 假红；
第二轮 while-read 被子脚本吃掉 stdin，只跑了 30 个。第三轮 `<&3` + `</dev/null`
才拿到完整 47。前两轮结论作废，以第三轮为准。）

### 5.4 主仓 seam 的 default-off 事实核验

不读代码默认值，直接读**活进程 env**：25 个在跑的 Lead 进程（生产 + 其他 issue 的
test slot）**无一设置 `CLAUDE_CONFIG_DIR`** → `${CLAUDE_CONFIG_DIR:-${HOME}/.claude}`
在真实运行中一律解析为 `$HOME/.claude`，与 main 行为一致。新 seam 仅在显式传入
`TEST_LEAD_CLAUDE_CONFIG_DIR` 时激活，且 `test-deploy.sh` 在生产启动路径上用
`env -u` 抹掉两个 `TEST_SKIP_*` 变量。

## 6. Findings / Follow-up

### 6.1 MEDIUM —— isolated hand-launch / mirror 路径仍有 HOME-based Claude surfaces 残留

`packages/teamlead/scripts/claude-lead.sh` 里已切到 `CLAUDE_CONFIG_DIR` 的只有
agent 目标（:620）和两处 settings 写入（:791、:863）。**仍写死 `$HOME` 的**：

- `:188` `DISCORD_STATE_DIR="${DISCORD_STATE_DIR:-${HOME}/.claude/channels/discord-${LEAD_ID}}"`
- `:1975` `"${HOME}/.claude.json"`（MCP seeding）

**当前不构成生产风险**：`test-deploy.sh` 在 slot 启动路径上显式传
`DISCORD_STATE_DIR="${SLOT_DIR}/discord-state"`（:1151、:1443），slot 模式被覆盖。
**风险面是手工起的隔离 Lead / mirror 路径**——不显式传 `DISCORD_STATE_DIR` 时，
即便设了隔离 `CLAUDE_CONFIG_DIR`，channel state 仍会落进生产
`~/.claude/channels/`。建议后续把 `:188` 的默认值也改为跟随
`${CLAUDE_CONFIG_DIR:-${HOME}/.claude}`。

### 6.2 LOW —— non-traversable config root 显示裸 `cd` 报错而非 guard 消息

`claude-lead.sh:729-733` 在 `CLAUDE_CONFIG_DIR` 存在但**不可进入**（无 `+x`）时，
`$(cd … && pwd -P)` 会把 shell 自己的错误打到 stderr。独立复现
（`evidence/q7-low-advisory-probe.sh`）：

```
line 14: cd: …/lowtest/cfg: Permission denied
QA_CLAUDE_CONFIG_REAL=[]
```

**行为本身是安全的**：变量为空 → 随后的 guard 命中 `-z "${QA_CLAUDE_CONFIG_REAL}"`
分支 → fail-closed abort。**只是诊断信息不友好**，操作者看到的是裸 shell 报错而不是
launcher 自己的 ERROR 行。建议把 `cd` 的 stderr 收进来并改发 guard 消息。

### 6.3 非阻塞产品 follow-up —— 冲突 settle intent 持续 retry

forced restart 后模型补发**不同** reply evidence 时，canonical receipt 正确拒绝冲突，
但冲突 settle intent 会持续 retry。建议把 confirmed conflict 隔离成显式 terminal
advisory。（继承自 7af14cc5 的观察，非本轮阻塞项。）

### 6.4 非阻塞 harness finding —— teardown 被生产 cmux watcher lease 拒绝

`test-teardown.sh` 会被持有 lease 的生产 cmux watcher 拒绝，独立 slot QA 需要一条
官方的、只删除明确 slot 资源的 teardown 路径。

### 6.5 基建 —— GitHub Actions 配额阻断

见 §5.1。**在配额恢复前，本仓所有 PR 都拿不到 CI 信号**，任何「CI 绿」的说法都
不能成立。需 founder 侧处理配额。这不阻塞 FLY-1437 的能力 verdict，但影响
PR #689 自身的 ship 门。

### 6.6 G0.4 可执行整改规格（供后续同类 QA 复用）

上一轮卡在 G0.4 的**根因不是产品**，是取证形态：只留 hash 无法归因无主漂移。
本轮的关闭方法即是规格：

**必须做到的四条**

1. **前后都存原文，不只存 hash。** 对每个纳入 byte-equality 门的全局文件，
   pre/post 各 `cp` 一份原始字节进 `evidence/`，禁止只记 sha256。
2. **同时记录源文件的 sha256 + mtime + inode。** inode 变化能证明是原子改名写
   （第三方 writer 的典型形态），并让「存档字节 = 观察字节」可回算验证。
3. **QA 停机后开一个受控观察窗口。** teardown 完成、slot 目录/端口/进程全部确认消失后，
   继续对该文件采样。若它在**零 QA 活动**下仍以同一 delta class 变化，漂移即归因于
   ambient writer。窗口需覆盖至少一次自发变化（本次实测间隔约 28–48 分钟）。
4. **判定必须是字节级正匹配。** mask 掉被指认的那一个字段后，前后必须
   `cmp` 完全相同。任何其他字段出现漂移 → 维持 FAIL-CLOSED，不接受「大体一致」。

**什么证据能让 verdict 翻 PASS**：满足上述 1–4，且被指认字段的语义是纯 metadata
（时间戳类）、不改变插件选择 / 源 / 安装位置 / 代码字节。本轮 §2 即为一次完整实例。

**更强的可选项（本轮未做，非必须）**：直接捕获 writer 身份（如 `fs_usage` /
`opensnoop`，需 root），可把归因从「强支持」升到「直接观察」。本轮未取得 root
层面的 writer attribution —— 这是本结论**唯一**的证据形态边界，已如实标注。

## 6.7 PR #689 自身的 codex code review —— 4 轮后 park

本节记录的是**主仓 QA 隔离 seam**（PR #689）的评审，不影响 §0–§4 对 fork PR #17
的能力 verdict。

四轮 codex xhigh 共 8 个 HIGH。每一个我都**先自己复现再修**，没有照单全收。

| 轮 | 发现 | 处置 |
|---|---|---|
| R1 | guard 只比顶层 config root，把 `plugins` symlink 回生产即绕过 | 修 `dcd9bf0f` |
| R1 | guard 跑在 agent 文件写入之后，拒绝前生产 `agents/<lead>.md` 已被覆盖 | 修 `dcd9bf0f` |
| R2 | 深层 symlink：`plugins/cache` 是真目录，里面的插件版本目录指回生产 | 修 `0ecd1082` |
| R2 | **相对 `CLAUDE_CONFIG_DIR` 的 TOCTOU** —— launcher cwd 下解析成隔离路径过检，但 Lead 由 tmux 以 `-c "$LEAD_WORKSPACE"` 启动，同一字符串解析到生产 | 修 `0ecd1082` |
| R3 | macOS 大小写不敏感卷上 `~/.CLAUDE` 与 `~/.claude` 同一目录，但 realpath 保留大小写，字符串比较漏判 | 修 `a91e5c7c` |
| R3 | 扫描漏掉悬空链接、经第三方目录中转的链、与生产同 inode 的 hardlink | 修 `a91e5c7c` |
| R4 | **插件注册表逻辑路径**：`installed_plugins.json` / `known_marketplaces.json` 的 `installPath` / `installLocation` / `source.path` 可直接指向生产 | 修 `991977e4` |
| R4 | 树内目录 symlink 可藏住嵌套的逃逸链接（`os.walk(followlinks=False)` 不进入其目标） | **不修，记档**（见下） |

### 判据（Lead 给的尺子，替代「轮数」）

- **misconfig 可达**（我们自己配错、脚本漏传变量、cwd 不同导致解析不同）→ **在威胁模型内，必须修**。
- **只有刻意构造才可达** → **出模型，不在本单修，记档**。

这个 seam 的威胁模型是「别污染生产」，不是「防蓄意攻击者」。

R2 的 TOCTOU 和 R4 的注册表路径都是**没人恶意、正常流程就能踩**的：前者是启动路径本身
cwd 不同，后者是 E3 setup 少改一处 `sed`。所以修。

### 已知边界（构造型，本单不修）

1. **树内目录 symlink 的中转隐藏**：`plugins/cache/x -> <cfg>/staged/x`（第一跳仍在隔离
   根内，通过 containment），而 `<cfg>/staged/x/server.ts -> 生产`。`os.walk(followlinks=False)`
   不进入被链接目录，故第二跳不被扫描。**需要刻意构造两条链、且其中一条指向生产**。
2. 同族的 hardlink / 大小写别名 / 三方中转形态虽已修，但它们同属「构造型」；本轮修了是
   因为顺手且成本低，不代表威胁模型扩大。

按 founder 的规矩（小修并族、不一单一开），这批构造型形态由 Lead 并族记进 Linear，
将来隔离面族批一起处理，不单开 follow-up 单。

### 一个比修复本身更值得记的过程发现

R3 我没有再打补丁，而是把规则整个换掉：**身份判定从「路径字符串」改成 `(device, inode)`，
插件树规则从「不许落进生产」改成「不许离开隔离根」** —— 从「枚举形态」升级到「结构约束」。
弱证据是「当前查了 0 条」，强证据是「约束不允许它存在」。

另外两条教训：

- **变异测试逼出「嵌套悬空链接」**：根级用例覆盖不到那个分支，**它一直是为错误的理由通过的**。
  绿的测试不等于验证了它声称验证的东西。补了独立 fixture。
- **`bash -n` 用错了 shell**：launcher 的 shebang 是 `#!/bin/bash`，在 macOS 上是 **bash 3.2**；
  bash 3.2 对 `$( )` 里带引号 heredoc 的分词与 bash 5 不同，python 注释里一个撇号就能让整个
  launcher 在生产 shell 下变成语法错误，而 PATH 上的 Homebrew bash 5 完全看不出来。已加一条
  「用最老的 bash 做 parse 检查」的门（提交前抓到，三个已推提交在 3.2 下均可解析）。

## 7. 最终结论

**PR #17 @ `bb0a1509` 的五项 producer 能力全部验收通过，G0.4 生产无害硬门已归因关闭，
FLY-1439 整体 verdict = PASS。**

本报告支持解锁 FLY-1437 的 ship 门。附带说明：主仓 PR #689（本 QA 的 harness 与
证据）自身尚未拿到 codex code review，且 CI 因 Actions 配额阻断拿不到信号 —— 这两项
属于 PR #689 自己的 ship 门，由 Lead 决定，不影响上面对 FLY-1437 的能力结论。
