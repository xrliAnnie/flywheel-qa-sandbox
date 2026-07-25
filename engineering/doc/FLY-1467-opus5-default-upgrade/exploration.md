# FLY-1467 默认 opus 档 fleet-wide 升级到 Opus 5 — 探索

Issue: FLY-1467 (https://linear.app/geoforge3d/issue/FLY-1467/infra-把默认-opus-档升级到-opus-5fleet-wide-注册表加-claude-opus-5-repoint-opus)
日期: 2026-07-24
基于: 无

## 1. Annie 的决定(2026-07-24)

Opus 5 出了。Annie 在两个方案里选 **①:把默认 `opus` 档 fleet-wide 直接升级到 Opus 5** —— **不是**加一个 `opus-5` alias 让人手动选,而是让整个 fleet 现在用 `opus`/medium 档的地方全部拿到 Opus 5。

## 2. 硬前提(本次探索已闭环)

> **Step 1(取证):`claude-opus-5` 在我们账号上真能调吗?** 若 API 未 GA / 账号没权限,repoint 会让全 fleet 的 opus 档挂掉。API 拒了就回报,别硬 repoint。

**结论:前提满足,可以 repoint。** 用本机生产 OAuth(runner/lead 实际用的同一套认证)实测:

| 测试 | 命令 | 结果 |
|---|---|---|
| 阳性对照(已知可用) | `claude --model claude-opus-4-8 -p …` | `CTRL_48_OK`,EXIT 0 |
| **决定性测试** | `claude --model claude-opus-5 -p …` | `OPUS5_OK`,EXIT 0 |
| 1M 变体 | `claude --model 'claude-opus-5[1m]' -p …` | `OPUS5_1M_OK`,EXIT 0 |
| 阴性对照(必须失败) | `claude --model claude-opus-99-nonexistent -p …` | `There's an issue with the selected model … may not exist or you may not have access`,无输出 |
| 自证身份(排除静默 fallback) | opus-5 → 报 `claude-opus-5`;opus-4-8 → 报 `claude-opus-4-8` | 两者不同 → **没有静默降级到 4-8** |

取证要点:阴性对照证明 Claude Code CLI 会**校验并对不可用模型报错**(不静默 fallback);opus-5 不报错且自报身份为 `claude-opus-5` → 真实可用。这是 runner/lead 生产路径的忠实测试(它们就是 `claude --model <string>` 这么起的)。

model id 与定价另核 `claude-api` skill(Anthropic 官方 catalog):`claude-opus-5`(无日期后缀),定价 = **Opus 4.8 同价**($5 input / $25 output per MTok)。

## 3. 现状取证(与 issue 描述一致 + 更广)

Flywheel 不直接调 Anthropic Messages API;runner/lead 都是 spawn `claude --model <string>`。所以本单纯粹是**改注册表里 `opus`/OPUS 档解析到哪个 model id 字符串**,不涉及任何 API 调用代码。

### 3.1 单一真相源

- `packages/config/src/model-registry.ts:22-23`
  - `OPUS: "claude-opus-4-8"` — `opus` alias + medium 档解析到 **4.8**
  - `OPUS_1M: "claude-opus-4-8[1m]"` — `opus-1m` opt-in
  - 注册表里**没有** `claude-opus-5`
- `packages/config/src/model-tiers.ts` — `medium` 档 `id: MODEL_IDS.OPUS`,短码 `O`。**自动跟随** OPUS 常量;`modelShortCode` 用 `startsWith("claude-opus")` → 4-8/5 都是 `O`。

### 3.2 issue 只点了 2 个文件,审计发现改动面更广

除 registry + tiers,以下引用 `claude-opus-4-8` 字面量的位置也受影响:

| 文件:行 | 内容 | repoint 后影响 |
|---|---|---|
| `config/src/runner-label.ts:91` | `if (labels.includes("opus-1m")) return "claude-opus-4-8[1m]"` **硬编码字面量** | 若升 1M,须改 → 否则 `opus-1m` 标签仍拿 4-8 |
| `teamlead/src/bridge/claude-review-runner.ts:83` | `DEFAULT_MODEL = "claude-opus-4-8"`(跨族 Claude reviewer) | 独立默认,不跟随 OPUS;fleet-wide 应一并升 |
| `token-usage/src/pricing.ts:35` | `"claude-opus-4-8": {input:5,output:25,cacheRead:0.5,cacheWrite:6.25}` | 缺 `claude-opus-5` 行 → opus-5 session 的 token 成本报告丢失/为零 |
| `token-usage/src/report/render-html.ts:10,19` | `"claude-opus-4-8": "Opus 4.8"` + 颜色 | 缺 opus-5 label/颜色 → 报告显示不出 Opus 5 |
| `config/src/three-stage-phases.ts:12,188` | 注释写 4-8;**`:188` qa 用 `MODEL_TIERS.medium.id`** | qa 阶段**自动跟随** → 三段式 QA 也升 Opus 5(注释要更新) |
| `teamlead/src/bridge/fleet-capabilities.ts:9-14` | 注释描述 Opus 4.8 事实;options 由 `buildModelCatalog` 从 registry 派生 | options **自动跟随**;注释过时须更新 |

### 3.3 关键迁移风险 —— config/seed 里 pin 了 `claude-opus-4-8` 字面量

> **⚠️ 本节初版机制描述已作废(Codex R1/R2 顶回 + 源码取证)。** 初版写的是「`/api/runs/start` 与 ConfigLoader 都用 `normalizeDispatchModel` 校验 `model` 字段,repoint 后旧字面量不再被接受 → 任何 pin 它的 config/seed **load 失败**」。**错**。已核实的真实边界(五条各不相同,见 plan §5):
> - `/api/runs/start model` → **确实**走 `normalizeDispatchModel`。
> - `projects[].leads[].model` → `ProjectConfig`,**只查非空 + 控制字符**(注释 "Deliberately NOT normalized")。
> - `.flywheel/config.yaml roles.*.model` → `ConfigLoader`,**只做非空 + trim**。
> - **workflow manifest / seed model → 走 `getModelRegistryEntry` + `workflow` surface 检查(`isModelSelectionSupported`),不走 `DISPATCH_MODEL_LOOKUP`**(R2 抓到的分叉)。
> - `xiaohongshu_learning.collections[].model` → ConfigLoader 里**唯一**调 `normalizeDispatchModel` 的地方。
>
> 所以下表的意义**不是**「不改就 load 失败」,而是「**不改就静默漏升**」—— 这些是 active default,fleet-wide 升级本就该带上它们。

下列 pin 必须在同一个 PR 里改成 `claude-opus-5`(**完整清单以 plan §2-H 为准**,本表为初版所列,已知漏了 3 个 `*_land_v1` seed 与 `lead-rules-base/model-routing.md`):

| 位置 | 值 | 备注 |
|---|---|---|
| `.flywheel/config.yaml:46` | `claude-opus-4-8[1m]` | **生产 flywheel 项目自己的 runner**(`[1m]` 变体) |
| `workflow-seeds/tpl_eng.yaml:20` | `claude-opus-4-8` | DAG 节点模型 |
| `workflow-seeds/tpl_eng_heavy.yaml:21` | `claude-opus-4-8` | 同上 |
| `workflow-seeds/tpl_eng_light.yaml:20` | `claude-opus-4-8` | 同上 |
| `workflow-seeds/tpl_product_prototype.yaml:20` | `claude-opus-4-8` | 同上 |
| `__tests__/fixtures/fly1262/project-config.yaml:23` | `claude-opus-4-8` | 测试 fixture |

~~否则 config load / DAG dispatch 会 fail-loud。~~ **(作废,见上方更正块:真实后果是静默漏升,不是 fail-loud。)**

**活的运行时配置(不在 repo,无法在 PR 里改):** 生产 `~/.flywheel/projects.json` 有 **9 处** `claude-opus-4-8[1m]` pin(实测 `grep -c` = 9;另有 5 个 `sonnet`)。

> **⚠️ 更正(2026-07-24,Codex R1 顶回 → 我源码取证推翻自己):** 本段初版写的是「9 个 **runner 角色**,经 `ConfigLoader.normalizeDispatchModel` 在 Bridge 启动时校验,不改会 **Bridge 起不来**」——**两处都错**。取证结论:
> - 9 处的真实 JSON 路径全是 **`projects[i].leads[j].model`**(Lead 的模型,**不是 runner 角色**),行 25/38/51/78/200/214/228/302/316。
> - 它们走 `loadProjects` → `parseAndValidateProjects`(`ProjectConfig.ts:608-626`),**只校验非空 + 无控制字符**,注释明写 "Deliberately NOT normalized",**不调 `normalizeDispatchModel`**。`ConfigLoader` 里唯一调它的地方是 `xiaohongshu_learning.collections[].model`。
>
> **真实影响方向相反**:不是响的(Bridge 起不来),是**哑的** —— 这 9 个 Lead 会安静继续跑 Opus 4.8(旧 ID 仍是合法模型串),不报错,只是**吃不到升级**。对主打 fleet-wide 的改动,静默漏升比启动失败更难发现。
> **迁移仍然必须做**,但理由是**防漏**不是防崩,且它属于 **Lead fleet 迁移**(非 runner-role ConfigLoader 迁移)。
> 我当时只验了 grep 数出的「9」,看到 ConfigLoader 里出现过 `normalizeDispatchModel` 就当成它守着这个字段 —— 没验就当事实用。

## 4. 待决设计问题(带推荐)

1. ~~**是否保留 `claude-opus-4-8` 为可 pin 的 registry 条目?** 推荐不保留。~~ **(作废 — 与最终采纳的向后兼容设计矛盾。)** 定稿方案见 plan §1:**保留** 4 个固定 ID 条目(身份与绑定分离),`pricing.ts`/`render-html.ts` 的 4-8 行同样保留。真正待决的是**收窄到哪些 surface**(R2 抓出 `workflow` surface 会把「已发布 revision 仍可跑」和「4.8 可被新选」耦在一起)→ 升为 plan §6.4 待 Annie 决策项。
2. **`opus-1m` 是否升 `claude-opus-5[1m]`?**(issue item #2)`claude-opus-5[1m]` 实测可调。**推荐:升**(fleet-wide = 默认档 + 1M opt-in 一起走 Opus 5),须同步改 `.flywheel/config.yaml:46` 与 `runner-label.ts:91`。Annie 可否决(保 1M 在 4-8)。
3. **review runner `DEFAULT_MODEL` 是否升?** **推荐:升**(reviewer 不应弱于它评审的 fleet 工作),并改为引用 `MODEL_IDS.OPUS` 常量而非字面量,消除未来漂移。
4. **三段式 QA 阶段自动升 Opus 5** —— 这是 `MODEL_TIERS.medium.id` 自动跟随的必然结果。fleet-wide 意图下**符合预期**,但要在知会里点名让 Annie 知道 QA 阶段也变了。

## 5. 下一步

见 research.md(机制核对)与 plan.md(逐文件改动 + 部署 + 回滚)。部署走 restart-services / 分离式 self-ship handoff,是**独立的 founder-gated ship 步骤**,不在本设计节点范围内。
