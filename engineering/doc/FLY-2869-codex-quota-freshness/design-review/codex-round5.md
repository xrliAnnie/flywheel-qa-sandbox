# Design Review — plan.md (Readiness Round 2)
Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮只复核 commit `d671c1ede` 对 Readiness R1 五项意见的修订及这些修订新引入的契约；A–D 未重审。

R1 #3 已关闭：desktop 校验现在固定了 `codesign --verify`、`-dv` stderr、多 Authority 的 leaf 位置、唯一 TeamIdentifier、超时/缓冲和缓存失效。R1 #5 也已关闭：founder Q1=A 后，§0、§1.6.8、切片 17 与 QA 表均明确“不加 activation flag、部署即生效”。R1 #1/#2/#4 的主体方向正确，但仍有三个安全/验收层面的阻断问题。

## What's Good (Keep)

- 第二份 `ps` 把 `ucomm` 与 args+env 放进同一权威行，并只从剥离后的 suffix 解析环境；缺 args、重复关键环境键和普通 prefix mismatch 都 fail-closed。
- stale-running 已从单次缺席改为同一 `(project, execution_id, started_at)` 持续至少 60 秒，Bridge 重启重新计时；SQLite timestamp 明确按 UTC 解释，null/非法/未来时间保持 blocking。
- desktop 身份合同与本机真实三条 Authority 输出一致；inode/mtime 变化强制重验签，argv0/lsof/signature 任一失败都回到 `process_home_unknown`。
- 测试清单已补入 slot symlink escape、HOME→canonical 正反例、fake argv token、terminal process-only/lease-only、15 分钟边界和 signature cache 失效。
- §1.7 没有改变产品代码或 Q1 决策；实验保持 scratch `CODEX_HOME`，未切 canonical、未碰 business 号。

## Issues & Recommendations

1. **BLOCKING — 两次 `ps` 的 prefix 合同仍不能区分“环境 suffix”和两次采集之间新增的 argv。**

   **Why it matters:** 当前合同只要求权威 `args+env` 以第一次 args command 开头。如果同一 PID/lstart 在两次采集之间 exec，新 argv 是旧 argv 的严格扩展，检查仍会通过。例如第一次 args 为 `/path/codex`；第二次变成 `/path/codex CODEX_HOME=/approved ...`，且真实环境没有 `CODEX_HOME`。剥掉旧前缀后，新增 argv 中的 `CODEX_HOME=/approved` 会被误当成环境事实。现有 “same pid/lstart exec” 用例只覆盖 prefix 不匹配，未覆盖 prefix-extension；因此“args 中伪造 token 会被剥掉”的保证在竞态中不成立。

   **Suggested fix:** 在权威快照之后再取一次非环境 args 快照，并要求同一 `(pid,lstart)` 的前后 args 逐字相等；只有稳定 args 才能作为权威行的剥离边界。任何缺行、重复、前后 args 变化都记全局 `process_home_unknown`。若不愿增加第三次 `ps`，改用能在同一内核读取中提供 argv/env 明确边界的接口。增加硬红：旧 args 是新 args 的严格前缀，新增 argv 恰为 `CODEX_HOME=`、`HOME=` 或 `FLYWHEEL_EXEC_ID=`；不得把它们解析为环境。

2. **BLOCKING — 新的 60 秒持续缺席状态没有定义并发 collector、失败采集和时间源的提交语义。**

   **Why it matters:** 计划 §1.5 会让 availability、runtime/observer 共享同一 wrapped collector；`CodexQuotaAvailability` 的 single-flight 只约束 availability 自身，账号读数刷新仍可并发调用 collector。若两个采集乱序完成，旧轮可能在新轮之后清除或成熟 candidate；一个耗时旧轮也可能仅凭“完成时间相隔 60 秒”制造第二个样本。当前 collector 又会把内部异常转成 `complete=false` inventory，而不是抛出；若部分/失败轮仍保留或推进 first-seen，两个成功端点之间并不构成“连续完成的采集”。此外，若 60 秒使用 wall clock，系统时钟跳变可提前成熟。

   **Suggested fix:** 给 absence tracker 写明原子发布规则。可将 host collection 本身 single-flight/串行化，或为每轮分配 generation，仅允许按权威证据采集顺序提交 tracker；被旧 generation 晚到的结果不得修改 tracker，并只能对 caller 返回 blocking 判断。只有 DB、权威 process snapshot 和全部批准 home leases 都成功取得的完整轮才能推进；任何缺失/失败轮、process/lease 出现、行消失或 identity/status/started_at 改变都重置连续段。60 秒用进程内单调时钟并可注入测试。key 建议使用 canonical comm-db path（legacy DB 也有唯一身份）而不只是 project label。另对 SQLite 时间做严格格式与 calendar round-trip 校验，因为 `Date.parse("2026-02-30T…Z")` 会归一化而不是报错。增加 deferred 并发乱序、夹在两次 absence 中的 incomplete collector、wall-clock 跳变、Bridge 重启及非法日历日期用例。

3. **BLOCKING — “每个单一放行都必须 complete=true 且 reader 仍在 homes/active”与若干获准规则及现有 fail-closed 不变量冲突。**

   **Why it matters:** `host-readiness.ts` 明确把 lease-only home 判成 `lease_without_process`/activity unknown；终态 keep-alive 的“只有 lease”分支按新规则只是让 CommDB 行继续进入原归属检查，不能单独变成 green。若测试为了满足 blanket `complete=true` 而放行 lease-only，会破坏“lease alone is never liveness”。同样，verified desktop 与 test-slot reader 的设计结果是显式排除并留下 info diagnostic，不应仍出现在生产 `homes/active`；Claude/node/zsh 误判回归本来就不是 reader。当前通用矩阵与后面的具体分支因此给出互不兼容的成功条件。

   **Suggested fix:** 把矩阵改成逐行显式期望，而不是统一 green 断言：真正的 ignore/exclusion 谓词应断言 `complete=true` + 指定 info reason（reader 可由该 diagnostic 追踪）；terminal process-only/lease-only 应断言 CommDB 行未被当残留丢弃并进入原 reconciliation，其中 lease-only 必须继续得到 `lease_without_process`、`complete=false`，除非同轮还有真实 process 证据。为每个 info relaxation 固定 reason、关键字段和 scope；“仍在 homes/active”只用于本来就应归属到生产 inventory 的真实 reader。

4. **ADVISORY — §1.7 与 QA 表对实验结论的表述比证据覆盖面更强。**

   **Why it matters:** 两轮证据证明的是：同一 app-server 在 `account/read {refreshToken:false}` 与 `account/rateLimits/read` 下，换软链后立即及 15 秒内仍报告启动账号。实验没有覆盖 refresh、401/配额错误后的重载或实际请求路径；§1.7 自己也承认 refresh 未测。QA 表直接写“切号不传导到在跑的 daemon”容易把该有限观察当成所有路径的证明。

   **Suggested fix:** 将结论写成“在已测的 non-refresh account/rate-limit 路径与 15 秒窗口内不跟随；refresh/error/request 路径未测”，并把“FLY-2729 需要做”标为基于该证据的保守工程结论。无需扩大本 PR 或冒险运行有损 refresh 实验。

## Verdict

CHANGES REQUESTED。`codesign` 与 Q1 已关闭；在实施前仍需修正 argv-prefix-extension 竞态，定义 sustained-absence tracker 的并发/失败发布语义，并把逐谓词测试期望改成不破坏 lease-only fail-closed 的可执行矩阵。
