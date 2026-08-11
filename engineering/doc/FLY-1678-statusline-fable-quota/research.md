# FLY-1678 statusline 增显 Fable 限额 — 调研

Issue: FLY-1678 (https://linear.app/geoforge3d/issue/FLY-1678/statusline-增显-fable-模型限额-5h7d-旁加第三个用量条)
日期: 2026-08-10
基于: exploration.md

---

## 1. 数据源合同:`limits[]` 的确切形状

本机 `~/.claude/usage-api-cache.json`（2026-08-10 12:53 抓取）的 `limits` 数组，逐字如下：

```json
[
  { "kind": "session",       "group": "session", "percent": 96, "severity": "critical",
    "resets_at": "2026-08-10T21:30:00.556020+00:00", "scope": null, "is_active": true },
  { "kind": "weekly_all",    "group": "weekly",  "percent": 75, "severity": "warning",
    "resets_at": "2026-08-12T07:00:00.556063+00:00", "scope": null, "is_active": false },
  { "kind": "weekly_scoped", "group": "weekly",  "percent": 90, "severity": "critical",
    "resets_at": "2026-08-12T07:00:00.556261+00:00",
    "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
    "is_active": false }
]
```

三条限额与 statusline 的三个条一一对应：

| limits 条目 | 现有 statusline | 本单 |
|---|---|---|
| `kind=session` | `5h` 条（读顶层 `.five_hour`） | 不动 |
| `kind=weekly_all` | `7d` 条（读顶层 `.seven_day`） | 不动 |
| `kind=weekly_scoped`, `scope.model.display_name="Fable"` | **无** | **新增第三条** |

数值交叉验证：`limits[0].percent=96` 与顶层 `.five_hour.utilization=96.0` 一致，`limits[1].percent=75` 与 `.seven_day.utilization=75.0` 一致。同一份数据的两种表达对得上，说明 `limits[]` 不是某种陈旧或旁路的副本，`percent` 与 `utilization` 同源同刻。这也是我敢让第三条只走 `limits[]` 的依据。

### 1.1 `scope` 的三种取值,决定筛选条件

实测存在三种：`scope: null`（全局限额，前两条）、`scope.model` 有值（模型限额，Fable）、以及结构上还留了 `scope.surface` 位（本机为 `null`，含义应为「按使用面切分的限额」）。

因此筛选条件必须是 **`scope.model.display_name != null`**，而不是 `kind == "weekly_scoped"`：
- 用 `kind` 筛，将来若出现 `surface`-scoped 的 `weekly_scoped` 条目，会被误当成模型限额，标签取不到名字。
- 用 `scope.model.display_name` 筛，天然只放行真正的模型限额，且顺手拿到了标签文本。

### 1.2 顶层代号字段全部排除

`seven_day_opus` / `seven_day_sonnet` / `seven_day_cowork` / `seven_day_omelette` / `seven_day_oauth_apps` / `tangelo` / `iguana_necktie` / `cinder_cove` / `amber_ladder` / `omelette_promotional` 本机**全为 `null`**；唯一非 null 的代号字段 `nimbus_quill` 值是 `utilization: 0.0`，与 Fable 的 90% 对不上，**不是 Fable**。

所以：全机没有第二个地方能拿到 Fable 的 90%。`limits[]` 是唯一来源，这不是偏好，是事实约束。

## 2. 缓存写入路径:`limits[]` 会不会被抹掉

这是本单最大的隐性风险——如果某个写者只写精简结构，第三个条就会时有时无，看起来像随机 bug。**两个写者我都核了源码**：

| 写者 | 代码位置 | 写什么 | `limits[]` 保住吗 |
|---|---|---|---|
| statusline 自己的后台刷新 | `~/.claude/statusline-command.sh` `refresh_cache()` | `echo "$body" \| jq . > "$CACHE.tmp" && mv` — 原样落盘整个 200 响应 | ✅ |
| FLY-1256 quota daemon | `packages/teamlead/src/account-heal/quota-monitor-runtime.ts` `writeStatuslineCache()` | `JSON.stringify(raw)` + fsync + rename | ✅ |

daemon 那侧的 `raw` 类型是 `ValidatedUsagePayload = Record<string, unknown> & { five_hour; seven_day }`，而 `validatePayload()` 的返回是 `value as ValidatedUsagePayload`——**整个对象原样透传**，只校验 `five_hour`/`seven_day` 两个窗口，不做字段裁剪（`quota-usage-api.ts:60-67`）。所以 `limits[]` 完整存活。

**结论：TS 侧一行都不用改。** 本单的改动完全封闭在那个 shell 脚本里。

## 3. 真机原型验证(不是推演)

我把打算用的 jq 直接打在**真缓存**上跑了：

```
$ jq -r '(.limits // [])[] | select(.scope.model.display_name != null)
         | "\(.scope.model.display_name)\t\(.percent)\t\(.resets_at)"' ~/.claude/usage-api-cache.json
Fable   90      2026-08-12T07:00:00.556261+00:00
```

一次命中，一行输出。退化场景同样实测过，都是**静默 exit 0 + 空输出**，不报错、不打脏字：

| 输入 | 输出 | 退出码 |
|---|---|---|
| `{"five_hour":{...}}`（整个 `limits` 缺失） | 空 | 0 |
| `{"limits":[{"kind":"session","scope":null}]}`（有 limits 但无模型限额） | 空 | 0 |

`(.limits // [])` 这个 `//` 兜底是必需的：没有它，`limits` 缺失时 `null[]` 会让 jq 报错。

## 4. `fmt_reset` 能否直接复用 — 能,已实测

Fable 的 `resets_at` 形状是 `2026-08-12T07:00:00.556261+00:00`（带小数秒 + 显式偏移），和顶层 `five_hour.resets_at` 完全同形。现有 `fmt_reset` 的处理是 `${iso%%.*}` 截到第一个点 → `2026-08-12T07:00:00`，再 `date -juf "%Y-%m-%dT%H:%M:%S" ... +%s`。实测：

```
$ iso="2026-08-12T07:00:00.556261+00:00"; date -juf "%Y-%m-%dT%H:%M:%S" "${iso%%.*}" +%s
1786518000        # = 2026-08-12T07:00:00Z ✓
```

`-u` 按 UTC 解析（API 返回的就是 `+00:00`），随后格式化时不带 `-u`，转成本地墙钟。07:00 UTC → PT 00:00，所以会渲染成 `tmrw 00:00`。**`fmt_reset` 零改动直接复用**，这也自动保证第三条的时间表述与前两条口径一致。

## 5. 交付形态:仓库先例

`~/.claude/statusline-command.sh` 无人纳管（exploration §3）。要把它收编，仓库里有一套已经被 FLY-1389 打磨过的成熟模子——`scripts/install-hooks.sh`：

1. **先拒后写**：`is_temp_or_worktree_root "$REPO_ROOT"` 在**任何全局写入之前**拦住 temp/worktree checkout。根因是 1389 那次事故：从 worktree 跑一次 installer，全局配置就永久指向一个会被清掉的目录。
2. **稳定副本**：源文件先原子部署到 `~/.flywheel/` 下的稳定路径（同目录 mktemp → chmod → `mv`，让并发读者只会看到旧版或新版，绝不会看到半个文件）。
3. **注册稳定路径**：`~/.claude/settings.json` 只引用稳定副本，且先 `jq empty` 校验旧 JSON、写完再校验新 JSON，最后才 `mv`。
4. **持续巡检**：`scripts/check-global-path-hygiene.sh` 只读扫描全局配置里有没有临时路径，作为 installer 守卫之后的第二张网。

判断依据在 `scripts/lib/path-hygiene.sh`（`is_temp_or_worktree_root` / `path_hygiene_target_is_temp_or_worktree` 等），是写者守卫与巡检器共用的单一真相——worktree 检测走的是「拥有仓库根的 `.git` 是不是文件形态」，不是路径名启发式（本仓自己的 worktree 路径里就不含 `worktrees/`，我这个 `~/Dev/flywheel-FLY-1678` 正是活例）。

**本单沿用同一套**，不发明新机制。

### 5.1 一个必须如实说的差异

`install-hooks.sh` 管的是 `settings.json` 里的 hook**注册项**；本单管的是 statusline **脚本文件本身**。而 `settings.json` 现有的 statusLine 命令写死的是 `bash /Users/xiaorongli/.claude/statusline-command.sh`——**已经**是一个稳定的、非 worktree 的绝对路径，path-hygiene 巡检对它没有意见。

所以本单**不需要动 `settings.json`**：只要把仓库里的脚本原子部署到那个既有路径即可。这比 install-hooks 少一整步（也少一类风险），我不会为了凑对称去改 settings.json。

## 6. 测试怎么落

- 仓库 shell 测试统一放 `scripts/__tests__/*.test.sh`，CI 的 `script-tests` job（`.github/workflows/ci.yml:98`）逐条 `bash` 调用。新测试必须显式接进那个 job，否则等于没跑。
- 生产 Mac 是 **bash 3.2**（`/bin/bash`），CI 是 Linux。脚本用 `#!/usr/bin/env bash`，测试里要注意别用 bash 4+ 语法（关联数组、`${var,,}` 等）。
- statusline 是纯 stdin→stdout 过滤器，**天然可测**：喂固定 stdin + 固定 `HOME`（指向临时目录里的假 cache）→ 断言 stdout。不需要起任何服务、不需要真 tmux、不打网络。
- 零回归的判据要**逐字节**：同一批输入分别喂旧版与新版脚本，断言 Line 1 完全相同、Line 2 的 5h/7d 前缀段完全相同（含 ANSI 转义序列）。只看「肉眼差不多」不算数。

需要特别设计的一点：脚本里的 `refresh_cache` 会在缓存过期时**打真网络**。测试必须让缓存文件保持「新鲜」（`touch` 成当前时间）以走不刷新分支，否则 CI 上会有一个后台 curl 在乱跑、还可能污染真 token 预算。这一条要在测试里显式处理，不能靠运气。

## 7. 待决

exploration §3.2 抛给 Tadashi 的部署时机问题（留给 ship / 还是授权 PR 前装）仍在等回复。**不阻塞**：无论哪种答案，仓库侧的脚本、installer、测试都完全一样，差别只在最后那一下 `bash scripts/install-statusline.sh` 谁来跑、什么时候跑。
