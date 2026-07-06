# FLY-755 模型缩写挪到 thread 名最前 — 探索

Issue: FLY-755 (https://linear.app/geoforge3d/issue/FLY-755/728-followup-模型缩写挪到-thread-名最前-规划-f-fly-xx-标题现在缀在末尾根本看不见)
日期: 2026-07-01
基于: 无

## 问题

FLY-728 Part D 把模型缩写（F/O/S/H）盖成 thread 标题**尾部后缀**（` ·F`）：

```
🧠规划 [FLY-751] [infra] Runner memory footprint … ·F
```

Annie 反馈（2026-07-01，#flywheel-product，带截图）：手机上标题被截断，末尾缩写永远看不到。要求改成放在最前面、status 之后：

```
🧠规划 [F] [FLY-754] <标题>
```

## 现状审计（代码事实）

模型缩写的**全部**标题逻辑集中在两个文件，callers 只传 `modelCode` 不碰格式：

### 1. `packages/teamlead/src/bridge/stage-utils.ts`（格式定义）

- `MODEL_SUFFIX_SEP = " ·"` / `MODEL_SUFFIX_RE = / ·[FOSH]$/`
- `stripModelSuffix(base)` — 剥尾部 ` ·F`
- `modelSuffixCode(base)` — 从尾部提取 code
- `applyModelSuffix(base, code)` — 追加尾部后缀（**只有测试在用**，无生产 caller）

### 2. `packages/teamlead/src/bridge/ChatThreadCreator.ts`（两个盖章路径）

- **路径 ①（dispatch 时命名）**：`ensureChatThread` / `maybeBackfillThreadName` → `composeThreadTitle("", buildIssueThreadName(ctx), ctx.modelCode)` → 现产出 `[FLY-XX] Title ·F`
- **路径 ②（FLY-560 stage 重盖）**：`writeTitleOnce` → `splitStatusEmoji` 剥 stage badge → `stripModelSuffix` 剥尾部 code → tri-state `effectiveCode`（set / clear(null) / preserve(absent)）→ `composeThreadTitle(badge + " ", base, effectiveCode)` 重组
- `composeThreadTitle(prefix, base, modelCode)` — 100 字符预算，现把 code 放尾部并为其保留空间（长标题中间截断保尾巴——挪到前面后这个特殊处理就不需要了）

### Callers（契约不变，零改动）

`event-route.ts:436`、`HeartbeatService.ts:1165`、`DirectEventSink.ts:190`、`auto-qa-effects.ts:351` 都只传 `modelCode: modelShortCode(session.runner_model) ?? null`。code 定义在 `packages/config/src/model-tiers.ts`（`modelShortCode`），不动。

## 方案（唯一合理解，无多方案取舍）

标题格式改为：`<stage badge> [F] [FLY-XX] <标题>`，模型 marker 变成 base 前的 `[F] ` 段。

### stage-utils.ts

把尾部后缀 helpers 替换为前置 marker helpers（旧函数无生产 caller，直接改名换语义）：

- `stripModelMarker(base)` — 剥**前置** `[F] ` marker，**同时**剥 legacy 尾部 ` ·F`（存量迁移用）。幂等。
- `modelMarkerCode(base)` — 先看前置 marker，fallback legacy 尾部后缀（存量 thread 在 preserve 场景下 code 不丢）。
- `applyModelMarker(base, code)` — 剥净后前置 `[${code}] `；`undefined` → 无 marker（未知模型不加空括号，维持现状）。

前置 marker 正则：`/^\[([FOSH])\] /` —— 单字母方括号不可能撞 Linear issue key（`[A-Z]+-\d+` 必带横杠数字）。

### ChatThreadCreator.ts

- `composeThreadTitle(prefix, base, modelCode)` — marker 插在 prefix 和 base 之间：`${prefix}[F] ${base截断}`。截断预算扣除 prefix + marker 长度；code 在前面天然不会被截掉，原"中间截断保尾巴"逻辑简化为普通尾部截断。
- `writeTitleOnce` — `stripModelSuffix`→`stripModelMarker`，`modelSuffixCode`→`modelMarkerCode`。tri-state 语义逐字保留（set / clear / preserve）。
- 创建/backfill 路径自动继承新格式（同一 `composeThreadTitle`）。

### 存量迁移

旧 thread（`… ·F` 尾巴）下次 stage 重盖时：`stripModelMarker` 剥掉尾巴 → `effectiveCode` 从 session（或 legacy 尾巴 preserve）拿到 code → 重组为 `<badge> [F] [FLY-XX] …`。自然迁移，不主动全量重命名（符合 issue 要求）。

## 覆盖 issue 的四条要求

| 要求 | 方案落点 |
|------|---------|
| ① dispatch 命名 + ② stage 重盖两路径 | 共用 `composeThreadTitle`，重盖 preserve/replay 前置位 |
| F/O/S/H 同规则 | 正则字符类 `[FOSH]`，`modelShortCode` 不动 |
| 未知模型不加空括号 | `code === undefined` → 无 marker（现有 tri-state 不动） |
| 存量 thread 自然迁移 | `stripModelMarker` 兼剥 legacy 尾巴，重盖即迁移 |

## 测试面

- `stage-status-emoji.test.ts` — marker helpers 单测改造（幂等 / 换 code / legacy 迁移 / undefined 清除）
- `ChatThreadCreator.test.ts` + `event-route.stage-emoji.test.ts` + `auto-qa-effects.test.ts` — 断言标题从 `… ·F` 改为 `[F] …` 前置形态
- 新增：legacy `… ·F` 标题重盖后迁移到前置格式；长标题截断不吃掉 marker

## 风险

- 低。格式纯前端展示，无持久化 schema、无 API 变化；Discord rename 预算不变（marker 仍搭 stage 重盖同一次 rename）。
- 唯一理论边界：无 issue key 的裸标题本身以 `[F] ` 开头会被误认成 marker —— 实际 base 恒以 `[FLY-XX]` 开头，可忽略（design review 可再权衡是否收紧成 `[F] [` 双括号匹配）。
