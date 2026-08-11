# FLY-1676 Discord plugin fork 追平 + 自动同步 + 冲掉通路根治 — QA 独立验证报告

Issue: FLY-1676 (https://linear.app/geoforge3d/issue/FLY-1676/chore-把-discord-plugin-fork-整个追平上游-rebase-我们的定制-修好自动同步-founder-裁定不)
日期: 2026-08-10
基于: plan.md、research.md、PR #802 head `877311b4de15193d45f27248d1ab9c64249edfcf`

## 判决:**FAIL**(阻断级,不可 cutover)

被测 head 与 PR head 一致(`877311b4`,`gh pr list --head` 与本地 `git rev-parse HEAD` 逐字相同,QA 开工时与写报告前各核一次)。

一句话:**插件内容是对的,但新的 `--channels` 选择器会被 Claude CLI 的 channel 白名单拒绝** —— cutover 之后每个 Claude Lead 都会「正常启动、看起来健康」,但 Discord 入站消息一条都收不到,全舰失聪。而且本单自己的验收门(pre-start 一致性门 + 逐 Lead MCP-root 取证)结构上**看不见**这个失败。

---

## 1. 阻断缺陷 · BLOCKER-1:`plugin:discord@flywheel-plugins` 不在 CLI 的 approved channels allowlist 上

### 1.1 机制(取自被测机器上真实 CLI 二进制,v2.1.226/2.1.227)

`gateChannelServer()`(bundle 内 `XOr`)决定一个 MCP server 是否被注册成 **channel**(= Discord 入站消息注入 session 的唯一通道):

```js
if (i.kind === "plugin") {
  ...
  if (!i.dev) {
    let { entries: a, source: l } = Pxn(o?.allowedChannelPlugins);
    if (!a.some(c => c.plugin === i.name && c.marketplace === i.marketplace))
      return { action: "skip", kind: "allowlist",
               reason: `plugin ${i.name}@${i.marketplace} is not on the approved channels allowlist ...` }
  }
}
```

```js
function Pxn(e){ if (e) return {entries:e, source:"org"}; return {entries: ini(), source:"ledger"} }
function ini(){ return nt("tengu_harbor_ledger", []) }   // Anthropic 远端 gate
```

判据是 **(plugin, marketplace) 二元组精确匹配**。本机实际 ledger(生产账号缓存,`~/.claude.json`):

```json
"tengu_harbor_ledger": [
  {"marketplace":"claude-plugins-official","plugin":"discord"},
  {"marketplace":"claude-plugins-official","plugin":"telegram"},
  {"marketplace":"claude-plugins-official","plugin":"fakechat"},
  {"marketplace":"claude-plugins-official","plugin":"imessage"}
]
```

四条全部是 `claude-plugins-official`。本机**没有** managed settings(`/Library/Application Support/ClaudeCode/managed-settings.json` 不存在),所以 `policySettings` 为 null → 走 ledger 分支 → `flywheel-plugins` 必然不匹配。

`marketplace` 这个键就是 marketplace 名字,而 `claude-plugins-official` 是 CLI 保留名(Codex R1 已实证只能从 Anthropic 官方源注册)——所以「换个名字绕过去」这条路本单已自行封死。

### 1.2 真机 A/B 铁证(同一 session、同一隔离 config、两个插件都已装)

隔离 `CLAUDE_CONFIG_DIR`(生产 `~/.claude` 逐项未改,见 §4),两个插件都真装成功:

```
discord@flywheel-plugins        -> <iso>/plugins/cache/flywheel-plugins/discord/0.0.4
discord@claude-plugins-official -> <iso>/plugins/cache/claude-plugins-official/discord/0.0.4
```

真 `claude` TUI 启动,两个 `--channels` 各自一份:

```
claude --channels plugin:discord@flywheel-plugins \
       --channels plugin:discord@claude-plugins-official
```

抓屏原文:

```
▎ Channels (experimental) messages from plugin:discord@flywheel-plugins, plugin:discord@claude-plugins-official
  inject directly in this session · restart without --channels to stop
▎ plugin:discord@flywheel-plugins · not on the approved channels allowlist
```

- **被测项** `plugin:discord@flywheel-plugins` → 被点名拒绝。
- **阳性对照** `plugin:discord@claude-plugins-official`(生产今天在用的那一个,同一次启动、同一份 config)→ **零告警**,通过。

对照组同屏、同进程、单变量只有 marketplace 名字 —— 排除了「隔离环境本身坏了」这一类解释。

### 1.3 为什么这是**静默**失败,而且本单的验收门抓不到

同一次运行里,adapter 进程**照样起来了**,而且加载根就是 pointer 的 installPath:

```
40173 37927 bun <iso>/plugins/cache/flywheel-plugins/discord/0.0.4/server.ts
```

也就是说:

| plan 的门 | cutover 后会看到 | 真实状态 |
|---|---|---|
| §4.3-3(b) pre-start 一致性门(repo SHA / bin checksum / settings / installPath 新鲜且含标志) | 全绿 | 与 channel 白名单无关,查不到 |
| §4.3-4 + V8 逐 Lead MCP 进程根取证(ps/lsof 指向 flywheel-plugins installPath) | 全绿(进程确实在那个根上) | channel 已被 skip,入站死 |
| Lead 启动 | 成功,进程健康 | Discord 入站零消息 |

后果按 issue 红线口径:cutover 一旦执行,**整个舰队同时失聪** —— founder 消息、#leads-roundtable、ship 卡片审批、Runner↔Lead relay 全断,而所有仪表显示绿色。只有人肉发现「怎么没人回话」才会暴露,然后必须跑 §4.3-5 反向事务恢复。

### 1.4 代码里其实已经写着这条规则

`packages/teamlead/scripts/claude-lead.sh:3436`(本 PR 未改的注释):

```
# Discord plugin: approved via GrowthBook allowlist → --channels
# Inbox MCP server: not on allowlist → --dangerously-load-development-channels (sets dev:true, bypasses gate)
```

本 PR 把 `--channels` 的值从「在白名单上的那个」换成「不在白名单上的那个」,但没有同时处理 gate。全仓 grep `allowedChannelPlugins` = 0 命中,cutover 脚本也不写 managed settings —— 这个面完全没被覆盖。

### 1.5 已知可行方向(供实现节点选,QA 不代拍)

1. **`--dangerously-load-development-channels plugin:discord@flywheel-plugins`** —— `i.dev` 为真时直接跳过 allowlist 分支;这条 flag 生产已在用(`server:flywheel-inbox`),改动一行。需评估 `--dangerously-*` 语义与 TUI 确认框(`claude-lead.sh:1271/1278` 已有 expect 自动确认)。
2. **managed settings 加 `allowedChannelPlugins`** —— CLI 报错文案自己指的路(`source:"org"` 分支)。⚠️ **陷阱**:`isChannelsPolicyBlocked`(`h8t`)在 `policySettings !== null && channelsEnabled !== true` 时**整体封禁 channels**。也就是说一旦创建了 managed-settings.json 却没写 `channelsEnabled: true`,会把**所有** channel(含现役官方 discord)一起打死,比现状更糟。要做必须两个键一起写,并且这是仓外、机器级、需要管理员权限的新权威面(与本单「单一受控写者」的设计取向冲突,需另行定权威 map)。

无论走哪条,**都必须补一条能真正证明 channel 已注册的验收判据**(不能再用 adapter 进程根路径当证据),否则同类静默失败下次还会漏。最小可信判据:真 Discord 入站消息 A/B(新选择器下真收到 / 拒绝路径下真收不到)。

---

## 2. 非阻断但必须让 Lead 定价的风险

### R-1:本 PR 一旦 merge,自升级部署管线立刻冻结,并会把**别的单**的 marker 打成 blocked + severe alert

`update-flywheel.sh` 新增 `discord_pointer_cutover_required()`:fetch 后、pull 前发现 `origin/main` 已选 pointer 而 live checker 还是 legacy → `return 3`。

`process_due_markers()` 里 rc=3 落进 `class="deterministic"` → 累计到阈值 → `ssq_block` + `severe_alert`「blocked after repeated deterministic failures … needs manual attention」。

即:merge 之后到 cutover 完成之前,**任何**别的单 self-ship 的 marker 都会重试→判定→block→给 Annie 发 severe。这是设计意图(§4.3-2 只允许持锁 cutover 的 `deploy_sha` 前进)且 fail-loud,不是 bug;但它意味着 **merge 与 cutover 必须在同一个窗口内背靠背完成**,不能「先合了再说」。已用 `update-flywheel-queue.test.sh` T8/T8b 复核该分支行为符合实现意图。

### R-2:fork main 前进但 discord `plugin.json` 版本没 bump ⇒ 全舰拒启

我独立复现了这条 CLI 语义(见 §3 P-4):**非 fast-forward 改写 ref、版本号不变 → `claude plugin update` 报 "already at the latest version",registry 停在旧 SHA、旧字节**。

与 checker 的 `INSTALLED_SHA != REMOTE_SHA → OUTDATED → exit 1` 组合起来:只要 fork main 有一次前进没带版本 bump(手推一个 commit、workflow 的 amend tip 逻辑出偏差、回滚到某个旧锚点),结果就是 checker 永远红 → updater 无法推进 → `claude-lead.sh` `recheck-failed` → **每个 Lead 拒绝启动 + severe alert**。

方向正确(fail-loud 好过静默 vanilla),但这条「版本号是整个舰队可用性的单点」必须进 runbook,并且回滚锚点也必须带着正确的版本号。

### R-3:CLI 版本在本次 QA 期间从 2.1.226 漂到 2.1.227

开工时 `claude --version` = 2.1.226,TUI banner = v2.1.227(会话中自动升级)。本单所有 CLI 语义结论(reserved marketplace、git-subdir schema、update 语义、channel gate)都是版本实证得来的;plan §7-1 已把「CLI 行为漂移」列为风险。上面的 allowlist 结论在 2.1.227 的真机运行上取证,不是只读二进制推断。

---

## 3. 已独立复核通过的部分(FAIL 不代表全盘否定)

### 3.1 聚焦测试全部独立重跑通过(未采信实现节点的自报数字)

| 套件 | 结果 |
|---|---|
| `scripts/__tests__/discord-plugin-ops.test.sh` | 19 passed, 0 failed |
| `scripts/__tests__/discord-plugin-cutover.test.sh` | 18 passed, 0 failed |
| `scripts/__tests__/restart-discord-plugin.test.sh` | 10 passed, 0 failed |
| `scripts/__tests__/update-flywheel-queue.test.sh` | 19 passed, 0 failed |
| `scripts/__tests__/test-deploy-discord-pointer.test.sh` | 3 passed, 0 failed |
| `packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh` | 21 passed, 0 failed |
| `packages/teamlead/scripts/__tests__/claude-lead-plugin-fork-check.test.sh` | 28 passed, 0 failed |

与实现节点 §9.4 自报数字逐项一致。

### 3.2 P-3(pointer marketplace 真装)—— 真 CLI,隔离 config,独立通过

- `claude plugin marketplace add <repo>/marketplaces/flywheel-plugins` → 成功;
- `claude plugin install discord@flywheel-plugins --scope user` → 成功,**恰好一个** user-scope 条目;
- `gitCommitSha` = `e1b061b0ea44844303f725558c5b9f614d4d7d79`,与 `git ls-remote https://github.com/xrliAnnie/claude-plugins-official.git refs/heads/main` 逐字相同 → 钉死了 checker 依赖的 "SHA authority" 语义;
- installPath 内 `server.ts` 三个关键标志齐:`allowBots`×3、`[reply-guard]`×4、`ChatReceiptRuntime`×2;
- **字节等同**:pointer 装出来的 `server.ts` sha256 = 生产当前 running 副本 sha256 = `695441ce376009ebc6ba0353a7ded9f620bfb23b5ddc8a1e6b0ccb6b4b59414d`。**插件内容本身没问题,坏的只是 channel 注册**;
- 仓库 canonical checker 打这个真安装:`OK: discord@flywheel-plugins matches fork main (e1b061b0…) with all critical markers`;`--print-install-path`、`--print-contract` 均正确。

### 3.3 P-4(更新语义)—— 独立复现实现节点的关键更正,并补了阴性对照

自建一次性本地 git 源(不碰生产 fork、不碰远端任何 ref),两步单变量:

| 步骤 | 动作 | CLI 结果 | registry |
|---|---|---|---|
| 2 | 非-FF 改写 main,**版本不变**(0.0.4) | `already at the latest version (0.0.4)` | 停在旧 SHA,**未跟随** |
| 3 | 非-FF 改写 main,**patch bump**(0.0.5) | `updated from 0.0.4 to 0.0.5` | 恰好一个条目,SHA = 新 commit,新 installPath 字节新、三标志齐 |

⇒ 实现节点 §9.1 的更正**成立**;「每次同步 bump discord plugin.json patch」不是可选优化,是这条链路能不能送到字节的**必要条件**(也正是 R-2 的成因)。

### 3.4 `claude plugin install` 会隐式写 enabledPlugins —— 实测确认

install 之后 `settings.json` 自动多出 `"discord@flywheel-plugins": true`。这证实了 plan R8 BLOCKER-1 的判断:生产 install **必须**放进 stop-all 停机窗内,窗外只注册不安装。设计正确。

### 3.5 legacy checker 面对新 flag 仍 fail-closed

生产在位的 legacy `~/.flywheel/bin/check-discord-plugin.sh --print-contract` 会忽略未知参数、照常输出 `OK: Discord plugin matches fork (e1b061b)…`,不等于 `discord@flywheel-plugins/v1` → 新 launcher 的契约门仍然正确拒绝。未被「legacy 恰好 exit 0」骗过。

---

## 4. 未做 / 未能做(诚实边界)

| 项 | 状态 | 原因 |
|---|---|---|
| V1 告警演练(`test_alert` 真 Discord 回执) | **未执行** | `SYNC_PAT` 尚未创建(operator-card 的 founder 依赖),fork workflow PR #19 未 land,workflow 处于 disabled 去膛态 |
| V2 sync workflow 真跑 / 守卫演练 / arm-disarm 证据 | **未执行** | 同上,且属 Tadashi 持锁 land 窗动作 |
| V3 fork 追平(rebase + force-push + 拓扑算术) | **未执行** | 生产 fork 写操作,属 land 窗;QA 节点不越权改 fork 历史 |
| V4–V8 生产 cutover 后验收 | **不可执行** | 依赖全舰 stop-all 持锁 cutover(founder-gated 破坏性动作);且被 BLOCKER-1 阻断,cutover 现在跑就是制造全舰失聪 |
| **真 529 房 N-to-N 真 Discord 收发** | **未执行,已定性** | ① 529 slot 从本分支部署会被新 launcher 的契约门在 Lead 起来之前挡住(生产 `~/.flywheel/bin` 仍是 legacy),而把新 ops 脚本装进 `~/.flywheel/bin` 会当场污染生产运行时(legacy launcher + 新 checker = plan 自己要防的 split authority),**绝不做**;② BLOCKER-1 已在真 CLI 上证明 channel 根本不会注册,再跑一遍真 Discord 只能重复同一个否定结论。修好之后的 re-verify **必须**包含真 Discord 入站 A/B —— 这正是本单缺失的那条判据 |
| fetch_messages(V7) | **未执行** | 依赖 cutover 后的真机;且 fork 版行为与今天生产运行的字节完全相同(§3.2 sha256 等同),不构成新增风险 |
| 全仓 `pnpm test:packages:run` | **未执行** | 本机 load average 52,memory 记录全量 vitest 会压死生产 Bridge;本单改动面为 shell + 三处 alert-kind 登记,已由聚焦套件覆盖 |

## 5. 生产零污染声明

- `~/.claude/settings.json`、`~/.claude/plugins/known_marketplaces.json`、`~/.claude/plugins/installed_plugins.json` 中 `flywheel-plugins` 命中数均为 **0**;
- `~/.flywheel/bin/` 未写入任何文件(生产仍是 legacy overlay,`check-discord-plugin.sh` 现跑 OK / e1b061b);
- fork 仓 `xrliAnnie/claude-plugins-official` 零写入(P-4 用的是本地一次性 git 源,没有 push 任何 ref);
- 所有探针在隔离 `CLAUDE_CONFIG_DIR` + 独立 tmux socket(`/tmp/fly1676qa.sock`)内进行,收工已 kill-server 并确认零残留进程;
- 未启停任何生产 Lead / Bridge / launchd job。

## 6. 给实现节点的复验清单(修完之后)

1. 选定 BLOCKER-1 的解法并落地(§1.5 二选一),把「channel 是否真的注册成功」变成一条**可断言**的判据;
2. 真 CLI A/B 复现:新选择器启动后 **不再**出现 `not on the approved channels allowlist`;
3. 真 Discord 入站 A/B(529 隔离房):新选择器下,一条 **bot 作者** 的消息真的到达 Lead(allowBots 生效);把这条加进 plan 的 V 表,替换掉「adapter 进程根路径」这条已被证明会假绿的判据;
4. 把 §4.3-3(b) pre-start 一致性门补上 channel 面的断言,否则 cutover 依旧可以把舰队起在「健康但失聪」的状态;
5. R-1(merge→cutover 之间部署冻结)与 R-2(版本号是舰队可用性单点)写进 operator-card / runbook。

---

# 第 2 轮复测 — head `d7791e3e`

日期: 2026-08-10
被测: `d7791e3e8df101d3eed96ab6d331d216b5bcdf9a`(= 远端 `origin/flywheel-FLY-1676`,开工与交卷前各核一次)
新增 commit: `1a2d4310` register pointer through dev channels / `20e20990` reject inbox-gated cutover poller / `d7791e3e` close cutover authority gaps

## 判决:**PASS**(限 implement 层;land 仍有两个硬前置)

## 1. BLOCKER-1 已真修好 —— 真 Discord 入站 A/B(带阴性对照)

修法(Lead 裁定 A):`--channels` → `--dangerously-load-development-channels`,`i.dev=true` 直接跳过 allowlist 分支;`server:flywheel-inbox` 并入同一个 variadic 参数列表。

### 1.1 参数确实是 variadic —— inbox 通道没被吞掉

这是我复测时首先怀疑的新风险:若该 flag 不是 variadic,`server:flywheel-inbox` 会变成 `claude` 的位置参数(= 首轮 prompt),inbox 通道静默死掉。真机跑生产 argv 原形,确认框原文:

```
Channels: plugin:discord@flywheel-plugins, server:flywheel-inbox
```

两项都被解析成 channel 条目。进入会话后 banner 同列两项,inbox 仅报 `no MCP server configured with that name`(我的隔离环境本就没配 inbox server)—— 这条警告本身反证了它被当作 channel 条目解析,而非被吞成 prompt。

### 1.2 真 bot 入站 A/B(529 隔离房 · 真 Discord · 单变量)

同一份隔离 `CLAUDE_CONFIG_DIR`、同一份 `access.json`(`allowBots` 只放行 flywheel-test-2 的 app id)、同一个 529 测试频道 `1493080991290626079`、同一个接收 bot(flywheel-test-1),**只变启动参数**:

| Arm | 启动参数 | 结果 |
|---|---|---|
| **A(被测)** | `--dangerously-load-development-channels plugin:discord@flywheel-plugins` | 无 allowlist 拒绝;真 bot 消息**注入会话**:`← discord · product-lead-test: FLY1676-QA-ARM-A-587242 inbound-probe from flywheel-test-2` |
| **B(阴性对照)** | `--channels plugin:discord@flywheel-plugins` | `not on the approved channels allowlist`;ARM-B 标记命中 **0** 次,`← discord` 注入行 **0** 行 |

**尺子自证**:两条消息都用接收方 bot 自己的 token 复查确认躺在频道里(`GET /channels/.../messages`),所以 Arm B 的「没收到」是真阴性,不是消息没发出去。

**发信方是真 BOT**(`author.bot = True`,id `1493072948683341976`)—— 因此这一条同时证明 fork 的 **allowBots** 从 pointer installPath 照常生效(官方原版会在此丢弃 bot 消息)。

这正是我第 1 轮要求的两条硬断言:**真注册断言**(不是「adapter 进程起来了」)+ **真 bot 入站 A/B 门**,两条都过。

诚实附注:Arm A 里模型侧回复没跑成 —— 我这个探针账号撞到 Fable 5 额度上限(`You've reached your Fable 5 limit`)。入站注入是本断言的判据,已成立;模型回信腿未验,且按规矩我不换模型、不碰全局配置。

## 2. FLY-1679 依赖闸 —— 真函数、四形态、动舰队之前

Lead 点名要验「implement 层能否正确拒绝缺失接线」。我把 `cutover-discord-plugin.sh` 里的**真** `pointer_launcher_contract()` 逐字抽出来跑(非 mock),对四种 launcher 形态:

| 形态 | 结果 |
|---|---|
| 1. 当前真 launcher(FLY-1679 未合入,poller 命中 0) | **REJECT** rc=1 ✅ |
| 2. + 无条件 FLY-1679 poller | ACCEPT ✅ |
| 3. poller 存在但被写在 `INBOX_MCP_ENABLED` guard 内 | **REJECT** rc=1 ✅ |
| 4. FLY-1679 已接但 selector 退回被拒的 `--channels` | **REJECT** rc=1 ✅ |

形态 4 意味着**我第 1 轮找到的缺陷无法悄悄回来**。

**时序**:`main()` 里顺序为 取全机锁 → `assert_deployed_repo` → **`preflight_target`** → 之后才 `inventory_leads / stop_authorities / bootout`。依赖闸确实在任何舰队变更之前触发,失败即 `release_lock; exit 1`。

## 3. 聚焦套件全部独立重跑(未采信自报)

| 套件 | 本轮 | 上轮 |
|---|---|---|
| `discord-plugin-cutover` | **23/23** | 18/18 |
| `claude-lead-plugin-fork-check` | **29/29** | 28/28 |
| `adapter-reap`(FLY-183 孤儿清理,新增 pointer 布局) | **15/15** | — |
| `update-flywheel-queue` | **19/19** | 19/19 |

(`discord-plugin-ops` 19/19、`test-deploy-discord-pointer` 3/3、`apply-core-room-mention-gate` 21/21 本轮未改动,沿用第 1 轮结果。)

orphan reaper 已认 `*/flywheel-plugins/discord` 精确目录边界两形态;`update-flywheel.sh` 的 pre-pull guard 已同步改成匹配新 selector(T8/T8b 绿)。

## 4. 仍然成立的两条风险(未变)

- **R-1 部署冻结**:merge 之后、cutover 之前,`update-flywheel.sh` 返 3 → deterministic → 会把**别的单**的 marker 打成 blocked + severe alert。**merge 与 cutover 必须同窗背靠背**。
- **R-2 版本号单点**:fork main 前进而 discord `plugin.json` 未 bump ⇒ checker 永远 OUTDATED、CLI 拒绝更新 ⇒ 全舰拒启。必须进 runbook。

## 5. 本轮诚实边界

| 项 | 状态 | 原因 |
|---|---|---|
| FLY-1679 / PR #801 冷启动免按键 | **未验** | 未合入。我 Arm A 是**手工按的 `1`**。生产冷启动的免按键腿由 FLY-1679 负责,且 cutover 闸已证明会在缺它时停住 —— 这是 land 硬前置,不是本 head 的缺陷 |
| V1–V3(告警演练 / sync workflow 真跑 / fork 追平) | 未执行 | `SYNC_PAT` 仍缺(founder 一次性动作),workflow 去膛;属 Tadashi land 窗 |
| V4–V8 生产 cutover 后验收 | 未执行 | 全舰 stop-all,founder-gated 破坏性动作 |
| 完整 529 双 Lead 部署形态 | 未执行 | 我用的是「真 Claude 会话 + 真 fork 插件 + 两个真 bot + 真 529 频道」的直接形态;它精确覆盖被测面(CLI 通道注册 + allowBots),但不覆盖 Lead 生命周期本身 |
| `fetch_messages`(V7) | 未执行 | 依赖 cutover 后真机;插件字节与今天生产在跑的完全相同,不构成新风险 |
| 全仓 `pnpm test:packages:run` | 未执行 | 本机 load 峰值 52;改动面为 shell + 三处 alert-kind 登记,聚焦套件已覆盖 |

## 6. 生产零污染(本轮复核)

`~/.claude` 三个 registry 中 `flywheel-plugins` 命中 **0**;`~/.flywheel/bin` 未写入(legacy checker 仍返回 `OK: Discord plugin matches fork (e1b061b)`);fork 仓零写入;探针全部在隔离 `CLAUDE_CONFIG_DIR` + 独立 tmux socket 内,收工后残留进程 **0**、tmux server 已 kill;未启停任何生产 Lead / Bridge / launchd job。两条探针消息留在 529 测试房作为证据。

## 7. founder ship 报告

已发布到 FLY-1676 issue thread:`https://fw-reports-a53de2.vercel.app/r/0b388b520a0eb764612180575db8450b/`(`delivered: true`,messageId `1536549649446608967`)。含三张 mmdc 预渲染 inline SVG、真机入站 A/B 关键帧、诚实边界与逐区评论框。
