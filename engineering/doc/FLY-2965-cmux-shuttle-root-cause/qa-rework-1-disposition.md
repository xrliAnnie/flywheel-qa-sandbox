# FLY-2965 QA 第 1 次打回处置 — 实施记录
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: plan.md, evidence/test-selection.md

QA(execution `072804e3`)在 head `c945876b8` 判 `qa_fail`,返工请求 `rework:b7022bc7…`,核心行为证据(fd-escape、隔离班车、cmux-sync、flag-truth)为绿。两个失败都属实,均为本实现引入:

| # | QA 发现 | 根因 | 处置 |
|---|---|---|---|
| 1 | `FLYWHEEL_VISIBILITY_CMUX_SYNC` 被 `scripts/lib/agent-visibility.sh` 与 `scripts/restart-services.sh` 读取,却不在 registry / `NON_FLAG_ALLOWLIST` / `FLAG_EXEMPTION`;`feature-flags-drift.test.ts` 12 passed / 2 failed(本地与 exact-head CI Unit light 一致) | agent-visibility 原先只用 `${VAR:-default}`,扫描器不计;本单在 restart 的 pin 函数里加了存在性判断 `[[ -z "${VAR:-}" ]]`,它成为需要记账的 shell 读取。我的 drift 测试只在 Chunk 1 后跑过,之后新增的 shell 读取没有重跑 —— 验证漏洞 | 在 `NON_FLAG_ALLOWLIST` 按真实用途登记为路径 plumbing(已有 seam,不是新旋钮),flag-truth 新增断言。RED:drift 2 项失败、flag-truth 新用例失败;GREEN:drift 14/14、flag-truth 45/45;所有读 `truth.ts` 的测试重跑通过 |
| 2 | exact-head CI Script D 分片 1130s,超过 1020s 容量 tripwire | 本单新增的 J 计数用例在 CI 用 W=10/100/200 三档夹具,单独约 100s;该 runner 本身也偏慢(`pnpm build` 96s,main 同期 64s)。main 同期 D 分片 810s,`test-cmux-sync.sh` 360s,本分支 572s | J 用例在 CI 缩为 W=10(W<N)与 W=30(W>N)两档,同样区分 2W 与 2·N·W;W=100/200 的计数(birth 枚举 200/400、read-screen 34)已在 R0 本地实测并记入 `evidence/implement-acceptance.md`。不提高上限、不搬分片 |

剩余风险:D 分片基线 810s,本单净增量缩减后约 25s(按正常 runner 估算)。若 runner 整体偏慢 30% 以上,即使无本单改动 D 分片也会逼近 1020s,那属于容量问题,不在本单范围。

## Lead 裁定(lead-instruction 1a54ee2b)与收口

Lead 明确:该 env 是「cmux-sync 可执行文件路径」覆盖,按非开关登记进 `NON_FLAG_ALLOWLIST` 并写清是路径覆盖、谁读、为什么;⛔ 不做成 feature flag、不进 registry。登记理由已改为点名 `scripts/lib/agent-visibility.sh`(逐 Lead 的 cmux 半边)与 `scripts/restart-services.sh`(restart 批量证明;回滚 pin 保留显式覆盖)。
Script D:对比证据(main 同期 D 分片 810s / `test-cmux-sync.sh` 360s;本分支 1130s / 572s,其中新增计数用例约 100s)已附 PR 评论。
收口顺序按 Lead:推送 → exact-head full CI 全绿、无冲突 → 同头复审 APPROVED → complete needs_review。
