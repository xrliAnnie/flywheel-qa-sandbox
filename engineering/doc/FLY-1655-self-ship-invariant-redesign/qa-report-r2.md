# FLY-1655 self-ship 按终节点不变量重设计 — 独立 QA 报告 R2(PASS,附 1 条部署前置)

Issue: FLY-1655 (https://linear.app/geoforge3d/issue/FLY-1655/founder-直令唯一单-self-ship-修了又坏-n-真根因每次修复只覆盖上一次事故的状态签名要按不变量重设计)
日期: 2026-08-09
基于: qa-handoff.md(terminal-land 版)

> R1 报告(`qa-report.md`)记录的是 founder 终节点纠偏**之前**的 A–G 补偿层实现,已被本轮取代。R1 的阻断项已修,详见 §1。

---

## 0. 判决:**PASS**(代码层)

被验 head:`7a3414623d5512924f68a986c20a14d4b096dd8b`(= PR #795 head = origin/flywheel-FLY-1655,开工与收工各核一次一致)。CI 在该 head **9/9 全绿**(含 `CI OK`)。

两条必须同时读的边界:
- **§5 部署前置(A1)—— ✅ 已解决**:曾有一颗 boot 炸弹(13:28 的 models.json 热切让菜单库抛错,而 Bridge boot 会调 `importWorkflowMenuSeeds`)。Tadashi 已回滚该绑定,我用 boot 同一条调用在 live 配置下复验通过(5 shapes / 5 seeds,零抛错)。详见 §5 A1。
- **§4 真机边界**:handoff §6 的 1–6(部署 → 真 DAG 到 approval gate → founder 卡片批准 → land 节点 merge/cleanup/archive → 关 runner 5 分钟零重派 → >2h QA 判决)**一条都未执行**,需要部署 + merge to main,QA 节点无该权限。**在那之前不得宣称 self-ship 已在线闭环。**

---

## 1. R1 findings 逐条核销

| R1 finding | 状态 | 证据 |
|---|---|---|
| **BLOCKER** `run-infra.ts:639` 的 `if (!run.snapshot) throw "active workflow snapshot not found"` 让无 snapshot 的 active run 起不来 | ✅ **已修**(按我建议的 A 方案) | 现为三元回落:有 snapshot 走 `credentialWindowForNode`,否则回原 30min/2h 窗口。`workflow-shadow-wiring.test.ts` 本机 **15/15 绿**(R1 时 1 failed/14),CI 该 job 也绿。对无 snapshot 的 active run 行为与改前逐字一致 |
| advisory:`artifactBuildSha` 挡不住脏工作树构建 | ⚠️ **未处理**(仍成立) | `package.json` build 脚本仍是 `git rev-parse HEAD`;能挡 stale Bridge,挡不住脏树。见 §5 A3 |
| advisory:`plugin.ts:9346` boot sweep 是 `void` 不 await | ✅ **已消失** | 该 boot sweep 连同整个补偿层一起被删除,不复存在 |
| 建议的 `credential_window_fallback` 审计事件 | ⚠️ 未采纳 | 回落路径静默。行为正确、字节兼容,只是少一条可观测性。见 §5 A4 |

---

## 2. 新形状:handoff 验收清单逐条独立核验

### 2.1 删除是真删除,零悬空引用

对 R1 时存在、handoff 声称已删的机制逐个全仓 grep（`packages/teamlead/src` + `packages/flywheel-comm/src` + `scripts`,排除 dist/node_modules）:

`reconcileShipTargetBindingForHeadAuthority` / `reconcileShipTargetBindingsAtBoot` / `reconcileShipTargetBindingAtBoot` / `gate-reissue` / `gate_reissue` / `proveDeliveredWithoutReceipt` / `ship_target_binding_reconciled` / `auditBoundWorkflowGateCarriers` / `ship-target-binding-boot` —— **全部 0 refs**;`ship-target-binding-boot.ts` 及其测试相对 R1 head 已物理删除。

改动规模同步收缩:`StateStore.ts` 从 R1 的 +2004 降到 **+198**;全 PR 69 文件 / +2798 −308。**删的比加的多的方向对了**。

### 2.2 拓扑不变量 —— 在真产物上逐个模板核

用 **PR head 的已构建 dist**(`dist/build-identity.json.artifactBuildSha = 7a341462`,与 HEAD 逐字相等)跑真编译器 + 真 YAML,逐模板断言「恰一个 engine-owned terminal land、approval gate 有边指向它、terminal 零出边、上游无 ship 位」:

| 来源 | 模板 | 结果 |
|---|---|---|
| menu 库(真 `loadWorkflowMenuLibrary` + `compileWorkflowMenuSeed`) | `tpl_code` / `tpl_prd` / `tpl_design` / `tpl_prototype` / `tpl_generic_menu` | **5/5 通过**(landNodes=1、type=land、execution=engine、gate→land 有边、terminal 出边 0、上游 ship 位 0) |
| bundled seeds(真 `loadBundledWorkflowSeeds`) | `tpl_product_v1` / `tpl_product_designer` / `tpl_product_prototype` / `tpl_generic` / 四个 `*_land_v1` | **8/8 通过** |
| bundled seeds(legacy v1) | `tpl_eng` / `tpl_eng_heavy` / `tpl_eng_light` / `tpl_eng_trivial` | **非 land**(见 §5 A2 —— 生产零绑定,休眠兼容件) |

### 2.3 生产实际绑定的是哪些模板(决定这修的到底是不是生产)

只读生产 `workflow_category_binding`:

- `flywheel` 项目:`code→tpl_code`、`design→tpl_design`、`generic→tpl_generic_menu`、`prd→tpl_prd`、`prototype→tpl_prototype`(`system:fly-1436-cutover`)
- 其余 5 个项目(geoforge3d / growth / joycon-typeless / personal-assistant / tidal-echo):`*→tpl_eng_heavy_land_v1`(`system:FLY-1434-land-migration`)

**没有任何生产绑定指向 §2.2 里那 4 个非-land 的 legacy seed。** 近期真实 run 也只用 `tpl_code`(64 条,最新今天 16:34)与 `tpl_generic_menu`(26 条);`tpl_eng_heavy` 最后一次使用是 2026-07-23,land 迁移之前。⇒ **拓扑不变量覆盖了生产真正会跑的全部模板。**

### 2.4 部署后是否真的生效(不是只在 fixture 里对)

生产 `workflow_template` 全部 `seed_owner=system`(无 founder-owned 拒绝路径)。把新 build 编出的 seed contentHash 与生产在册 hash 逐个对比:

(下表在 **A1 回滚后用生产 live `~/.flywheel/models.json` 重算**,不再依赖 fixture 覆盖)

| 模板(生产绑定) | 生产 hash(rev) | 新 build hash | land? | 部署后会升版? |
|---|---|---|---|---|
| tpl_code | b5b5aefb8bfb(3) | 5ad10455aa21 | ✅ | **YES** |
| tpl_prd | 77a1fdd37abe(3) | 7a5d395d922f | ✅ | YES |
| tpl_design | 754452ed9fd3(3) | 1cd5113c5d36 | ✅ | YES |
| tpl_prototype | 23268e2b1081(3) | dbfcc565817c | ✅ | YES |
| tpl_generic_menu | 6565cfc11319(3) | e5ecc5b9ae79 | ✅ | YES |
| tpl_eng_heavy_land_v1 | 210992bc70fd(4) | 210992bc70fd | ✅ | **no(逐字相同)** |

⇒ boot 时 seed 导入会给 **flywheel 项目在用的 5 个 V2/menu 模板**各发一个新 revision,其 manifest 是 terminal-land。**新 run 会真的走新拓扑,不是纸面改动。**

`tpl_eng_heavy_land_v1` 不升版是**正确且预期**的:它是 V1 `manifest_variant: land_v1`,`isWorkflowManifestV1Land` 在 main 上就已识别 ⇒ 绑它的那 5 个项目(geoforge3d / growth / joycon-typeless / personal-assistant / tidal-echo)**本来就已经在 land 路径上**。本 PR 新增覆盖的是 **V2/menu 家族**(`tpl_code` 等),也正是 flywheel 项目自己在用、FLY-1648/1650 出事的那一族 —— 覆盖面与事故面对得上。

> 自我更正:本表初版用 `FLYWHEEL_MODELS_CONFIG` 指向仓库内建 fixture 计算(当时 live models.json 会让菜单库抛错,见 A1),那一版把 `tpl_eng_heavy_land_v1` 也算成会升版。A1 回滚后用 live 配置重算,该行实为逐字相同。菜单模板的 contentHash **依赖模型注册表取值**,所以这类 hash 必须在目标环境的真配置下算 —— 记此教训。

### 2.5 兼容边界 —— 185 条真实生产 run 全量重解析

只读生产快照(VACUUM INTO,生产零写),用新 build 的真 `parseWorkflowRunSnapshot` + `resolveWorkflowGateAuthority` 跑**全部 185 条** run 的冻结 snapshot:

- **unparseable = 0** —— 新 build 不会让任何存量 run 解析失败(这是"改了又坏"最容易复发的形态,已排除)
- 权威分布:`tpl_code@1/2/3 → runner_ship`(64)、`tpl_eng_heavy@1 → runner_ship`(36)、`tpl_generic_menu@1/3 → engine_terminal`(13)/`runner_ship`(13);**存量 run 一条都没有被改写成 land** —— 冻结 snapshot 保持 pinned,符合 handoff §4
- FLY-1648(`tpl_code@3`)仍解析为 legacy `runner_ship`,与 handoff §4 的声称一致(我独立复现)

### 2.6 阳性对照 8/8(新形状,外科式 mutation)

方法同 R1:精确改产品码 → 跑目标用例 → `git checkout --` 还原 → 断言工作树干净。全程零提交。

| # | 摘掉的东西 | 结果 |
|---|---|---|
| PC1 | `isWorkflowManifestLand` 退回只认 V1(V2 land 图掉回 runner_ship) | **红** 3 文件 3 例 |
| PC2 | 去掉 land 图下"上游 ship 位强制关闭" | **红** 1 |
| PC3 | 去掉 land gate 的 head 证明(`land_head_unavailable`) | **红** 1 |
| PC4 | 删掉 relay 的 `approve_to_ship_requires_founder_writer` 守卫 | **红** 1(`does not let a Lead relay consume founder ship approval`) |
| PC5 | 去掉 permanent 凭据旁路 | **红** 1 |
| PC6 | 去掉 legacy 409 的 `binding.{required,reason,authorityMode}` | **红** 8 |
| PC7 | 删掉 deploy identity 的 `merge-base --is-ancestor` 闸 | **红** 2/10 |
| PC8 | 去掉 qa-result marker 的 `status`/`summary` | **红** 3 |

8/8「摘掉即红、恢复即绿」。

### 2.7 card 路径

ship 卡片正文(`gate-materializer.ts:91`)在本 head 仍是新指引原文:
`Approval is recognized only from the founder's ✅ reaction on this card or the founder's direct reply in this card's thread.`
R1 已在 529 房用真 bot / 真 thread 渲染并截图确认过该正文(卡片正文本轮未变)。本轮未重跑真 Discord:R1 验过的 consumed-gate ❓+severe 告警链路(`founder-reply-deliverer` / `founder-decision-convergence`)**在本轮被整体删除**,不再是本 PR 的交付面;剩余 Discord 面只有卡片正文与 relay 守卫,两者分别由上面的静态核对与 PC4 覆盖。

---

## 3. 自动化门(独立复跑)

| 门 | 结果 |
|---|---|
| **CI @ 7a341462** | **9/9 SUCCESS**(Quick Gate / Unit teamlead 1-3 / Unit heavy / Unit light / Script Tests / NPM payload / CI OK)—— canonical 结论 |
| `workflow-shadow-wiring.test.ts`(R1 阻断项) | 15/15 绿 |
| `StateStore.workflow-templates.test.ts` 隔离 | 21/21 绿(清掉 runner 注入的 env 后,见 A5) |
| 本机 14 文件批量跑 | **不作为验收依据**:期间 load average 125→159(WindowServer 52% / cmux 31%),17 个失败里 16 个是 5000ms 超时,属主机争用;唯一非超时项由 A5 解释。按 `feedback_heavy_vitest_suite_on_prod_host_kills_bridge` 我停止了继续加载 |

---

## 4. 诚实边界:没测的

1. **handoff §6 的 1–6 全部未执行**(部署 / 真 claim-backed `code` 与 claimless `generic` 两条 DAG 到 approval gate / founder 真卡批准 / land 节点做 merge+cleanup+archive / 关 runner 5 分钟零重派 / >2h QA 判决)。需要部署 + merge to main,超出 QA 节点权限。
2. **生产目前 0 条 land-mode run** —— 由构造决定(冻结 snapshot 是 pinned,新拓扑只对部署后新建的 run 生效)。所以「land 节点真的会 merge/cleanup/archive」这件事**只能在部署后证**,本轮拿不到。
3. 本轮未跑真 Discord E2E(理由见 §2.7),未跑 canonical 全包 sweep(以 CI 为准)。
4. ~~观察项:核验期间生产 Bridge `/health` 连续三次不响应~~ —— **撤回,该观察是错的**。我当时用 `--max-time 4/5` 探活,在 load 125–159 下超时,我把「我的探针超时」写成了「Bridge 不响应」。Tadashi 指出后用 40s 预算单次复探:**`http=200`、`total=0.008s`、`ok:true`、`sessions_count=4`** —— Bridge 一直健康,只是高负载下偶发慢回(1663 QA 20:31 也测得 200,12.7s)。**负载来源是我和 1663 QA 的重测并跑,不是故障。** 教训:高负载主机上短超时探针的结果不能当服务状态结论。

---

## 5. Findings(均非本 PR 代码缺陷,但 A1 是部署硬前置)

**A1 —— 部署窗口前置(高,环境;本 PR 无关但会挡住本 PR 的部署)—— ✅ 已解决并经独立复验**

> **结案(2026-08-09 14:01)**:Tadashi 确认这是他 13:28 的热切(founder 拍板启用 4.6),已由他本人回滚 `bindings.opus → claude-opus-5[1m]`(`phases.qa` 保留 4.6 —— 实测确认它不在爆炸路径上)。
> **我的独立复验(不取信口头结论)**:① 读 live `~/.flywheel/models.json`(mtime 14:01:53)确认 `bindings.opus = claude-opus-5[1m]`;② 用 Bridge boot **同一条调用**在 live 配置下真跑一遍 —— `loadWorkflowMenuLibrary()` OK(5 shapes)、`loadWorkflowMenuSeeds()` OK(tpl_code / tpl_prd / tpl_design / tpl_prototype / tpl_generic_menu),727ms,零抛错。**boot 炸弹已拆,部署前置清除。**

以下为原始取证,保留备查:


生产 `~/.flywheel/models.json`(mtime 2026-08-09 13:28)把 `opus` 绑到 `claude-opus-4-6[1m]`,其 workflow surface effort 集为 `[low, medium, high, max]`;`menus/shapes/code.yaml` 的 qa 节点声明 `allowedEfforts: [low, medium, high, xhigh, max]` → `parseMenuModel` 抛
`menu code.nodes[2].models[0].allowedEfforts must equal the opus workflow CLI set: low, medium, high, max`。
`importWorkflowMenuSeeds(store)` 在 Bridge boot 执行(`plugin.ts:4034`,该调用点无 try/catch),`run-bridge.ts` 顶层 `main().catch(... process.exit(1))` ⇒ **boot 失败退出**。
**归因**:`parseMenuModel` 与 `menus/shapes/*.yaml` 本 PR **零 diff**(已 grep 确认),所以这是既有环境状态,不是本 PR 引入。
**为什么至今没撞上(读只读证据,已复核)**:活着的 Bridge `bridge_started_at = 2026-08-09T16:04:31Z`(= 本地 09:04:28,与 PID 65553/66236/66369 的 `lstart` 一致),**早于 models.json 的 13:28 修改** ⇒ 这个进程从未在当前 models.json 下 boot 过,该路径**尚未被执行过**,危险仍然成立且未被证伪。
**旁证(同一次探针)**:该 `/health` 响应里 `buildMode/buildSha/artifactBuildSha` 全部缺失 —— 这三个字段正是本 PR 新加的,所以它也独立证明**生产此刻跑的是本 PR 之前的构建**(即本单要治的"部署真相"缺口本身)。
**为什么必须先解决**:部署本 PR = 重启 Bridge。按 `feedback_never_inject_model_or_touch_global_config`,我没有碰 models.json;请由改它的人决定回退绑定 / 对齐 effort 集。

**A2 —— 休眠 legacy seed(低)**
`tpl_eng` / `tpl_eng_heavy` / `tpl_eng_light` / `tpl_eng_trivial` 仍是非-land。生产零绑定指向它们(§2.3),故无生产暴露;但若将来有绑定落到它们身上,权威会静默退回 `runner_ship`。建议显式退休或在 handoff 里点名它们是兼容件。

**A3 —— build 身份的诚实缺口(低,R1 遗留)**
`artifactBuildSha` = build 时 `git rev-parse HEAD`,脏工作树构建会被盖上一个干净 commit 的 SHA。挡 stale Bridge 有效,挡脏树无效。

**A4 —— 可观测性(信息)**
`run-infra` 无 snapshot 的回落路径静默,没有审计事件。行为正确且字节兼容,只是事后查不到"这条 run 走的是回落窗口"。

**A5 —— QA harness 环境污染(信息,非缺陷)**
Runner 自身 env 带 `FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES=1`,会让 `StateStore.workflow-templates.test.ts` 里断言"未开 flag 应抛错"的那条失败。清掉该变量后 21/21 绿,CI(干净 env)也绿。**不是代码缺陷**;记下来免得下次误判。
