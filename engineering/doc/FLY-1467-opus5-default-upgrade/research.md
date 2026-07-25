# FLY-1467 默认 opus 档 fleet-wide 升级到 Opus 5 — 调研

Issue: FLY-1467 (https://linear.app/geoforge3d/issue/FLY-1467/infra-把默认-opus-档升级到-opus-5fleet-wide-注册表加-claude-opus-5-repoint-opus)
日期: 2026-07-24
基于: exploration.md

## 1. 解析链路怎么走(核对源码,非猜测)

### 1.1 `opus` alias / medium 档 → model id

```
model-registry.ts:
  MODEL_IDS.OPUS = "claude-opus-4-8"
  claudeEntry({ id: MODEL_IDS.OPUS, label:"Opus 4.8", aliases:["opus"], dispatch:true })
  → MODEL_REGISTRY 条目;MODEL_LOOKUP 把 "claude-opus-4-8" 和 "opus" 都指向它

model-tiers.ts:
  MODEL_TIERS.medium = { id: MODEL_IDS.OPUS, aliases:["opus"], code:"O" }
  DISPATCH_MODEL_LOOKUP 由 MODEL_TIERS + ONE_M_DISPATCH_MODELS 构建
  normalizeDispatchModel(raw) = DISPATCH_MODEL_LOOKUP.get(key) ?? null
```

改 `MODEL_IDS.OPUS` 的**值** → medium 档 id、`opus` alias 解析、fleet console tier options(`buildModelCatalog`)、三段式 QA 阶段(`three-stage-phases.ts:188` 用 `MODEL_TIERS.medium.id`)**全部自动跟随**。这是"改一个常量、fleet-wide 生效"的核心机制。

### 1.2 短码 `O` 不变(issue 要求)

`modelShortCode` 用 `m.startsWith("claude-opus")` → `claude-opus-4-8` 和 `claude-opus-5` 都返回 `O`。`SHORT_CODE_DISPLAY_NAME.O = "Opus"`。所以 thread 短码/显示名不需要改,升级后仍是 `O`/"Opus"。✅

### 1.3 五条互不相同的校验边界(**初版把它们混为一谈,已更正**)

> ⚠️ 初版标题是「`/api/runs/start` + ConfigLoader 校验(破坏点在这)」,并称 ConfigLoader 用 `normalizeDispatchModel` 校验 runner roles —— **错**。逐条取证后的真实边界:

| 边界 | 校验方式 |
|---|---|
| `/api/runs/start` 的 `model` 参数 | **确实**走 `normalizeDispatchModel`,不认识就 `INVALID_MODEL` |
| `projects[].leads[].model`(Lead) | `ProjectConfig`,**只查非空 + 控制字符**("Deliberately NOT normalized") |
| `.flywheel/config.yaml` 的 `roles.*.model`(runner) | `ConfigLoader`,**只做非空 + trim** |
| **workflow manifest / seed model** | **`getModelRegistryEntry` + `workflow` surface(`isModelSelectionSupported`),不走 `DISPATCH_MODEL_LOOKUP`**(R2 抓到) |
| `xiaohongshu_learning.collections[].model` | ConfigLoader 里**唯一**调 `normalizeDispatchModel` 之处(`:660-670`) |

**含义:** `normalizeDispatchModel` 只接受 `MODEL_TIERS` 的 id/alias + `ONE_M_DISPATCH_MODELS` 的键。repoint 后:
- `opus` → `claude-opus-5` ✅
- `claude-opus-5`(= 新 medium.id)→ ✅ 被接受
- `claude-opus-4-8` / `claude-opus-4-8[1m]`(旧字面量)→ 除非显式保留,否则不再被 **`normalizeDispatchModel`** 接受。~~→ pin 它们的 config load fail~~ **(作废:只影响上表第 1、5 行两条边界;Lead / runner-roles / workflow 三条各走各的路,不会 config load fail。)**

### 1.4 label 路径(runner-label.ts)

`runner-label.ts:91` 的 `if (labels.includes("opus-1m")) return "claude-opus-4-8[1m]"` 是**硬编码字面量**,直接作为 `--model` 传给 CLI(不过 `normalizeDispatchModel`)。这条:
- CLI 层面 `claude-opus-4-8[1m]` 仍能跑(阳性对照证);但**语义上没升级** —— `opus-1m` 标签仍拿 4-8。
- 若升 1M,应改为 `MODEL_IDS.OPUS_1M` 引用(消除硬编码漂移),或直接改字面量。

## 2. Flywheel 不直接调 Messages API —— 本单纯粹是"传哪个 --model 字符串"

runner/lead 都是 `claude --model <string>`(claude-tmux adapter)。Opus 5 的 API 层新行为(thinking on-by-default、effort 门控、512-token cache min、独立 rate-limit 桶、cyber safeguards、fast-mode)**由 Claude Code CLI 自己处理**,Flywheel 侧无需任何 API 调用代码改动。本单 = 改注册表里 `opus` 档指向的字符串。

## 3. Opus 5 事实核对(Anthropic 官方 catalog,经 `claude-api` skill)

| 项 | 值 | 来源 |
|---|---|---|
| model id | `claude-opus-5`(无日期后缀) | models 表 |
| input | $5.00 / MTok | Current Models 表 |
| output | $25.00 / MTok | 同上 |
| 相对 4.8 | **"a drop-in upgrade at Opus 4.8's pricing … same feature set"** | migration guide |
| context | 1M(default 且 max) | models 表 |
| 独立 rate-limit 桶 | 不与 Opus 4.x 合并计 | migration guide(运维注意,不影响本单代码) |

**pricing.ts 的 Opus 5 行 = 与现有 Opus 4.8 行逐字相同:** `{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }`。理由:官方明确 Opus 5 = Opus 4.8 同价;`cacheRead 0.5 = 0.1×input`、`cacheWrite 6.25 = 1.25×input` 是标准 5min-TTL cache 倍率,与 4.8 行一致。**这不是猜测**,是官方"同价"+ 标准倍率推出的确定值。

## 4. 生效面 / 部署机制(核对,供 plan 用)

| 消费点 | 何时读注册表 | 生效条件 |
|---|---|---|
| dispatch 校验 / medium 档解析 | Bridge 进程内(runs-route/ConfigLoader) | Bridge 重启(或新 dispatch 用新 dist) |
| runner spawn `--model` | `Blueprint.readAgentFile` / resolver 在 spawn 时现读 | 新 runner spawn 即生效(dist 已 build) |
| 三段式 QA 阶段模型 | phase dispatch 时读 `MODEL_TIERS.medium.id` | 同 runner spawn |
| fleet console tier options | Bridge 起时 `buildModelCatalog` | Bridge 重启 |
| Lead 自己的模型 | 由 `leads[].model` / `FLYWHEEL_LEAD_MODEL` launchd env 定(FLY-241/247),经 **`ProjectConfig`**(非 ConfigLoader)只查非空+控制字符 | Lead launchd bootout/bootstrap;pin `opus` alias → 重启后升 opus-5;**pin `claude-opus-4-8` 字面量 → 不报错,静默停在 4.8(必须迁移才升)** |

**部署 = 独立的 founder-gated ship 步骤**(build dist + restart-services / 分离式 self-ship handoff)。不在本设计节点范围;plan 里列为交接清单。

## 5. 迁移风险汇总(决定 plan 的设计选择)

1. **活的 `~/.flywheel/projects.json` 有 9 处 `claude-opus-4-8[1m]`**(实测)—— 运行时配置,PR 改不到。
   > **⚠️ 更正(Codex R1 顶回 + 源码取证)**:本条初版写作「9 个 **runner 角色** → Bridge 启动校验失败」是**错的**。真实路径是 `projects[i].leads[j].model`(**Lead 模型**),走 `loadProjects` → `ProjectConfig.parseAndValidateProjects`,**只查非空 + 控制字符,不调 `normalizeDispatchModel`**(源码注释原文 "Deliberately NOT normalized")。**真实影响 = 9 个 Lead 静默漏升(不报错、继续跑 4.8),不是启动失败。** 迁移仍必做,理由改为**防漏**,归类为 **Lead fleet 迁移**。详见 exploration §3.3 更正块。
2. **repo 内 config/seed pin**(初版记 6 处,**R2 审计后实为 9 处** —— 漏了 3 个 `*_land_v1` seed 与 `lead-rules-base/model-routing.md`)—— 可在 PR 内改。**完整清单以 plan §2-H 为准。**
3. **回滚需求** —— Opus 5 若出问题,要能快速回 4-8。

→ **plan 采用身份/绑定分离设计**(plan §1):4 个固定 ID 永不改值 + 两个 `DEFAULT_*` binding 决定 `opus`/`opus-1m` 指向谁。~~规避 #1 的破坏窗口~~ **(作废:#1 不存在破坏窗口,是静默漏升)**;真正目的是 ① 旧 pin 在各自边界仍被接受 ② 回滚不会撞 registry 重复 id。deploy 清单把活 projects.json 的 9 个 Lead pin 迁到 `claude-opus-5[1m]`,理由是**让它们真正吃到升级**(防漏)。详见 plan.md。
