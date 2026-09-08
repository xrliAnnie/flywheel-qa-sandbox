# FLY-2397 强度二证据台账 — 探索

Issue: FLY-2397 (https://linear.app/geoforge3d/issue/FLY-2397/2309b3-强度二证据台账-真环境跑过-外部可查可重跑的记录两个独立字段p0-影子跑前置)
日期: 2026-09-06
基于: 无(上游为 `product/doc/FLY-2309-auto-merge-rollout/build-issues.md` §B3、同夹 prd.md §4.2 ③、research.md §3,以及 `product/doc/FLY-2261-auto-merge-criteria/process-log.md` §1.3 founder 原话)

---

## 0. 一句话

founder 定的闸②「强度二」是两半 —— (a) 在 529 房把链路从头到尾真跑一次、(b) 留下外部可查、能被重跑的记录 ——
今天这两半**没有任何一张表落账**,QA 的「跑过」只存在于 `workflow_claims.evidence.summary` 那段自由文本里,
也就是**自称**。本单要建一张新台账,让 (a)(b) 各成一个独立字段、各有独立判定,
并把「没有台账行 = 不满足」「记录地址取不到 = 不满足」两条 fail-closed 规则钉成可测的代码。
它不改任何门的放行行为(影子跑前置,只记账不拦人),消费者是 B4 的记录线 ③。

## 1. 现状审计(2026-09-07T01:14Z 只读副本 `teamlead.db` + `-wal`,未碰生产库)

### 1.1 三张既有台账,没有一列表示「真跑过」或「记录在哪」

| 表 | 主键 | 有什么 | 缺什么 |
| --- | --- | --- | --- |
| `auto_qa_record` | `(parent_execution_id, target_pr_head_sha)` | `status ∈ {running,passed,failed,stuck,superseded}`、`verdict_event_id`、`qa_issue_url`、起止时间、retry 计数 | 无 summary、无场地、无记录地址、无重跑法。74 行:passed 35 / superseded 20 / stuck 17 / failed 2。**FLY-1981 后已无生产写入方**(只读 ledger,写 API 已删) |
| `codex_review_record` | `(execution_id, target_repo_identity, target_pr_head_sha)` | 评审结论、轮数、thread id;绑 exact head | 评审 ≠ 跑过。1,504 行 |
| `workflow_claims` | `server_seq`;`subject_kind='git_head'` + `subject_digest` 绑 exact head | `predicate='qa_passed'`(371 行,全部 `issuer_kind='runner_node'`)的 `evidence` JSON **只有一个键 `summary`** | 「跑过」只是 summary 里的一句话。这正是 spec 说的「自称」 |

`qa_exempt`(13 行)全部由 `bridge_policy` 签发,理由 `all_nodes_no_write` —— 与本单无关(无写入的单本来就不进强度二)。

### 1.2 今天 QA 自由文本里实际写了什么(371 条 `qa_passed`)

| 模式 | 条数 | 说明 |
| --- | --- | --- |
| 提到 `529 房` / `slot N` / `slot-N` | 205 | 有「场地」的叙述,但只是文字 |
| 含 `vercel.app` URL | 301 | QA 报告经 `publish-report` 托管;这是今天**事实上的**外部记录 |
| 含 `~/.flywheel/artifacts/…` 路径 | 23 | 拷出 529 房的证据;**本机路径,外部不可查** |
| 含 `/tmp/flywheel-test-slot-N/…` 路径 | 6 | teardown 即消失(记忆库 `feedback_copy_evidence_before_the_action_that_destroys_it`) |
| 含 `github.com/.../actions/runs/...` | 0 | 没有人拿 CI run 当记录 |
| 含 `linear.app` | 3 | 极少 |

⇒ 三个事实:① 「跑过」和「记录」今天混在一段文本里,机器分不开;② 事实上的记录载体是托管报告,
但**托管报告 14 天过期**(`report-registry.ts:49`,FLY-2283 founder 要求),B4 的两周表跨越这个窗口;
③ 原始证据目录在 529 房里是易失的,只有拷到 `~/.flywheel/artifacts` 才活下来,而那是本机路径。

### 1.3 「529 房真跑」在代码里长什么样

- 驱动器 `scripts/qa-529-generalized-e2e.mjs <slot> --issue <FLY-N> [--real] [--timeout-ms N]`;
  退出码 0 = 九步全过;`A3_DIAGNOSIS_EXIT` / `STUB_FATAL_DIAGNOSIS_EXIT` 为已知诊断;其它非零 = fail-closed。
- 每一步写 `<slotDir>/e2e-evidence/<runId>-<ISO>/step-N.json`(`schemaVersion:1, runId, step, title, observedAt, …`)
  与 `owner.json`(`issue, projectName, runId, executionIds`)。
- 房间由 `scripts/test-deploy.sh <slot>` 起、`scripts/test-teardown.sh <slot>` 拆(`rm -rf /tmp/flywheel-test-slot-N`)。
- 记忆库已有四道前置(`reference_529_generalized_room_prereq_chain`):dept label、`--generalized`、
  驱动器替代 inject 脚本、`TEST_REPLY_BY_ISSUE=1`。**stub-runner 房结构性测不了某些面**(display fingerprint 永远为空)。

⇒ 「怎么重跑」不是一句话,是一组可执行的参数:slot、issue、`--real` 与否、起房 env、被测 head、驱动器 git rev。
这些今天散在 QA 的叙述里,没有一处结构化。

### 1.4 「外部可查的记录地址」今天有哪些载体

| 载体 | 外部可查? | 耐久 | 机器可验「取得到」? |
| --- | --- | --- | --- |
| Bridge 托管报告 `https://<fw-reports-x>.vercel.app/r/<token>/` | ✅ 任何拿到链接的人 | ❌ 14 天(`DEFAULT_RETENTION_MAX_AGE_MS`) | ✅ Bridge 本地 `ReportRegistry.list()` 按 token 查 + HTTP GET |
| GitHub(PR 评论 / gist / Actions run) | ✅ | ✅ | ✅ `gh api` / HTTP GET(Bridge 已有 `gh` 调用面) |
| Linear 评论 | ✅ 组织内 | ✅ | ⚠️ 需 Linear token;本会话 MCP 401,证明这条线不稳 |
| `~/.flywheel/artifacts/<ISSUE>-qa/<round>/` | ❌ 本机 | ✅ | ✅ `fs.stat` |
| `/tmp/flywheel-test-slot-N/e2e-evidence/…` | ❌ | ❌ teardown 即失 | 一时可验,随后必失 |

⇒ 「外部可查」与「耐久」在今天的载体里**没有一个同时满足且零成本**。托管报告最接近(已在用、301/371),
但 14 天窗口正好是影子跑长度。本探索把这个矛盾摆给 Lead(§7),不在实现里悄悄选一边。

### 1.5 founder 原话与 spec 硬约束(逐字,不改写)

- 强度二 = 两半,缺一半就不算:①场地(529 房从头到尾真跑一次,不是单元测试)②证据(外部可查、能被重跑的记录)。
- 第 2 半才是挡住「模型自称跑过」的那道墙;少了它退化成强度一,对那 8 条「说做完了但没真跑过」一条都拦不住。
- fail-closed:没有台账行 = 不满足;只认台账,不认自称。
- 阳性对照 1(自称跑过无台账 ⇒ 不满足)、阳性对照 2(有台账行但记录地址取不到 ⇒ 不满足)、两半分别单测。
- 已知不解:强度二挡不住 FLY-1833 那种 flaky;本单无新解法,验收文档保留缺口说明。
- 开机/常驻/部署类(FLY-2029 型)由 Lead 判「强度二证不了」⇒ 回 founder;「拿不准」≠ 退回(自律条款)。

## 2. 问题重述

把「强度二是否满足」从**一段话**变成**一个可重算的函数**:

```
evaluateStrengthTwo(ledgerRow | null, recordProbe) → {
  ran:    { satisfied: boolean; reason },   // (a) 真环境真跑过
  record: { satisfied: boolean; reason },   // (b) 外部可查、可重跑的记录
  verdict: 'satisfied' | 'unsatisfied'      // = ran.satisfied && record.satisfied
}
```

- 输入只有台账行 + 对记录地址的一次探测结果;**不读 `workflow_claims.evidence.summary`**(自称不算输入)。
- `null` 行 ⇒ 两半都 `unsatisfied:no_ledger_row`(阳性对照 1)。
- 行在、探测失败 ⇒ `ran` 可以 satisfied 而 `record` unsatisfied(阳性对照 2),verdict 仍 unsatisfied。
- 两半是**两个字段、两个 reason**,测试分别断言,不许一个布尔盖两件事。

## 3. 谁来写这一行 —— 三条路

| 路 | 写入者 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 扩 `qa-result`** 加 `--ran-at / --record-url / --rerun` 等 flag,随 `qa_passed` claim 同事务落表 | QA runner | 一次提交、与 claim 原子 | `qa-result` 走 loopback-only 的 `/api/workflow/decision`,消费**一次性** `workflow_submission_credential` 并以 `submission_digest` 做重放键;改 payload 形状 = 改一条已被 Codex 多轮审过的合同;且「跑过」与「判 PASS」是两件事,一个 QA 可能跑过但判 FAIL,也该记账 |
| **B. 新子命令 `flywheel-comm evidence-run record`** → Bridge 新 route → 新表;与 verdict 解耦 | QA runner(或任何持 exec 身份者) | 不碰 `qa-result` 合同;跑过就记,与 PASS/FAIL 无关;B4 可独立读 | 多一次提交;runner 可能忘记(但忘记 = 无行 = 不满足,fail-closed 本来就是要的) |
| **C. 由 529 驱动器直接写** | `qa-529-generalized-e2e.mjs` | (a) 变成机器证词,不经 runner 之手 | 驱动器面向 slot 房 Bridge,不持生产 Bridge 的 runner 身份;跨房写生产表要新的授权面;`--real` 之外还有 test-deploy 手工跑法,驱动器覆盖不了全部「真跑」 |

**倾向 B**,并把 C 的精神保留成 B 的一条**负向护栏**:记录里必须带驱动器产物的**内容摘要**
(`step-N.json` 集合的 sha256,或托管报告的 `bytes`+token),Bridge 在 (b) 探测时比对,
让「填个字符串就算」过不了(spec 明说这是 (b) 最容易退化的方向)。

## 4. 记录行的骨架(待 research 校准列名)

| 字段 | 含义 | 独立性 |
| --- | --- | --- |
| 绑定 | `(run_id, execution_id, target_repo_identity, head_sha)`;head 40 hex | 与 `workflow_claims.subject_digest` 同口径 |
| 场地 `site` | 枚举 `slot_529:<n>` / `other:<label>`;不是自由文本 | (a) |
| 链路 `lane` | 枚举:`generalized_e2e_stub` / `generalized_e2e_real` / `manual_test_deploy` / `other:<label>` | (a) |
| 驱动器身份 | 驱动器脚本的 git rev + 退出码 | (a) |
| 记录地址 `record_url` | 允许的 scheme/host 类别(托管报告 / github.com);Bridge 在写入时**先探测** | (b) |
| 记录摘要 `record_digest` | 内容 sha256(64 hex);复验时比对 | (b) |
| 重跑法 `rerun_command` | 结构化:driver、slot、issue、`--real`、env 名(不含值)、被测 head;渲染成一行命令 | (b) |
| 声明者 | `recorded_by_execution_id`、`recorded_at` | 审计 |

「(a) 真跑过」在台账里不是一个布尔,是「场地 + 链路 + 驱动器退出码」三列齐全;
「(b) 有记录」是「地址 + 摘要 + 重跑法」三列齐全**且**地址在判定时刻取得到、摘要相符。

## 5. 判定时刻与消费者

- 写入时 Bridge 做一次探测(取不到 ⇒ 422,零写入 —— 与 FLY-2395 C4 的「任何 422 都在 DB 写入之前」同风格)。
- **判定时**(B4 记录线 ③ 或未来的闸②)再探测一次;过期 / 404 / 摘要不符 ⇒ `record.unsatisfied`。
  行不删、不改 —— 台账只追加,判定是纯函数。
- 本单**不接任何门**:`review-hold.ts` / land / founder gate 行为零变化。只提供 store 读面 + 纯函数 + CLI/route。

## 6. 不做什么(边界)

- 不改 `founder-only-authority`;不改 `qa-result` / `workflow_claims` 合同;不改 `auto_qa_record`。
- 不解决 flaky(FLY-1833 型):一条 flaky 的端到端偶然全绿,台账照样记「跑过 + 有记录」,判满足。**这是已知缺口,验收文档保留。**
- 不承诺记录地址在 14 天后仍可取(见 §7);不自建新的托管面。
- 不判「这一类改动强度二证不证得了」(FLY-2029 型由 Lead 人判,不在本表)。

## 7. 待 Lead 裁(非阻塞 ask,不停研究)

1. **记录地址的耐久窗口**:托管报告 14 天过期,而 B4 两周表在期末重算时地址可能已失效 ⇒ 期末会把早期单子判成
   `record.unsatisfied:expired`。三个选项:(i) 接受,B4 表加「地址已过期」一栏单独计;(ii) 本单允许 `record_url`
   同时登记一份 GitHub 侧副本(PR 评论 / gist)作为耐久地址;(iii) 判定时若地址过期但 `record_digest` 与
   Bridge 本地 registry 留存的 HTML 摘要相符,视为 (b) 仍满足。倾向 (i)+(iii):不加新托管面,不让 QA 多做一步。
2. **写入者走 B 路(新子命令)而非扩 `qa-result`** —— 需要 Lead 认可「跑过」与「判 PASS」解耦记账。

**Lead 裁定(ask `14a0e53c`,2026-09-07)**:(1) B 路批,⛔ 不改 `qa-result` 的 `submission_digest` 合同,新表归 `protectedCurrentOrReference`;
(2) 不取 i / iii,取更干净的一条:半边 (b) **在写入时判定** —— Bridge 真取一次地址(HTTP 200 + 内容 digest),把 `checked_at / status / digest` 存进行里,之后地址过期**不回溯改判**;
B4 报表把记录分三态单列 `live` / `verified_then_expired` / `unsatisfied`;托管 14 天过期作为已知限制写进 plan 并告知 B4。研究与计划照此收敛(research.md §0)。
