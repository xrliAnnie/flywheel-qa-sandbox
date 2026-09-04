# FLY-2296 Codex TUI 额度换模菜单钉死停驻体 — 实施计划

Issue: FLY-2296 (https://linear.app/geoforge3d/issue/FLY-2296/病根-codex-tuiapproaching-rate-limits-switch-to-luna菜单卡住停驻体poller)
日期: 2026-09-03
基于: research.md

## 0. 一句话

runner 出生时把 Codex 自己的偏好键 `notice.hide_rate_limit_model_nudge = true` 钉进 `$CODEX_HOME/config.toml`,让「Approaching rate limits → Switch to luna?」菜单永远不弹;不换模、不加旋钮、不改巡检。

## 1. 范围

| 块 | 内容 | 状态 |
|---|---|---|
| C1 | runner home:`provisionCodexHome` 新增 `pinRunnerNotice`,与 `pinRunnerPolicy` 同层 | 必做 |
| C2 | Lead home:`codex-lead-tui-home.sh` 在 trust 段后追加同一个键 | 纳入(Lead 裁定,question dffb0ecd:同一个病、同一处修法;**只钉这一个键**,不顺手改任何其它 config.toml 项,不加开关) |
| C3 | 判别力探针:假 app-server 接真 TUI 的红绿脚本,固化进仓 | 必做(Lead 硬要求:守卫必须能变红) |

不在范围:巡检脚本、goal pause/resume 语义、额度切号(FLY-2109)、任何 `-c` argv、任何环境变量。

## 2. C1 — runner home pin

### 2.1 落点

`packages/claude-runner/src/codex-home.ts`

```ts
// provisionCodexHome:两道 pin 都是纯字符串计算,放到任何文件系统写入之前
// (现在 pinRunnerPolicy 在第 1051 行,晚于 auth.json / .active 的写入,也在 try 之外;
//  一旦 pin 抛错,重 provision 时旧 home 里的 GH_TOKEN 不会被 scrub。本单把两道 pin 一起提前。)
let runnerBaseToml: string;
try {
  runnerBaseToml = pinRunnerNotice(pinRunnerPolicy(baseToml));       // ← 在 writeFileSync(auth.json) 之前
} catch (error) {
  // 重 provision 同一 executionId 时 home 里可能还留着上一轮的 managed GH_TOKEN 块
  // (启动期 scrubOrphanedCodexHomes 有意跳过 live exec;adapter 的 try/finally 在本函数返回之后才进入)。
  // pin 拒绝 = 本轮不会再有 finally 来 scrub,所以这里自己 scrub 再抛。
  scrubCodexHomeCredential(opts.executionId, env);
  throw error;
}
… 之后才 mkdir / 写 auth.json / .active / config.toml(原顺序不变)
```

`pinRunnerNotice` 放在 `pinRunnerPolicy`(第 483 行)之后,**导出**以便形状表测试直接打它(`pinRunnerPolicy` 是私有的,只经 provision 测;本单形状多,直接测更清楚)。提前计算 + 拒绝时 scrub 的效果:pin 抛错时本轮什么都没写,上一轮留下的 token 也被清掉;不存在「auth 写了、config 没写」或「旧 token 没 scrub」的中间态。`scrubCodexHomeCredential` 对不存在的 home 是 no-op(现有语义),首次 provision 时无副作用。失败路径用测试钉住(§2.3 残留用例)。

### 2.2 语义(单一真相 = TOML 键 `notice.hide_rate_limit_model_nudge`)

输入是已钉过 policy 的 base TOML 字符串;输出仍是 base TOML 字符串(managed 块由后续 `renderCodexHomeConfig` 追加,本函数不碰 sentinel)。

```
parsed = parseTomlSanitized(body, "base")
noticeVal = parsed.notice?.hide_rate_limit_model_nudge
headers = 行首 `[notice]` 字面表头的匹配列表(允许两侧空白,忽略注释行)
rootSegment = body 从头到第一个任意表头行之前的文本(与 pinRunnerPolicy 的 firstTableIndex 同一算法)
dottedOrInline = **仅在 rootSegment 内**行首 `notice =` 或 `notice.` 的赋值(root 级点键/内联定义)
   —— 出现在某个表下面的 `notice.foo = "x"` 定义的是 `<table>.notice.foo`,与 root 的 notice 无关,不能误判

if dottedOrInline.length > 0            → throw "provisionCodexHome: notice is defined as a dotted/inline table; refusing to pin"
if parsed.notice !== undefined && !isPlainTable(parsed.notice) → throw(root 有 `notice = <标量/数组>`,但没被上面正则抓到的写法,如 `"notice" = 1`)
if headers.length > 1                   → throw(理论上 parse 已炸;仍显式守)
if headers.length === 0:
    body = `${body.trimEnd()}\n\n[notice]\nhide_rate_limit_model_nudge = true\n`
else:
    span = 表头行之后到下一个任意 `[` 表头行之前
    assignment = span 内行首 `hide_rate_limit_model_nudge =` 的行
    if assignment.length > 1            → throw
    if assignment.length === 1          → 把该行整行替换为 `hide_rate_limit_model_nudge = true`
    else                                → 在表头行后立刻插入 `hide_rate_limit_model_nudge = true`
post = parseTomlSanitized(body, "rendered")
if post.notice?.hide_rate_limit_model_nudge !== true → throw "provisionCodexHome: notice pin did not take effect"
```

要点:
- **pin 语义**:base 里已是 `true` 也照走(幂等,输出等价);`false` 一律改 `true`。无人值守体没有「要看菜单」的合法理由。
- 引号键 `"hide_rate_limit_model_nudge" = false` 不被正则识别,会插入第二个赋值 → 后置 parse 因重复键炸掉 → fail-loud,不会写出坏文件。
- 种子当前形状(只有 `[notice.model_migrations]`)走 `headers.length === 0` 分支;research §3.2 已实测该形状合法。
- 错误信息只说形状,不引用配置内容(沿用 FLY-1604 的 sanitized 约定)。

### 2.3 测试(先写红)

`packages/claude-runner/test/codex-home.test.ts`

新 describe `pinRunnerNotice (FLY-2296)`,`it.each` 形状表:

| 输入 base | 期望 |
|---|---|
| 空串 | 输出 parse 后 `notice.hide_rate_limit_model_nudge === true` |
| 只有 `[notice.model_migrations]\n"a" = "b"` | 同上,且 `model_migrations.a === "b"` 仍在 |
| `[notice]\nhide_full_access_warning = true` | 同上,且 `hide_full_access_warning` 仍为 true,`[notice]` 表头仅一处 |
| `[notice]\nhide_rate_limit_model_nudge = false` | 变 true,文件里该键只出现一次 |
| `[notice]\nhide_rate_limit_model_nudge = true` | 输出与输入等价(`parse` 相等且不新增行) |
| `[notice]` 表头后跟 `[projects."/x"]` 再跟 `[notice.model_migrations]` | true;projects 不动 |
| `notice = { hide_full_access_warning = true }` | throw,消息含 `refusing to pin`,不含配置文本 |
| `notice.hide_rate_limit_model_nudge = false`(root 点键) | throw |
| `[notice]\n"hide_rate_limit_model_nudge" = false`(引号键) | throw(后置 parse 重复键) |
| `[other]\nnotice.foo = "x"`(表下的相对键,**对照组**) | 不 throw;输出里 `other.notice.foo === "x"` 仍在,且 `notice.hide_rate_limit_model_nudge === true`(追加整表路径) |
| `"notice" = 1`(root 标量) | throw |

provision 级(与 `FLY-2168 pins a requirements-compatible runner policy`,第 757 行,同一写法):

- 种子 = 生产种子的最小复刻(`model`、`[projects.*]`、`[notice.model_migrations]`),`provisionCodexHome` 后读回 `config.toml`,`parseToml` 断言 `notice.hide_rate_limit_model_nudge === true`,同时 `sandbox_mode/approval_policy/model` 与既有断言一致(证明两道 pin 不互相破坏)。
- 种子里 `[shell_environment_policy.set]` 已存在 + `[notice]` 已存在的组合:GH_TOKEN 手术注入与 notice 注入都成立(两处「表头后注入」不串位)。
- **阴性对照**:临时把调用点改成只 `pinRunnerPolicy` 时上面两条必须变红(评审时在 PR 描述附一次红→绿输出;这是 FLY-2257 教训:测试要能对「漏装」变红)。
- 幂等:同一份种子 provision 两次,第二次输出与第一次逐字节相同。
- **失败路径残留**(Codex R1 第 3 条 + R2 唯一 HIGH 的直接回归):
  1. 用合法种子 + `ghToken` 直接调 `provisionCodexHome`(同一 executionId),读回 `config.toml` 断言 managed 块里 **有** `GH_TOKEN`(这一步不做任何 scrub,模拟 adapter finally 还没跑到的 live home);记下 `auth.json` 的字节与 mtime。
  2. 把种子改成会被 `pinRunnerNotice` 拒绝的形状(`notice = { … }`),再次调 `provisionCodexHome` 同一 executionId。
  3. 断言:throw(消息含 `refusing to pin`);`config.toml` 里 **不再含** `GH_TOKEN`(拒绝路径的 scrub 生效);`auth.json` 字节与 mtime 与第 1 步相同(本轮没有重写 auth);`.active` 未被重写。
  阴性对照:把拒绝路径里的 `scrubCodexHomeCredential` 调用注释掉,这条用例必须变红(评审时在 PR 描述附一次)。

### 2.4 反向守卫(生产代码内)

后置断言 `post.notice.hide_rate_limit_model_nudge === true` 留在 `pinRunnerNotice` 里 —— 未来有人把追加逻辑改坏,provision 当场 throw,dispatch fail-loud,而不是悄悄放出一个还会弹菜单的体。这与 `pinRunnerPolicy` 对「unsupported assignment shape」的处理同一档。

### 2.5 C3 — 判别力探针(runtime 红绿对照)

research §7 已用一次性脚本证明:同一份假 app-server 应答下,`$CODEX_HOME/config.toml` 有无 `notice.hide_rate_limit_model_nudge = true` 决定真 TUI 弹不弹菜单。实现节点把它固化为仓内脚本:

| 文件 | 内容 |
|---|---|
| `scripts/codex-tui-fake-app-server.cjs` | research §7.2 的 `server.cjs`:unix socket + JSON-RPC 应答表 + 在 `account/rateLimits/read` 之后主动推 `turn/started`/`turn/completed`;`ws` 取自仓内依赖(`packages/claude-runner` 已依赖 `ws`,不新增依赖) |
| `scripts/codex-tui-nudge-probe.sh` | 用法 `codex-tui-nudge-probe.sh --home <CODEX_HOME> --expect menu\|nomenu [--codex-bin <path>]`。把 home 的 **config.toml 一份**复制到临时目录(**不带 auth.json**),复制时先剥掉 flywheel-managed credential 块(`# >>> flywheel-managed credential (FLY-123)` … `<<<` 之间,与 `stripManagedBlock` 同一对标记),写入后 `chmod 0600`,并断言副本里 **不含 `GH_TOKEN`**(含则 exit 2,不起 TUI);往副本追加临时 cwd 的 trust(不动原 home);`trap` 在任何退出路径删掉临时目录、杀 tmux 会话与假 server,**trap 装好之后**才起进程。然后起假 server + tmux 起 `codex resume --remote`,等 TurnComplete 后 `capture-pane`,按 `Approaching rate limits` 与 `Press enter to confirm` 两行同时存在判 menu / 都不存在判 nomenu;期望不符 **exit 1** 并把 pane 打印出来;tmux 或 codex 缺失 exit 2 并明说「未验证」 |
| `--self-check` | 同一次调用里跑三组:无键 → 期望 menu、键 true → 期望 nomenu、键 false → 期望 menu;任一组不符 exit 1。这就是「对隐藏态必须变红」的自检:把 `--expect nomenu` 的判定逻辑改坏,self-check 必红 |

接入点:
- QA 真机步骤 E4(§5)用它打**真 provision 出来的 home**,先期望 nomenu;再把副本里 `[notice]` 段删掉,期望 menu。两条都过才算修复有判别力。
- CI:`packages/claude-runner` 的 vitest 里加一条 `codex-tui-nudge-probe (self-check)` 用例,仅当 `tmux -V` 与 `codex --version` 都可用时执行,否则 `it.skip` 并在用例名里带 `SKIPPED: codex/tmux absent`——跳过必须**可见**,不能与通过长得一样(FLY-2178 「两种状态一个痕迹」教训)。GitHub CI 没有 codex 二进制,预期是可见跳过;本机 pre-push / QA 台架上跑真的。
- 安全:副本 home 永远不含 `auth.json`,假 server 只监听 unix socket,不做任何出网。

## 3. C2 — Lead home pin

`packages/teamlead/scripts/codex-lead-tui-home.sh` 的 `ensure_home`(第 571 行起)有**两条**配置装配路径,插入点必须两条都够得着(Codex R1 BLOCKER):

- full-access 分支(第 608–612 行):`write_full_access_config` → `append_full_access_lead_actions_mcp` → `return 0`。生产的 Mufasa / infra-bot launcher 都是 `FLYWHEEL_CODEX_LEAD_PROFILE=full-access`,而且**每次 ensure 都整份重写** config.toml,所以人手按过的键在下次启动就没了。
- read-only 分支:pins(第 615–643 行)→ trust 段(第 655–695 行)。

新增 `ensure_notice_pin "$CONFIG"`,在**两条分支各自的装配终点**调用一次:full-access 分支在 `append_full_access_lead_actions_mcp` 之后、`return 0` 之前;read-only 分支在 trust 段之后。函数体:

```
state=$(python3 tomllib 读 $CONFIG:
   解析失败 / tomllib 缺失              → error
   顶层没有 notice 键                    → absent      (inline 表、root 点键、["notice"] 引号表头都会让顶层出现 notice,因此都不是 absent)
   notice 非 dict                        → error
   notice 是 dict 且键 == True           → pinned
   notice 是 dict 且键 == False          → drift
   notice 是 dict 且键缺                 → present_unpinned)
absent           → cat >> "$CONFIG" <<EOF

[notice]
hide_rate_limit_model_nudge = true
EOF
                   然后再 tomllib 读一次,断言键 == True,否则 die(写入后验证)
pinned           → :
drift            → die "config.toml explicitly shows the rate-limit model-switch menu — an unattended TUI would wedge on it. Set hide_rate_limit_model_nudge = true manually."
present_unpinned → die "config.toml already defines [notice] without hide_rate_limit_model_nudge — appending a second [notice] table would be invalid TOML. Add hide_rate_limit_model_nudge = true to the existing table manually."
error            → die(fail closed,与 trust 段同句式)
```

只在「顶层 notice 完全不存在」时追加;bash 侧不做任何手术注入(与 trust 段 R3 MED-2 同理)。三个生产 Lead home 现状都是「无 `[notice`」,走 absent。full-access 分支重写整份 config 后 notice 段必然缺失 → 每次 ensure 都走 absent 追加,幂等成立(追加前 config 里没有它)。

测试:`packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh` 加 6 例,照既有 trust 用例的形状:absent 追加(read-only)、**absent 追加(full-access,`FLYWHEEL_CODEX_LEAD_PROFILE=full-access`,读回 True 且 lead_actions MCP 块仍在)**、pinned 不动、drift die、present_unpinned die(`[notice]` 有表头无键)、inline `notice = { }` die。

## 4. 生效边界 / 回滚(写给 QA 与巡检)

- 新派工的体:出生即生效。
- 修复前在飞的体:TUI 只在启动时读一次 `notices`;等 Bridge 下一次重启走 recovery(`CodexTmuxAdapter.executeOwned` 第 721/758 行重新 provision,第 1121 行重新 `ensureWindow`)才生效。在那之前巡检处置照旧(`Down Down Enter` 选 never-show-again)。**不做**对在飞 home 的一次性回填:TUI 不热重载,回填不改变生效时刻。
- 回滚:revert 提交即可。已渲染 home 里的 `[notice]` 是 Codex 自己的合法键,留着无害,下一次 provision 从种子重渲染时自然消失。
- 无 schema、无 DB、无 env、无 feature flag。

## 5. 验收证据

| # | 证据 | 谁给 |
|---|---|---|
| E1 | 单测形状表 + provision 级断言全绿;阴性对照红→绿输出贴 PR | implement |
| E2 | 真机:派一具 Codex 体后 `python3 -c 'import tomllib,sys;print(tomllib.load(open(sys.argv[1],"rb"))["notice"]["hide_rate_limit_model_nudge"])' ~/.flywheel/codex-homes/<exec>/config.toml` 输出 `True`;且该 home 的 `[notice]` 在 managed 块**之前**(不在 trust 块内部) | QA |
| E3 | 该体的 TUI pane(`tmux capture-pane`)正常显示 `Pursuing goal` 状态行,没有 boot 菜单、没有信任菜单(证明多出的表没有破坏其它 pin) | QA |
| E4 | 判别力(真机,§2.5 探针):对 E2 那份真 provision 的 home 跑 `codex-tui-nudge-probe.sh --home <home> --expect nomenu` → exit 0;把副本里 `[notice]` 段删掉再跑 `--expect menu` → exit 0(pane 里出现 `Approaching rate limits … Press enter to confirm`);`--self-check` exit 0。三条命令的 stdout/pane 原文附在 QA 报告 | QA |
| E5 | C2:在复制的 Lead home 上以 **`FLYWHEEL_CODEX_LEAD_PROFILE=full-access`**(生产形态)跑一次 `codex-lead-tui-home.sh` ensure,tomllib 读回 `notice.hide_rate_limit_model_nudge == True` 且 `[mcp_servers.lead_actions]` 仍在;再以 read-only 形态跑一次同样读回 True;对 full-access 副本跑 E4 同样的 nomenu/menu 两条;真 Lead home 由 Lead 决定何时重启 TUI | QA + Lead |
| E6 | 场证据(post-ship,不作验收门):下一次任一账号窗口 ≥90% 时,修复后出生的 Codex pane 不再出现 `Approaching rate limits`;巡检 `INTERACTIVE_MENU` 对 Codex pane 计数为 0 | 巡检 |

说明:菜单需要账号窗口 ≥90% 才弹,生产上不能按需触发;所以判别力不靠等生产,靠 E4 的假 app-server 探针(research §7 已在 0.153.0 真二进制上跑通三组红绿)。上游读路径(`rate_limits.rs:410–425`)与写路径(`event_dispatch.rs:2452–2466`)同键同文件、本机 21 份 home 是 Codex 自己写出的同一形状,是解释;E4 是证明。

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `packages/claude-runner/src/codex-home.ts` | 新增导出 `pinRunnerNotice`;`provisionCodexHome` 调用链插一层 |
| `packages/claude-runner/test/codex-home.test.ts` | 新 describe + provision 级 2 例 + 幂等 1 例 |
| `packages/teamlead/scripts/codex-lead-tui-home.sh` | (C2)`ensure_notice_pin` |
| `packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh` | (C2)4 例 |
| `scripts/codex-tui-fake-app-server.cjs` | (C3)假 app-server,来自 research §7.2 的 `probe/server.cjs` |
| `scripts/codex-tui-nudge-probe.sh` | (C3)红绿探针 + `--self-check` |
| `packages/claude-runner/test/codex-tui-nudge-probe.test.ts` | (C3)self-check 用例,codex/tmux 缺失时**可见**跳过 |
| `engineering/doc/milestones/FLY-2296.md` | ship 时新建 |

## 7. 安全边界

- 写入内容是常量,不含任何用户/issue 派生文本;错误信息不回显配置内容(沿用 FLY-1604)。
- 文件权限沿用 provision 的 0600 + 写后 chmod。
- 不改 argv、不改 tmux 命令、不改 shell 拼接面。
- 探针副本 home 不含 `auth.json`;假 server 只在 unix socket 上,不出网。

## 8. 诚实边界

- **未证明菜单会导致 goal paused。** 代码里 `setGoalStatus("paused")` 只由 Bridge 自己调用(FLY-1269 phase hold、FLY-1257 gate hold),菜单是 TUI 本地状态,不向 daemon 发 pause。巡检对 %131/%165 手工 `/goal resume` 存在越过 Bridge hold 的风险,由 Lead 另行处置;本单不为它改代码。
- 「poller 不读信」在 Codex 体上的准确含义是「体的 goal turn 没有推进」;本单只能证明菜单盖住了状态行并带来误按换模的风险,不能把 turn 停滞归因于菜单。
- 修复对修复前已在飞的 TUI 进程不生效,要等下一次 provision + 重新拉起 TUI(§4)。
- 不改巡检:`INTERACTIVE_MENU` 已能命中该文案;修好后它对 Codex pane 归零是场证据,不是验收门。
