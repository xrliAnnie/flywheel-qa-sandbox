# FLY-1811 19 条解析器状态待查 — 实施计划

Issue: FLY-1811 (https://linear.app/geoforge3d/issue/FLY-1811/flag执行e6-19-条解析器状态待查人工过目后才决定进不进批量)
日期: 2026-08-16
基于: 无(上游文档 `product/doc/FLY-1782-flag-recheck/resolver-state.md` §4 与 `exec-ready.md` ——
审计期间它们还在 FLY-1782 分支上,现已由 **#853 合入 `main`**;若远端又有变动,以 §3.3 步 2 的 fresh-fetch 为准)

---

## 0. 一句话结论

**19 条逐条核完:18 条一致,1 条不一致(`delivery_secret_path`)。**

放行口径**分母是 18,不是 19**:

- **18 条**仍注册的 flag —— 判词通过,**立即**可进 E1 / E2。
- **1 条**`delivery_secret_path` —— 判词是「不一致」,但它同时被 FLY-1809 判定
  **根本不该在 flag 表里**(是配置值不是开关)。它**不计入 E1 / E2 的固化分母**,
  且在 **PR #856 真正合入之前必须显式 hold**,不能当成「已有归属 = 已完成」。

**本 PR 零生产代码**;除文档外唯一的改动是一条 owner 行为守卫(见 §3.3),
它测的是 `delivery-secret.ts` 里**不随 registry 行消失**的 fallback 分支。

> ⚠️ **#856 尚未合入**(在 founder 门等 ✅)。若它被拒、被改写、或晚于 E1 / E2,
> **FLY-1811 的处置自动重新打开** —— 本单不为一个未发生的 postcondition 背书。
> 判据见 §3.3「解除阻塞的条件」。

> **过程里的四次真错,记在这里,不是自我批评是给下一个人的路标**:
> - **D-R1**:初稿判「19/19 全绿」。`delivery_secret_path` 被我用「语义同址」这种**肉眼近似**放过了 ——
>   而这一单交付的恰恰是**机器要照抄的字符串**,「人看着是同一个地方」不是那个属性。
> - **D-R2**:改判之后我**保留了错的 default**、只加注释描述这个差异,理由是「schema 没有计算型 default」。
>   这个理由是错的 —— registry 是 TypeScript,`default` 只需求值成 string。
>   我查的是「有没有先例」这个近似,不是「合不合法」这个属性。
>   更糟的是我那条守卫断言 registry 与 owner **必须不相等** —— **谁真去修它,那条测试就会变红**。
> - **C-R2**:我又加过一条「全 registry 不得有 `~/` 开头的 default」的前瞻守卫,被判 blocking 后撤了。
>   撤的理由比 review 给的更重:那条守卫用「长得像需要展开的路径」去代理「与 owner 不一致」——
>   **又是一次近似检查冒充那个属性,正是这一单从头到尾在治的病。**
> - **D-R5**:撤回代码时我**多撤了一条**,还跟 Lead 说「6 条守卫全是绑那一行的」——
>   其中一条测的是 owner 的 fallback 分支,**不依赖 registry 行**,#856 也没覆盖它。
>   **过度回退和过度改动一样是错**;而且我把一句没核过的概括当结论报了上去。已恢复并更正(§3.3)。
> 四条都是外部 review 抓的。**这一单最该被记住的不是「查了 19 条」,是「近似检查会以四种不同的样子回来」。**

---

## 1. 这一单在问什么

上游 `resolver-state.md` 的三态扫描把 95 条执行候选分成:72 无解析器 + 3 数值 sanitizer(可批量)、
1 有解析器(`qa_auto`,挡下)、**19 待查**。待查的原因是它们读法是混合形态
(`args.env ?? process.env` 可注入 env / 两步式取值 / 同文件多种用法),**机器判不准**。

要回答的问题只有一个:**registry 那一行的 `default` 与解析器的真缺省一致吗?**

- 一致 ⇒ 放行进 E1 / E2
- 不一致 ⇒ 以解析器为准,PR 里写明,并**修正那个错误声明** ——
  「把那行改对」或「把根本不属于 flag 的行移出 registry」都算(第 19 条走的是后者)

`qa_auto` 是这个问题为什么值得问的活证据:registry 写 `polarity: opt_in` / `default: false`,
而 `resolveAutoQaPolicy` 实际是 fleet-wide default-ON(FLY-752 翻代码时注册表那行没跟着翻)。
按 registry 删它 = 固化成「关」= Flywheel 自己的 PR 不再自动起 QA,且不报错。

---

## 2. 方法(以及它的边界)

对每一条,逐点做五件事:

1. **读 registry 那一行**:`polarity` / `valueKind` / `default` / `readSites`。
2. **读解析器本体**,取「env 未设时」这一条分支的落点 —— 那才是真缺省。
   多层的(`env ?? ctorConfig ?? 常量`)要一路追到常量,并回查上层是否真的没被传入。
3. **全仓反查读点**,不信 registry 的 `readSites` 是全的 —— 用词边界正则扫全仓
   (排除 `node_modules` / `dist` / `__tests__` / 文档),看有没有 registry 没登记、
   而且缺省方向不同的第二个读点。
4. **核生产持久配置**:只读 `~/.flywheel/.env` + Bridge launchd plist。
5. **核活进程真值**:`ps eww` 读活 Bridge 的进程 env,再从活 Bridge 自己的
   flag 控制台取 in-process effective(§3.5)。**磁盘配置不等于活进程状态** ——
   仓库自己就区分 `bridgeEffective` / `fileEffective` 并定义了
   `staged_restart` / `split_brain` / `bridge_stale` 三种背离(`resolve.ts:149-199`)。

**词边界匹配是硬要求**:上游自己在这套分类器上栽过一次 ——
`includes()` 让 `FLYWHEEL_SHIP_GATE_CARD` 命中了 `FLYWHEEL_SHIP_GATE_CARD_GRACE_MS` 这另一个 flag。
本次第 3 步全部用 `\b<VAR>\b`。

### 2.1 阳性对照(凭什么信这份判定)

一把量不出东西的尺子,和一把量出「没问题」的尺子,输出长得一模一样。
所以把**同一套方法**跑在唯一已知有这个 bug 的 `qa_auto` 上:

- registry(`registry.ts:2246-2264`): `polarity: "opt_in"`,`default: false`
- 解析器(`auto-qa-policy.ts:37-79`)第 6 条落点:
  `// Default-on (FLY-752): absent config / no qa block / auto absent / auto: true` → `return { enabled: true }`
- ⇒ **方法判定:不一致(两个字段都反)** ✅ 与已知事实吻合

**尺子抓得住已知的那条,才敢用它去看未知的 19 条。**

事后看,这个阳性对照**只证明了尺子的一半** —— 它证明我能在 bool flag 上抓到方向反转,
没有证明我能在 **value flag 上抓到形态不一致**。`delivery_secret_path` 正是漏在这半边
(§3.3)。**阳性对照本身也需要覆盖被测的每一类形态。**

### 2.2 突变检验是后果证据,不是判词依据(主次别倒)

**判词的直接依据**是源码两侧的值不相等:
registry 声明 `"~/.flywheel/delivery-secret"`,owner 算 `join(homedir(), ...)`,
中间层零传入,`resolve.ts` 不展开 `~`。**这就够了,是读出来的。**

**突变检验证明的是另一件事** —— 那个错值交给 Node filesystem 之后**会怎样**:
把 owner 改成 tilde 字面量 ⇒ `provision()` 的 `mkdirSync` 在 `packages/teamlead/` 下
**真建出了 `~/.flywheel/delivery-secret.<uuid>`**。(残留已清除。)
它没有观察到「当前 owner 消费 registry 的 default」——**它是后果证据 / 阳性对照,不是判词本身**。

初稿把这两件事写反了(「不是靠读代码论证的」),review 抓出。**证据的主次写错,读者对结论的信心就建在错的地方。**

### 2.3 这份审计**没有**回答的

- **不覆盖 `readSites` 的 `timing` 字段是否准确** —— 那是 live-toggle 安全性,属 FLY-1455。
- **不覆盖固化动作本身的正确性** —— 本单只判方向与值,E1 / E2 才动代码。
- 生产核对是**本时刻的快照**。`mailbox_queue` 的值会被部署闸改写(§3.4),
  E1 / E2 执行前应把 **18 条仍注册的 flag 全部重取一次**,不要拿本文档的时间戳当准。
  第 19 条 **#856 合入后就不在 registry 里了,按原方法取不到** ——
  对它要验的是 **#856 的 postcondition**(行已删 + 已进 `NON_FLAG_ALLOWLIST`);
  没满足就继续 hold(§3.3)。

---

## 3. 逐条判定(19 条)

「真缺省」列 = 解析器在 env 未设时实际落到的值。

### 3.1 bool(7 条)

| flag | registry(polarity/default) | 解析器真缺省 | 判定 |
|---|---|---|---|
| `mailbox_queue` | default_on / true | `mailbox-queue.ts:5` `env.X !== "0"` → **ON** | ✅ 一致 |
| `converge_cmux_symlink` | default_on / true | `converge-flywheel-bin.sh:296` `${X:-1}`,非法值 warn 后回 1 → **ON** | ✅ 一致 |
| `auto_qa_killswitch` | default_on / true | `auto-qa-policy.ts:42` 仅 `=== "0"` 时关,否则穿透 → **ON** | ✅ 一致 |
| `workflow_rework_reentry` | default_on / true | 3 处读点全为 `!== "0"` / `=== "0"` → **ON** | ✅ 一致 |
| `external_merge_reconcile` | default_on / true | `external-merge-reconcile.ts:818` `=== "0"` 才 return → **ON** | ✅ 一致 |
| `instruction_path_check` | default_on / true | 5 处读点全为 `!== "0"` / `=== "0"` → **ON** | ✅ 一致 |
| `runner_autocontinue` | opt_in / **false** | `autocontinue-armer.ts:90` `=== "1"`;`plugin.ts:10115` 同 → **OFF** | ✅ 一致 |

`mailbox_queue` 的两个读点缺省方向相同:`resolveLiveMailboxQueueEnabled`(inbox-mcp)读共享 dotenv,
key 缺失时 `readEnvValueFromContent` 返回 `undefined`,交给同一个 `mailboxQueueEnabled` ⇒ 仍是 ON。
读文件失败则回落 `processEnv`,同一函数,仍是 ON。**两步式取值不改变缺省方向。**

`auto_qa_killswitch` 要和 `qa_auto` 分清:出错的是 `qa_auto` 那一行(`source: project_config`,
`configKey: qa.auto`),本条是它上面那层 `source: env` 的全局急停开关,方向没问题。
**共用一个策略函数 ≠ 同一行注册表。**

### 3.2 value(12 条)

| flag | registry default | 解析器真缺省(证据) | 判定 |
|---|---|---|---|
| `liveness_activity_window_ms` | `"600000"` | `liveness-evidence.ts:20,27` `DEFAULT_ACTIVITY_WINDOW_MS = 600_000` | ✅ |
| `deferred_approval_ttl_ms` | `"2700000"` | `deferred-approval.ts:58,64` `45 * 60_000` | ✅ |
| `founder_reply_deadletter_age_ms` | `"1800000"` | `gate-poller.ts:2562-2567` `positiveIntEnv(..., 30 * 60_000)` | ✅ |
| `issue_display_sweep_ticks` | `"60"` | plugin 未设时传 `undefined` → `gate-poller.ts:1189` `?? 60` | ✅ |
| `ship_gate_grace_ms` | `"15000"` | `gate-poller.ts:2373-2380` → `this.config.shipGateGraceMs ?? 15_000` | ✅ |
| `merge_reconcile_window_days` | `"7"` | `external-merge-reconcile.ts:820-824` `deps.windowDays ?? 7` | ✅ |
| `ship_gate_card_grace_ms` | `"15000"` | `gate-poller.ts:1649-1656` → `this.config.shipGateCardGraceMs ?? 15_000` | ✅ |
| `reports_ttl_days` | `"7"` | `plugin.ts:920-925` → `report-registry.ts:44` `7 * 24 * 60 * 60 * 1000` | ✅ |
| `ghost_guard_wait_ms` | `"90000"` | `runs-route.ts:235-238` `positiveInt(..., 90_000)` | ✅ |
| `done_thread_reconcile_interval_min` | `"360"` | `done-thread-reconcile.ts:102-106` `parsePositiveInt(..., 360, {allowZero:true})` | ✅ |
| `done_thread_reconcile_max_per_run` | `"25"` | `done-thread-reconcile.ts:108-111` `parsePositiveInt(..., 25)` | ✅ |
| **`delivery_secret_path`** | `"~/.flywheel/delivery-secret"` | `delivery-secret.ts` `join(homedir(), ...)` 的绝对路径 | ❌ **不一致 → §3.3(处置归 FLY-1809)** |

三条「两步式」的额外核对(这正是它们进待查的原因):
`ship_gate_grace_ms` / `ship_gate_card_grace_ms` / `merge_reconcile_window_days` 都是
`env → 构造器 config → 常量` 三层。**全仓反查确认 `plugin.ts` 一处都没传这三个构造器参数**
(`grep shipGateGraceMs|shipGateCardGraceMs|windowDays` 在生产代码中零命中),
⇒ 中间层恒为 `undefined`,常量即真缺省。**「有中间层」和「中间层被用了」是两件事,查了才算。**

### 3.3 🔴 唯一的不一致:`delivery_secret_path`(判词成立,处置归 FLY-1809)

**事实**:
`registry.ts:2891` 写的是字面串 `default: "~/.flywheel/delivery-secret"`;
owner `delivery-secret.ts` 在 env 未设时返回 `join(homedir(), ".flywheel", "delivery-secret")`,
本机是 `/Users/xiaorongli/.flywheel/delivery-secret`。中间层 `options.secretPath` 也没兜住 ——
生产装配处 `plugin.ts:4865` 只传 `{ store }`。
`resolve.ts:132-134` 对 value kind 只做 `raw ?? String(spec.default)`,**没有任何 `~` 展开**。

⇒ **Node 不展开 `~`,它是一个普普通通的路径段。**

**判词依据到上一段为止就够了** —— 两侧源码的值不相等,是读出来的(见 §2.2 的主次)。
突变检验是**后果证据**:owner 一用回字面串,`provision()` 的 `mkdirSync`
就在 `packages/teamlead/` 下真建出了 `~/.flywheel/delivery-secret.<uuid>`,
它证明的是「这个错值交给 Node filesystem 之后会怎样」,不是判词本身。

**而且它此刻就在生产上活着**:活 Bridge 的 flag 控制台(§3.5 实测)
显示 `FLYWHEEL_DELIVERY_SECRET_PATH = ~/.flywheel/delivery-secret`,而进程实际用绝对路径。
**和 `qa_auto` 同一类:账面 ≠ 实际,人和脚本会按账面行事。**

#### 为什么本单不修这一行

我一度**已经修了** —— 加了 canonical helper `defaultDeliverySecretPath()`,让 registry 那行和
owner 调同一个,配 6 条等式型守卫,连带修了被计算型 default 打断的 `extract.mjs`。
design review 4 轮 + code review 3 轮全过。

**然后 Tadashi 给了一条跨单事实,推翻了处置(不是推翻判词)**:
**FLY-1809(PR #856,已在 founder 门等 ✅)把 `delivery_secret_path` 整条从 `FEATURE_FLAGS` 删掉**,
登记进 `truth.ts` 的 `NON_FLAG_ALLOWLIST` —— 因为**它本来就不是开关,是配置值**。

已核实(不是照单全收):`gh pr diff 856` 里 `- name: "delivery_secret_path"` 与
`+ ["FLYWHEEL_DELIVERY_SECRET_PATH", "delivery_secret_path"]` 都在;
而且 #856 与本单当时有**三个直接重叠的文件**(`registry.ts` / `flag-truth.test.ts` /
`delivery-secret.test.ts`)—— 本单当时还另外动了 helper / exports / owner 生产代码 / extractor。

⇒ **行都要没了,修它没有意义,只会撞车。**
已回退到 `main` 的:registry 那一行、canonical helper、两处 exports、owner 生产代码、
extractor stub,以及 5 条绑死在该 row 上的守卫。
**保留的**:1 条 owner 行为守卫(见下方「一条自我更正」)—— 所以本 PR **不是纯文档**,
是「文档 + 一个测试文件」,零生产代码。
**从根上说 #856 的处置比我的更对**:我是让一个不该存在的注册表行「说对话」,
它是**把这行拿掉** —— 修结构,不是加补丁。

#### 判词、归属、解除阻塞的条件

| | |
|---|---|
| **判词** | ✅ 成立 —— registry 声明与 owner 真缺省不一致,依据是两侧源码值不等(§2.2 说明证据主次) |
| **处置归属** | FLY-1809 / PR #856(把行移出 registry) |
| **本单代码** | registry / helper / exports / extractor 相关改动**全部回退**;**保留一条 owner 行为守卫**(见下) |
| **E1 / E2** | 这条**不计入固化分母**。exec-ready 本就标它「搬(配置数据,不是删)」,#856 就是那个「搬」 |

**解除阻塞的条件(fail-closed,不能默认成立)**:

1. PR #856 **实际合入**,且合入内容确实包含:registry 行删除 + `NON_FLAG_ALLOWLIST` 登记。
2. 在那之前,**E1 / E2 必须显式 hold / exclude 这一条**,不能因为「已有归属」就当它完成。
3. 若 #856 被拒、被改写成别的形态、或晚于 E1 / E2 —— **FLY-1811 的处置自动重新打开**,
   本单的判词和证据(§3.3 上半)就是重启时的现成输入。

**合并顺序是有约束的,不是「预计无冲突」**(已用 `git merge-tree` 实测,不是估计):

```
git merge-tree $(git merge-base HEAD origin/flywheel-FLY-1809) HEAD origin/flywheel-FLY-1809
```

在 `delivery-secret.test.ts` 的 `node:fs` import 上**真的产生 conflict** ——
两个分支都把 main 的单行 import 改成多行,#856 加 `existsSync`,本单加 `existsSync + mkdirSync`。
**两个测试体本身能自动并存,import hunk 不能** —— **取并集即解,无逻辑冲突**。

> ⚠️ **别用 GitHub 的 `mergeable` 字段判这件事。** 它是**每个 PR 各自对当前 `main`** 算的,
> 两个 PR 都会显示 `MERGEABLE`,而它们**彼此**冲不冲突这个问题它根本没在回答。
> 要用 `git merge-tree`(或真试合)。**又一次「量具量的不是你以为的那个东西」——
> 和这一单从头治到尾的是同一种病。**
>
> 这处冲突有**两条独立取证**:我的 `merge-tree`,以及独立 QA 的真试合 —— 结论逐字一致。

⇒ **集成合同**:

| 步 | 动作 |
|---|---|
| 1 | **#856 实际合入**并满足上面三条 dependency gate。**这是后续每一步的前提** —— 在它之前取 `B` 没有意义 |
| 2 | **随后**权威取 base:`git fetch origin main`(或从 GitHub 读 current base OID),记下 **`B`** —— 此时的 main 已含 row removal + allowlist。**`B` 必须在 rebase 与所有验证之前定下**:跑完再回头读一次 main,只会把「测试期间漂过去的新 base」标到没见过它的旧证据上 |
| 3 | 本单 rebase / merge 到 `B`,**显式解 import 冲突**,`existsSync` 与 `mkdirSync` 都要留;得到 head **`H`**。**证明 `B` 真的是 `H` 的基线**:`git merge-base --is-ancestor B H` |
| 4 | 确认**两条互补测试都还在**(#856 的 explicit-env 分支 + 本单的 env-absent fallback 分支) |
| 5 | **在合并态重验 #856 的结构性 postcondition**:`delivery_secret_path` 的 row/`name` 确实不在 `FEATURE_FLAGS`、`FLYWHEEL_DELIVERY_SECRET_PATH` 确实在 `NON_FLAG_ALLOWLIST`、且**没被 tombstone**(生产还在读它) |
| 6 | 确认 **#856 那条结构性守卫本身还在**,并跑它(`packages/config/src/__tests__/flag-truth.test.ts`,或整包 `packages/config`) |
| 7 | 跑 `delivery-secret.test.ts`,预期从各分支的 5/5 变成 **6/6**;再跑 lint / build |
| 8 | 证据签在 **`H+B` 这一对**上(`B` 来自步 2,即 #856 合入之后、验证之前;不是事后补记) |
| 9 | **落地 fence(见下方「这次用哪道 fence」)**:在最后一次 base 复核**之前**取得排他权并**保持到 merge 完成**。`H` 变、权威 `B` 变、或 fence 丢失 ⇒ **证据全部作废**。**回到步 2 重跑步 2-8**(不是从步 3 —— 步 3 只消费 `B`,只有步 2 会权威地重取它;从步 3 重跑等于要么继续用旧 `B`,要么把新 base 无声代入,正是本合同刚修掉的那个错) |

> ⚠️ **任一分支单独的 5/5 不能替代合并态的 6/6。** 解冲突时丢掉任一条测试,
> 单分支的绿看起来一模一样 —— 这正是「把必然发生的集成工作藏成『预计无冲突』」的代价。
>
> ⚠️ **步 5/6 不能省,而且不能用步 7 代替。** 那两条 owner 测试**根本不读 registry / truth**,
> lint 和 build 也不跑这些语义断言 —— 所以「#856 正确合入后,main 上又有人把 row 加回去、
> 或把 allowlist 条目删掉、或解冲突时丢了 #856 的结构守卫」这一整类漂移,
> **在只跑步 7 的合同下会全绿通过**。
> 好消息是不用新写:**#856 已经带了这条可执行守卫**(断言 env/name 不在 `FEATURE_FLAGS`、
> 不在 tombstones、allowlist reason 在、`validateFlagTruthEnvironment` 通过)——
> 合并态**跑它**即可,本单不重复造一条。
>
> ⚠️ **步 8/9:为什么「同一个 combined head」还不够。** 本仓的 ship 机制**不补这道门**(已核实):
> `.github/workflows/ship-on-comment.yml` 的 `actions/checkout` 用的是 `ref: head_sha`
> —— 测的是**孤立的 PR head**,不是 prospective merge tree;
> 而 `pulls.merge({ sha: HEAD_SHA })` 里那个 `sha` **只保证 head 没动过,不约束 base**。
>
> ⇒ 可以构造这条全绿的漏网序列:#856 正确合入 → 本单 rebase 到 `main=B1` 得到 `H`,
> 在 `H` 上步 4-7 全绿 → **之后** `main` 前移到 `B2`,某个能干净合并的 commit
> 把 row 加了回去 / 删了 allowlist → 本单不再碰 registry/truth,`H` 仍能无冲突 squash 进 `B2`
> ⇒ **落地的树是坏的,而所有证据都来自 `H+B1`**。
>
> ⇒ 所以证据必须**绑 `head SHA + base SHA` 这一对**,而且 `B` 要在 **#856 合入之后、开跑之前**定下(步 2)。
>
> **这次用哪道 fence —— 不留成没定的二选一:**
>
> 先查了本仓的实际保护设置(`gh api repos/xrliAnnie/flywheel/branches/main/protection`):
> `required_status_checks.strict: **false**`、`enforce_admins: true`。
> **merge queue 另外单独查过**(classic branch-protection 那个 endpoint 根本不返回它,
> 拿它的字段缺席去推「不存在」是错的):`gh api repos/.../rulesets` 与
> `gh api repos/.../rules/branches/main` **都返回 `[]`** ⇒ 无 ruleset、无 merge queue。
> **`strict: true` 正是 GitHub 用来「合并前必须与 base 同步、base 漂了就拒绝」的那道机制 fence,
> 它现在是关的。** 所以**不能声称机制已经在保证**。
>
> ⇒ **本次 landing 采用 Lead 串行窗口**:`#856` 与 `#857` 是当下唯一碰
> `delivery-secret.test.ts` 的两个 PR,由 Tadashi 按 §3.3 顺序**串行落地**;
> 触发 `:cool:` **之前**做最后一次 fresh base 复核,且该窗口内**不并行落别的 PR**。
>
> ⚠️ **诚实说清它的限度**:这是**运维 fence,不是原子的**。
> `:cool:` workflow 从 checkout 到自动 merge 中间要跑完整套 install/build/lint/test,
> 期间没有人工停顿贴着 merge —— **check → merge 之间仍有一个真实的时间窗**。
> 串行窗口把这个窗口的风险压到「这段时间里没有别人在落 PR」,**没有消除它**。
> 真正原子的解只有 `strict: true` 或 merge queue,那是机制级改动,归 §5.4 交 Lead 判断。
> **写成这样是因为我不能假装一个我没有的保证。**

> **本单不为一个还没发生的 postcondition 背书。** 写「已有归属」很容易读成「已经好了」,
> 所以把条件列成清单,而不是一句「归 FLY-1809」。

#### 一条自我更正:我多撤了,并且报错了

我一度跟 Tadashi 说「那 6 条守卫全是绑这一行的,行删了就是死码」。**这句话错了一条。**

- **5 条确实随行消失**:4 条 delivery-path(registry default / resolveFlag effective / helper 形状 /
  override 逐字)+ 1 条 extractor 契约(它存在只因为我引入了计算型 default)。
- **1 条不是** —— `delivery-secret.test.ts` 里那条 owner 行为守卫,测的是
  「env 未设 **且** 没传 `secretPath` ⇒ 落到 `join(homedir(), ...)`」。
  **这个分支在 #856 之后照样存在**;而 **#856 新增的测试只覆盖「显式设 env」那条路**
  (已核 `gh pr diff 856`:它 set `FLYWHEEL_DELIVERY_SECRET_PATH` 再断言不落 fallback),
  **没有覆盖 fallback 本身**。这个分支通向 `mkdirSync` 和 `removeOrphanVersions()`,对象是 0600 HMAC key。

⇒ **已恢复这一条**,并去掉它对(已删的)shared helper 的依赖 ——
直接断言 `join(fakeHome, ".flywheel", "delivery-secret")`。
**故意写成字面的**:靠 shared helper 断言会让两边一起漂,写死才能让这条测试有资格说「owner 错了」。
突变检验过:owner 改回 tilde ⇒ 变红,还原 ⇒ 绿,且 cwd 隔离在 scratch,红测不脏 checkout。

> 这一条记下来,是因为我犯的不只是「多撤一条代码」——
> **我把一句没核过的概括当结论报给了 Lead。** 过度回退和过度改动一样是错。

### 3.4 生产持久配置

`~/.flywheel/.env` 只读实测:**18 条未设**;**1 条显式设置** —— `FLYWHEEL_MAILBOX_QUEUE=1`,与缺省同值(ON)。
Bridge launchd plist(`~/Library/LaunchAgents/com.flywheel.bridge.plist`)实测**不注入任何 `FLYWHEEL_*`**
—— 全部 key 只有 `KeepAlive` / `Label` / `ProgramArguments` / `RunAtLoad` / 日志路径 / `ThrottleInterval`。
审计基线里这 19 个 env row **都被 registry 标为 `scope: bridge_global`**,不吃逐项目 `config.yaml`,
所以这两处就是全部持久来源。(语义上它们是 **18 个 flag + 1 个被误登记的配置值** ——
`scope` 是 registry 当时的说法,不是本单的结论,见 §3.3。)

> `mailbox_queue` 值得单说:`scripts/lib/mailbox-queue-deploy-barrier.sh` 会在部署就绪闸未过时
> 显式压 `FLYWHEEL_MAILBOX_QUEUE=0`。实测 `.env` 里是 `=1`,说明闸已释放
> (`mqb_release_via_bridge`:"default-ON is live and persisted")。
> **这条闸是显式 env 覆盖,不是 default 写错** —— 但它说明这条 flag 的现值会被部署流程改写。

### 3.5 活进程实测(不是磁盘快照)

磁盘配置证明不了活进程 —— 尤其是那 3 条 **direct-toggleable** 的
(`mailbox_queue` / `auto_qa_killswitch` / `workflow_rework_reentry`),
控制台可以在**进程内**改 `process.env`,那种改动 `ps eww` 根本看不见。所以两路取证:

**(a) 进程 env**:活 Bridge `pid=80264`(`lsof -ti :9876 -sTCP:LISTEN`),
`ps eww` 中这 19 个 key 只出现 `FLYWHEEL_MAILBOX_QUEUE=1`,其余 18 条不在环境里。

**(b) in-process effective**:向活 Bridge 自己要
(`GET /api/fleet/flag-report.html`,loopback,HTTP 200),逐条读回:

| | 活 Bridge 报的值 |
|---|---|
| 6 条 default-on bool | 全部 **ON** |
| `runner_autocontinue` | **OFF** |
| 9 条数值 | 600000 / 2700000 / 1800000 / 60 / 15000 / 7 / 15000 / 7 / 90000 |
| `done_thread_reconcile_*` | 360 / 25 |
| `delivery_secret_path` | `~/.flywheel/delivery-secret` ← **§3.3 的账面≠实际,当场可见** |

**这条证据链对哪些行有多强,分开说清**(不把一个 endpoint 冒充成通用 owner introspection):

- **3 条 direct-toggleable 行**(`mailbox_queue` / `auto_qa_killswitch` / `workflow_rework_reentry`):
  **最强**。该 endpoint 每次请求都走 `FleetConsole.buildSnapshot()` → `resolveAllFlags({ env: process.env, ... })`,
  读的就是控制台 writer 会改的那份 live env,且三条的 generic resolver 与各自 owner 是同款
  default-on 语义 ⇒ 进程内改过的值这一路看得见,`ps eww` 看不见。
- **其余 bool / 数值行**:endpoint 值 = registry projection。它们的 owner 结论由
  「env 未设(§3.4 两处持久来源都查过)+ owner 源码分支 + 中间层零传入(§3.2)」推出,
  不靠 endpoint 单独成立。
- **`delivery_secret_path`**:它恰恰**证明了这一路不是通用 owner introspection** ——
  endpoint 返回 registry 的 tilde 串,而活 provider 捕获的是绝对路径。
  这条差异由 FLY-1809 除名后自然消失(没有 registry 行,就没有会说错话的账面)。

⇒ 在上述限定下,**18/18 仍注册的 flag 满足「当前生效值 == 真缺省」**(exec-ready §1 的前提),
即「冻结在现值」与「落回默认」指向同一个值,**不存在方向选择,也就没有选错的余地**。

**第 19 条不满足这个前提,也不该被算进去**:它的 flag projection(tilde 串)
与 owner 实际用的绝对路径**就是不相等**。它的出路不是「被算作满足」,
而是**被移出 flag pipeline**(§3.3)。初稿在这里写了「19/19」——
和上面那段自己列的差异**直接矛盾**,review 抓出。
**一个把自己刚写的反例算进合格数的总结句,比没有总结句更坏。**

### 3.6 反查到的唯一疑似漏登记读点 —— 已排除

全仓扫描发现 `FLYWHEEL_SHIP_GATE_GRACE_MS` 出现在 `founder-reply-deliverer.ts:86`,
不在 registry 的 `readSites` 里。**逐字读过:那是 `checkpointGraceMs` 字段的 JSDoc 注释,
不是 `process.env` 读取**,值由 gate-poller 计算后传入。⇒ 非读点,不构成漏登记。
(Codex R1 独立复核同结论。)

其余 18 条的全仓扫描结果与 registry `readSites` 一致,无第二缺省来源。

### 3.7 与 exec-ready 固化值的交叉对照

E1 / E2 真正会焊进代码的是 `exec-ready.md` 那张表的「固化成」列。逐条比过:

- **18/19 逐字相同**(6 条 bool 开 + `runner_autocontinue` 关;11 条数值 600000 / 2700000 /
  1800000 / 60 / 15000 / 7 / 15000 / 7 / 90000 / 360 / 25)⇒ 不需要修正。
- **1/19 不走固化**:`delivery_secret_path` —— exec-ready 本就标它「**搬**(配置数据,不是删)」,
  而 FLY-1809 / PR #856 就是那个「搬」。E1 / E2 不必为它写固化值(§3.3)。

---

## 4. 要落的改动

| # | 改动 | 文件 | 说明 |
|---|---|---|---|
| 1 | **registry 零改动** | — | 18 条本就正确;第 19 条由 FLY-1809 / PR #856 除名解决(§3.3) |
| 2 | **1 条 owner 行为守卫** | `packages/teamlead/src/__tests__/delivery-secret.test.ts` | 封住「env 未设且无 `secretPath` ⇒ `join(homedir(), ...)`」这条**没人覆盖**的 fallback;不依赖 registry 行,不依赖 shared helper;已突变检验(§3.3) |
| 3 | 本审计文档入 PR | `engineering/doc/FLY-1811-resolver-state-recheck/plan.md` | E1 / E2 的放行凭据 |
| 4 | 把 §5 **五条**发现转报 Lead | — | 4 条 flag / E1-E2 相关(§5.1-5.3、§5.5)+ 1 条 ship 机制观察(§5.4);均不在本单改代码 |

**为什么 registry 零改动而不是我没查**:判定依据在 §3 逐条列了文件与行号;
方法在 §2.1 用 `qa_auto` 做了阳性对照,并写明它只覆盖 bool 那半边、正因如此漏了 §3.3;
漏登记读点在 §3.6 单独反查过;活进程真值在 §3.5 从 Bridge 自己取回并按 timing 类别分开定强度;
不一致那条在 §2.2 分清了「判词依据」与「后果证据」。
**「查完发现不用改」和「没查」,靠的就是这五样东西分辨。**

而且第 19 条的零改动**不是「没修」,是「别人修得更对」** —— #856 把这行拿掉,
我原来是让它「说对话」。**修结构 > 加补丁。**(但见 §3.3:「归属」不等于「已完成」。)

---

## 5. 顺带发现(不在本单改,转报 FLY-1455)

### 5.1 value-kind flag 的 `polarity` 字段没有解析器语义,FLY-1455 的断言在这类 flag 上无法定义

`polarity` 有 **4 个消费点**(逐个查过,不是抽样):

| 消费点 | 是否可能作用在 value flag 上 |
|---|---|
| `resolve.ts:136` | 否 —— 在 bool 分支内;value 走 `raw ?? default` |
| `flag-routes.ts:96` `effectiveOf` | 否 —— 同上 |
| `flag-routes.ts:80` `computeRawTo`(写策略) | 否 —— 调用前被 `isDirectToggleable(spec)` 挡住 |
| `management-existing-writers.ts:874`(写策略) | 否 —— `:846` 同样被 `isDirectToggleable(spec)` 挡住 |

而 `direct-toggle.ts:29-38` `isDirectToggleMetadata` 逐字写明
`value`-kind **被拒**("a free string has no bounded target set")。
⇒ value flag 的 `polarity` **当前完全 inert,无活风险**。

但账面是乱的。**计数按两个时点分开给,免得下游拿错**:
- **本次审计时(pre-#856)**:19 条里 12 条 value,polarity 6 `opt_in` / 6 `default_on`。
- **#856 合入后(post-#856,给 FLY-1455 / E1-E2 用这个)**:`delivery_secret_path`(原 `opt_in`)
  移出 registry ⇒ 本 cohort 剩 **11 条** value flag,polarity **5 `opt_in` / 6 `default_on`**。

这 11 条里
取值随意且不可证伪(例如 `liveness_activity_window_ms` 是 `opt_in`,
`deferred_approval_ttl_ms` 是 `default_on`,两者形态完全相同)。

**对 FLY-1455 的直接影响**:那条 CI 断言写的是「`polarity`/`default` 必须与解析器实际行为一致」。
**value flag 没有可对照的 polarity 行为**,断言在这 11 条(post-#856)上无从落地。
建议 FLY-1455 明确断言范围 = bool 的 `polarity + default` + enum/value 的 `default`,
并考虑把 value flag 的 `polarity` 收成不可填(或统一常量),免得下一个人照着它做判断。

### 5.2 value flag 的「有效值」展示不过 sanitizer —— 与 qa_auto 同类的「账面 ≠ 实际」

`resolveEnvEffective` 对 value kind 直接返回 `raw ?? String(spec.default)` 原样。
所以 env 若被设成垃圾值(如 `abc`),控制台会显示 `abc`,
而运行时 `positiveIntEnv` / `parsePositiveInt` 之流实际用的是 default。

**只有 `liveness_activity_window_ms` 做了特判修正**(`resolve.ts:265-277`,FLY-1329 A2 补的);
其余 pre-#856 是 11 条、**post-#856 是 10 条**没有。

⇒ 这 19 条当前全部未设或设成合法值,**无活风险**;但 §3.3 的 `delivery_secret_path`
正是这一类在**路径**上的变体,而且**已经在生产控制台上显形** ——
它由 #856 除名后,那条错误的 projection 才随之消失(不是本单修的)。
建议进 FLY-1455 作为第二类断言:**展示值必须过 owning sanitizer**。
实施期间试过的形状(最终因 FLY-1809 除名而未采用,但形状本身可复用):
让 registry 与 owner 共用一个 canonical helper,再用**等式型**守卫钉住 ——
比事后加一条「记住两者不同」的注释可靠得多。

### 5.3 给 E1 / E2 的一条事实(不改判定)

这些 value flag(post-#856 为 11 条)焊死后就失去运行时可调性。其中至少两条是出事时的应急旋钮:
`done_thread_reconcile_max_per_run`(注释写明是 Discord 429 保护)、
`merge_reconcile_window_days`(配合 gh 调用预算)。
**这不影响一致性判定**,方向没有选错的余地;但「焊死」的代价是运维手感,
要不要为这两条保留 env 是 E1 / E2 的处置判断,不是我的。

### 5.4 一条可移植的机制观察:ship 只钉 head,不钉 base(机制级修复超出本单 scope)

写 §3.3 步 8/9 时核实的(`.github/workflows/ship-on-comment.yml`):
`actions/checkout` 用 `ref: head_sha` —— 测的是**孤立的 PR head**,不是 prospective merge tree;
`pulls.merge({ sha: HEAD_SHA })` 的 `sha` **只保证 head 没动,不约束 base**。

⇒ 任何「验证完 → main 前移 → 仍可干净 squash」的 PR,**落地的树都可能不是被验证过的那棵**。
这不是 FLY-1811 特有的 —— 但它**正是 §3.3 步 2/8/9 存在的理由**,所以不是「与本单无关」,
准确的边界是:**机制级修复超出本单 scope,本单只在自己这一次 landing 上用运维 fence 兜住**。

**而且这道机制 fence 已经存在,只是关着** —— 实测
`gh api repos/xrliAnnie/flywheel/branches/main/protection`:

| 设置 | 现状 |
|---|---|
| `required_status_checks.strict` | **`false`** ← 这就是「合并前必须与 base 同步」的开关 |
| `enforce_admins` | `true` |
| merge queue / rulesets | 无 —— **另用 `rulesets` 与 `rules/branches/main` 两个 endpoint 查的,都返回 `[]`**。<br>classic protection 的 payload 不含 merge queue,**不能拿它的字段缺席当证据** |

⇒ **把 `strict` 打开就是原子的 base fence**(base 漂了 GitHub 直接拒绝 merge),
比任何串行窗口都可靠。但它是**仓库级设置,影响每一个 PR** ——
**开不开是 Lead / founder 的判断,不是我的**,所以本单只把这个测量结果和它的含义交上去。
记在这里免得下一个人重新发现一遍。

### 5.5 前瞻守卫两次没做成,教训归 FLY-1455

本单**没有**留下任何「防止下一个 flag 犯同类错」的守卫。试过两条,两条都撤了,原因值得记:

1. **「registry 与 owner 必须不相等」** —— 朝后指的守卫。谁真去修那一行,它就变红。
   (design R2 抓出。这是**把 bug 钉死**,不是防它。)
2. **「全 registry 不得有 `~/` 开头的 default」** —— 字符串形状启发式,不是类型边界。
   将来一个 free-string flag 完全可以拿 `~/artifacts/*.json` 当交给 shell 的 glob
   (展开是 owner 的既定语义),或拿 `~/` 当纯展示文本;而「当前 catalog 里没有反例」
   证明不了策略对。(code R2 抓出。)
   **撤它的真正理由更重**:它用「长得像需要展开的路径」去代理「与 owner 不一致」——
   **又一次近似检查冒充那个属性,和这一单要治的病同源。**

⇒ **真正的一般化只有一条路**:FLY-1455 那条断言 —— **registry 的声明必须与 owner 的实际行为一致**,
直接测那个属性,不测它的影子。

落地它需要的是**可执行的 owner oracle**:每行能真的取到 owner 在「什么都不覆盖」时的值,
再与声明比对(canonical resolver / per-row adapter 之类)。

> ⚠️ 一个语义判别字段(path / 纯值 / shell 模板)可以帮忙**路由**该怎么测,
> 但**它本身仍然只是又一份 registry metadata,会和 owner 一起漂** ——
> **别把它当第四个近似检查用。** 它证明不了等价,只能决定用哪把尺子。

---

## 6. 验收

| 项 | 判据 | 状态 |
|---|---|---|
| 19 条逐条有判定 | §3.1 / §3.2 覆盖 19/19,每条带文件:行号 | ✅ |
| 方法可信 | §2.1 `qa_auto` 阳性对照变红;并写明它只覆盖 bool 那半边,以及正是这个缺口漏掉了 §3.3 | ✅ |
| 证据主次正确 | §2.2 判词依据(源码两侧值不等)与后果证据(突变)分开写 | ✅ |
| 无漏登记读点 | §3.6 词边界全仓反查,唯一疑似已逐字排除(外部 review 两轮独立复核同结论) | ✅ |
| 活进程前提成立 | §3.5 `ps eww` on 活 Bridge pid + Bridge 自己的 flag 控制台,按 timing 类别分开定强度 | ✅ |
| 第 19 条有归属**且有解除条件** | §3.3:判词成立;处置归 #856;**列了 fail-closed 的三条解除条件,不默认它已完成** | ✅ |
| owner fallback 有守卫 | §3.3:恢复的那条,突变检验变红/还原绿,cwd 隔离红测不脏树 | ✅ |
| 定向测试(本分支) | `delivery-secret.test.ts` **5/5**(含新增那条) | ✅ |
| **合并态验收** | 见下方「合并态取证记录」 | ✅ **已完成(2026-08-17)** |
| **base 权威且前置** | `B` 在 #856 合入后、验证前 fresh-fetch 定下;`git merge-base --is-ancestor B H` 已证明 | ✅ |
| **落地 fence** | ⏳ 待 Lead 协调 —— Lead 串行窗口:最后一次 fresh base 复核前取得排他权并保持到 merge 完成;`H` 变 / `B` 变 / fence 丢失 ⇒ 证据作废重跑。**限度已写明:非原子,check→merge 仍有窗口** | ⏳ **§3.3 步 9** |
| lint / build | `pnpm lint` exit 0(8 条既有 warning);`pnpm -r build` exit 0(22 workspace) | ✅ |
| diff 面 | `git diff main --stat` = 本单文档 + 一个测试文件,**零生产代码** | ✅ |

### 合并态取证记录(2026-08-17,§3.3 步 1-8 实跑)

| 步 | 结果 |
|---|---|
| 1 #856 合入 | ✅ `gh pr view 856` → `state: MERGED`,merge commit `2cf31bd78`(自己核的,没信转述) |
| 2 权威 `B` | `git fetch origin main` → **`B = 2cf31bd78c250140dfae18405285da1e21d7dcf4`** |
| 3 合并到 `B` + 祖先证明 | 恰 **1 处冲突**,正是预测的 `node:fs` import;**取并集**(`existsSync` 两边都有,`mkdirSync` 本单加)。`git merge-base --is-ancestor B H` **通过** |
| 4 两条互补测试都在 | ✅ `FLY-1809 resolves the secret path from FLYWHEEL_DELIVERY_SECRET_PATH`(显式-env 分支)+ `provisions under $HOME/.flywheel, not a literal ~ directory`(env-absent fallback 分支) |
| 5 结构性 postcondition | ✅ row 按 `name` / 按 `envVar` 都**不在** `FEATURE_FLAGS`;**在** `NON_FLAG_ALLOWLIST`(reason 含 FLY-1279);**未** tombstone(生产还在读);`validateFlagTruthEnvironment` → `{ok:true}` |
| 6 #856 守卫仍在并通过 | ✅ 守卫存在;`packages/config` 整包 **598/598** |
| 7 合并态 6/6 + lint/build | ✅ `delivery-secret.test.ts` **6/6**(各分支 5/5 → 合并 6/6,与合同预测逐字一致);`pnpm lint` exit 0(8 条既有 warning);`pnpm -r build` exit 0 |
| 8 签名 | 见下方「签名为什么不写死一个 `H`」 |

#### 签名为什么不写死一个 `H` —— 我踩了自己的门,而且这是个结构缺陷

第一次取证签在 `H = 42d55f43d`,然后**提交这份记录本身**把 head 推到了 `22a61acf6`;
按我自己写的规则「`H` 变 ⇒ 证据作废」,那份签名当场失效。我照规则重跑重签,
**结果下一次提交又把 head 推走了** —— 自指回归。

**这不是操作失误,是合同的结构缺陷**:**把签名写在它自己所签的文件里,它永远追不上自己的 head。**
(没有用「只是文档」给自己开豁免 —— 那正是把门掏空的那种理由。)

**结构性修法:签「被验证的代码状态」,不签一个会自己动的 commit SHA。**

| | |
|---|---|
| **被验证的代码状态** | 提交 **`42d55f43d`** 的树 —— 冲突解决 + 两条互补测试就位后的那棵树 |
| **其后每个提交** | **仅文档**。判据可复跑,不是声称:`git diff --name-only 42d55f43d <后续 head>` 过滤掉 `engineering/doc/` 之后**为空** |
| **每次推动 head 后** | 全部内容门重跑过,每次都是 `config 598/598` · `delivery-secret 6/6` · `lint exit 0` · `build exit 0` · `git merge-base --is-ancestor B H` 通过 |
| **`B`** | **`2cf31bd78c250140dfae18405285da1e21d7dcf4`**(#856 的 merge commit) |
| **落地时的 `H`** | = 落地那一刻的分支 tip,**由步 9 的 fence 持有者(Lead)现取现核**,不由本文档写死 |

⇒ **本文档给的是「哪棵代码树被验证过、以及后续增量为何无害」的可复跑判据;
`H` 的最终确认属于落地时刻,是步 9 的事。** 这样合同才闭得上,而不是每写一行就自我作废。

> **步 9(落地 fence)不在本记录内** —— 由 Lead 协调串行窗口并在持有期做最后一次 base 复核。
> **`H` 变 / 权威 `B` 变 / fence 丢失 ⇒ 以上证据全部作废,回到步 2 重来。**

> **一条环境项**:新建 worktree 没有 `node_modules`,未跑 `pnpm install` 时 `pnpm -r build` 会 exit 2。
> 上表的绿是装完依赖后**实跑**的,不是推断。
> **一条测试环境项**:本 runner 的 `TMPDIR` 很深,跑 teamlead 套件要 `TMPDIR=/tmp`,
> 否则无关的 AF_UNIX 测试会撞 `sun_path` 上限(与本 diff 无关,已用短 TMPDIR 对照验过)。

---

## 7. 上游 / 下游

- **上游**: FLY-1782(`resolver-state.md` §4 的 19 条待查名单、`exec-ready.md` 的固化值表)
- **下游 E1 / E2**:
  - **18 条**立即解除阻塞,按 exec-ready 现有固化值走(逐条比对过,§3.7)。
  - **`delivery_secret_path` 不在固化分母里,且在 #856 合入前必须显式 hold** ——
    解除条件见 §3.3,**不要因为「已有归属」就当它完成**。
- **同窗协调**: FLY-1809 / PR #856 —— 两单都碰 `registry.ts`。**本单已完全让开那一行**。
  唯一重叠文件是 `delivery-secret.test.ts`,而且 `git merge-tree` 实测**确有冲突**
  (`node:fs` import hunk,不是测试体)。
  **顺序(注意 `B` 在验证之**前**记,不是之后):**
  ① #856 合入 → ② fresh-fetch `origin/main` **记下 `B`** → ③ rebase 到 `B` 得 `H`,
  并用 `git merge-base --is-ancestor B H` 证明祖先关系 → ④ 内容门(两条测试都在 + 重验 #856
  结构性 postcondition 并跑它自带守卫 + `delivery-secret.test.ts` 6/6 + lint/build)
  → ⑤ 证据签在已有的 `H+B` 上 → ⑥ **持有 fence 期间**做最后一次 base 复核后 landing。
  逐步见 §3.3(**§3.3 是 canonical 合同,本节只是执行顺序的摘要**)。
  **失效三元组:`H` 变 / 权威 `B` 变 / fence 丢失 —— 任一发生,旧证据全部作废,回到 ② 重来。** **若 Lead 认为该守卫更适合并入 #856,我随时移交** —— 它不依赖本单任何东西。
- **防复发**: FLY-1455(CI 断言)。转报四条:§5.1 value flag 的 `polarity` 无解析器语义
  (post-#856 该 cohort 11 条)、§5.2 展示值不过 owning sanitizer(post-#856 10 条)、
  §5.3 运维旋钮事实、§5.5 前瞻守卫两次失败的教训 + **语义判别字段不能当第四个近似检查**;
  另有 §5.4 一条可移植观察(ship 机制只钉 head 不钉 base),供 Lead 判断要不要在机制层面补。
- **仍挡下**: `qa_auto` 不在本单范围,按 issue 单独处理。
