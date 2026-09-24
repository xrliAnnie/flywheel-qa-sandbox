# FLY-2775 Opus 线切到 Opus 5.5 — 实施计划

Issue: FLY-2775 (https://linear.app/geoforge3d/issue/FLY-2775/模型opus-线-opus-线切到-opus-55claude-opus-5-5-已于-2026-09-22-1007-pt)
日期: 2026-09-22
基于: research.md

## 0. 一句话

在 `model-builtins.ts` 加 Opus 5.5 身份、把 `opus` / `opus-1m` 绑定与 medium/light/trivial
三档翻到它,同时**保住 `claude-opus-5` 的 dispatch 合法性**;目录层与 models.json 由 Lead 按
PR 部署说明执行。仓内不碰生产状态。

## 1. 假设(明写,不隐含)

1. **A1** 运行 Claude runner 的主机 `claude` 版本 ≥ 2.1.280。本机实测=2.1.280。
   若某载体低于此,翻绑后它起的 Claude runner 会 400(research §1)。→ 写进部署前置检查。
2. **A2** Opus 5.5 与 Opus 5 同价。官方 catalog 尚未列 5.5,按同族同价登记并在注释里标注待复核。
3. **A3** Opus 5.5 的窗口与 Opus 5 同构(200k 标准 / 1M 带 `[1m]`)。依据:2.1.280 认识该 id
   (阴性对照说明「未知模型」才退回 200k 假设),且 `[1m]` 变体实测被接受。
4. **A4** 额度桶是否与 Opus 5 共用 —— **未知**,本单不依赖它。QA 能探则记录。

## 2. 改动清单(仓内)

### 2.1 `packages/config/src/model-builtins.ts` —— 核心

| # | 改动 | 理由 |
|---|---|---|
| a | `MODEL_IDS` 加 `OPUS_55: "claude-opus-5-5"`、`OPUS_55_1M: "claude-opus-5-5[1m]"` | 新身份 |
| b | `DEFAULT_OPUS_BINDINGS` → `{ opus: OPUS_55, opus1m: OPUS_55_1M }` | **升级/回滚唯一开关** |
| c | `OPUS_IDENTITIES` 头部加 `OPUS_55, OPUS_55_1M` | 让 `buildModelRegistry` 的 bound/legacy 过滤对新 id 生效;同时让 `buildDispatchLookup` 自动带上退役的 `claude-opus-5` |
| d | `OPUS_LABELS` 加 `"Opus 5.5"` / `"Opus 5.5 (1M)"` | 控制台/收据显示 |
| e | `TRUSTED_CONTEXT_WINDOWS` 加 `OPUS_55: 200_000`、`OPUS_55_1M: 1_000_000` | A3 |
| f | `BUILTIN_MODEL_TIERS` medium/light/trivial 的 `id` → `MODEL_IDS.OPUS_55` | 难度档 |
| g | 文件头 `BUILTIN_MODEL_TIERS` 上方那段 founder policy 注释里的「Opus 5」→「Opus 线当前绑定」 | 免得注释再陈旧 |

**不改**:`claudeEntry` / `buildModelRegistry` / `legacy()` / `bound()` / `pilot()` 任何逻辑。
FLY-1467 已经把身份与绑定拆开了,本次纯数据。

### 2.2 `packages/config/src/model-config.ts` —— 保住旧 id(判据 4)

`buildDispatchLookupForRegistry()` 里那串硬编码 legacy id 补上 Opus 5:

```ts
for (const id of [
  MODEL_IDS.OPUS_5, MODEL_IDS.OPUS_5_1M,      // FLY-2775
  MODEL_IDS.OPUS_48, MODEL_IDS.OPUS_48_1M,    // FLY-1467
  ...LEGACY_FABLE_MODEL_IDS,
]) lookup.set(id.toLowerCase(), id);
```

加一行注释说明「这串必须随每次 Opus 绑定升级增补,否则上一代 id 掉出 dispatch 白名单,
在飞 run 的快照(`dispatchPinned` 全名)与历史 pin 一起失效」。

并在 `model-builtins.ts` 的 `OPUS_IDENTITIES` 上方加一条**反向交叉引用**注释(Gemini R1 #2,已采纳):
指明升级 Opus 线时这里和 `model-config.ts:buildDispatchLookupForRegistry()` 的硬编码串**必须同时改**。
两处不对称是既有形状(research §4),把它写在两边比只写一边更难漏。

### 2.3 `packages/token-usage/src/pricing.ts`

`MODEL_RATES` 加**两条**(Gemini R1 #1,已采纳):

```ts
"claude-opus-5-5":     { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
"claude-opus-5-5[1m]": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
```

注释标注 A2 待复核。原计划只加基础 id —— 但 `tpl_eng_heavy` 的 QA 节点用的就是 `opus-1m`
(现 manifest 为 `claude-opus-5[1m]`),翻绑后它会变成 `claude-opus-5-5[1m]`,不登记就静默 $0。

**不采纳**的那半条:Gemini 建议顺手补 `claude-opus-5[1m]` / `claude-opus-4-8[1m]` 的历史缺口。
那是 pre-existing(research §5 已记),不在本单范围,留 follow-up。

### 2.4 `packages/token-usage/src/report/render-html.ts`

`MODEL_LABEL` 加 `"claude-opus-5-5": "Opus 5.5"`;`MODEL_COLOR` 加一个与 Opus 族同系的值
(Opus 5 = `#d92d20`,5.5 取更深的 `#b42318`,与既有 4.8/4.7/4.6 的由深到浅序一致)。

### 2.5 `packages/teamlead/lead-rules-base/model-routing.md`

难度表三行 `Opus 5` → `Current Opus family`(与 Heavy 行的 `Current Fable family` 对称);
`opus-1m` 那行的 `(Opus 5 · 1M)` → `(current Opus family · 1M)`;正文「every lower bucket uses
Opus 5」→「uses the current Opus family」。**这是 Lead 每次派工都读的规则文件,写成产品线措辞
才符合 FLY-2766「各随自己最新版」。**

### 2.6 `fleet/example/models.json`

`bindings.opus` / `opus1m` / `tiers.medium|light|trivial` → Opus 5.5 全名。示例文件,保持与内建一致。

### 2.7 `.flywheel/config.yaml:37` 注释

「QA row remains the only Opus 5 default」→ 措辞改为 Opus 线。纯注释。

### 2.8 测试

按 research §6 两分:**默认绑定**类断言改 5.5;**历史 id / 任意夹具**类不动。
新增/加强的断言(TDD,先红后绿):

1. `model-binding.test.ts`:`MODEL_IDS.OPUS_55 === "claude-opus-5-5"`;
   `DEFAULT_OPUS === MODEL_IDS.OPUS_55`;`DEFAULT_OPUS_1M === MODEL_IDS.OPUS_55_1M`。
2. `model-registry.test.ts`:`getModelRegistryEntry("opus")?.id === "claude-opus-5-5"`;
   `getModelRegistryEntry("claude-opus-5")` 仍存在且 `selectableSurfaces` 为空(退役但可识别)。
3. `model-tiers.test.ts`:
   - `normalizeDispatchModel("opus") === "claude-opus-5-5"`,`"opus-1m"` → `"claude-opus-5-5[1m]"`
   - 🔴 **阴性回归**:`normalizeDispatchModel("claude-opus-5") === "claude-opus-5"` 且
     `normalizeDispatchModel("claude-opus-5[1m]") === "claude-opus-5[1m]"`(判据 4 的本体)
   - `normalizeDispatchModel("claude-opus-9-9") === null`(未知仍拒)
   - `MODEL_TIERS.medium/light/trivial.id === "claude-opus-5-5"`
4. `model-config.test.ts`:构造一个 `bindings.opus = "claude-opus-5"` 的 models.json 快照,
   断言 `normalizeDispatchModel("claude-opus-5")` 仍非 null(部署窗口那一格,research §4.1)。
5. `workflow-menu` 侧:断言 `receipts["qa"].model === "opus (= claude-opus-5-5)"`(判据 1 的单测面)。
6. `pricing` 侧:`costMicroUsd("claude-opus-5-5", ...)` 不为 0 且等于 Opus 5 同参结果。

## 3. TDD 顺序

```mermaid
flowchart LR
  R1["① 写 §2.8 的新断言<br/>(全红)"] --> G1["② 2.1+2.2 改绑定<br/>(①转绿)"]
  G1 --> R2["③ 跑选测<br/>收集因默认值变化而红的既有用例"]
  R2 --> G2["④ 按两分法逐个修<br/>(默认→5.5 / 历史→不动)"]
  G2 --> G3["⑤ 2.3~2.7 周边<br/>+ 对应断言"]
  G3 --> V["⑥ lint + build + typecheck + 选测全绿"]
```

③ 是**发现步**,不预先猜清单;每一个「不动」的判定都要能说出它是历史 id 而不是默认值。

## 4. 验证(本地目标化,不跑全仓)

- `pnpm lint` —— 判据 = 退出码 + `Found N errors`(不用 grep 过滤器)
- `pnpm --filter "flywheel-config..." build`、`"flywheel-teamlead..."`、`"flywheel-token-usage..."`
- `pnpm --filter "...flywheel-config" typecheck`(本次导出新增 `OPUS_55*`,属导出变更)
- `vitest related <改动 .ts> --run` + `git grep -lF` 三路(全路径 / 文件名 / 父目录)找消费者,
  ≤6 文件/批,排除项逐条写进 PR
- 🔴 排除 `**/tmux-viewer.macos.test.ts`
- 判测试成功看 **Tests 条数**,不看退出码(`pnpm --filter` 名字写错 = exit 0 零测试假绿;
  teamlead 包真名是 `flywheel-teamlead`)

## 5. PR 部署说明(Lead 执行,本单不碰生产)

> 🔴 **本节已被取代,不要照它部署。** 以 PR #1295 body 的 Deployment 一节与
> `implementation-notes.md §1.2` 为准。Codex 代码评审 R1 证明本节有三处错:
>
> 1. **顺序反了。** 下面写的是「先重启(步骤 1)、再改 models.json(步骤 2)」。seed 只在 Bridge
>    **启动时**按当时的配置编译一次,这样做会把 system-owned 模板冻在 Opus 5,事后改文件不会重编。
>    正确顺序:**先删 `~/.flywheel/models.json` 的五项 Opus override(对旧二进制行为不变),再部署/重启。**
> 2. **`tpl_eng_heavy` 不会自动重 seed** —— 它已退役(FLY-1693),不在 registry.yaml,也不需要升级。
>    会自动重 seed 的 system-owned 模板是四个,不是五个。
> 3. **回滚说法只对一半。** models.json 绑回 `claude-opus-5` 只是部分回滚(按别名的派工按 FLY-1496
>    设计被拒);全量回滚 = 回退代码常量。
>
> 下面保留的是通过设计门(Gemini R1 + leadAcceptance,blob `f9bc186`)时的原文,仅作记录。

**顺序不可颠倒。**

0. **前置检查**:`claude --version` ≥ `2.1.280`。低于则先 `claude update`,**否则不要合入生效**
   —— 全名钉 5.5 在 2.1.278 上是 400(research §1)。
1. 合入 + rebuild + 重启 Bridge。
2. **同一次维护动作内**改 `~/.flywheel/models.json`(把窗口压到 0):
   - 推荐:**删掉** `bindings.opus`、`bindings.opus1m`、`tiers.medium`、`tiers.light`、`tiers.trivial`
     这五项,让内建默认当家(对齐 FLY-2766「改一处生效」)。
   - 或显式改成 `claude-opus-5-5` / `claude-opus-5-5[1m]`。
3. **目录层**:system-owned 的五个模板(tpl_eng_heavy / tpl_prd / tpl_design / tpl_prototype /
   tpl_generic_menu)在 Bridge 启动时自动重 seed。founder-owned 的两个**必须手动发布**:
   ```
   flywheel-comm workflow-template publish --template tpl_code        --from seed --reason "FLY-2775 Opus 5.5"
   flywheel-comm workflow-template publish --template tpl_simple_code --from seed --reason "FLY-2775 Opus 5.5"
   ```
   不做这一步,两条主力代码线的 QA 节点会**静默**停在 `claude-opus-5`(research §3)。
4. 验收:新起一个 run,`POST /api/runs/start` 响应 `resolved.nodeModels.qa.model`
   应为 `opus (= claude-opus-5-5)`;已在飞 run 的 `workflow_run.snapshot` 仍为 `claude-opus-5`。

**回滚**:把 `DEFAULT_OPUS_BINDINGS` 翻回 `OPUS_5` / `OPUS_5_1M` 并回滚三档 tier,或在
`~/.flywheel/models.json` 里显式绑回 `claude-opus-5`(**不需要**改代码,因为 §2.2 保住了它的
dispatch 合法性 —— 这正是那条改动的第二个理由)。模板层用
`workflow-template rollback --template <id> --revision <n>`。

## 6. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 某载体 CLI < 2.1.280 | 新 Claude runner 全部 400 | 部署步骤 0 前置检查;回滚=翻绑定 |
| 忘了发布两个 founder-owned 模板 | 主力代码线 QA 静默停在 Opus 5 | 部署步骤 3 显式列出;QA 判据 1 会照出来 |
| 5.5 实际价格 ≠ 5 | 成本估算偏差(非功能) | 注释标注待复核;`~/.flywheel/token-pricing.json` 可覆盖 |
| 额度桶与 5 共用与否未知 | 可能挤占同一周桶 | 不阻塞;QA 能探则写明,不能探就照实写「未探到」 |
| 漏改某个默认绑定断言 | CI 红 | ③ 发现步 + CI |

## 7. 明确不做(与 research §8 一致)

不动 Fable / Codex / Astra / Lead 载体模型;不动 `registry.yaml`;不改生产 models.json;
不重启 Bridge;不 publish 生产 template;不放宽 legacy 条目 surface;
不补 `claude-opus-5[1m]` 的历史费率缺口(follow-up)。

## 8. 独立设计评审记录

Codex 池 2026-09-22 全灭(6 个 profile 全部 usage limit,最早恢复 16:50 PT),
Lead 裁定(question `7d72c521-9fe3-4373-b26c-c9d9236a2fc1`)按 FLY-2560 先例走 Gemini API-key 通道。

- **Gemini R1**(gemini-cli 0.60.0,隔离 HOME):**APPROVED**,原文见同文件夹 `gemini-review-round1.md`。
- BLOCKING:**0 条**。
- LOW #1(`claude-opus-5-5[1m]` 未登记费率)→ **已吸收进 §2.3**;其中「顺手补历史 1M 缺口」那半条**未采纳**(越界,留 follow-up)。
- LOW #2(两处硬编码缺交叉引用)→ **已吸收进 §2.2**。
- 残留(residue):Codex 未跑,`claude-opus-5[1m]` / `claude-opus-4-8[1m]` 的历史费率缺口未补;
  实现 PR 的 code review 需要复核本 plan。
