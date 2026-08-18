# Design Review — plan.md (Round 3)
Date: 2026-08-17 / Author: Codex / Status: CHANGES REQUESTED

## Summary

Round 3 已关闭 Round 2 的主要架构问题：A-1/B-1 现在同步翻 runtime resolver、registry `polarity` 与 `default`，并覆盖控制面 raw-write 语义；cmux 已选择单一的“删除整个 observation family”处置，RED oracle 在改前确实会因 `A1B1|0` latch 变红；D-2 对批准证据的措辞、采用规模与“现在关会停什么”的因果也已拆开；具名账目、AutoContinue 精确 sweep、legacy epoch/enrollment 合同均保持正确。生产只读复核仍得到 313 run、261 claim、schema 分布 NULL=59 / v1=36 / v2=218，当前 5 个 published/unretired template 均为 schema v2；active/held engine run 当前仍全部 enrolled 且 epoch=1。生产 `.env` 仍是 cmux=`0`、五个 workflow flag=`1`、D-3 mailbox Discord=`1`。

本轮仍不能批准：D-2 被声明为“逐字执行”的 census SQL 在当前数据库上有两条直接报错，使 founder re-ask 的强制前置无法按计划执行；此外，B-1 的实际测试文字没有落全已接受的输入矩阵，research evidence table 也仍保留了旧的 exemption 载体说法。这些都是窄修，不需要重开已经闭合的架构决定。

本轮执行了文档与源码核读、生产 `.env`/`teamlead.db` 只读查询及 `git diff --check`；这是设计复审，未运行尚未实现的代码测试。仓库没有 README.md。

## What's Good (Keep)

- 保留 A-1 的完整三件套：sync/autostart 真缺省、`polarity:"opt_in"`、`default:false` 同 commit；对应 absent/`0`/`1`/invalid 与 on/off raw-write 测试形状正确。
- 保留 B-1/B-2 的两阶段部署合同：B-1 先变为 default-ON 且保留显式 `=0` opt-out，B-2 才删除最后选择；registry/control-plane 写法与 runtime 已同向，R8 也诚实记录中间部署窗。
- 保留 cmux 的单一 disposition 与跨层清单：删除 latch/check/event-kind family，同时明确 view/WAL/receipt/lifecycle 无条件活链一行不动。当前源码 inventory 与计划列出的 shell、notifier、kind-contract、copy/router 及测试面相符。
- 保留 D-2 修正后的证据边界：总 run/claim 只证明采用规模；“关掉会停”由 5 个当前模板均为 schema v2 加 fresh-dispatch 串联谓词证明；审计沉默既不证明批过也不证明没批。
- 保留 Wave B 历史合同矩阵，尤其是 DB 直构 epoch-0 fixture、`claims_read_enrolled=0` 不推断、legacy non-engine completion、enrolled claims/head authority，以及 READ-on + unenrolled 的 fail-closed 负例。
- 保留 founder-UX、AutoContinue、两条显式 exemption object 和 named-set guard 的详细处置；这些 Round 2 项无需重开。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[HIGH] D-2 的“精确、逐字执行”SQL 与当前 `teamlead.db` schema 不匹配。**

   **Why it matters:** plan.md:148-159 明确把这些 SQL 设为 relay 前强制前置，并要求“逐字执行”。实际以 `sqlite3 -readonly ~/.flywheel/teamlead.db` 执行时，run 总数与 claim 总数两条成功，但 schema 分布报 `no such column: template_snapshot_json`，当前模板查询报 `no such column: definition_json`。当前表结构是 `workflow_run.snapshot`，JSON key 为 `$.schema_version`；模板 schema 在 `workflow_template_revision.schema_version`，发布指针是 `workflow_template.current_published_revision`，没有 `published`/`definition_json` 列。plan.md:159 的“实现时再校对列名”又与“钉死、逐字执行”自相矛盾，会把 founder 卡片的证据查询变成未经评审的临场改写。

   **Suggested fix:** 现在就把 SQL 改成可执行版本，删除“届时按 schema 校对”的逃生句，并在同一个只读事务里取得 timestamp 与一致快照。例如：

   ```sql
   -- sqlite3 -readonly ~/.flywheel/teamlead.db
   BEGIN;
   SELECT datetime('now') AS observed_at_utc;
   SELECT COUNT(*) AS run_count FROM workflow_run;
   SELECT COALESCE(CAST(json_extract(snapshot, '$.schema_version') AS TEXT), 'NULL') AS schema_version,
          COUNT(*) AS run_count
     FROM workflow_run
    GROUP BY 1;
   SELECT COUNT(*) AS claim_count FROM workflow_claims;
   SELECT t.template_id,
          t.current_published_revision AS revision,
          r.schema_version
     FROM workflow_template AS t
     JOIN workflow_template_revision AS r
       ON r.template_id = t.template_id
      AND r.revision = t.current_published_revision
    WHERE t.retired_at IS NULL
      AND t.current_published_revision IS NOT NULL
    ORDER BY t.template_id;
   COMMIT;
   ```

   该版本本轮只读实跑得到计划卡片现有的 313 / 261、59/36/218 与 5 个 schema-v2 template。若 relay 时 schema 真漂移，应 fail closed、更新 plan/card 后再征询，而不是临场换查询继续。

2. **[MEDIUM] B-1 的实际计划没有落全已接受的 absent/`0`/`1`/invalid 测试矩阵。**

   **Why it matters:** plan.md:109 只承诺“absent→ON、显式 `0`→OFF、控制面 on/off 写行正确”；A-1 则明确列出了 absent/`0`/`1`/invalid。B-1 的新 runtime 判读式和中央 resolver 都是 `raw !== "0"`，所以显式 `"1"` 与非法值都应为 ON；控制面 on/off 测试只覆盖删行与写 `0`，不会覆盖这两个 raw 输入。尤其 claims-read 还有 argsEnv/live-`.env`/processEnv 三级优先级，少测这些状态会留下 runtime、CLI 与 registry 再次漂移的空间。

   **Suggested fix:** 把 B-1 文本改成与 A-1 对称：五条逐项覆盖 absent、`"0"`、`"1"`、invalid 的 runtime + registry effective，并覆盖每行 on/off raw-write；对 claims-read 再明确三层来源的 absent/`0`/`1`/invalid 与优先级用例。B-2 的“显式 `0` inert”RED 保持不变。

3. **[MEDIUM] 两个已接受的具名账目修正尚未贯穿所有权威摘要。**

   **Why it matters:** research.md:47-48 的逐条 evidence table 仍写 `lead_dry_run`/`done_thread_reconcile` 搬到 `QA_AND_INVOCATION_SEAMS`，但同文件 §2.5 与 plan.md §3.5-3.6 已正确要求“17 项数组不动，在 `FLAG_EXEMPTIONS` 追加两个显式 FLY-1808 object”。该 evidence table 又是 plan.md:17 指定的 PR 判词底稿，旧说法可能让实现按错误载体落账。另 plan.md:131 的测试汇总仍回退成“10 条 env + registry + tombstone”的总数表达，遗漏 `founder_ux_gate.mode` 的独立 config-key guard，也把 9 个 flag env 与 1 个 companion env 再次混在一起；这与 §3.7/§9 的正确 named-set 合同不一致。

   **Suggested fix:** 把 research.md #11/#12 的处置列改为“`FLAG_EXEMPTIONS` 显式 object（不改 `QA_AND_INVOCATION_SEAMS`）”；把 plan.md §5 集合守卫行逐字镜像 §3.7：10 个具名 registry row、9 个具名退休 flag env、1 个 companion env、`founder_ux_gate.mode` 独立零残留、2 个 exemption 四联断言。不要在摘要层重新压成一个可被错误成员凑满的数字。

## Verdict

CHANGES REQUESTED

先修正 D-2 SQL，使 founder re-ask 的强制证据前置能够按文档逐字执行；再补齐 B-1 的完整 raw-input 矩阵并清掉两处旧账目措辞。其余 Round 2 修复可原样保留。
