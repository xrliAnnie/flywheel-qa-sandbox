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

## 2. 部署窗口的两个可观察后果(必须让 Lead 知道)

代码合入并重启后、`~/.flywheel/models.json` 被改之前,生产那份文件里
`tiers.medium/light/trivial = "claude-opus-5"` 会被**忽略 + 警告**(tier 校验要求 `dispatch` 面,
legacy 条目没有)。实测两处可见:

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

**结论**:部署步骤 2(改 models.json)必须和重启放在同一次维护动作里,plan §5 已这么写。
推荐做法仍是**删掉**那五项覆盖,让内建默认当家。

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
共 **121 行 / 44 个文件**(`git grep -n 'claude-opus-5' | grep -v 'claude-opus-5-5'` 实数),
全部属于「历史 id / 任意夹具值」类,**有意保留不动**,其中一部分正好构成判据 4 的现成回归。代表性的:

- `packages/config/src/model-builtins.ts` 的 `MODEL_IDS.OPUS_5`(身份常量,值永不改)
- `model-binding` / `model-config` / `model-registry` / `model-tiers` 里的 legacy 断言
- `phase-roles.test.ts`、`StateStore.land-*`、`StateStore.workflow-claims` 等的夹具串
- `fly1650-companion-effort.test.sh` 的透传夹具(不解析绑定)
- `TmuxAdapter.test.ts:1745` 的 `/^claude-opus-5/` 正则(对 5.5 仍成立,有意不收紧)

**未检查的 root**:无。本单未净删或改名任何 `flywheel-comm` 子命令,故不触发 CLI 合同 sweep(FLY-1914)。

## 5. 未做(留 follow-up)

1. `claude-opus-5[1m]` / `claude-opus-4-8[1m]` 的历史费率缺口(`MODEL_RATES` 无键 ⇒ $0)。
   pre-existing,Gemini R1 建议顺手补,**未采纳**(越界)。
2. 不放宽 legacy 条目的 `surfaces`,所以 `tiers.* = <退役 id>` 仍被拒 + 警告。
   若将来希望 tier 层也能显式回滚到上一代,那是单独一个决定。
3. 生产 `~/.flywheel/models.json`、Bridge 重启、两个 founder-owned 模板的重新发布
   —— 全部是 Lead 的部署动作,见 plan §5。
