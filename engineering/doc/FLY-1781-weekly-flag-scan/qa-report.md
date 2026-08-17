# FLY-1781 每周 flag 退役扫描 — 独立 QA 报告

> **最终结论(第 2 轮,2026-08-17):PASS** —— 第 1 轮三条 FAIL 全部关闭,见文末「第 2 轮复测」。
> 复测 head `2d319c9906e32cc089c0a3cac50e8e826140a85d`(PR #863,非 draft、MERGEABLE)。
> Founder ship-report:https://fw-reports-a53de2.vercel.app/r/a0f9b04fd895ba3d53ffd6f6fca91ab5/
>
> 以下第 1 节至第 4 节保留第 1 轮 FAIL 原文,作为返工前的基线证据,未做修改。

---

# 第 1 轮(2026-08-16)— FAIL

Issue: FLY-1781 (https://linear.app/geoforge3d/issue/FLY-1781/flag治理b3第4批-每周扫描-摆出候选问-annie留清-退役出口主体永不自动删)
日期: 2026-08-17
基于: plan.md, runbook.md

被测 head: `66b29733a0b1545db461260ff3e9b7b88e79fcf9`(PR #863,非 draft,MEREGEABLE)

**结论:FAIL** —— 机制层全绿,但**给 Annie 看的那一页**缺了三个 plan §8.1 明文要求的逐行字段,其中两个直接决定她能不能答题。

---

## 1. 绿的部分(逐条有据)

### 1.1 静态门

| 门 | 结果 |
|---|---|
| `packages/config` scan + registry 测试 | 50/50 PASS |
| `packages/teamlead` 9 个相关测试文件 | 93/93 PASS |
| `scripts/__tests__/test-verify-flag-verdicts.test.sh` | PASS(双模式 + 只读自证) |
| `scripts/__tests__/flag-governance-cos-contract.test.sh` | PASS |
| 全仓 `pnpm lint` | 0 error(8 条既有 warning) |
| 全仓 `pnpm -r build` | 22 workspace 全绿 |

### 1.2 真机隔离 E2E(真 Discord,12/12 PASS)

自建 harness:**真 dist 编译产物**(`createFlagRetirementScanner` / `createProductionFlagScanEffects` / `buildFlagProvenance`)+ **真 StateStore**(临时库)+ **真 `resolveAllFlags` 跑真 51 条 registry** + **真 git first-parent walk** + **真 Discord bot token(TEST_BOT_TOKEN_2)真发进隔离测试频道 `product-lead-test`**。生产零触碰。

| # | 场景 | 结果 |
|---|---|---|
| S0 | kill switch 关 ⇒ `disabled`,零 run 行 | PASS |
| S1 | 首轮 = 只采样:0 候选、0 Discord(51 条全部建状态行) | PASS |
| S2 | 第 6 天 tick `not_due`(周节奏未被绕过) | PASS |
| S3 | ≥7 天第二次同值 ⇒ 44 候选,Linear/report/discord/lead_notify 四腿冻结 | PASS |
| S3 | Discord 腿走**真 POST** 到 done,消息 id `1538775691942957207` | PASS |
| S3 | 频道里**恰一条**带该 run marker 的真消息 | PASS |
| S4 | 注入 ambiguous + 过可见性 fence ⇒ **收养既有消息,零重复投递** | PASS |
| S5 | 三个 founder 面(Discord/Linear/HTML)零「自动删除/自动清理」暗示;HTML 明写「不会自动回传」 | PASS |
| S5 | Linear 正文含铁律逐字句「删除动作由人点头后另行执行」 | PASS |
| S5 | Linear 首行机器 marker + 「不进派工、不指派 Runner」 | PASS |
| S6 | dry-run 零 DB 写 | PASS |
| S7 | 真 git provenance:51/51 行落库(17 resolved / 34 无主) | PASS |

实测周期常量 `FLAG_SCAN_INTERVAL_MS = 604800000ms = 7d`(写死,无旋钮 —— Annie O5 裁决成立)。

真 Discord 消息原文:

```
🤖[自动] flag 周扫描 · 44 个候选待逐条裁决（留/清）
Linear: https://linear.test/FLY-QA-<runToken>
报告发布失败，见 Linear 单（stubbed in QA harness）
`flywheel:flag-governance run=<runToken>`
```

### 1.3 生产装配核对(只读)

- `resolveFlagScanOwner(loadProjects())` 对**真生产 `~/.flywheel/projects.json`** 跑通:owner = `flywheel-eng-lead`,generalChannel = `1516209289406971965`(#flywheel-core)。⇒ 上线后扫描器会被真正构造出来,周批量通知落在 Tadashi + Annie 都在的频道。
- 生产 Bridge 进程 env **不含** `FLYWHEEL_PROJECTS`(`ps eww 79600` 阳性对照:140 个 env token、30+ 个 `FLYWHEEL_*` 可见,唯独没有它)⇒ `plugin.ts:4550` 的构造分支在生产成立。
- 派工防线四层实读确认:① 生产 effects 建 `flag-governance` label;② `.lead/flywheel-cos-lead/identity.md:67` 绝对禁令;③ `runs-route.ts:1544` 的窄拒绝**位于 leadId 自动解析之前、任何 dispatch 之前**,且 label 读取失败时 marker 仍能拦住;④ marker 常量与建单正文首行一致。

### 1.4 HTML 裁决界面(真 Chrome 实操)

真浏览器打开真渲染产物:44 张卡、Apple-light 房规。
- 选「留」+ 写理由 → **刷新后逐字恢复**(localStorage,pathname 前缀键)PASS
- 「复制全部」→ 45 行(标题 + 44 行),含 run token、留/清、理由,未答显示 `未答` PASS
- 页面底部明写「本页留言不会自动回传」PASS

---

## 2. FAIL:founder 决策面缺三个 plan 明文要求的逐行字段

plan §8.1 逐字要求每行给出:**flag、问法、当前值、稳定时长、来源、人话描述、已问过 N 次**。
实测两个 founder 面(Linear 批量单正文 + HTML 报告)**每行只有**:flag、问法、当前样本摘要(sha256)、来源、已问过 N 次。

### F-1(阻塞)人话描述整条没渲染

- registry **51 条 flag 全部**有 `description`(`registry.ts:75` 定义,逐条填写)。
- `FlagScanRunItemInput`(`StateStore.ts:1512-1519`)**没有承载它的字段** ⇒ 不进 frozen item ⇒ 两个渲染器都拿不到。
- 判据(非近似):取 `cmux_linked_view` 的 description 原文去 grep 两个真渲染产物 → **两边都是 0 次命中**。

**对 Annie 的实际后果**:她面对的是 44 行 `cmux_linked_view` / `auto_qa_killswitch` / `comm_bypass_bridge` 这样的标识符,加一串 64 位十六进制。要判断「还要留着吗」,她必须逐条去开 Linear 单。这单存在的意义就是省掉这一步。

### F-2(阻塞)当前值没给,enum 形态直接无法作答

- `value` 形态的问法把值嵌进去了(「把它写死成当前值 "90000" + 删 flag?」),够用。
- `bool` 形态只能从「bake in + 删」vs「删」反推开/关 —— 隐含,勉强。
- **`enum` 形态是硬伤**:实测 `issue_gate_supersede_mode` 渲染成「选一个赢的 branch 留下,删其余分支 + 删 flag?」,**页面上没有任何地方写着当前哪个 branch 在赢**。她被要求选一个赢家,却看不到候选。

### F-3(次要)稳定时长没给

plan 要求「稳定时长」。frozen item 无此字段,两面均未渲染。她判断「这个还要留着吗」时,「已经三个月没动过」和「刚满一周」是完全不同的信号。

**修复面很小**:`FlagScanRunItemInput` 加 3 个字段(description / 人话当前值 / streak 起点),`commitFlagScan` 冻结,`itemLine()` 与 HTML 卡片各加一行 `<dt>/<dd>`。不动任何状态机。

---

## 3. 诚实边界(打了桩 / 没测到的,逐条点名)

1. **529 QA 房对本改动结构性不可用 —— 我没跑 529 N-to-N,原因不是省事**:
   `scripts/test-deploy.sh:1738` 永远向 slot Bridge 传 `FLYWHEEL_PROJECTS`,而 `plugin.ts:4550` 把**整个扫描器的构造**关在 `if (!process.env.FLYWHEEL_PROJECTS)` 里;叠加 `resolveFlagScanOwner` 要求存在一个字面名为 `flywheel` 的 project。⇒ 任何 529 slot 里扫描器恒为 `undefined`,`/api/flag-scan/run` 恒 503,rider 恒 no-op。
   我用**模块驱动的真 Discord harness** 替代(真 dist + 真 bot token + 真隔离频道 + 真 POST/GET),这是本改动能拿到的最强真机证据。建议把「529 房支持 self-host 形态(不传 FLYWHEEL_PROJECTS)」记成独立跟进单。
2. **Linear 腿 / report 腿 / lead_notify 腿在我的 harness 里是桩**。`createLinearBatch` 把 team 写死 `FLY`、project 写死 `Flywheel` —— 没有隔离目标,真跑会在生产 Linear 建一张 founder 可见的单。我没有自行授权做这个外发动作。⇒ **Linear 建单/穷尽分页收养、report publish、真 LeadAlertNotifier 投递,均未经真机验证**,只有单测覆盖。
3. **跨时钟收养(R4#3)、双 orchestrator 竞态、24h 里程碑告警**:只有单测,我没在真机复现。
4. `plan §4.2` 第 1 步说「tick 入口先结算未结的 failure alert intent」,实现把结算放在 `alertFailure` 内部。后果:intent 落库后崩溃、且下一轮扫描**成功**了,这条告警不会补投。与 R4#4「失败 episode 随 baseline run_id 前进自然翻新」自洽,**不判 FAIL**,但与 §4.2 字面不一致,留给 Lead 定夺。
5. **第二周的真实批量 = 44 条**(拿真 51 条 registry 实测)。这是设计使然,不是缺陷,但 Annie 第一次收到的会是 44 行待裁决 —— 值得提前跟她打招呼。
6. HTML「复制全部」的粘贴文本**不含 canonicalDigest**,而 runbook 第 1 步的 verdict 文件要求它。Lead 需从 Linear 正文逐条抄。摩擦,非缺陷。
7. 我的 harness 里 `expectedProjectNames: []`,所以 S3 出现的 7 条 `no_clock` 是 harness 造成的(project scope flag 拿不到 roster),**不是产品缺陷**,生产 roster 是真的。

---

## 4. 复测清单(修完这三个字段后)

1. 重跑 `qa-fly-1781-real-discord-e2e.mjs`(应仍 12/12),另加断言:任取一条候选,其 registry `description` 原文同时出现在 Linear body 与 HTML;enum 候选的当前值可见。
2. 重看真 Chrome 里的 HTML 卡片:描述 / 当前值 / 稳定时长三行在位,localStorage + 复制全部不回归。
3. `pnpm lint` + `pnpm -r build` + 上述 11 个测试文件。

---

# 第 2 轮复测(2026-08-17)— PASS

复测 head `2d319c9906e32cc089c0a3cac50e8e826140a85d`(= PR #863 head = origin,worktree 干净)。
返工 commit `c9b09d560 fix(FLY-1781): show founder decision context`。

## 5. 三条 FAIL 逐条关闭(判据 = 真数据,不是读代码)

| # | 修法 | 复测判据与结果 |
|---|---|---|
| F-1 人话描述 | `FlagScanRunItemInput` 加 `description`,从 spec 冻结;两个渲染器各加一行 | **S8**:取真 44 个候选各自 registry `description` 的**原文**,逐条 grep 真渲染的 Linear 正文与 HTML(HTML 侧按 `escapeHtml` 同款转义)——**44/44 两面都命中,missing=none**。第 1 轮同一判据是 0 命中,这是同方法的前后对照 |
| F-2 当前值 | 加 `currentValue`,由已冻结的 canonical 现算成人可读形态 | **S9**:真 registry 里 3 个 enum 候选全部给出当前赢家 —— `issue_gate_supersede_mode="enforce"` / `founder_consent_decision_mode="audit_only"` / `skill_framework_mode="split"`,且逐条出现在 Linear 正文的 `当前值:` 行。截图确认「选一个赢的 branch 留下」这一问上方就是列出全部分支的人话说明 + 当前值 ⇒ 问题**变成可答** |
| F-3 稳定时长 | 加 `stableForMs`,渲染成「7 天」 | **S10**:44/44 非空,两面均渲染 |

**防空过绿**:S8 断言里带 `specs.length > 0 && specs.length === cand3.length`,S10 带 `cand3.length > 0` —— 候选集为空时不会假绿。

## 6. 第 2 轮全量门(全部在新 head 上重跑)

| 门 | 结果 |
|---|---|
| config 50/50 · teamlead 94/94(9 文件) | PASS |
| 两个 shell harness(verify-flag-verdicts / CoS 契约) | rc=0 |
| 全仓 `pnpm lint` | 0 error(8 条既有 warning) |
| 全仓 `pnpm -r build` | 22 workspace 全绿 |
| 隔离真机 E2E(真 dist + 真 StateStore + 真 51 条 registry + 真 git walk + **真 Discord 隔离频道**) | **15/15 PASS**(原 12 项 + 新增 S8/S9/S10) |
| 真 Discord 消息 | id `1538788765122830408`,频道内恰一条带 run marker;注入 ambiguous 过 fence 后**收养原消息、零重复** |

返工新增的单测(`shows the description, current enum winner, and stable duration on both founder surfaces`)逐字断言三个字段同时出现在两面,并用 enum 做样本 —— 非空过绿。

## 7. 第 2 轮诚实边界(在第 3 节基础上的变化)

第 3 节 1–7 条**全部仍然成立**(529 房结构性不可用、Linear/report/lead_notify 三腿打桩、跨时钟与双写者只有单测、告警 intent 结算位置、第二周 44 条批量、复制全部不含 digest、harness 的 7 条 no_clock 是 harness 造成的)。新增一条:

8. **Chrome 扩展在本轮复验中途断连**(founder 把 Chrome 整个关掉了)。我按 chrome-repair 流程做到 R2(重启 Chrome,worker 已恢复)后仍 0 注册,下一步 R5 需要 founder 手动开一次侧边栏 —— 为一张截图不值得打扰她。**第 2 轮的页面截图因此是本机 headless Chrome 渲染,不是她的浏览器会话**。可交叉验证的事实:HTML 的 `<script>` / `<style>` / localStorage / 复制全部处理器在两个 head 之间**逐字未变**(diff 只动了卡片内的 `<dl>`),所以第 1 轮在**真 Claude-in-Chrome** 里验过的交互行为(刷新后留言逐字恢复、复制全部出 45 行含「未答」)在本 head 仍然成立;本轮新增的只是那三行的视觉版式,已由 headless 截图确认。
9. 「修前」截图是**用旧渲染器逐字 `<dl>` 结构复原**的(旧 head 的 dist 已被覆盖),复原依据是 git diff 里 `-` 侧的原文;「修后」截图是真机渲染。ship-report 页面上已如实标注。

## 8. 交付物

- Founder ship-report(可留言):https://fw-reports-a53de2.vercel.app/r/a0f9b04fd895ba3d53ffd6f6fca91ab5/
  三张 mmdc 预渲染 inline SVG + 修前/修后真截图 + 诚实边界原样上页。
  `--publish-only` 出 URL,投递到 parent issue thread 由 Tadashi 代投(FLY-1719:runner 无直投权限)。

---

# 第 3 轮复测(2026-08-17)— PASS

复测 head `71a7cae49a33c634e4da6576966911ae01af7100`(= PR #863 head = origin,非 draft、MERGEABLE)。
范围由 Tadashi 锁定:两条必收 + C + E + 回归面;以下六项**沿用第 2 轮结论不重跑** —— 7 天写死无旋钮 / 永不自动删 / 四层防派工 / 快照法判据 / git 现算 fail-closed / founder 面三字段。

判据在**结果出来之前**已写死于 `PREREGISTERED.md`(含 E 的两种走向读法),下文未做事后调整。

## 9. 必收与新增项逐条(判据 = 真数据 + 前后对照)

| 项 | 红先行基线(修前实测) | 复测结果 |
|---|---|---|
| **必收 1** copy payload 带 canonical digest | 汇总行只有 flag/verdict/reason,`data-digest` 出现 0 次 | **PASS,双面取证**。① node 侧:44/44 候选卡片的 `data-digest` 等于我**独立计算**的 `sha256(冻结 canonical)`(missing=0, mismatch=0);② 粘贴侧:浏览器里真点复制,45 行里 **44/44** 命中 `- <flag>: <留/清/未答> \| canonicalDigest: <64位十六进制>`,且抽样 flag 的 digest 与其卡片 `data-digest` 逐字相等 |
| **必收 2** recovered/成功轮不留 undrained intent | 同一脚本同一注入:intent 落 `pending` → 连跑两轮 `published` → **仍 `pending`** | **PASS**。同脚本同注入,故障消失后两轮 `published`,intent 变 **`done`** |
| **C** 复制全部的失败路径 | subject 红 / control 绿:`offersManualText=false`、`showsAnyFeedback=false`、console 一条 `unhandled:denied` | **PASS**,control 仍绿。`offersManualText=true`、`showsAnyFeedback=true`、`errs=[]`。失败时全文摊进 `#copy-fallback` 并自动选中 + 明说「浏览器不允许自动复制;下方文本已选中,请按 ⌘C 贴回」 |
| **E** lead-notify 不得「报 done 但进死信」 | 机制链只读追出:`resolveLead` 精确区分大小写 → 不匹配走 `deadLetter` → 紧接着 `withDeliveryReceipt(..., "deadlettered_durable")` **写下收据** → `notifyLead` 读到收据 → 返回 done | **PASS**,control 复现成功。主路径:死信文件 **0**、收据 outcome = **`sent`**、腿 done;**到目的地取证**:隔离告警频道 `#test-flywheel-alerts` 里主场景消息 **1 条**(id `1538827443840753725`),对照场景 **0 条** |

C 与 E 的阳性对照都做成 **harness 内的硬闸**:control 不成立即 `exit 3` 判 PROBE-DEGRADED、不出结论。

## 10. 第 3 轮全量门

| 门 | 结果 |
|---|---|
| config 50/50 · teamlead 98/98(9 文件) | PASS |
| 两个 shell harness | rc=0 |
| 全仓 `pnpm lint` | 0 error(8 条既有 warning) |
| 全仓 `pnpm -r build` | 22 workspace 全绿 |
| 隔离真机 E2E(真 dist + 真 StateStore + 真 51 条 registry + 真 git walk + 真 Discord) | **15/15**,真消息 id `1538788765122830408` |
| keep-anchor runtime | **7/7**(见 §11 边界) |
| 必收 1 digest(node 侧 + 粘贴侧) | PASS |
| 必收 2 intent drain | PASS |
| C 复制失败出路(含硬闸对照) | PASS |
| E 告警真投递(含硬闸对照 + 目的地取证) | PASS |

## 11. 单列:机制层仍未收紧(预先登记的读法,不挡本单)

Tadashi 在**看到结果之前**就登记了两种走向。实测落在第一种:

> 在**修后**的代码上人为再造一次「收件人解析不到」的条件 ⇒ **死信文件仍然出现,而那条腿仍然报 done**(收据 outcome = `deadlettered_durable`)。

⇒ implement 修掉的是**触发条件**(项目名大小写),而「**有收据即判 done**」这个错误判定仍然活着 —— 将来任何别的 `resolveLead` 失败都会再产生一次假 done。
按预先登记的约定:**不影响本单 PASS**,单列在此,由 Tadashi 另开一单治机制(判 done 必须看收据的**结果类型**,而不是收据是否存在)。

这条的普适形状值得记住:**该凭证由成功路径与失败路径共同产生,因此不具备区分度 —— 一个不能区分成功与失败的证据,不是证据。**

## 12. 第 3 轮诚实边界

第 2 轮第 3 节的 1–7 条**仍然成立**(529 房结构性不可用 / Linear 建单腿与 report 腿打桩 / 跨时钟与双写者只有单测 / 第二周约 44 条 / harness 的 7 条 no_clock 是 harness 造成的)。变化与新增:

1. 第 2 轮第 3 节第 4 条(failure intent 不补投)**已被必收 2 修掉**,不再是边界。其窄化结论保留在 founder 页:失败轮 fail-closed 零 run 行、下一 tick 整轮重跑产出不受影响、**丢的只是失败通知不是候选批次**。
2. 第 2 轮第 3 节第 6 条(粘贴文本不含 canonicalDigest)**已被必收 1 修掉**,不再是边界。
3. **keep-anchor 7/7 的边界**:真 `computeFlagScan` + 真 StateStore + 真 scanner 的 **runtime 跑通**,但 **registry 输入是构造的** —— 真实 51 条里没有任何一条带 `longTermKeep`,不构造这条路径根本走不到。**不是「真机验过」**。非法绑定只覆盖三种(无 token / token 未知 / 该 flag 那轮没被摆过);plan 还列的「冻结行 bucket 是 claimed/no_clock」与「canonical 为空」两种**未跑**,仍只有单测。
4. **页面高度**:Annie 的裁决页实测 **23280px**。按今天新记的 ≤6000px 判据它超了,但那条判据记录的失败形态是 **Discord 预览图崩**,而这条腿发的是纯文本 + 链接、无 proofshot,**那个崩法多半不触发**;这里是可读性问题,不是我实测到的崩溃。Tadashi 裁定本 lap 不动版面,数字归到每周扫描运行合同那张单。
5. **本轮页面截图用的是本机 headless 渲染**,不是 founder 的浏览器会话 —— Chrome 扩展在第 2 轮中途断连(她把 Chrome 整个关了),我按 chrome-repair 做到 R2 后仍 0 注册,下一步 R5 需要她手动开一次侧边栏,我判断不值得为截图打扰她。

## 13. 交付物(已发布,投递由 Lead 代投)

按读者拆两页,**逐页量过**(判据 ≤6000px):

| 页 | 读者 | 高度 | URL |
|---|---|---|---|
| 主页 | founder | **5766px** OK | https://fw-reports-a53de2.vercel.app/r/fd4b23378bbae541171d13fd08737e21/ |
| 第二页 | 工程侧 | **1204px** OK | https://fw-reports-a53de2.vercel.app/r/948c49ef84d7b51993dd1883ffc499fd/ |

拆法依据是量出来的(修前:architecture 2127 / e2e-529 1202 / boundary 603,总 7666;只拆 boundary 只降到 7063 仍超),因此又做了图 3 改 LR、图 1/图 2 并排、修前修后两图并排,**每步都重新量**,不硬砍内容。
自检:nonce=1、prefers-color-scheme=0、逐区 textarea 主页 6 + 第二页 1、427KB<480KB、零残留占位符、两页 hosted 均 200 且主页含第二页链接。
`--publish-only` 出 URL,投递到 parent issue thread 由 Tadashi 代投(FLY-1719:runner 无直投权限)。
