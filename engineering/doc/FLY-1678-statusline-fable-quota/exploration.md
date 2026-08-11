# FLY-1678 statusline 增显 Fable 限额 — 探索

Issue: FLY-1678 (https://linear.app/geoforge3d/issue/FLY-1678/statusline-增显-fable-模型限额-5h7d-旁加第三个用量条)
日期: 2026-08-10
基于: 无

---

## 1. Founder 要什么

> 现在我们的那个 terminal 的 status bar 里面,不是有显示我们的 Five Hour Limit 和 Seven Day Limit 吗?我希望再显示一个那个 table 的 Limit

在现有 `5h` / `7d` 两个用量条旁边，再加**第三个**用量条，显示 Fable 模型专属的限额。

### 1.1 「table」= 「Fable」— 已被数据坐实，不是猜测

Tadashi 的判读是语音转写误拼。这一条现在**有硬证据**：本机 `~/.claude/usage-api-cache.json`（statusline 自己读的那份缓存，2026-08-10 12:53 抓取）里 `limits[]` 数组第三项逐字写着：

```json
{
  "kind": "weekly_scoped",
  "group": "weekly",
  "percent": 90,
  "severity": "critical",
  "resets_at": "2026-08-12T07:00:00.556261+00:00",
  "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
  "is_active": false
}
```

API 自己就把这条限额命名为 **Fable**，且它确实是**第三条**限额（前两条正是 `session`=5h 和 `weekly_all`=7d）。founder 说的「第三个用量条」与 API 的第三条 limit 精确对应。判读闭合。

---

## 2. 现状:statusline 到底是什么、在哪

### 2.1 渲染入口

`~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "bash /Users/xiaorongli/.claude/statusline-command.sh" }
```

`~/.claude/statusline-command.sh`（5517 字节，mtime 2026-07-18）是一个 **stdin → stdout 的纯过滤器**：Claude Code 每次渲染 statusline 时把 session JSON 从 stdin 喂进来，脚本打印两行 ANSI 文本。

- **Line 1**（本单不碰）：`model/effort | ⚡agent | 🌿worktree | 👤email | cwd | ctx N% ▓░`
- **Line 2**（本单要改）：`5h ▓░ N% reset ... | 7d ▓░ N% reset ...`

Line 2 的现有实现（脚本尾部）：读缓存里的 `.five_hour.utilization` / `.seven_day.utilization` / `.resets_at`，经 `pick_color` 上色、`make_bar` 画 10 格条（`▓` 实心 / `░` 空心）、`fmt_reset` 把 ISO 时间转成 `today HH:MM` / `tmrw HH:MM` / `Mon HH:MM`。

### 2.2 数据源:缓存文件,不是实时 API

脚本不在渲染路径上同步打 API。它读 `~/.claude/usage-api-cache.json`，缓存超过 600s 才**后台**异步刷一次（`refresh_cache`，带 `/tmp/claude-usage-refresh.lock` 120s 防抖），因为 Anthropic 的 `GET /api/oauth/usage` 按 access token 限流（~5 次就 429）。

**这对本单是决定性的好消息**：Fable 那条限额**已经躺在同一个缓存文件里**（见 §1.1）。加第三个条 = **零新增 API 调用、零新增网络路径、零新增 token 预算消耗**，纯粹是「同一份 JSON 多读一个字段、多打印一段」。

FLY-1256 的 quota daemon 还会周期性把新鲜的 200 响应原子回写这个缓存（`packages/teamlead/src/account-heal/quota-monitor-runtime.ts:142` 指的就是它），所以新字段的新鲜度自动继承现有机制，同样零改动。

### 2.3 Fable 数据在 JSON 里的确切位置 — 只有一处

我把整份缓存的 key 全列了一遍，逐个核对哪里能拿到 Fable 的 90%：

| 字段 | 本机实测值 | 能用吗 |
|---|---|---|
| `seven_day_opus` | `null` | ✗ |
| `seven_day_sonnet` | `null` | ✗ |
| `seven_day_cowork` / `seven_day_omelette` / `seven_day_oauth_apps` | `null` | ✗ |
| `tangelo` / `iguana_necktie` / `cinder_cove` / `amber_ladder` / `omelette_promotional` | `null` | ✗ |
| `nimbus_quill` | `{utilization: 0.0, resets_at: null}` | ✗ 值是 0，不是 90 |
| **`limits[]` 里 `kind=="weekly_scoped"` 且 `scope.model.display_name=="Fable"`** | **`percent: 90`, `resets_at: 2026-08-12T07:00:00Z`** | **✓ 唯一来源** |

结论：**顶层那一堆代号字段（`nimbus_quill` 等）全都不是 Fable**，别去猜代号。唯一自描述、且带 `display_name` 的来源就是 `limits[]` 里的 `weekly_scoped` 条目。这也是最稳的选择——它自己带模型名，Anthropic 改代号/加模型都不会让我们显示错东西。

---

## 3. 关键发现:这个脚本**不在仓库里**

这是本单最重要的一条，直接决定交付形态。我做了穷尽搜索：

```
find . -name "*statusline*"   → 零命中
find . -name "*status-line*"  → 零命中
grep -rn "statusline-command|usage-api-cache|oauth/usage" (排除 node_modules/dist)
  → 只有 QA 脚本、quota daemon、以及 FLY-1252/1256 的文档在**引用**它，
    没有任何一处**产出/安装**它
scripts/provision-fleet-host.sh 里 grep statusLine → 零命中
```

也就是说：`~/.claude/statusline-command.sh` 是一份**纯机器本地、无人纳管**的文件。仓库既不拥有它，也不部署它，重装机器会丢。issue 里写的「flywheel 管理的 statusline 脚本」这个前提**不成立**；顺带澄清，FLY-887 里那个 "status line" 是 Discord 侧的东西，跟终端 statusline 无关，循它找不到落点。

### 3.1 这带来一个必须表态的交付选择

验收要求「真机截图 + 全 Lead 生效」，而 statusline 是全局配置：改 `~/.claude/statusline-command.sh` 一处，**所有** Lead / Runner 的 pane 下一帧就生效（脚本每次渲染现读，无需重启任何服务）。但仓库的铁律是「所有改动走 PR」，而 PR 装不下一个仓库外的文件。

两条路：

- **A. 只改机器本地文件**，PR 里只放文档。
  代价：改动不受 review、无测试、重装即丢、下一个人完全看不到它存在过。等于把一份已经无人纳管的文件继续留在无人纳管状态。
- **B. 把脚本收进仓库当 source of truth + 写幂等 installer**，由 installer 部署到 `~/.claude/statusline-command.sh`。
  仓库里有现成且已被打磨过的先例：`scripts/install-hooks.sh`（FLY-1389 加固版）——拒绝从 temp/worktree checkout 安装全局配置、先原子部署一份稳定副本、再注册稳定路径；`scripts/check-global-path-hygiene.sh` 还会持续扫描全局配置里有没有临时路径。照这个模子做即可。

**我选 B**，理由是 A 无法满足「改动可 review、可测试、可复现」这三条仓库非协商项，而 B 只多花一个 installer 的成本，还顺手把一份孤儿文件收编。

### 3.2 由此产生的一个边界(已抛给 Tadashi,非阻塞)

FLY-1389 的 hygiene 铁律是**不允许从 worktree 安装全局配置**——而我正跑在 worktree（`.git` 是 gitdir 指针，指向 `~/Dev/flywheel/.git/worktrees/flywheel-FLY-1678`）。所以「把新脚本真正装进 `~/.claude/`」这一步按仓库纪律应当在 merge 后从主 checkout 执行，而这正是 ship 步骤——本节点的合同明确写着不得请求 ship/merge。

于是「真机截图」这条验收在 PR 阶段能做到什么程度，需要说清楚，我不打算含糊过去：

- **PR 阶段我能给的真凭据**：拿**真实的**那份 `~/.claude/usage-api-cache.json`（含真 Fable 90%）喂给新脚本，捕获它真实渲染出的 ANSI 两行；并用同一批输入跑新旧两版脚本做逐字节 diff，证明 5h/7d 两段一字未变（零回归）。这是真数据、真脚本、真输出，不是 mock。
- **PR 阶段我给不了的**：一张「某个 Lead 的活 pane 里第三个条已经在那儿」的截图——那需要先把文件装到 `~/.claude/`，即部署。

已用 `flywheel-comm ask`（非阻塞）请 Tadashi 定这一条：部署是留给 ship，还是授权我在 PR 前就装（带 `.bak` 备份，随时可逆）。等回复期间我继续按 B 把东西建出来，不空等。

---

## 4. 设计取向

### 4.1 标签写死 "Fable" 还是跟着 API 走?

**跟着 API 走。** 遍历 `limits[]`，凡是带 `scope.model.display_name` 的条目就渲染一条，标签直接用那个 `display_name`。

理由很实在：写死 "Fable" 的话，Anthropic 哪天把 scoped limit 换成别的模型，statusline 会理直气壮地把别人的数字标成 Fable——这正是「拿标签冒充事实」的那类 bug。跟着 `display_name` 走，代码更短，还天然正确。本机今天恰好只有一条（Fable），所以视觉上就是 founder 要的「第三个条」。

同时要**跳过**只有 `scope.surface` 而没有 `scope.model` 的条目（那不是模型限额），避免误渲染。

### 4.2 样式

与现有两条完全一致：`pick_color` 同色阶（≥80 红 / ≥50 黄 / else 绿）、`make_bar` 同 10 格 `▓░`、`fmt_reset` 同 `today/tmrw/weekday HH:MM`、同 `  |  ` 分隔符。不重排现有内容，只在 7d 之后追加。

按本机真实数据，Line 2 会从

```
5h ▓▓▓▓▓▓▓▓▓░ 96% reset today 14:30  |  7d ▓▓▓▓▓▓▓░░░ 75% reset tmrw 00:00
```

变成

```
5h ▓▓▓▓▓▓▓▓▓░ 96% reset today 14:30  |  7d ▓▓▓▓▓▓▓░░░ 75% reset tmrw 00:00  |  Fable ▓▓▓▓▓▓▓▓▓░ 90% reset tmrw 00:00
```

**要如实说的一个折中**：这一行从约 74 字符涨到约 116 字符。founder 明确要「旁加」（同一行），所以我按她说的做，但窄终端会折行。这是她的选择空间，我把事实摆出来，不擅自改成第三行。

### 4.3 缺数据时怎么办

现有代码的姿态是 `if [ -n "$u5" ] && [ -n "$u7" ]` —— 拿不到就整行不渲染。第三条沿用同样的克制：`limits[]` 里没有 model-scoped 条目（比如账号没有 Fable 限额、或旧版 API 不返回这个字段）就**只是不打印第三段**，5h/7d 照常。绝不打印 `?%` 或占位符去污染 founder 的视野，也绝不因为新字段缺失就让整行消失（那就是回归）。

---

## 5. 待办范围

1. 把现有 `~/.claude/statusline-command.sh` 逐字收进仓库作为基线（先证明 byte-identical，再改）。
2. 追加 model-scoped 限额渲染。
3. 幂等 installer（照 `install-hooks.sh` 的 worktree 拒绝 + 原子写模子）。
4. 测试：新旧逐字节零回归 diff + 真实缓存渲染 + 缺字段/多条/仅 surface-scoped 等边界 fixture。
5. 部署与真机截图按 §3.2 的裁决执行。
