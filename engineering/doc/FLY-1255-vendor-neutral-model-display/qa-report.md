# FLY-1255 厂商无关的标题与窗口模型显示 — QA 报告（round 2，独立复验）
Issue: FLY-1255
日期: 2026-07-15
基于: plan.md, exploration.md, research.md

## 结论

**PASS.** 三段流水线 QA 阶段独立验证 PR #597。

本轮由**新的 QA session**（`212eca7e`）从零复验：上一个 QA session（`21901878`）写完
PASS 报告后被 **terminated**，它的 verdict 绑在一个已死的 session 上，且它的 E2E
harness **没有提交进仓库**（无法复现）。因此本轮**不继承**上一轮结论，全部自己重跑，
并**补上了上一轮明确未做的真机 Discord E2E**。

两份可复现 harness 已随本次提交入库（上一轮缺的就是这个）：
- `scripts/qa-fly-1255-display-chain-e2e.mjs` — 对已编译 dist 跑完整显示链
- `scripts/qa-fly-1255-real-discord-e2e.mjs` — 真 Discord 写入 + 读回

## 0. 这个 bug 到底存不存在（before 证据）

不靠描述，直接对 dist 跑旧路径的判据。旧标题路径**只认** `modelShortCode()`
（F/O/S/H），每个调用点传 `modelShortCode(runner_model) ?? null`，而 `null` = **清除
marker**：

| model | 旧 `modelShortCode` | 旧标题 marker |
|---|---|---|
| `gpt-5.6-sol` | `undefined` | **（无）← 就是这个 bug** |
| `kimi-for-coding` | `undefined` | **（无）** |
| `gemini-3-pro` | `undefined` | **（无）** |
| `claude-fable-5` | `F` | `[F]` |

即 Annie 说的「绑死 Anthropic」：非 Anthropic 后端**一个模型名都不显示**。
这同时证明本轮的断言**不是空过**——旧代码确实会让它们全红。

## 1. 真机 Discord E2E（上一轮明确未做，本轮补上）✅

`ChatThreadCreator` 标题写入路径不碰 StateStore → 空 stub 即可，**无需重启任何
Bridge**。走**生产**写入路径（合流 writer + 429 Retry-After），打隔离 529 房
（slot 1 `cos-test`），**ground truth = 从 Discord API `GET /channels/<id>` 读回
`.name`**，不信 writer 自报。

**4/4 PASS** — Discord 实际存下来的标题：

| 场景 | Discord 读回的真实标题 |
|---|---|
| Codex `gpt-5.6-sol` | `🔨实现 [Model GPT-5.6] [FLY-1255] vendor-neutral model display` |
| Kimi `kimi-for-coding` | `🧪QA [Model kimi-for-coding] [FLY-1255] kimi runner` |
| Claude `claude-fable-5`（兼容） | `🎨设计 [F] [FLY-1255] claude runner` |
| model 缺失（legacy 字节兼容） | `🎨设计 [FLY-1255] legacy runner` |

每场景一条新线程（Discord 硬限 2 改名/10min/线程），跑完已 archive。
**这就是 Annie 会看到的那一行——真的显示 GPT-5.6 了。**

## 2. 显示链 E2E（对已编译 dist，非 mock）✅ 36/36

`dispatch {vendor,model}` → `renderRunnerModelDisplay` → `sessionModelDisplay` →
`applyModelMarker`（标题）/ `runnerDisplayName` + `buildWindowLabel` +
**`sanitizeTmuxName`**（cmux 窗口名）。

覆盖：Codex/Kimi/Claude/model-absent、缺 backend metadata **不谎称 claude**
（`adapter_type` 缺失 + gpt model → `codex-GPT-5-6`）、vendor/model 冲突不伪造 Claude
档位、pending phase 走计划 dispatch + 两个 kill-switch 分支、marker 注入拒绝
（`Model bad]value` / `[evil]` / 裸 `GPT-5.6` 均拒）、**重复 stamp 幂等不叠加**、
换模型替换而非追加、legacy `·F` 尾缀迁移到前置 marker、opaque id 截到 24 仍能
round-trip、shell/path 元字符被清洗。

> 修正记录（诚实留痕）：本 harness 首版有 4 条断言是**我自己写错了**，不是产品 bug——
> ① 窗口名 `.`→`-` 是 tmux 合法化的**有意**行为（`codex-GPT-5-6` 正确）；
> ② `buildWindowLabel` **故意**不做 sanitize（注释写明由 adapter 收口），50 字上限在
> `sanitizeTmuxName`，我漏了这一步 → 已补进链路；③ heavy 档 = `claude-fable-5` = `F`
> （我错记成 `O`）。修正后 36/36。

## 3. cmux 清理安全门（真生产函数，非重写）✅

从 `scripts/flywheel-cmux-sync.sh` **原样抽出** `is_managed_runner_title`，喂进第 2 项
真实产出的窗口名：

| 窗口名（dist 真实产出） | 判定 |
|---|---|
| `FLY-1255-implement-codex-GPT-5-6-Fix-a-deliberatel` | MANAGED ✅ |
| `FLY-9-runner-kimi-kimi-for-coding-Fix-a-deliberate` | MANAGED ✅ |
| `FLY-1-claude-Fix-a-deliberately-long-founder-visib` | MANAGED ✅ |

反向哨兵全部 NOT-MANAGED（正确，绝不能被误杀）：`FLY-293-codex-foo`、`gemini`、
`kimi-x`、`agy-x`、`runnerX-codex-x`、Lead 窗、用户自开 tab。
新 namespace 没有破坏清理契约，也没有扩大 kill 半径。

> 过程留痕：第一次抽函数时 BSD `sed` 报错、函数根本没加载，脚本却照常打出一片
> "NOT-MANAGED" —— 差点被读成回归。改用 `awk` 抽取、并加 `type` 断言函数确实存在后重跑。
> **空/失败的输出不是结论。**

## 4. 测试 / 门禁（本轮自己跑）

| 项 | 结果 |
|---|---|
| `flywheel-config` `model-display.test.ts` | 11 passed |
| `flywheel-core` `tmux-naming.test.ts` | 19 passed |
| `flywheel-teamlead` FLY-1255 触碰的 11 个文件（`--no-file-parallelism`） | **309 passed** |
| `scripts/test-cmux-sync.sh`（须 `/bin/bash` 3.2） | **351 passed, 0 failed** |
| `pnpm build` | exit 0 |
| `tsc --noEmit`（config + teamlead） | exit 0 / exit 0 |
| `pnpm lint`（committed HEAD） | **exit 0** |
| CI @ `bd34ebec3` | Build & Test SUCCESS |
| API 改名残留 `modelMarkerCode` | grep = 0（无遗漏调用点） |

`98de68deb..bd34ebec3` 只动 `qa-report.md`（docs-only）→ 上一轮验的代码 = 当前 head 的代码。

> 留痕：`pnpm lint` 一度红，查明是**我新加的两个 harness** 的 import 排序/格式，
> 与被测 PR 无关——移走我的文件后 baseline lint exit=0。已 `biome check --write` 修好
> 自己的文件，全仓 lint 回到 exit 0。**没有去改 PR 的代码来凑绿。**

## 5. 需求对照

| 交付项 | 证据 |
|---|---|
| 标题/窗口模型名对任意厂商正确显示 | 真 Discord 读回 `[Model GPT-5.6]` / `[Model kimi-for-coding]`（§1） |
| 回归：codex 后端 runner 标题带 GPT-5.6 | §1 + §2；对照 §0 旧路径为「无 marker」 |
| Kimi 不被 Claude 逻辑吞掉 | §1 真机 + §2 dist |
| 从 dispatch 计划统一取 {vendor, model}，非 Anthropic-only 运行时读 | `sessionModelDisplay` 优先级 actual→phase-plan→dispatch；pending 分支实测（§2） |
| Claude 兼容边界不回归 | `[F]` 真机不变；model-absent 窗口仍 `claude`、标题无 marker（§1/§2） |
| cmux 清理仍安全 | §3 真生产 gate |
| 无 runtime sniff / schema 变更 | diff 无 adapter CLI 解析、无 StateStore 迁移 |

## 6. 边界与已知限制（诚实记录，均不阻塞）

1. **tmux 50 字上限可能吃掉超长 opaque model 名**（实测边界）：
   `LEARN-1234` + `implement` + `some-extremely-long-opaque-model-id-v2`
   → `LEARN-1234-implement-weird-some-extremely-long-opa`，model 尾部被截。
   评估：**不阻塞** —— (a) 50 字上限是 `sanitizeTmuxName` **既有**行为，非本票引入；
   (b) 真实在用的 model 全部安全（`GPT-5.6` 7 字、`kimi-for-coding` 15 字、Claude 走短码）；
   (c) 降级是优雅的，vendor family 仍在前面可见；(d) 修复前这里**只显示 `claude`、
   连模型都没有**，最坏情况仍严格优于现状；(e) founder 主surface 是 Discord 标题
   （100 字预算，不受影响）。
2. **标题 marker 理论上可被 slice 切断**：`composeThreadTitle` 改为先拼 marker 再切，
   需 `prefix.length + marker.length > 100` 才会切进 marker。实际 prefix 是 stage badge
   （≤4 字），marker ≤24 字 → **不可达**。记录备查。
3. 未跑生产 Bridge 重启后的活体派发：display-only、无 schema/迁移，随下次自然重启生效；
   §1 已在**真 Discord** 上验过 founder 可见字符串，覆盖了这一层的真实集成面。

## 判定

**PASS** — Annie 报的问题（非 Anthropic 后端不显示模型名）在**真 Discord 线程标题上
确认修复**；Claude 兼容与 cmux 安全门守住；scope 未越界（display-only）。
