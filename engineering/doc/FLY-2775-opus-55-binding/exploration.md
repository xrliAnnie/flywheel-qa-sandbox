# FLY-2775 Opus 线切到 Opus 5.5 — 探索

Issue: FLY-2775 (https://linear.app/geoforge3d/issue/FLY-2775/模型opus-线-opus-线切到-opus-55claude-opus-5-5-已于-2026-09-22-1007-pt)
日期: 2026-09-22
基于: 无

## 1. 要解决的问题

`claude-opus-5-5` 已于 2026-09-22 10:07 PT 对本账号开通,服务端 `opus` 别名也已指向 5.5。
按 FLY-2766 定的规矩「按产品线绑定,各随自己最新版」,Opus 线应当从 Opus 5 抬到 Opus 5.5:
**新起的体用 5.5,在飞的体不换**。

founder 2026-09-22 10:21 PT 已拍板起单。

## 2. 现状(2026-09-22 实测,不是转述)

### 2.1 代码侧

`packages/config/src/model-builtins.ts` 是唯一的身份/绑定权威:

- `MODEL_IDS.OPUS_5 = "claude-opus-5"`、`OPUS_5_1M = "claude-opus-5[1m]"`
- `DEFAULT_OPUS_BINDINGS = { opus: OPUS_5, opus1m: OPUS_5_1M }`
- `BUILTIN_MODEL_TIERS.medium/light/trivial = { id: OPUS_5, aliases: ["opus"] }`(heavy = Fable)
- `OPUS_IDENTITIES = [OPUS_5, OPUS_5_1M, OPUS_48, OPUS_48_1M]` —— `buildModelRegistry()` 用
  `bindings` 过滤:被绑的那两个走 `bound()`(带 `opus` / `opus-1m` 别名 + `dispatch` 面),
  没被绑的走 `legacy()`(`selectableSurfaces: []`,**且没有 `dispatch` 面**)。

FLY-1467 已经把「身份」和「绑定」拆开了,所以本次升级**结构上就是改绑定 + 加一组身份常量**,
不需要动工厂逻辑。这是 FLY-1467 明写的设计意图(`DEFAULT_OPUS` / `DEFAULT_OPUS_1M` 是
「升级/回滚唯一开关」)。

### 2.2 工作流菜单已经是别名,不用改

`.flywheel/agents/registry.yaml`(仓内,菜单权威)里所有 Opus 节点写的是 **别名 `opus`**,
不是全名。`workflow-menu.ts:resolveAlias()` 在 **请求时** 把别名解析成当前绑定的 id,
`receipts[node].model = `${alias} (= ${resolved})`` —— 这正是验收判据 1 要看的那个字段。

⇒ 任务描述第 3 条「工作流模板里凡钉 `claude-opus-5` 的节点改为读 `bindings.opus`」在**仓内已成立**,
无需代码改动。

### 2.3 但 DB 里已发布的模板 manifest 钉的是全名

`~/.flywheel/teamlead.db` `workflow_template_revision` 最新修订(只读句柄实查,2026-09-22):

| template | 节点 → model |
|---|---|
| tpl_code rev14 | eng_design:fable · implement:gpt-5.6-sol · **qa:claude-opus-5** |
| tpl_design rev9 | **product_design:claude-opus-5** |
| tpl_eng_heavy rev5 | design:claude-fable-5 · implement:gpt-5.6-sol · **qa:claude-opus-5[1m]** |
| tpl_generic_menu rev8 | **general:claude-opus-5** |
| tpl_prd rev9 | **pm:claude-opus-5** |
| tpl_prototype rev9 | **proto:claude-opus-5** |
| tpl_simple_code rev6 | implement:gpt-5.6-sol · **qa:claude-opus-5** |

原因:`compileWorkflowMenuSeed()` 在 **seed 编译期** 把 `opus` 解析成当时的绑定值再写进 manifest。
所以这些全名是**派生产物**,不是人手钉的;绑定一翻、seed 重算,`contentHash` 变化即重新 import。
⇒ 这一层是**运行时数据**,靠重新 seed 收敛,不是仓内改动。

### 2.4 生产 models.json 会盖掉代码默认值

`~/.flywheel/models.json` 现有 `bindings.opus = "claude-opus-5"`、`tiers.medium/light/trivial =
"claude-opus-5"`。`createSnapshot()` 里 models.json 覆盖层**优先于**内建默认。
⇒ 只改代码不改该文件,生产仍然跑 Opus 5。该文件在主机、不在仓库,只能写进 PR 部署说明。

## 3. 两个硬发现(它们决定了这单的形状)

### 3.1 🔴 CLI 2.1.278 用全名钉 5.5 会硬失败

本机实测(2026-09-22):

```
npx -y @anthropic-ai/claude-code@2.1.280 -p --model claude-opus-5-5      → claude-opus-5-5
npx -y @anthropic-ai/claude-code@2.1.280 -p --model 'claude-opus-5-5[1m]'→ claude-opus-5-5[1m]
npx -y @anthropic-ai/claude-code@2.1.278 -p --model claude-opus-5-5      → API Error: 400
    "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required."
npx -y @anthropic-ai/claude-code@2.1.280 -p --model claude-opus-9-9      → unrecognized_model(阴性对照)
```

founder 观察到的「2.1.278 `--model opus` 已回 claude-opus-5-5」是**服务端别名**在漂,
跟**客户端能不能认全名**是两件事。Flywheel 的 registry 派工时下发的是**全名**
(manifest `nodes[].model` = 解析后的 id),所以:

> **凡是 `claude` 二进制还停在 ≤2.1.279 的载体,绑定一翻,新起的 Claude runner 全部 400。**

本机 `claude --version` = 2.1.280,runner 走 PATH 上这一个二进制,所以现在满足条件;
但这必须作为**部署前置条件**写死在 PR 里,且回滚手段要留。

### 3.2 🔴 旧 id 会掉出 dispatch 白名单

`model-config.ts:buildDispatchLookupForRegistry()` 只对**带 `dispatch` 面的条目**登记
id + 别名,然后硬编码补上一组 legacy id:

```ts
for (const id of [MODEL_IDS.OPUS_48, MODEL_IDS.OPUS_48_1M, ...LEGACY_FABLE_MODEL_IDS]) ...
```

`claude-opus-5` 现在之所以在白名单里,**只是因为它是被绑的那个**(走 `bound()` 带 dispatch 面)。
绑定翻到 5.5 之后它降级成 `legacy()` 条目 —— 没有 dispatch 面,也不在上面那串硬编码里
⇒ **`claude-opus-5` 会变成 `INVALID_MODEL`**,历史 pin / 在飞快照 / 回滚全部失效。

这直接违反验收判据 4。FLY-1467 当初把 4.8 加进那串硬编码,就是为了这件事;本次必须同样对待 5。

## 4. 其它受影响面(实查)

| 位置 | 现状 | 处置 |
|---|---|---|
| `packages/token-usage/src/pricing.ts` | `MODEL_RATES` 无 `claude-opus-5-5` 键;未知模型 → **$0 + 一次 warn** | 必须加,否则 Opus 成本报表整条归零 |
| `packages/token-usage/src/report/render-html.ts` | `MODEL_LABEL` / `MODEL_COLOR` 无 5.5 | 加(缺了只是 label 退化成 raw id,不致命) |
| `packages/teamlead/lead-rules-base/model-routing.md` | 三行难度表写死「Opus 5」 | 改成产品线措辞(对齐 Fable 行的「Current Fable family」),免得下次再陈旧 |
| `fleet/example/models.json` | 示例文件钉 `claude-opus-5` | 同步,否则示例在教人写一个已降级的绑定 |
| `.flywheel/config.yaml:37` | 注释「QA row remains the only Opus 5 default」 | 注释,顺手改措辞 |
| `.flywheel/agents/registry.yaml` | 全是别名 `opus` | **不动** |
| `packages/teamlead/src/account-heal/fable-model-sync.ts` | 只管 Fable 线 | **不动** |
| Codex / Astra / Lead 载体 | 与 Opus 线无关(Lead 是 Fable) | **不动** |

## 5. 在飞不换体 —— 机制在哪

在飞 run 的模型不是每步重解析的。`teamlead.db` `workflow_run.snapshot` 里冻的是
**解析后的全名**,只读句柄实查(2026-09-22):

```json
{"id":"implement", ... ,"dispatchPinned":true,
 "dispatch":{"vendor":"claude","model":"claude-opus-5","effort":"high"}}
```

(取自 run `53ab3f14-8bc0-4806-95a1-80686f4ea7a1` = FLY-2775 本单自己的 run,tpl_simple_code rev6。)

`dispatchPinned: true` + 全名冻结 ⇒ 绑定翻到 5.5 之后,**已存在的 run 仍然拿
`claude-opus-5`**。这是既有机制,本单不新增任何东西 —— 但它正是 §3.2 必须保住
`claude-opus-5` dispatch 合法性的**第一现场理由**:在飞 run 后续节点派工时,
拿去过白名单的就是快照里这个全名。判据 2 用这条快照实证。

## 6. 待定/未知

1. **额度桶**:5.5 与 5 是否共用同一周桶 —— 未知,官方 models 文档页此刻还没列 5.5。
   这不阻塞实现;QA 判据 3 要求能探就写明。
2. **1M 变体**:已实测 `claude-opus-5-5[1m]` 在 2.1.280 上被接受 ⇒ 按与 Opus 5 同样的方式加。
3. **上下文窗口**:`TRUSTED_CONTEXT_WINDOWS` 需要给 5.5 一个值。Opus 5 是 200k / 1M。
   5.5 未独立证实,但 2.1.280 的阴性对照文案说明「未知模型才退回 200k 假设」,
   而 5.5 是**被 catalog 认识的**,且 `[1m]` 被接受 ⇒ 按 Opus 5 同构登记 200k / 1M。
