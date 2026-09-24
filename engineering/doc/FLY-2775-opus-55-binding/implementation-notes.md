# FLY-2775 Opus 线切到 Opus 5.5 — 实施记录

Issue: FLY-2775 (https://linear.app/geoforge3d/issue/FLY-2775/模型opus-线-opus-线切到-opus-55claude-opus-5-5-已于-2026-09-22-1007-pt)
日期: 2026-09-22
基于: plan.md(Gemini R1 APPROVED + Lead leadAcceptance)

> plan.md 是**已通过 design_review 门的设计**,本文件记录实施过程中**新发现的事实**与**相对计划的偏差**,
> 不回写 plan,免得动已被 blob 绑定的那一份。

## 1. 一次试错:给退役 id 连别名一起登记 —— 已撤回

plan §2.2 的做法是把退役 id **按 id** 补进 `buildDispatchLookupForRegistry()` 的硬编码串。**最终实现就是这样**,
但中间走过一次弯路,记下来,因为它暴露了 plan §5 回滚说法里的一处错误。

**弯路**:既有用例 `model-config.test.ts` "hot-reloads an atomically replaced same-size binding" 用
`bindings: { opus: "claude-opus-5" }` 起快照,断言 `normalizeDispatchModel("opus") === "claude-opus-5"`,
绑定翻转后它红了。我据此判断「models.json 绑回退役 id 时别名 `opus` 掉出白名单 = 回滚半生效」,
于是改成连别名一起登记。

**被推翻**:`scripts/__tests__/fly1496-qa-acceptance.test.sh` §4 明文断言相反的不变式 ——
把 `bindings.opus` 指向**没有 dispatch 面的模型**时,`getDispatchCanonical("opus")` **必须为 null**
(「a non-dispatch model yields no alias」),目的是让一次配置编辑无法把新工作静默路由到
派工层不承载的模型上。我的别名登记直接打穿它(`dispatchOpus` 从 null 变成 `claude-opus-4-8`)。
这是 FLY-1496 的既有验收合同,优先于我的推断 ⇒ **撤回**,恢复为「按 id、不按别名」,
并在代码注释里写明这条合同,免得下一个人重走一遍。

那条 hot-reload 用例的真实意图是「原子替换后热加载」,与模型策略无关;它原来能过只是因为
`claude-opus-5` 碰巧是当时被绑的那个。已把夹具改成当前被绑的 `claude-opus-5-5`,
并另加一条**专门**钉部署窗口行为的用例(见下)。

### 1.1 由此修正的回滚说法

plan §5 写「在 `~/.flywheel/models.json` 里显式绑回 `claude-opus-5`,不需要改代码」。**这句只对一半**:

| 回滚后 | 行为 |
|---|---|
| 全名 `claude-opus-5`(在飞快照、历史 pin、Lead 启动参数) | ✅ 仍可派工 —— 这正是 §2.2 保住的 |
| 别名 `opus` / `opus-1m` 的**派工** | ❌ **null**(FLY-1496 合同,按设计) |
| Lead 启动接缝(`claude-lead.sh` 读 projects.json 的 `opus`) | ✅ 照绑定解析为 `claude-opus-5`(fly1496 §4 "re-pointed binding is obeyed verbatim at the Lead seam") |

⇒ **真正的全量回滚 = 回退代码常量**(`DEFAULT_OPUS_BINDINGS` → `OPUS_5` / `OPUS_5_1M`,三档 tier 同步)
再重建重启。models.json 绑回只能算「部分回滚」:Lead 和全名路径回去了,按别名的 runner 派工会被拒。
PR 部署说明按这个口径写,不沿用 plan §5 那句。

新增用例 `model-config.test.ts` "keeps a retired Opus id dispatchable by id while its alias goes dark"
把上表前两行钉成可执行断言。

### 1.2 Codex 代码评审 R1 推翻的两条部署说法(plan §5 / research §3 已被本节取代)

Codex 于 2026-09-22 恢复(`personal` 快照,隔离 `CODEX_HOME`,未碰共享 auth),对 head `b58eec5de` 做代码评审
R1:**CHANGES REQUESTED,2 BLOCKING + 3 LOW**。代码层(绑定、按 id 保住退役 id、定价、夹具隔离)
全部通过其独立验证;两条 BLOCKING 都打在**部署说明**上,且都成立:

**(a) 顺序反了:必须先改 `~/.flywheel/models.json`,再启动新 Bridge。**
published 模板的 manifest 里冻的是**全名**,由 `compileWorkflowMenuSeed` 在 **seed 编译时**解析 `opus` 得到;
Bridge 只在**启动时**编译一次 seed。plan §5 写的是「重启 → 同一次维护里改 models.json」——
那样启动时 override 仍是 `claude-opus-5`,system-owned 模板就按 5 编译并落库;之后改文件只会热重载配置,
**不会**重跑 seed 迁移 ⇒ 这些模板一直派 Opus 5,直到下一次重启。run-start 回执却会显示 5.5
(它是请求期解析)——**回执与真实起的体不一致**,正是本单要防的那种静默分叉。

改法:先删 models.json 里那五项 override(对**旧**二进制是行为不变的:旧内建默认本来就是 Opus 5),
再部署/重建/重启。新增 `workflow-menu.test.ts` 的 FLY-2775 describe 两条互为对照的用例钉住这件事:
内建策略下所有 Opus 线菜单节点编译成 `claude-opus-5-5`;pre-deploy override 在场时编译成 `claude-opus-5`。

**(b) `tpl_eng_heavy` 不会「启动时自动重 seed」—— research §3 那张表是错的。**
它不在 `.flywheel/agents/registry.yaml` 的 graphs 里,`loadWorkflowMenuSeeds()` 根本不产出它;
`workflow-template publish --from seed` 对它会是 `seed_not_found`。实查它的处境:

| 事实 | 值 |
|---|---|
| `RETIRED_BUNDLED_TEMPLATE_IDS`(`workflow-template.ts`) | ✅ 在列(FLY-1693 founder 批准退役) |
| FLY-2121 为何没删它 | 生产里有不可变的历史 run 引用 |
| `workflow_category_binding` 指向它的行 | **0** |
| `workflow_run` 用它的最近一次 | 2026-07-23;**2026-09-01 以来 0 次** |

⇒ 没有任何新派工会落到它上面,「新体用 5.5」不受它影响;它**有意**停在旧 pin 上。
新增用例断言 `loadWorkflowMenuSeeds()` 不含 `tpl_eng_heavy`。`pricing.ts` 里那句
「`[1m]` 要登记是因为 tpl_eng_heavy 的 QA 走 opus-1m」的理由也是错的,已改成真实理由:
`opus-1m` / `opus[1m]` 是任何 runner 都能显式请求的活别名(FLY-751 的 1M opt-in)。

所以 system-owned 能自动重 seed 的是**四个**:`tpl_prd`、`tpl_design`、`tpl_prototype`、`tpl_generic_menu`
(且前提是 (a) 的顺序对了)。founder-owned 的 `tpl_code` / `tpl_simple_code` 仍需手动发布。

**LOW 三条全部吸收**:三档 tier 改为从 `DEFAULT_OPUS` 派生(FLY-1467 原计划里就是这么写的,
`DEFAULT_OPUS_BINDINGS` 才真正是唯一开关);两条「前缀/包含」松断言改为精确;去掉一处行尾空格。
收紧 `TmuxAdapter` 那条时它在本机红了 —— 本机 seam 把 `opus` 解析成 `claude-opus-5`,因为宿主那份旧
`models.json` 还把 `opus` 绑在 5 上;隔离 HOME 后即 `claude-opus-5-5`。这是第 4 条被宿主活配置耦合的用例,
所以这条改为**以 adapter 自己调用的同一个 resolver 为参照**做精确比较,而不是对内建常量比较。

## 2. 若违反部署顺序会看到什么(故障形态,不是正常窗口)

> ⚠️ 本节最初按「先重启、后改 models.json」写成了一个**可接受的**部署窗口 —— 那是错的,
> §1.2(a) 已更正:**必须先改文件再启动新 Bridge**。这里保留的是**顺序被违反时**的可观察症状,
> 便于 Lead 一眼认出。按正确顺序部署,下面这些都不会出现。

新代码已在跑、但生产那份文件里仍有 `bindings.opus = "claude-opus-5"` 与
`tiers.medium/light/trivial = "claude-opus-5"` 时:

0. **(最严重,由 §1.2(a) 补上)** 四个 system-owned 模板在那次启动时按 `claude-opus-5` 编译落库,
   之后改文件也**不会**重编 —— 真实起的体是 Opus 5,run-start 回执却显示 5.5。只有再重启一次才收敛。

另有两处较轻的症状(本机实测):

1. **stderr 噪音**:每个加载模型配置的进程会打
   `[model_config] tier medium ignored: unavailable Claude model claude-opus-5; tier light ...; tier trivial ...`。
   行为是**对的**(三档回落到内建 = Opus 5.5),但噪音会持续到文件被改。
   `lead-note-e2e` 那条断言 `stderr === ""` 的 e2e 因此在本机变红 —— 它的子进程 env 里没有 `HOME`,
   于是经 OS user db 解析到了**开发者真实的** `~/.flywheel/models.json`。
   已给它加 `HOME: dir`(指向夹具目录)把这条隐藏耦合切断;这不是为了迁就本单,
   是那条断言本来就不该依赖宿主的活配置。
2. **fleet console 不再接受把载体切到 `claude-opus-5`**:`stage` 返回 403,因为它已是 readonly
   legacy id。这与 FLY-1467 立的「退役身份可见、只读、永不作为新选项」一致,是预期行为,
   不是回归。`fleet-routes-mount` 那两条用例的夹具已改成 `claude-opus-5-5`
   (它们测的是路由挂载/CSRF/令牌重放,不是模型策略)。

**结论**:~~部署步骤 2(改 models.json)必须和重启放在同一次维护动作里,plan §5 已这么写。~~
**更正**:同一次维护动作**不够**,还必须**先改文件、后启动**(§1.2(a));plan §5 的写法是错的。
推荐做法仍是**删掉**那五项覆盖,让内建默认当家(对旧二进制行为不变,所以可以在旧 Bridge 还在跑时就删)。

## 3. 实机验证(本机,2026-09-22 16:20–16:45 PT)

| 项 | 结果 |
|---|---|
| `claude --version` | `2.1.280 (Claude Code)` |
| `claude -p --model claude-opus-5-5 'Reply with exactly your model id'` | `claude-opus-5-5` ✅ |
| `claude -p --model 'claude-opus-5-5[1m]'` 同上 | `claude-opus-5-5[1m]` ✅ |
| `claude-code@2.1.278 -p --model claude-opus-5-5` | **`API Error: 400 … version 2.1.280 or newer is required`** ❌ |
| `claude-code@2.1.280 -p --model claude-opus-9-9`(阴性对照) | `unrecognized_model` ❌ |

⇒ 「全名钉 5.5 需要 CLI ≥ 2.1.280」是实测结论,不是推测。已写进 plan §5 步骤 0 与 PR body。

### 额度桶(判据 3 的后半)

`~/.claude/usage-api-cache.json` 的 schema 里 Opus 只有**一个**桶键 `seven_day_opus`,
**没有按版本分的键**;本账号上该键此刻为 `null`(即这个计划不走独立 Opus 桶,
走的是通用 `five_hour` / `seven_day`:实测 utilization 10% / 23%)。

⇒ 能说的:**接口层面不存在「Opus 5 一个桶、Opus 5.5 另一个桶」这种形状**。
不能说的:没有做过「跑满 5.5 看 5 是否同步下降」的实测,所以「共桶」是**schema 证据**,
不是**行为实测**。QA 若要更强证据需要真实跑量对照。

## 4. 本地验证口径与结果

| 项 | 命令 | 结果 |
|---|---|---|
| lint | `pnpm lint` | **exit 0**,`Found 25 warnings`、**0 errors**(warnings 为既有) |
| build | `pnpm -r build` | 全包 Done,无 error |
| typecheck | `pnpm --filter "...flywheel-config" typecheck` | **exit 0** |
| config 包 | `vitest run`(packages/config) | **904 passed**(新增 1 条部署窗口用例);全包并发下 `repository-baseline` 偶红、单跑 4/4 绿 |
| token-usage 包 | `vitest run` | **175 passed** |
| teamlead 包 | `vitest run --exclude '**/tmux-viewer.macos.test.ts'` | 见下 |
| claude-runner 包 | `vitest run test/ClaudeRunner.test.ts test/TmuxAdapter.test.ts` | **207 passed** |
| edge-worker 包 | `vitest run` | 1356 passed / 1 failed(`WorktreeManager.reap.real-tmux`,真 tmux 宿主用例,基线同样红) |
| shell | `packages/teamlead/scripts/__tests__/fly1650-companion-effort.test.sh` | 12 passed / 0 failed |
| shell | `packages/teamlead/scripts/__tests__/fly241-lead-model-override.test.sh` | 17 passed / 0 failed |
| shell | `scripts/__tests__/fly1496-qa-acceptance.test.sh` | **11 passed / 0 failed**(改前 2 红,见 §1) |
| shell | `scripts/__tests__/fly1496-model-policy.test.sh` | 4 passed / 0 failed |
| shell | `scripts/__tests__/flywheel-fleet.test.sh` | 27 passed / 0 failed |
| shell | `scripts/__tests__/lead-session-resume-gate.test.sh` | 23 passed / 0 failed |
| shell | `scripts/__tests__/fly1678-statusline-fable.test.sh` | 329 checks / 0 failures |
| shell | `scripts/__tests__/flywheel-fleet-lead-flags.test.sh` | 2 passed / 8 failed —— **基线同样 2/8**(改动前代码实测),非本单 |

🔴 按 flywheel 红线,**排除** `**/tmux-viewer.macos.test.ts`(它会真开 Terminal.app 弹授权窗到 founder 屏幕)。

### teamlead 包:用基线做差,不看绝对数

18136 条测试里有一大片与本单无关的宿主/并发相关红(真 tmux、真 socket、codesign、
voice probe 等)。做法是**在同一台机器上把 `model-builtins.ts` / `model-config.ts`
回退到改动前的 commit、重建 `flywheel-config`、跑同一条命令取基线**,再做集合差:

- 基线:**104 failed** / 18014 passed
- 改动后(未修测试):**123 failed** → 集合差 = **19 条**,全部与模型 id 有关,已逐条修
- 修完、并撤回 §1 的别名登记后**最终一跑**:**106 failed** / 18012 passed,集合差 3 条 ——
  `workflow-ship-ready-head-enrichment`、`fly247-bash-suites`、`chat-thread-routes`。
  后两者**单跑全绿**;前者单跑 3 次 = 红/红/绿,且文件里**零**处 `opus` / `model` 引用 ⇒ 既有 flake。
  ⇒ 相对基线,**本单引入的模型相关失败 = 0**。
  (输出里能看到 12 行 `[model_config] tier medium ignored: … claude-opus-5` —— 那是测试进程读到了
  宿主**活的** `~/.flywheel/models.json`,即 §2 描述的部署窗口噪音,不是失败。)
  同理 `packages/config` 的 `drift-scan` / `repository-baseline` 在全包并发下偶红、单跑全绿
  (后者按定义就要求干净工作树,与并发的 git 用例互相踩)。

### 消费者普查(`git grep -lF`,三路:全路径 / 文件名 / 父目录)

改动的每个文件都扫过消费者。`claude-opus-5`(不含 `claude-opus-5-5`)的**剩余**字面量,排除 `engineering/doc`、`product/doc` 后
共 **118 行 / 43 个文件**(`git grep -n 'claude-opus-5' | grep -v 'claude-opus-5-5'` 实数,
在 Codex R2 之后的最终 head 上重数;行数会随注释与新增对照用例上下浮动,以这条命令的当前输出为准),
全部属于「历史 id / 任意夹具值」类,**有意保留不动**,其中一部分正好构成判据 4 的现成回归。代表性的:

- `packages/config/src/model-builtins.ts` 的 `MODEL_IDS.OPUS_5`(身份常量,值永不改)
- `model-binding` / `model-config` / `model-registry` / `model-tiers` 里的 legacy 断言
- `phase-roles.test.ts`、`StateStore.land-*`、`StateStore.workflow-claims` 等的夹具串
- `fly1650-companion-effort.test.sh` 的透传夹具(不解析绑定)
- ~~`TmuxAdapter.test.ts:1745` 的 `/^claude-opus-5/` 正则(对 5.5 仍成立,有意不收紧)~~
  **更正**:这条恰恰不该留 —— 前缀同时匹配退役 id,Codex R1 #4 指出后已改为精确比较(见 §1.2 末段)

**未检查的 root**:无。本单未净删或改名任何 `flywheel-comm` 子命令,故不触发 CLI 合同 sweep(FLY-1914)。

## 5. 未做(留 follow-up)

1. `claude-opus-5[1m]` / `claude-opus-4-8[1m]` 的历史费率缺口(`MODEL_RATES` 无键 ⇒ $0)。
   pre-existing,Gemini R1 建议顺手补,**未采纳**(越界)。
2. 不放宽 legacy 条目的 `surfaces`,所以 `tiers.* = <退役 id>` 仍被拒 + 警告。
   若将来希望 tier 层也能显式回滚到上一代,那是单独一个决定。
3. 生产 `~/.flywheel/models.json`、Bridge 重启、两个 founder-owned 模板的重新发布
   —— 全部是 Lead 的部署动作,见 **PR #1295 body 的 Deployment 一节**与本文 §1.2
   (plan §5 的顺序已被取代,不要照它做)。

---

## 6. 返工(implement attempt 2):Opus 线「跟最新」

> 起因:founder 2026-09-23 00:11Z「不要 hardcode 成 5.5,以后有最新的 Opus 就自动切换」,QA 判 FAIL(B1 未实现跟最新;B2 exact-head CI 红)。
> 设计见 `rework-plan.md`,经 Codex 设计审 R1/R2 修订;Lead 裁定问 9d81f23e / e6ffc4ce。

### 6.1 B2(CI 字节预算)

`model-routing.md` 最终采用 main 的「当前 Opus 族」措辞;历史 bundle 从 241531 增至 241533
(**+2 bytes**)。按先例刷新 `fixtures/fly2567/legacy-bundle.json` 并以最终 ship SHA 更新
`opusRoutingWordingEvolution` 记录;两条预算用例在合并 origin/main 后的树上 7/7。

### 6.2 实现落点

| 面 | 做法 |
|---|---|
| 发现 + 推进 | `account-heal/opus-model-sync.ts`:**本机 CLI 是发现权威**。探 `opus` / `opus[1m]` 读 `modelUsage`,要成对;再用精确拼写准入;通过后在 authority 锁下推进 `bindings.opus/opus1m` 与跟 Opus 的三档 tier,写后校验,失败回滚;回滚也失败 ⇒ `rollback_failed` + severe 告警 |
| 进程边界 | 有界子进程:无 shell、stdin 关闭、输出封顶、超时杀进程组;隔离 argv(`--safe-mode --setting-sources "" --strict-mcp-config --disable-slash-commands --tools "" --permission-prompts none --no-session-persistence`,实测可用) |
| 花费 | 冷却键 = `claude --version` + 二进制 realpath;同版本 24h 内不重复探测;已准入的 id 对缓存 |
| 告警 | **从 authority 推导,不排队**(R2 后,见 6.8):每次运行(含关闭、含 CLI 失败)读 `models.json`,首次只记基线;确认成对可派工且与上次已播报值不同才发一次 info;送达后才推进水位;不可用才发 severe(按内容指纹去重) |
| 接线 | `update-flywheel.sh` 的 `updater_sync_opus_model`,紧跟 Fable,advisory |
| 熔断 | **store 管理的 kill_switch flag `opus_model_sync_disabled`**(见 6.3) |
| 模板 | 统一持久化契约 `validateManifestForPersistence`:种子编译 / 启动预检 / 导入 / 发布 / 回滚 / `createWorkflowTemplateRevision` 全部保留 `opus`/`opus-1m`/`opus[1m]` 原拼写;run 物化仍规范化并钉死精确 id |
| founder 模板 | `publish-fable-template-alias --model opus`(默认 fable,行为不变),Lead 合入后对 `tpl_code.qa`、`tpl_simple_code.qa` 各执行一次 |
| 管理台 | Lead 模型下拉加「Opus · 跟最新」「Opus 1M · 跟最新」,写入别名原值 |
| 定价 | 5.5 改正为 $4/$20、cache read $0.20(命名例外)、5 分钟写 $5;**不加** Opus 家族通配价;报表标签兜底 |
| 盘点 | `scripts/fly2775-opus-inventory.mjs` 只读盘点 = 部署闸 |

### 6.3 相对 rework-plan 的两处偏离(都由守卫/测试逼出来,不是临场改主意)

1. **发布与回滚也纳入持久化契约。** 计划只让种子路径保留别名,发布走受控写入器。实现后
   `workflow-template-publication-service` 的回滚用例变红:回滚会把历史修订里的 `opus` 冻回全名。
   ⇒ 契约扩到所有写修订的路径。仍保留受控写入器做 founder 模板迁移,因为 `--from seed` 是整份覆盖,
   会把 `tpl_code.eng_design` 的 `fable` 别名改回种子里的 Fable 全名。
2. **熔断从 `.env` 变量改为 store 管理的 flag。** 计划(采纳 Codex 设计审答复)用 `FLYWHEEL_OPUS_MODEL_SYNC_DISABLED=1`。
   feature-flag 漂移守卫拒收:手册规定新开关只能走「registry + store codec + 命名 reader」,
   不得开第二条开关通道。改为登记 `opus_model_sync_disabled`(kill_switch),经管理路径切换;
   CLI 用只读句柄读 `teamlead.db`,沿用 `lead_token_savings` 的启动读取器先例。
   ⇒ 回滚说明改为 `flywheel-comm feature-flags set --name opus_model_sync_disabled --to on --reason …`。

### 6.4 过程中抓到的真缺陷(都已修且有测试)

- `lead-alert.sh` 的 severity 只认 `info|warning|severe`,我原写的 `high` 会让 rollback_failed 告警**永远**投递失败。
- 验证失败用例的夹具写的是 `{"version":1}`,而空配置恰好回落到内建 5.5 ⇒ 校验**碰巧通过**;改成真正不一致的内容。
- 生产形状的 models.json 把 `opus` 绑在退役 id 上,此时派工别名按 FLY-1496 合同熄灭 ⇒ sync 取「当前值」必须读 `bindings.opus`,不能走派工别名。
- 反证:只撤掉启动预检那一处修复,测试立即报 `workflow seed content hash mismatch: tpl_code`(即 Codex 抓到的启动炸弹)。

### 6.5 项目 × 节点核对表(生产只读盘点)

#### 模板节点(7 个有绑定的项目共用同一组全局模板)

| 类别 | 模板 · 节点 | 归属 | 今天(生产实况) | 部署后 | 覆盖项目 |
|---|---|---|---|---|---|
| code | `tpl_code` · `qa` | founder | `claude-opus-5` 钉死 ❌ | `opus` → `claude-opus-5-5` ✅ Lead 合入后用受控写入器改成 `opus` | 7/7 |
| product_design_flow | `tpl_design` · `product_design` | system | `claude-opus-5` 钉死 ❌ | `opus` → `claude-opus-5-5` ✅ Bridge 启动时自动重新导入种子,存为 `opus` | 7/7 |
| generic | `tpl_generic_menu` · `general` | system | `claude-opus-5` 钉死 ❌ | `opus` → `claude-opus-5-5` ✅ Bridge 启动时自动重新导入种子,存为 `opus` | 7/7 |
| prd | `tpl_prd` · `pm` | system | `claude-opus-5` 钉死 ❌ | `opus` → `claude-opus-5-5` ✅ Bridge 启动时自动重新导入种子,存为 `opus` | 7/7 |
| prototype | `tpl_prototype` · `proto` | system | `claude-opus-5` 钉死 ❌ | `opus` → `claude-opus-5-5` ✅ Bridge 启动时自动重新导入种子,存为 `opus` | 7/7 |
| simple_code | `tpl_simple_code` · `qa` | founder | `claude-opus-5` 钉死 ❌ | `opus` → `claude-opus-5-5` ✅ Lead 合入后用受控写入器改成 `opus` | 7/7 |

覆盖项目:flywheel, geoforge3d, growth, joycon-typeless, personal-assistant, raya, tidal-echo。每行一个模板节点,对这 7 个项目同时生效。

#### Lead(`projects.json`,所有项目共用 `claude-lead.sh` 的一个启动解析器)

| 项目 | Lead | 存储值 | 今天(旧代码) | sync 后(新代码) |
|---|---|---|---|---|
| geoforge3d | product-lead | `opus[1m]` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` ✅ |
| geoforge3d | ops-lead | `opus[1m]` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` ✅ |
| geoforge3d | cos-lead | `opus[1m]` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` ✅ |
| joycon-typeless | joycon-lead | `opus[1m]` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` ✅ |
| flywheel | flywheel-cos-lead | `opus[1m]` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` ✅ |
| flywheel | flywheel-eng-lead | `opus` | `claude-opus-5` | `claude-opus-5-5` ✅ |
| flywheel | flywheel-product-lead | `opus[1m]` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` ✅ |
| tidal-echo | tidal-echo-content-lead | `opus[1m]` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` ✅ |
| tidal-echo | sub-lead | `opus[1m]` | `claude-opus-5[1m]` | `claude-opus-5-5[1m]` ✅ |

只读盘点(`node scripts/fly2775-opus-inventory.mjs`,2026-09-23 生产 `teamlead.db` + `projects.json`):51 行 Opus 线派工面,**42 行需迁移**(即上面 6 个模板节点 × 7 个项目),exit 1。部署步骤完成后应为 exit 0。9 个 Lead 已存家族别名,无需改 `projects.json`,下次启动即跟上。

### 6.6 本地验证(只跑相关文件,不跑整包)

| 范围 | 结果 |
|---|---|
| lint / build / `...flywheel-config` typecheck | exit 0 / 0 / 0 |
| `opus-model-sync` + CLI + flag-store-runtime | 85/85 |
| 种子 / 发布 / 迁移 / 菜单 / 管理台写入器等消费者(45 文件) | 928 passed;唯一红 `fly1674-opus46-real-tmux`「carries …」在改动前同机基线同样红(真 tmux socket 路径) |
| flag 注册表消费者(teamlead 33 文件) | 626/626 |
| config 包 | 904/905;`repository-baseline` 要求干净工作树,脏树下既有现象 |
| token-usage 包 | 177/177 |
| shell | updater 54/0 · shuttle-unit 全过 · fly241 Lead 解析 19/0 · fly2102 flag freeze 46/0 · fly2103 通过 · 盘点 4/0 · Fable sync 19/19 |

### 6.8 Codex 代码评审 R2(`b1d1f58d3`)与处置

R2:3 BLOCKING + 2 MEDIUM + 2 LOW。处置原则是做减法 —— 三条 BLOCKING 里两条出自同一个「持久通知队列」状态机,
修补它只会再长新状态,所以把队列整个拿掉。

| R2 条目 | 处置 |
|---|---|
| BLOCKING 1:CLI `process.exit` 让未 unref 的 SIGKILL 定时器永远不触发,忽略 SIGTERM 的孙进程存活 | `runBounded` 一旦开始终止,**等进程组确认消失**(每 25ms 探 `kill(-pgid,0)`,到宽限期直接 SIGKILL)才 resolve。新增**进程外**用例:harness 在 `runBounded` 返回后立即 `process.exit`,断言孙进程已死;把修复撤掉该用例变红(反证) |
| BLOCKING 2:并发 sync 抹掉已提交的通知 | 不再有通知队列。告警由 `observeAndAlert` 每次从 authority 推导;sync 自己写状态时只写探测缓存,**水位字段重读磁盘**不回退(新用例模拟并发播报) |
| BLOCKING 3:rollback_failed 后,旧的 prepared 成功通知被后续运行提升为成功告警 | 不再有 prepared 通知。成功告警只在 authority 为「成对且可派工」(consistent)时才推导;rollback_failed 作为**事件**随结果返回,CLI 直接投 severe |
| MEDIUM:关闭开关时 prepared 通知永不结算 | CLI 在读开关**之前**先跑一次推导;关闭期间别的写入者造成的版本变化照常播报(CLI 用例) |
| MEDIUM:菜单回执与 run 实际钉住的模型可能不一致 | 路由在拿到 run 快照后用 `pinMenuReceiptsToRun` 按快照重建回执;新用例用真实物化快照验证 |
| LOW:`state_write_failed` 不在告警原因集合 | 该原因随队列一起删除 |
| LOW:B5 用例没走 run/launch 路径 | 新增 `workflow-dispatch-resolution` 用例:生产形状(`opus` 绑 5)下 `opus` 节点物化钉 `claude-opus-5`、启动解析 `pinned_snapshot` 派 5;绑定推进后旧 run 仍 5,新 run 钉 5.5 |

本地验证(只跑相关文件):sync + CLI 64/64(含进程外用例);菜单 / 模型分配 / DAG 入口路由 / flag-store-runtime
合计 217/217;`workflow-dispatch-resolution` 15/15;config flag 注册表 + 漂移 69/69;lint、`flywheel-teamlead...` build exit 0。

⚠️ 如实披露:按角色规则对 `workflow-menu.ts` 跑 `vitest related`,因它被 `runs-route` 引入,依赖图几乎覆盖整包,
实际等于一次整包运行(25 分钟超时被杀,违背「本机不跑整包」的初衷,之后不再对这类枢纽文件跑 related)。
其中红的文件都与本次改动无关、是宿主环境问题:长 TMPDIR 下 unix socket `listen EINVAL`(voice-self-filter-probe、
codex-lead-subscriptions-cli)、宿主环境变量 `FLYWHEEL_CODEX_LEAD_WORKSPACE` 串入(codex-lead-runtime FLY-350 组),
以及既有基线红 `fly1674-opus46-real-tmux`、`default-parent-integration`;`parity-drill`、`lifecycle-closeout` 各 1 条,
未在本机逐条归因,交 exact-head CI 判定。

### 6.9 Codex 代码评审 R3(`20f2ccf27`)与处置

R3:3 BLOCKING + 2 MEDIUM + 2 LOW,全部落在告警子系统与 `runBounded`;派工 / 回执 / 钉死路径 Codex 确认正确。
按规则第 3 轮打回即分档报 Lead(问 ea64726f):Lead 同意只修 R3 所列、不加新机制、L1 进 Follow-ups、走限定范围的 R4。
版本变化告警是 founder 9-23 原话要求的护栏,保留。

| R3 条目 | 处置 |
|---|---|
| B1 状态文件不可写 ⇒ 基线静默丢失,5→5.5 告警永久丢;且没有保留 `{from,to,时间,送达}` 记录 | 每次运行先重写一次状态文件探可写;不可写 ⇒ CLI **不推进 authority**(`state_unwritable`,属于告警原因)。送达的变化记入有界 `history`(最近 20 条) |
| B2 rollback_failed 之后观察者仍可能宣布成功 | 观察者与事务**共用一个判定** `opusAuthorityIsCoherent`;另把 rollback_failed 持久化为 `rollbackFailure` 标记,标记未被「之后某次通过校验的 sync」解除(`resolvedAt`)前,不推导任何成功告警 |
| B3 rollback_failed 的 severe 告警只投一次 | 标记里带着告警,每次运行未送达就重投,送达记 `deliveredAt`;送达且已解除才删除标记。只有标记写不进去时才交回 CLI 直投 |
| M1 两个重叠观察者可回退水位 | 水位 compare-and-set:只有磁盘上仍是本次读到的 `from` 才推进 |
| M2 正常退出时同进程组的残留后代不被清理 | `runBounded` 在任何退出后都查进程组:正常退出直接 SIGKILL 残留;超时/溢出先给 SIGTERM 宽限 |
| L1 回执用例只测到 helper,没测路由 | 进 Follow-ups(Lead 裁定) |
| L2 flag `whenOn` 文案仍写「已排队」 | 改为「版本变化与回滚失败告警仍按 models.json 与状态文件照常发出」,同步注册表用例 |

反证:新增 6 条回归用例在 R3 前的 `opus-model-sync.ts` 上全部变红,修复后全绿。
本地(只跑点名文件):sync + CLI + flag-store-runtime 107/107;config flag 注册表 + 漂移 69/69;lint、`flywheel-teamlead...` build exit 0。

### 6.10 Codex 代码评审 R4(限定轮,`1c0dd173a`)与处置 —— 最后一轮

R4 确认 M2、L2、状态不可写守卫、B2/B3 顺序场景已修;重提 M1/B2/B3/B1 的并发与极端组合形态(3 BLOCKING + 1 MEDIUM)。
触发 Lead 的上限条件,停下问(问 40303c01)。Lead 选 A 且明确是最后一轮:只做下面四项,每项一条先红后绿用例,R5 只核这四项,
R5 后无论结果停下问,剩余项由 Lead 用 review-ruling 收口进 Follow-ups。

| R4 条目 | 处置 |
|---|---|
| BLOCKING 1 状态读改写无跨进程锁,旧写者可覆盖新水位 / history / 回滚标记 | **整次 CLI 运行一把排他锁**(`<state>.lock`,O_EXCL 写 pid,持有进程已死即判陈旧、回收一次)。有活持有者 ⇒ 本次什么都不碰(`sync_in_progress`);建不了锁 ⇒ 只投递不推进。用锁消掉整个并发类,不再加 CAS |
| BLOCKING 2 回滚标记没写进去 + 直投失败 ⇒ 同次运行随后宣布成功 | 该情形下本次运行的收尾观察 `announce:false`,不从未校验的 authority 推导成功告警 |
| BLOCKING 3 重叠场景下,水位写被拒的那条已送达变化没进 history | 送达即记 history;只有水位受「仍是本次读到的 from」约束 |
| MEDIUM 状态目录不可写时,已持久化的回滚告警当次不重投 | 返回 `stateWritable:false` 之前先投未送达的回滚告警(记不了 `deliveredAt`,下次可写时同签名再投、下游去重) |

反证:5 条新/加强用例在 R4 被审的两个模块上全红,修复后全绿。本地(只跑点名文件):sync + CLI + flag-store-runtime 111/111;lint、build exit 0。

### 6.11 收口:R5 裁定 + Bridge 代码复审

- **R5**(`115db0293`)确认第 3、4 项关闭;第 1 项(陈旧锁回收竞争)与第 2 项(同次运行三重故障的跨运行后果)仍被 Codex 判阻塞,
  **Lead 裁定驳回**(问 ef4342de:生产为单例 updater + 至多一次手动运行;第 2 项为三重故障边缘),原样进 Follow-ups F1/F2。
- 五轮 companion 复审都不在 Bridge 登记,Lead 拒绝把 R5 写成 APPROVED 的 `code-review.json`(问 38395416),改走 Bridge 复审:
  `request-review` 1458e9d5 → **APPROVED**,无新阻塞,6 条非阻塞(2 MEDIUM + 4 LOW)。
- Lead 裁定只修两条 MEDIUM(问 5f27227e),各一条先红后绿用例:
  - [0] 第二次推进后,上一代 Opus 在所有选择器里仍可选(违反 FLY-1496)⇒ 每次推进把 overlay 里其余 Opus 代的 `selectableSurfaces` 置空,仍可按 id 派工;
  - [1] 停用开关读不到时放行 ⇒ 读不到按「已停用」处理;updater 传 `--db`(`TEAMLEAD_DB_PATH` 或 `FLYWHEEL_HOME/teamlead.db`)。
  其余 4 条 LOW 进 Follow-ups。本地:sync + CLI + flag-store-runtime 113/113;updater 源测 54/0;lint、build exit 0。

### 6.12 QA@2 FAIL(claim 1425)返工 —— implement attempt 3

QA 实测 B1(判据 3 跟最新)端到端通过、B2 已修;FAIL 全部来自**新代码没登记进既有守卫清册**(exact-head CI 4 条红)。
按 Lead 指令只修 B3–B6 + N2,N1 进 Follow-ups:

| 条目 | 处置 |
|---|---|
| B3 Quick Gate:新 shell 套件不在 ci.yml 枚举(CI 里从没跑过) | 加入 `FLY-1496 model resolution + Lead derivation` 步骤;`ci-shell-suite-enumeration` / `ci-structure` / `ci-scope` / `ci-classify` / `ci-matrix-coverage` 全绿 |
| B4 子进程清册差 1 条 | `child-process-census.json` 登记 `opus-model-sync.ts` raw_spawn=1(`one_shot_cli`) |
| B5 kill 点清册差 10 条 | `kill-path-inventory.json` 用清册扫描器重生成,diff 仅新增这 10 条(源码 4 条、测试 6 条) |
| B6 required 检查里有墙钟上限断言 | 改为断言状态:`timedOut` 且子进程被信号结束 |
| N2 停用开关注释与行为不符 | 注释改为「缺行 / 不可读 ⇒ 按 disabled」;行为不变 |

本地(只跑对应守卫与测试文件):5 个 CI 结构守卫全绿;`fly2775-opus-inventory.test.sh` 8/0;
census + kill-path + wall-clock 守卫 + opus sync/CLI 全绿;lint exit 0。

### 6.7 Follow-ups(不在本单)

1. 从会话记录回填**实际服务**模型并与请求派工 id 比对告警(Lead 裁定 (a),问 e6ffc4ce)。
2. Fable 种子同样存全名,也会冻结在旧版;是否同样保留别名,另开单。
3. `claude-opus-5[1m]` / `claude-opus-4-8[1m]` 历史费率缺口。
4. 菜单回执重建补一条**路由级**用例(Codex R3 L1;当前用例只到 `pinMenuReceiptsToRun`,路由接线靠静态核对)。
5. F1:运行锁的回收做成并发安全(原子发布 pid + 改名后核对),补多进程抢锁用例(Codex R5 第 1 项,Lead 驳回)。
6. F2:未记录的回滚失败连告警也发不出时,下一次运行会宣布未校验的推进 —— 在状态目录外留兜底标记或在校验前拒绝推导成功(R5 第 2 项,Lead 驳回)。
7. Bridge 复审 1458e9d5 的 4 条 LOW:盘点闸缺「有意钉死」类别;非 `claude-` 的 modelUsage 键被当作原因;探测继承调用方环境;菜单别名保留区分大小写。
8. QA@2 N1:宿主 `~/.flywheel/models.json` 仍绑 `claude-opus-5` 时(部署窗口),`packages/flywheel-comm` 有 10 条真 CLI / 真 socket 用例因 `[model_config] tier … ignored` 告警红;隔离 HOME 下全绿。按 lead-note-e2e 的做法给这些子进程钉 HOME。
