# FLY-2080 巡检升级 — QA 补测报告(founder 8-27 05:36 退回)
Issue: FLY-2080 (https://linear.app/geoforge3d/issue/FLY-2080/巡检升级-发现即补账推进-病根记录进-epic所有-lead-巡检强制两步founder-8-26-直令)
日期: 2026-08-27
基于: qa-report.md(首轮)、plan.md

## 0. 本轮范围

Founder 2026-08-27 05:36 UTC 退回,原话:

> 「两件事:一是没有真的在 FLY-2072 底下建过子 issue 或写过 comment;二是没有跑过一次真实的定时巡检,看真 Lead 会不会照着新规则做。这个是必须要补测的你可以在 Linear 里面的 issue 底下写清楚,说这个只是测试用的」

Lead 授权的补测 scope 两项:**(1) 真实建账一次**、**(2) 真实巡检一次**。其余首轮已验部分不重测(见 `qa-report.md`)。

被测 head:第一轮 `c23cb7a52`;复测 `29370f272`(= 当前 `origin/flywheel-FLY-2080`)。

> **最终结论:PASS(复测,head `29370f272`)。** 见 §7。
> 下面 §3 记录的是复测前那一轮的 FAIL 与其阻塞项,**原样保留**作为过程账,不是当前状态。
>
> **(历史)第一轮结论:FAIL(阻塞项 1 条)。**
> 两项补测本身**都跑通了**(见 §1 / §2,作为 FAIL 内的 PASSED sub-item 保留),
> 但这一轮真实运行把一条**确定性、在成功路径上**的缺陷顶了出来:
> 规则的**建单模板**与规则的**查重语句**互相矛盾 —— 照模板建的病根子 issue,
> 下一次同类复发时**必然搜不到**,于是静默新建重复单,founder 要的「重复出现 ×N」永远不累加。详见 §3。

---

## 1. item 1 — 真实建账一次(通过)

全部是真 Linear workspace + 真生产 Bridge,不是 fixture、不是 mock。

### 1.1 真实对象

| 项 | 值 |
| --- | --- |
| 病根子 issue | **FLY-2081** `[病根] ⚠️测试用-receipt死结-delivery与run同时held · ×2` |
| parent | `FLY-2072`(真 Epic) |
| team / labels | `FLY` / `Flywheel` |
| 创建时间 | 2026-08-27T05:43:44Z |
| 重复实例 comment | `a89316a8-5bdc-4f03-af1d-4f0048c56855`(2026-08-27T05:45:14Z) |

「测试用」标注落在**三处**:标题(`⚠️测试用`)、描述首段(`⚠️ 测试用 · 可删 …… 不是一个真实发生的病根`)、实例 comment 首行。符合 founder「在 Linear 里面的 issue 底下写清楚,说这个只是测试用的」。

### 1.2 规则形状逐条核对

| 规则要求 | 实测 |
| --- | --- |
| 标题 `[病根] <稳定短名> · ×N` | OK |
| description 四字段 `形状/根因/处置/首见时间` | 四项全部 present |
| `occurrences: N` 与标题 `×N` 一致 | `occurrences=2`,标题 `×2` |
| `class_key:` 为 64hex | `0601f60b…d598d551`,len=64,`^[0-9a-f]{64}$` OK |
| `patrol-finding:` marker 可回读 | 描述与 comment 各一条,末段均为 64hex |
| 首次不写 comment / 重复才写 comment + 加计数 | 1 条实例 comment + `occurrences=2`,与「首次(1,无 comment)→ 重复(2,+1 comment)」一致 |

### 1.3 identifier → UUID receipt 全链路(规则原文命令,真 Bridge)

```sh
CHILD_IDENTIFIER='FLY-2081'
CHILD_LOOKUP_JSON="$(printf 'header = "Authorization: Bearer %s"\n' "$TEAMLEAD_API_TOKEN" \
  | curl --config - -fsS --get --data-urlencode "query=$CHILD_IDENTIFIER" "$BRIDGE_URL/api/linear/issue")"
CHILD_UUID="$(printf '%s' "$CHILD_LOOKUP_JSON" | jq -er --arg identifier "$CHILD_IDENTIFIER" \
  'select(.matchType == "identifier" and .issue.identifier == $identifier) | .issue.id')"
```

结果:`matchType=identifier`,`CHILD_UUID=75e56d92-00a4-4cf2-bb9c-e2c28bb60a00`,UUID 正则通过。
交叉核对:Linear GraphQL 直查 `FLY-2081.id` 返回同一串,逐字相同 —— Bridge 精确读口没有拿别的 issue 顶包。

这正是实现期 `b34dc1fd8 fix(FLY-2080): resolve child issue receipt UUID` 要修的那条链(Linear MCP 的 `id` 是 `FLY-<number>` identifier,不是完成门要的 UUID)。

### 1.4 完成门真实通过 + 反向突变

用上面两个**真** receipt(首次=child UUID,重复=comment UUID)组一份报告,跑规则里的两道门:

| 门 | rc |
| --- | --- |
| `# FLY-2080-FINDING-GATE`(awk finding validator) | **0** |
| STEP/PANE 完成门(step count + pane evidence + 禁用词) | **0** |

只证「能过」不够 —— 门必须能红。逐条突变(每次只改一处),FINDING-GATE 全部 `rc=1`:

| # | 突变 | rc |
| --- | --- | --- |
| M1 | `epic=FLY-2072#FLY-2081`(拿 identifier 冒充 receipt UUID) | 1 |
| M2 | `result=known-waiting`(founder 点名禁止的归档值) | 1 |
| M3 | `epic_marker` 截成 8 hex | 1 |
| M4 | `bridge_problem=yes` 却 `epic=n/a epic_marker=n/a` | 1 |
| M5 | `result=fixed` 却带 `owner=founder next=inspect:x` | 1 |
| M6 | `epic=unavailable` 但缺 `UNAVAILABLE_CAUSE … linear_epic_unavailable` | 1 |
| M7 | UUID 末位改成非 hex 字符 `z` | 1 |

M1 是本轮最关键的一条:它就是 founder 要求「验证 identifier→UUID receipt 全链路」的失败方向,门确实拦住。

---

## 2. item 2 — 真实巡检一次

本项分两条腿跑,一条测**真 Lead 拿到新规则后的实际行为**(生产,真 finding、真修、真接力),一条测**新规则真的被注入进 Lead 的活 bundle**(529 QA 房,零生产污染)。两条腿的成色分别标注。

### 2.1 腿 A — 生产真 Lead 按新规则跑一次真 tick(flywheel-eng-lead / Tadashi)

前置事实(结构性,先说清楚为什么不能直接用生产的例行 tick 当证据):生产 Lead 当时活着的 bundle
`flywheel-flywheel-eng-lead.3028-lstart-35c2994438c7a4f6.md`(generatedAt 2026-08-27T06:09:35Z)里
`FLY-2080` 命中数 = **0** —— 它 source 的是 `~/Dev/flywheel`(main `b889c4b6`)的规则文件,而本改动还没合。
所以 05:52:40Z 那份例行 tick 虽然是真的,但跑的是**旧**规则,且 STEP 1-6 全 OK、零 finding,不构成
「按新规则做」的证据。Lead 因此以本 worktree `c23cb7a52` 的规则文件为本 tick 的权威,逐字执行。

被巡检出的 finding 是**当晚真实发生**的,不是造出来的:22:59 PT 整机重启后,FLY-2029 的 run
`5ae599c6` 的 rework 卡在 `persisted_target_missing` 空转 —— 首选执行体 `83d58a6f` 的 pane 已死,
但它的 session 状态是 `ship_parked`,既不在 zombie 检测器扫的 `running` 集合里,也不满足换体所需的
irreversible-terminal 前置,于是引擎既不换体也不推进。

**步骤 A 实测(我自己去 append-only 账本量的,不是采信 Lead 的报告):**

| 时刻 | `workflow_run_event` | exec |
| --- | --- | --- |
| 06:33:25 – 06:40:26 | `rework_held_recovery_failure` × 4(seq 269/270/271/272) | 83d58a6f |
| 06:47:19 | `workflow_node_session_divergence` × 2(seq 273/274) | 83d58a6f |
| **06:48:26** | `execution_dead_rolled_back`(275)→ `rework_replacement_materialized`(276)→ `rework_replacement`(277) | 83d58a6f → **39629d3a** |
| 06:48:26 – 06:48:31 | `dispatch_vendor_resolved`(278)· `execution_admitted`(279)· `activation_turn_granted`(280)· `turn_granted`(281)· `issue_delivery_prepared`(282)· `issue_delivery`(283) | 39629d3a |
| **06:48:32** | `rework_replacement_launched`(285)· `rework_stall_recovered`(286) | 39629d3a |

`workflow_run 5ae599c6` 现状 `status=active`(此前 held)。

这条正是 founder 要的「发现即补账推进」:Lead 没有把它归档成「已知,等着」,而是先读源码守卫条件
(`isStateStoreIrreversibleTerminalForZombie` 与 zombie 检测器只扫 `running` 之间的缺口),
判定它属于**挡漏账**而非**挡篡改**那一类,再用规范端点 `POST /api/actions/terminate` 把死体标终态,
然后**让引擎自己接力**。接力证据是 baseline 之后新增的 `seq/kind`,不是 `changes()==1` 自证 —— 符合规则第 4 条。

**步骤 B 实测:** 新建类别子 issue **FLY-2083** `[病根] ship_parked死体不被zombie检测→held-recovery自锁 · ×1`,
parent = FLY-2072,label = Flywheel,`class_key=9fa96d1a…d1a3bc`(合法 64hex),
`patrol-finding:20260827T064619Z-tickNA:3:1:35846946…045fb3`(合法 64hex),四字段齐全。**这条 PASS。**

同一 tick 还产出跨界聚合子 issue **FLY-2084**(product-lead 名下 runner 的 legacy 复活路径缺陷,
Lead 按契约「报账不处置」)。这两张单在本轮中途都有过缺陷,已在我提出后由 Lead 修正,过程见 §2.3。

**封口版报告与两道门(我自己复跑,不是采信 Lead 的结论):**

`REPORT_PATH = ~/.flywheel/patrol-reports/flywheel-eng-lead/20260827T064619Z-tickNA.md`
(md5 `4072de4e6b05f79c89db0909b9b5b5b7`)

```
STEP 1: OK / STEP 2: OK / STEP 3: FINDING / STEP 4: OK / STEP 5: OK / STEP 6: OK
FINDING step=3 bridge_problem=yes result=advanced
  evidence=fly2029_rework_a1e6b647_shipparked_deadbody_83d58a6f_terminated_06:47_replacement_39629d3a_06:48
  owner=n/a next=n/a
  epic=FLY-2072#47391660-8cba-40f7-affd-4689261da782
  epic_marker=35846946b0488c8b1b69d273183377a6ccbb905cb0253819426ff6449b045fb3
```

| 检查 | 结果 |
| --- | --- |
| 完成门 1(FINDING validator) | **rc=0** |
| 完成门 2(steps=6 panes=5 evidence=5 well-formed=5) | **rc=0** |
| `epic` 里的 UUID = FLY-2083 真 UUID | 是(Bridge 精确读口与 Linear GraphQL 两条独立路径同值) |
| `epic_marker` 在 FLY-2083 描述里可回读 | 是,逐字命中 |
| FLY-2083 形状 | parent=FLY-2072 · label=Flywheel · 标题 `[病根] … · ×1` · 四字段齐 · `class_key=9fa96d1a…d1a3bc` 合法 64hex |

这就是 founder 点名要看的那条链在**生产真实巡检**里被走通一次:
finding → 补账推进 → 引擎接力 → 病根子 issue → identifier→UUID receipt → 完成门。

### 2.2 腿 B — 529 QA 房:新规则真的被注入进真 Lead 的活 bundle

从本 worktree 起 slot 2(`scripts/test-deploy.sh 2 --generalized --stub-runner --lead-label Flywheel`),
真 Lead `flywheel-test-2` 由本分支的 `claude-lead.sh` 启动。它实际加载的 materialized bundle:

| 检查 | 实测 |
| --- | --- |
| `FLY-2080` 命中数 | **31**(两次独立部署都是 31,可复现) |
| `FLY-2080-FINDING-GATE-BEGIN` / `-END` | 1 / 1 |
| 步骤 A / 步骤 B 标题 | 均在 |
| founder 原话「让所有的巡检都带上这两个步骤」 | 在 |
| `known-waiting` 禁令 | 在 |
| `runner-patrol-rules.md` 在 bundle 中的序位 | **11/19**,紧跟 `xiaohongshu-memory-rules.md` —— 与新 `lead-rules-bundle.sh` 的顺序一致 |
| source 路径 | `/Users/xiaorongli/Dev/flywheel-FLY-2080/packages/teamlead/scripts/../lead-rules-base/runner-patrol-rules.md` |

这条同时把 `claude-lead.sh` 内联组装与 `lead-rules-bundle.sh` resolver 的**顺序 parity** 用真启动产物验了一遍
(不是只靠 `lead-rules-bundle.test.ts` 的断言)。角色边界另用 resolver 实跑:`dept`=1 份 patrol 规则,
`cos`=0,`companion`=0 —— 与 `claude-lead.sh` 新加的 `IS_COS_ROLE != true && IS_COMPANION_ROLE != true &&
IS_EXTERNAL_ROLE != true` 条件一致。

#### 真 tick 与两道门(slot Lead 自己跑完的,我没有代笔)

要让 slot 收到真 tick 有三个前置条件,前两次尝试都被它们挡住,一并记下(这三条不是 FLY-2080 的伤,是 529 房的既有形状):

1. **空 roster 不铸 tick** —— `packages/teamlead/src/bridge/patrol-tick.ts:221-226`,`roster.length === 0` 直接 `continue`。
   刚起的 slot `sessions_count=0`,永远等不到 tick。
2. **`match.labels=["*"]` 不是通配** —— `classifyIssue` 要字面 label 命中,所以 `/api/runs/start` 恒返
   `DEPT_SCOPE_REJECT / issue_no_department_label`。要 `--lead-label <真 label>` + 带该 label 的 issue。
3. **非 generalized 房再撞 `DAG_ENTRY_NOT_MATERIALIZED`**;而 generalized 房里 `inject-linear-issue.sh` 被显式禁用,
   要走 `scripts/qa-529-generalized-e2e.mjs`。

补齐后真 `patrol_tick` 铸出,slot Lead 独立跑完并封口。最终报告
`/tmp/flywheel-test-slot-2/q/2/patrol-reports/flywheel-test-2/20260827T064518Z-tickNA.md`:

| 项 | 实测 |
| --- | --- |
| STEP 1-6 全部封口 | `FINDING / OK / FINDING / FINDING / UNAVAILABLE(structural: chat_threads_disabled) / UNAVAILABLE(transient: linear_epic_unavailable)` |
| `FINDING` 行 | 6 条,`bridge_problem=yes` |
| `result` 取值分布 | **6/6 = `escalated-with-plan`**,零条 `known-waiting` 类 |
| 每条都带 owner + 有限动词 next | 是(`owner=founder`,`next=inspect:… / authorize:… / repair:…`) |
| 完成门 1(FINDING validator) | **rc=0** |
| 完成门 2(STEP/PANE:steps=6 panes=5 evidence=5 well-formed=5) | **rc=0** |

行为上最值得记的一条:它读完附录 A 与附录 B 的 precondition 后判定**都不满足**
(证据 token 里直接写了 `appendixA_rows0:appendixB_rows0`),于是按规则「任一 recipe precondition 不满足时
不得硬拨」走升级路径 —— 既没有硬拨库,也没有写「已知,等着」。这正好补上腿 A 没覆盖的那半:
腿 A 演示的是**能修就修**(`advanced`),腿 B 演示的是**修不了就带可执行 plan 升级**(`escalated-with-plan`)。

### 2.3 本轮中途判出的两条缺陷 —— 都已在我提出后被修掉,过程原样保留

这一节是本轮补测最有价值的部分:founder 那句「看真 Lead 会不会照着新规则做」问出来的东西,
一半是「会照做」,另一半是「照做的过程里会怎么错」。两条都在**封口前**被抓出并修正,修正后的状态见 §2.1。

**(a) receipt 全部退化成 `epic=unavailable` —— 真因是 Lead 侧的 jq 字段路径,不是规则。**

中途状态:生产 Lead 与 529 slot Lead 的 `bridge_problem=yes` finding **全部**写
`epic=unavailable epic_marker=n/a` + `UNAVAILABLE_CAUSE ... linear_epic_unavailable`。
也就是那一刻,`epic=FLY-2072#<uuid>` 这条 receipt 路径一次都没被走通。我做了带对照的诊断把两边分开:

| 格 | 观测 |
| --- | --- |
| Linear MCP 端点本身 | 真 key + `Authorization: Bearer <key>` 打 `initialize` → **http 200** 正常握手 |
| 同请求换裸 key(不加 `Bearer`) | **http 401** `invalid_token` |
| 生产 Lead 进程(pid 85554)env | **有** `LINEAR_API_KEY` |
| 529 slot Lead 进程(pid 35650)env | **没有** `LINEAR_API_KEY` |
| 我这个 runner 会话 | 没有 → 开局即 linear-api MCP `AUTH_HEADER_REJECTED` 401,与上一行一致 |
| Bridge 精确读口对两张新子单 | `FLY-2083 → 47391660-…`、`FLY-2084 → ce3287a4-…`,**都通** |

- **slot Lead 那条 `unavailable` 是诚实且正确的**:它的 MCP 里 `${LINEAR_API_KEY}` 展开成空,必然 401,
  规则要求此时必须报 `linear_epic_unavailable` 而**不得假装记账成功** —— 它照做了。这是新规则被正确执行的**正面**证据。
  副产品是 529 房的一个 provisioning 缺口(见 §4)。
- **生产 Lead 那条不适用这条解释**(有 key、且真建出了子 issue),我把这个矛盾点交回给他。
  他自查后的答案:**是他的 jq 读了顶层 `.id` 而不是 Bridge 响应里嵌套的 `.issue.id`**,拿到 null 就判 unavailable。
  他同时撤回了自己早先「Linear 索引滞后 / 规则不可执行」的假归因。回填真 UUID + marker、删掉 UNAVAILABLE_CAUSE 后,
  §2.1 那条链就通了。

  **我这里也有一次归因错误,如实记下**:我当时已量到规则第 210 行要求复核 `team=FLY`、而 MCP 实返
  `team="Flywheel"`(返回体里根本没有 `teamKey` 字段),就把它当成了他 `unavailable` 的原因发了出去。
  这是错的 —— 反证在我自己手里(我跑同一条链用的就是 `.issue.id`,一次就通),我却没先问「他和我差在哪一步」。
  该测量本身仍然成立,但它的分量见 §4。

**(b) FLY-2084 的机器元数据一度是占位符。**

中途状态:

```
class_key:7d3b1c9a2e5f4086abod... SEE NOTE      ← 32 字符、含非 hex 的 o、带字面量 SEE NOTE
patrol-finding:20260827T064619Z-tickNA:2:1:0000…00cb   ← 格式合法的 64hex,但不是任何三元组的 sha256
```

规则明写「标题只帮助人读,`class_key` 才是去重权威」。假 `class_key` 会让下次同类复发时精确搜 0 命中 →
走首次分支 → 再建一张同类子 issue,founder 要的 `×N` 计数从此对不上。
Lead 接受后的处置:这条是五个子机制的跨界聚合,本来就凑不出单一三元组,因此**不设 `class_key`**、
标为跨界聚合索引,五个子机制各由 owner 在复发时单独 keyed。
按规则那条精确搜是搜 `class_key:<ROOT_KEY>`,没有 `class_key` 的对象永远不会被匹配,所以它**不污染去重集**。
我认可这个处置,并把它记录为「一条 off-spec 但无害的 Epic 子对象」。

**(c) 由 (a)(b) 共同暴露的一个设计事实(Lead 与我共识,不藏进「已验证」)。**

完成门只校 `FINDING` 行的字段格式,**不回读 Linear**:它不校 `class_key` 是不是
`sha256(ERROR_CODE|GUARD_KEY|STRUCTURAL_SHAPE)`,不校 `epic` 里的 UUID 是不是真属于那张子单,
也不可能校 `UNAVAILABLE_CAUSE` 那条 cause 是真是假。今晚这两条缺陷**都过了门**
(jq 误判落 unavailable 过门;占位符 marker 凑成合法 64hex 过门)。形状是:**门为绿,账为空**。

这不在 FLY-2080 的验收条款里(验收只要求 `result` 枚举 + 拒 `known-waiting`,那条实测是过的),
所以**不作为 FAIL 依据**;但它就是 founder 这次退回想看到的东西,交她决定要不要排一条后续。
可行修法(Lead 提、我认同):门增加一次 Linear 回读,校 `class_key == sha256(triple)` 且 `epic` UUID 真属该子单。

---

## 3. 阻塞项 —— 照模板建的单,规则自己的查重语句搜不到(FAIL 依据)

### 3.1 规则里那两句互相矛盾

**建单模板**(`runner-patrol-rules.md`,本 diff 新增)规定 description 的顺序是:

```
形状: …
根因: …
处置: …
首见时间: …

occurrences: 1
class_key:<ROOT_KEY>
patrol-finding:<report>:<step>:<ordinal>:<64hex>
```

`class_key` 天然落在**正文之后**。而**查重语句**规定:

> 用 `mcp__linear-api__list_issues({team:"FLY",parentId:"FLY-2072",includeArchived:true,limit:250})`
> 只查 FLY-2072 的子 issue……然后在 **description** 中精确找 `class_key:<ROOT_KEY>`。
> 匹配 0 张走首次;恰好 1 张走重复。

规则同时又写死了「标题只帮助人读,`class_key` 才是去重权威」。

### 3.2 实测:`list_issues` 会截断 description

直打 Linear MCP(真 key、真 workspace、非模拟),对 FLY-2072 的四张子 issue:

| identifier | `list_issues` 返回的 desc 长度 | 该视图里含 `class_key` |
| --- | --- | --- |
| FLY-2081 | 502 | **否** |
| FLY-2082 | 500 | 否 |
| FLY-2083 | 500 | 是 |
| FLY-2084 | 502 | 否 |

每一条的尾部都带明文标记:`… (truncated, use `get_issue` for full description)`。

再用 GraphQL 取**未截断**全文,量 `class_key` 的字节偏移:

| identifier | 全文长度 | `class_key` 偏移 | 在 `list_issues` 视图里可见? |
| --- | --- | --- | --- |
| **FLY-2081**(严格照模板建) | 713 | **532** | **不可见** |
| FLY-2083 | 1337 | **0**(写在第 1 行,偏离模板) | 可见 |
| FLY-2084 | 2165 | 无 `class_key` | — |
| FLY-2082 | 1229 | 无 `class_key` | — |

关键在 FLY-2081:它是本轮**严格按规则模板**建的那张单,`class_key` 落在 532,超过截断点,
所以规则自己的查重语句在它身上返回 0 命中。
FLY-2083 之所以可见,只是因为 Lead 把 `class_key` 写到了第 1 行 —— 一个**偏离模板**的写法。

### 3.3 后果链(确定性,走的是成功路径)

```
照模板建单(class_key 落在尾部)
  → 下次同类复发,按规则跑 list_issues + 搜 class_key
  → 0 命中
  → 判为「首次出现」
  → 静默新建一张同类子 issue
  → occurrences 永远停在 1,标题永远是 ×1
  → founder 要的「哪些问题在重复出现」失去度量
  → 同类单越堆越多,最终撞 root_class_duplicate(>1 张则不再写任何一张)而卡死
```

founder 8-26 直令里那句「隔段时间可以 review 一下 Bridge 当前的问题到底在哪里、
**有哪些重复出现的问题**可以解决」,靠的就是这个 ×N 计数。它现在不会累加。

### 3.4 修法(交实现方,具体形状由他们定)

1. **(阻塞)查重必须读未截断源**:对 FLY-2072 的每张子 issue 逐个 `get_issue` 再搜 `class_key`;
   或把 `class_key` 提到 description 第 1 行**并且**保留一次 `get_issue` 复核。
   只把它提到第 1 行不够 —— FLY-2084 全文 2165 字符说明子单正文长度不受控,单靠位置约束会再次被越过。
   同时要改**模板示例**里 `class_key` 的位置,否则模板会继续教人写到尾部。
2. **(顺带,同一文件一行)** 第 210 行的 `team=FLY` 复核:MCP 实返 `team="Flywheel"`(团队名)且返回体没有 `teamKey` 字段;
   字面照做会把成功记账判成失败(见 §5-3)。
3. **(follow-up,本轮不做)** 完成门回读 Linear,校 `class_key == sha256(triple)` 与 `epic` UUID 归属(见 §2.3(c))。

### 3.5 我自己在这条上的失误,如实记录

我在拿到 §2.1 的证据后一度判了 PASS。当时我把注意力全放在「**这一轮**的 FINDING 有没有把 receipt 走通」,
没有回头问「**下一轮**还找不找得到这条账」。而 founder 这次退回要的恰恰是后者。
反证其实就在我自己的数据里:item 1 的 FLY-2081 是我亲手核过形状的那张单,它正是**照模板建、因此搜不到**的那一张。
是 Lead 把这条 BLOCKING 顶回来,我才回去量的。

---

## 4. 回归与 head

- targeted 回归在 exact head 重跑:`fly369-patrol-rule.test.ts` + `lead-rules-bundle.test.ts` = **41/41 通过**。
- 首轮已验部分(全仓 lint / build / 全包测试 / 检测面与频率不变)不重测,见 `qa-report.md`。

## 5. 诚实边界(没测的、测不了的、以及已知但没修的)

| # | 边界 | 为什么 | 风险 | 什么时候能补 |
| --- | --- | --- | --- | --- |
| 1 | **两个 SQL 配方附录没有被端到端执行过** | 生产那条 finding 属于另一类(`ship_parked` 死体),Lead 用的是 `POST /api/actions/terminate` 端点,不走附录;529 slot Lead 读了两个附录的 precondition,查库结果是 `appendixA_rows0 : appendixB_rows0`,即**前置条件都不满足**,按规则不得硬拨 | 附录的 SQL 语句本身(表名/字段/条件/事务/CAS)只被**读**过、被**当作判据查询跑**过,没有被真正拨过一次库。如果里面有写侧的错(例如 UPDATE 的 WHERE 少一个条件),本轮测不出来 | 下一次真的撞上 receipt 死结或 replacement 漏账时,由当值 Lead 执行并留 before/after 证据 |
| 2 | **529 QA 房测不了步骤 B 的端到端** | slot Lead 进程 env 里没有 `LINEAR_API_KEY`,linear-api MCP 必 401(三格对照已量) | QA 房里永远只能验到「Lead 会诚实报 `linear_epic_unavailable`」,验不到它在 Linear 里真建单/真查重/真加计数 | 给 529 房补 `LINEAR_API_KEY` 注入(是 529 房的 provisioning 缺口,不是本单的伤) |
| 3 | **规则第 210 行 `team=FLY` 与 MCP 实返 `team="Flywheel"` 不一致** | 我实测 MCP `get_issue` 返回体里 `team = "Flywheel"`(team 名),且**没有** `teamKey` 字段 | 规则紧接着写「任一不符都不得报记账成功」,字面照做的 Lead 会把成功记账判成失败。**对照数据:今晚这个真 Lead 并没有被它绊倒**,他拿着 `team="Flywheel"` 照样报了成功 —— 所以是一条**潜在**措辞陷阱,不是确定性缺陷 | 已于 2026-08-27 04:33Z 作为「ship 后 follow-up、不阻塞当前卡」存进 FLY-2080 评论;修法是一行措辞 |
| 4 | **完成门不回读 Linear** | 见 §2.3(c) | 门无法分辨真假 `class_key`、真假 `epic` UUID 归属、真假 `UNAVAILABLE_CAUSE`;今晚两条缺陷都过了门 | 需要新排期(Lead 已提修法) |
| 5 | **只跑了一个 tick,`×N` 重复计数路径没有在生产里被走过** | 生产这一 tick 的两条 finding 都是首次出现(`×1`) | 「同类再次出现 → 复用子单 + 加计数 + 写实例 comment」这条分支,只在 item 1 的测试对象 FLY-2081(`×2` + 1 条实例 comment)上验过,没有在真实巡检里自然发生过 | 下次同类病根复发时自然验到 |
| 6 | **harness deviation(我改了 529 房的东西,如实交代)** | slot 私有 state dir 的 `bin/` 里没有 `flywheel-patrol-snapshot`(它由 `scripts/converge-flywheel-bin.sh` 铸,`test-deploy.sh` 不铸),而规则 step 0 依赖它 | 我在 slot 内补了指向本 worktree `scripts/lead-patrol-snapshot.sh` 的 symlink(形状与生产 `~/.flywheel/bin` 一致),并在 slot 的 project config 里加了 `patrol.interval_minutes: 10`(hot-read、project-scoped)。**生产 `~/.flywheel/patrol.json` 一个字没碰,生产 tmux / Bridge 没碰。** 这两项都是让 529 房恢复生产形状,不是削弱被测面 | 已作为 follow-up 记在 FLY-2080 评论(06:37Z) |

另需说明:本轮生产 Bridge 在 07:00Z 前后短暂不可用,原因是 **00:00 PT 的例行 deploy shuttle 自更新重启**
(`origin/main` 从 `b889c4b6` 前进到 `f43d01cd`),日志末行是 `[review-coordinator] shutdown`。
不是本轮 QA 造成的,恢复后 `/health` `ok=true`。

## 6. 结论

**verdict:FAIL** —— 阻塞项 1 条(§3),ride-along 1 条(§3.4-2),follow-up 1 条(§3.4-3,本轮不做)。

### 已通过、不需重测的部分(FAIL 内的 PASSED sub-item)

founder 退回的两项补测**本身都用真对象、真链路跑过了**,不是 fixture:

1. **真实建账一次(§1)** —— FLY-2081 是 FLY-2072 下的真子 issue(标题/描述/评论三处标了「测试用」),
   形状逐条合规,identifier→UUID receipt 在真 Bridge 上跑通
   (`CHILD_UUID=75e56d92-00a4-4cf2-bb9c-e2c28bb60a00`,与 Linear 直查同值),
   两道完成门用真 receipt rc=0,7 条反向突变全红。
2. **真实巡检一次(§2)** —— 两条腿:
   - **生产真 Lead** 拿新规则跑了一次真 tick,撞上当晚真实发生的 `ship_parked` 死体死锁,
     **当场补账推进**、**引擎真接力**(seq 275→286 新事件、run 由 `held` 转 `active`)、
     **写进病根 Epic**(FLY-2083)、**receipt 绑定两条独立路径回读一致**、**两道门 rc=0**。
   - **529 QA 房**里由本分支 `claude-lead.sh` 真启动的 Lead,新规则**真的被注入**进它的活 bundle
     (31 处命中、序位 11/19、source 指向本 worktree),收到真 tick 后产出 6 条 finding,
     **6/6 `escalated-with-plan`,零 `known-waiting`**,两道门 rc=0,
     并且它的 `linear_epic_unavailable` 是**诚实**的(进程 env 无 Linear 凭据,三格对照已量)。

验收四条:规则含步骤 A/B 全文 + founder 原话(✅);完成门拒 `known-waiting` 类值
(✅ —— 突变 M2 红,两个真 Lead 共 7 条 FINDING 行零 known-waiting);
两个配方附录写全(✅ 文本层,端到端执行见 §5-1);不改检测面/频率(✅,首轮已验)。

### 为什么仍然 FAIL

因为**步骤 B 的账,下一轮找不回来**。照规则模板建的病根子 issue,
`class_key` 落在 `list_issues` 的截断点之后(实测 FLY-2081 偏移 532,截断在 ~500),
规则自己的查重语句必然 0 命中 → 静默新建重复单 → `×N` 永不累加。
founder 直令的第二步(「记录问题……这样我们隔段时间可以 review 一下……有哪些重复出现的问题」)
就是靠这个计数,它现在不成立。这条是确定性的、发生在成功路径上,而不是边缘 case。

修掉 §3.4-1(顺带 §3.4-2,同一文件一行)后我复测,复测范围只覆盖:
重新按模板建一张单 → 走一次完整查重 → 证明同类第二次出现时**命中原单、`occurrences` 加一、标题 `×N+1`**,
外加两道门重跑。§1 / §2 已验部分不重测。

**本轮不发 ship 报告**(FAIL 不开 founder ship 门)。已备好的 HTML 留在本地
`/tmp/fw2080qa/ship-report.html`,不投递,待修复复测通过后按最新证据重出。

---

## 7. 复测(2026-08-27,head `29370f272`)—— 阻塞项已解除,verdict 转 PASS

修复 commit `8a280ba77 fix(FLY-2080): make patrol root dedupe truncation-safe`,
exact-head code review R2 已 APPROVED at `29370f272`(R1 的两条 HIGH 转 follow_up → FLY-2088,不在复测范围)。

规则文件的三处改动:

1. `list_issues` 的分页结果**只用于取 candidate identifier 集**;必须对每个 candidate 调
   `get_issue`,只在逐张 fresh read 的完整 description 中搜 `class_key`;任一张不可读就报 UNAVAILABLE。
2. 建单模板把 `class_key:<ROOT_KEY>` 提到 description **第 1 行**。
3. 建后复核那一项 `team=`FLY`` → `team=`Flywheel``(ride-along)。

复测范围严格按约定:只验四条判据,§1 / §2 已验部分不重测。

### 7.1 判据 4 —— 截断夹具:旧尾部写法 RED / 新修法 GREEN(真数据,非合成)

拿**真实存在**的 FLY-2081 当夹具:它是上一轮严格照**旧模板**建的,`class_key` 落在偏移 532。

| 流程 | 结果 |
| --- | --- |
| **旧流程**(`list_issues` + 搜 description) | 5 张 candidate 的 desc 长度全部被截在 500–502,`contains_target` **全 False** → **命中 0 张 → RED**(会走首次分支、静默新铸重复单) |
| **新流程**(`list_issues` 取 id → 逐张 `get_issue`) | 读到未截断全文(713 / 1229 / 1337 / 2165 / 4083),FLY-2081 `contains_target=True` → **命中恰好 1 张 → GREEN**(走重复分支,不新建) |

补充:实现方在单测里加的那段夹具是**自构造字符串的自我断言**(先造一个截断串、再断言它不含 `class_key`),
逻辑上是同义反复,证明不了真实 API 的行为。上表这一格才是真 API 往返的证据。这条我按「单测不足以支撑、
已用真链路补上」记录,不当缺陷。

### 7.2 判据 1 —— 按新模板真实建单

新建 **FLY-2089** `[病根] ⚠️测试用-2080复测-截断安全查重夹具 · ×1`(标题/描述/评论三处标「测试用·可删」)。
建后按规则原文跑 `get_issue` 复核:

| 规则要求 | 实测 |
| --- | --- |
| `team=`Flywheel`` | `team = "Flywheel"` ✅(**这一项在修复前必然失败** —— 旧规则要求 `team=FLY`) |
| `parent=FLY-2072` | `parentId = "FLY-2072"` ✅ |
| label 含 `Flywheel` | `["Flywheel"]` ✅ |
| title `[病根] … · ×1` | 正则命中 ✅ |
| 四字段齐全 + marker | `形状/根因/处置/首见时间/occurrences/patrol-finding` 全部 present ✅ |
| `class_key` 在第 1 行 | offset **0** ✅(全文 1500 字符,远超截断点) |

receipt 链:`FLY-2089` → Bridge 精确读口 → `CHILD_UUID=44a00f39-dd0c-40a2-8be0-c331cc047916`
(`matchType=identifier`,UUID 正则通过),Linear GraphQL 独立直查同值。

### 7.3 判据 2 —— 同类第二次出现必须命中原单,且不新铸

按规则原文跑完整查重:`list_issues` 分页 `hasNextPage=false` → 6 张 candidate → **逐张 `get_issue`**。

```
[1] FLY-2089 match=True     [2] FLY-2084 match=False   [3] FLY-2087 match=False
[4] FLY-2083 match=False    [5] FLY-2081 match=False   [6] FLY-2082 match=False
iterated=6 (= candidate count)   matches=1 → 走「重复」分支
```

> harness 自查:第一次跑时我的 `while read` 循环漏掉了最后一行(文件末尾无换行),
> 只迭代了 5/6 张。这正是「查重不完整」的失败形状,所以我补了 `iterated == candidate count` 的显式断言重跑。
> 记录在此,免得这条证据被当成完整覆盖。

重复分支闭环(全部 fresh read 复核):

| 项 | 前 | 后 |
| --- | --- | --- |
| `occurrences` | 1 | **2** |
| 标题 | `… · ×1` | `… · ×2` |
| 实例 comment | 0 条 | **1 条**,marker 可回读,comment UUID `3fab932d-4f3e-480f-8324-aa9f4d3a6bc3` |
| `class_key` 位置 | offset 0 | offset 0(未被更新破坏) |
| FLY-2072 子单集合 | 6 张 | **6 张**(`FLY-2081/2082/2083/2084/2087/2089`) |
| 该 `class_key` 命中数 | 1 | **1** |

**NO-DUPLICATE: PASS** —— 第二次出现没有新铸任何同类单,`×N` 真的累加了。
这正是 founder 直令第二步要的那个度量。

### 7.4 判据 3 —— 两道完成门

门的文本与上一轮逐字相同(`cmp` 无差异),用本轮**真** receipt 跑:

| 门 | rc |
| --- | --- |
| FINDING validator | **0** |
| STEP/PANE | **0** |

反向突变复检(确认门在新判据下仍能红):identifier 冒充 UUID / `known-waiting` / marker 截短 /
`result=known` —— 四条全部 `rc=1`。

单测在 exact head `29370f272` 复跑:`fly369-patrol-rule` + `lead-rules-bundle` = **42/42 通过**(较上轮 +1,即新增的截断夹具用例)。

### 7.5 复测遗留边界

- FLY-2089 是复测夹具,三处标了「测试用·可删」,**建议 founder review 完后删除**;
  它挂在 FLY-2072 下会出现在病根列表里。
- §5 的其余边界(SQL 配方未端到端拨库、529 房无 Linear 凭据、完成门不回读 Linear、
  harness deviation)本轮未变,仍然成立。其中「完成门不回读 Linear」已由 Lead 明确为冻结 follow-up。
- 本轮 Linear MCP 是我用 `Authorization: Bearer <LINEAR_API_KEY>` 直接调 `https://mcp.linear.app/mcp`
  的 `tools/call` 驱动的(我这个 runner 会话的 MCP 客户端 401,env 里没有该变量)。
  调的是**同一个 MCP server 的同一批 tool**(`list_issues` / `get_issue` / `save_issue` /
  `save_comment` / `list_comments`),不是另一条 API 路径;如实记录。

### 7.6 复测结论

四条判据全部通过,上一轮的阻塞项(照模板建的单查重搜不到)已经**用真 Linear 往返证明解除**。
**verdict:PASS。**
