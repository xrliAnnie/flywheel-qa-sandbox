# FLY-755 模型缩写挪到 thread 名最前 — 调研

Issue: FLY-755 (https://linear.app/geoforge3d/issue/FLY-755/728-followup-模型缩写挪到-thread-名最前-规划-f-fly-xx-标题现在缀在末尾根本看不见)
日期: 2026-07-01
基于: exploration.md

## 调研范围

确认改动的精确落点、每个盖章路径的数据流、现有测试断言清单、以及 brainstorm gate 上 Lead 补充的误剥/误插边界。

## 1. 标题格式逻辑的完整分布（grep 实证）

模型缩写格式的定义与使用**只存在于** `packages/teamlead/src/bridge/` 下两个文件；其余全部 caller 只传 `modelCode` 值：

| 位置 | 角色 | FLY-755 改动 |
|------|------|-------------|
| `stage-utils.ts:265-292` | `MODEL_SUFFIX_SEP/_RE` + `stripModelSuffix`/`modelSuffixCode`/`applyModelSuffix` | 换成前置 marker helpers |
| `ChatThreadCreator.ts:149-158` | `composeThreadTitle(prefix, base, modelCode)` — 尾部拼接 + 预算 | marker 移到 prefix 之后 |
| `ChatThreadCreator.ts:266`（创建）/ `:923`（backfill） | 路径①: dispatch 时命名 | 共用 compose，自动继承 |
| `ChatThreadCreator.ts:565-589`（writeTitleOnce） | 路径②: FLY-560 stage 重盖 + tri-state | strip/extract 换 marker 版 |
| `event-route.ts:436` / `HeartbeatService.ts:1165` / `DirectEventSink.ts:190` / `auto-qa-effects.ts:351` | callers: `modelCode: modelShortCode(session.runner_model) ?? null` | **零改动** |
| `packages/config/src/model-tiers.ts:76`（`modelShortCode`） | model id → F/O/S/H 映射 | **零改动** |
| `dashboard-html.ts:309` | dashboard 显示 raw `runner_model` | 与标题无关，零改动 |

`applyModelSuffix` 无生产 caller（仅 `stage-status-emoji.test.ts` 使用）——改名换语义安全。

## 2. writeTitleOnce 数据流（路径②，重盖时保 [F] 的关键）

```
GET thread name
→ splitStatusEmoji(currentName).base        # 剥 stage badge（不动）
→ stripModelSuffix(rawBase) → bareBase      # 【改】stripModelMarker: 剥前置 [F] + legacy 尾部 ·F
→ effectiveCode:                            # tri-state（语义不动）
    ctx.modelCode === undefined → modelSuffixCode(rawBase)  # 【改】modelMarkerCode: 前置优先, legacy 尾部 fallback
    ctx.modelCode = "F".."H"    → set
    ctx.modelCode = null        → clear
→ isPlaceholderThreadName(bareBase)         # 用 marker-free base 判断（不动）
→ composeThreadTitle(badge+" ", base, effectiveCode)  # 【改】marker 插 prefix 后
→ no-op skip / PATCH
```

关键点：`[F]` 的"保留/重放"由 tri-state 天然给出——重盖 caller 都带 session（set/clear），无 session 的防御路径走 preserve（从旧标题提取，前置或 legacy 尾部都认）。

## 3. 截断预算变化

现状（728）：`budget = 100 - prefix.length - suffix.length`，base 尾部截断，suffix 拼回尾部（"中间截断保尾巴"）。
新格式：marker 在 prefix 后，`budget = 100 - prefix.length - marker.length`，base 尾部截断。code 在前面**结构上**不可能被截——保尾巴的特殊设计自然消失，无需对应物。

Marker 字面：`[F] `（4 字符）。对比旧 ` ·F`（3 字符），预算差 1 字符，无实际影响（Discord 100 上限，实际标题 ~60-80）。

## 4. 误剥/误插边界（Lead gate 补充要求）

前置 marker 正则候选：`/^\[([FOSH])\] /`（单字母 + `] ` + 空格）。

误匹配分析：
- `[FLY-755] Title` — `FLY-755` 非单字母，**不匹配** ✓
- `[founder-UX] Title` / `[infra] Title` / `[Fable] Title` / `[FIX] Title` — 均非单字母，**不匹配** ✓
- `[F] Title`（标题字面以 `[F] ` 开头且无 issue key）— **会匹配**。触发条件：issue 无 identifier 且原始标题以单字母 FOSH 方括号开头。实践中 base 恒以 `[FLY-XX]` 开头（buildIssueThreadName），此边界只在裸标题场景存在。

收紧选项（design review 定夺）：marker 匹配要求后随 `[`（即 `/^\[([FOSH])\] (?=\[)/`）——marker 永远由我们插在 `[FLY-XX]` 前，`[F] [` 双括号形态更特异。代价：issue 无 identifier 的裸标题上 marker 插入后（`[F] Bare title`）下次重盖剥不掉 → code 重复插入风险。

**结论（Codex design R1 #2 + R2 #1 修正）：收紧，识别与插入锚定同一 bracketed issue-key pattern**——识别用 `/^\[([FOSH])\] (?=\[[A-Z][A-Z0-9]*-\d+\](?:\s|$))/`，插入只在剥净后 base 匹配 `/^\[[A-Z][A-Z0-9]*-\d+\](?:\s|$)/`（`hasIssueKeyHead`，stage-utils 单一导出）时进行。仅锚 `[` 不够（R2 #1）：keyless 标题可以是 `[infra] …`/`[Fable] …`，`[F] [infra] copy` 字面标题会被 `(?=\[)` 误剥。锚 issue key 后：(a) 任何 keyless 标题（含方括号开头）永不被误剥/误插（`modelCode:null` 不会删真标题前缀）；(b) 插过的必以 `[F] [KEY-N]` 形态存在，必可剥，无双盖；(c) keyless 场景 model code 不展示——退化场景，可接受。TDD 用例覆盖 Lead 点名的 `[founder-UX]`/`[infra]`/`[F...]` 形态 + `[F] Founder copy`/`[F] [infra] copy` 字面边界。

## 5. legacy 迁移路径（存量 thread）

`stripModelMarker` 同时剥两种形态：前置 `/^\[([FOSH])\] (?=\[[A-Z][A-Z0-9]*-\d+\](?:\s|$))/`（issue-key 锚定，见 §4 修正）+ legacy 尾部 `/ ·[FOSH]$/`。
`modelMarkerCode` 提取顺序：前置优先 → legacy 尾部 fallback。

存量 `🔨实现中 [FLY-751] Title ·F` 重盖流程：剥 badge → 剥尾部 ·F → effectiveCode=F（session set 或 legacy preserve）→ 重组 `🧪QA [F] [FLY-751] Title`。**一次重盖即迁移**，无需全量重命名。

## 6. 现有测试断言清单（需改造）

| 文件 | 现断言 | 改后 |
|------|--------|------|
| `stage-status-emoji.test.ts:250-295` | `applyModelSuffix`/`stripModelSuffix`/`modelSuffixCode` 尾部形态 | 改为 marker helpers 前置形态 + legacy 迁移 + 误剥边界用例 |
| `ChatThreadCreator.test.ts:515-533` | 重盖后 `"🔨 [FLY-560] … ·F"` | `"🔨 [F] [FLY-560] …"` |
| `ChatThreadCreator.test.ts:537-560` | null 清除尾部 ·F | null 清除前置 [F]（+legacy ·F 也被清） |
| `ChatThreadCreator.test.ts:564-585` | absent 保留尾部 ·F | absent 保留前置 [F]；新增: absent 遇 legacy 尾部 → 迁移到前置 |
| `ChatThreadCreator.test.ts:594-629` | 长标题截断 code 存活于尾部 | code 存活于前部（截断只吃 base 尾巴） |
| `event-route.stage-emoji.test.ts` | stage_changed 端到端标题断言 | 同步改前置形态 |
| `auto-qa-effects.test.ts` | QA thread 标题（`QA · FLY-643 —` 无 code 断言） | 检查是否有 code 断言，有则同步 |

## 7. 结论

方案与 exploration.md 方向一致；design review 补强两点（详见 plan.md）。落点收敛为：
- `stage-utils.ts`：3 个 helper 换语义（strip 兼容 legacy；识别/插入锚定 issue-key，`hasIssueKeyHead` 单一导出）
- `ChatThreadCreator.ts`：`composeThreadTitle` + `writeTitleOnce` + **`maybeBackfillThreadName`**（Codex design R1 #1：placeholder 判定先剥 marker，absent modelCode preserve——生产 caller `tools.ts:807` `/send` 路径）三处
- 测试：2 个单测文件改造 + 端到端断言同步 + Lead 要求的误剥边界用例 + backfill placeholder/迁移用例
