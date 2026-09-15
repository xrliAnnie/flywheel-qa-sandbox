# FLY-2413 并行追加保留分类 — 实施证据
Issue: FLY-2413 (https://linear.app/geoforge3d/issue/FLY-2413/fly-2006-retention-registry-是并发热点任何加表的单都要改同一个测试文件同批-pr-必然互撞)
日期: 2026-09-14
基于: plan.md

## 分类迁移

实现输入基线 `1b9be2546`，修改前从旧 registry 导出有序 `(database, table, classification)` 映射到 `/tmp/fly2413-implement-evidence/baseline.json`。
一次性输出 257 个 identity：teamlead 228、comm 29。导出新 API 的全部分类，与旧映射逐项 `assert.deepEqual`，差异为空。
按 database:table 排序后对紧凑 JSON 计算 SHA-256：`cd8b19caeb0ba775678706b161ad7451c210f1863d12633e4af0e759323b7ef6`。数量仅是本次审计快照，不是未来的全局测试断言。
所有 deleteTarget、retiredOptional 和 protected 分类保持原值。配额保护理由保存在说明文档：当前 pause/recovery/install/delivery 引用需要保留，舰队 rotation 未授权删除 quota 表。

## 可执行证据

- loader 初始 RED：新模块缺失；实现后 24 个格式、并集、不可变性及拒绝路径测试通过。
- guard 工厂初始 RED：4 个测试因 API 尚不存在失败；提取后 missing/unknown/optional/overlap 通过。
- 真实 StateStore/MailboxQueue 临时建库后独立读取 sqlite_master。新增 `fly2413_unregistered_probe` 必须得到精确 unknown 错误，删除后恢复。初始化只证明未遗漏已出现的表，不证明完整生产表相等。
- 在微型独立 actual list 中省略 required_b，必须报 `schema_missing:comm:required_b`。actual list 不从分类数组读回。
- 摘要初始 RED：cached API 缺失，旧 activation/manifest 仍执行而使预期抛错断言失败；接通两个 digest consumer 后均通过。
- 正向清理对照确实删除一条临时旧记录；片段变化后的普通 apply 拒绝 `engine_digest_mismatch`，该行仍在。完整激活链拒绝 `activation_receipt_invalid`。已完成回执在片段变化后仍可重放。
- `scripts/__tests__/fly-2413-retention-mutations.test.mjs` 对 unknown、missing、activation registry field、engine digest 四处逐一执行正常/禁用/恢复。禁用版必须是 `ERR_ASSERTION: Missing expected exception/rejection` 且包含对应错误码；模块加载失败不能冒充被杀死。4/4 通过，亦由 Vitest wrapper 纳入包级 CI。
- activation 专项变异体为了独立验证 registrySha256，把测试凭证的 engineSha256 显式更新到当前值；保留旧 registrySha256，要求仍拒绝。普通激活失配测试不做此更新。engine 专项使用普通 apply，避免 activation 更早失败遮蔽它。
- 参数化 loader 覆盖 add/remove/edit、源文件变化、重命名恢复顺序不变、坏 JSON 及根/库/文件软链。补充根目录软链 RED 揭示尾斜杠会跟随软链；在 lstat 前规范化路径后 35/35 通用测试通过。
- 临时 Git 仓库 A/B 从共同 base 各自只添加一张保护表的 JSON。普通 merge 成功；diff 仅两片段，common guard 字节不变；加载为并集。实际 SQLite 保留 B 而删去 B 片段，报精确 unknown。该实验不承诺 StateStore 源码并发无冲突。

## 消费者与设计建议处置

两个源码边界扫描仅增加固定 retention JSON 树的扫描范围，允许命中仍是 exact file paths；FLY-2396 保持 6 条，FLY-2398 的一个旧 registry 路径替换为两个具体片段。
FLY-1645 仅修改两个 exact path+linePattern，命中数 9/3 不改；FLY-1674 内容例外替换为两库具体路径，并为文件名扫描增加相同两个 exact path、各自 liveness 检查，没有目录通配豁免。

严格 dotfile/备份拒绝保持批准计划，不采用 advisory 的忽略 dotfile 建议。摘要根明确为 scripts/lib，参数化根的固定同级 loader/registry 源一起散列。旧全局 fixture 删除后的交叉副本 typo 覆盖损失已明确写在维护说明中；未增加新的集中历史/延迟表清单。
既有逐 feature 保护断言移入冻结迁移测试，quota 单独测试；后续 feature 自己维护测试。原 delete-target/policy 多重集合相等断言保留，亦满足集合相等，不自动产生任何删除 SQL。

## 验证状态

- `pnpm install --frozen-lockfile`: exit 0。
- `pnpm lint`: exit 0，有既存 warning，非零错误未被忽略。
- `pnpm -r build`: exit 0。
- `pnpm --filter flywheel-teamlead typecheck`: exit 0。
- focused：初次总跑 78/79，根目录软链断言失败；修复后通用文件 35/35、activation + mutation wrapper 12/12。最终整组复跑结果见后续追加。
- `node --test scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs` 与实际 consumer gate 通过。
- `node scripts/fly1645-receipt-residue-gate.mjs --main-only`: passed。
- `bash scripts/__tests__/fly1674-residue.test.sh`: 79 passed / 0 failed。
- 包级聚合仍运行；代码评审、PR 和 exact-head CI 尚未完成。未执行生产清理、激活、部署、QA dispatch 或 merge。

原始运行日志位于 `/tmp/fly2413-implement-evidence/`；本文件保存可复跑命令、断言范围与结果，不把 focused green 写成 aggregate green。

最终整组 focused 复跑：8 files / 80 tests passed，包含 mutation wrapper；运行时间 2026-09-14 13:56:56 PDT，29.05s。日志 `final-focused.log`。

## Resume audit (2026-09-14)

- Recomputed the 257 identity/classification pairs directly from Git baseline `1b9be2546` and the current facade: exact equality, difference zero, SHA-256 unchanged (`cd8b19caeb0ba775678706b161ad7451c210f1863d12633e4af0e759323b7ef6`).
- Added an executable simulated third-party PR test. A fixed `shared-schema.test.mjs` independently reads SQLite schema created from SQL, and invokes the strict production guard with loaded classification fragments. Baseline passes; adding only feature schema fails with `schema_unclassified:comm:third_party_feature`; adding that feature's fragment passes; removing the fragment fails again. The shared test bytes remain identical throughout. Registry suite: 36/36 pass (`third-party-test.log`). Existing A/B ordinary merge and four guard mutants remain in the CI suite.
- Earlier code review gate `b0659ded-8b5e-44b9-853a-b4b614fe6d5c` returned effective APPROVED for `b34d493d1b83da7dd5cac224bc5e477fcfd92af7`. Four nonblocking advisories were reported to Lead via report `164b71c7-d47a-4e7b-a871-eaa93264c8af`: absent-table typo coverage, strict stray-file rejection, existing activation rotation procedure, repeated digest I/O. No scope expansion to resolve these advisories.
- PR #1196 is non-draft. CI run `34896923189` passed all checks on `8cf78db41f7081c1297ee36b01c2027c4343696f`; that result does not certify subsequent commits. Final-head review and CI will be recorded in the PR/handoff receipts.
- Previous local aggregate process handle 13843 is absent. Its `flywheel-package-gate-EWBZK3/summary.json` is incomplete: claude-runner 1334, comm 2551, config 825, core 263 tests passed; execution stopped before an edge-worker receipt. It is not aggregate green or an accepted complete RPC-only receipt. Remaining packages are being run with `VITEST_MAX_FORKS=1`, with results under `resume-packages/`. CI package coverage is independently green on the head named above.

## Engine conflict rework (2026-09-15)

- Request `rework:577efcaad54b432bf74020597ffee1cd940b1eaa37f0c250b1507beea3492c00`; TURN implement epoch 8, attempt 2. Rework base `71a10b1b1c805851c57355a02fdffdb6cce18458`; merged main `8e28a264c214c8b4f0d8f1a11d15d9634aafbc07`.
- Resolved registry/shared-test/deleted-fixture conflicts by retaining fragment loading and removal of the shared global inventory. Main's three FLY-2563 protected tables become three independent fragments; their feature protection assertions live in `fly-2563-retention-protection.test.ts`. No retention policy or deletion behavior changed.
- Independently evaluated main's old registry and compared every identity/classification with the resulting JSON fragments: 260 entries (257 original plus three main additions), exact equality, zero differences. The original 257-entry migration evidence above remains historical evidence.
- Initial focused attempt failed before schema assertions because the checkout's compiled flywheel-config lacked the newly imported `installSqlTiming`; source exported it. Full workspace build corrected the stale artifact. This initial failure is not drift evidence.
- After building, temporarily removed only the three new fragments and ran the unchanged registry suite plus the feature protection test: 3 assertion failures / 34 passes. Both real initialized-schema checks rejected `schema_unclassified:teamlead:ship_judgment_observation_cursor,ship_judgment_observation_pending,workflow_terminal_archive_cursor`; the feature assertion rejected missing protection. Restored all three fragment bytes immediately. Log: `/tmp/fly2413-rework-drift-red.log`.
- `pnpm lint` exit 0 (20 existing warnings); `pnpm -r build` exit 0. Consumer gate tests and production scanner passed; FLY-1645 residue passed; FLY-1674 residue 81 passed / 0 failed; CI structure contract passed. Focused/aggregate and final review/CI receipts are pending at this writing.

- Follow-up main movement to `b9418b780cce46466665a360f680b56ade736d56` introduced a FLY-2567 patrol-document path conflict in FLY-1674's exact allowlist. Preserved both new main document paths and both retention fragment paths. Rechecked FLY-1674: 82 passed / 0 failed; FLY-1645 and CI structure passed. No registry identity changes in this second sync.
- Focused run finished with 81 passed / 1 timeout (third-party subprocess experiment exceeded default 5s under host contention); isolated default-timeout retry also timed out. A command-line `--testTimeout 30000` rerun passed in 3.15s without source changes. All four mutants, activation/manifest negatives, initialized schema checks, and feature protection passed. Typecheck exit 0. Aggregate remains live; exact-head CI is the final package gate per the injected QA criteria.

## 2026-09-15 PR #1199 conditional main sync

- Lead ruling ae9f2413 authorized one main merge onto frozen `c87097744`, one targeted verification, one push and one new review. PR #1199 merged at 18:37:48Z; merged base is `84a65da2e`.
- Resolved the registry/test/removed-fixture conflicts by preserving the fragment facade and removal of the shared current-table list. Main's `epic_intake_scan` and `epic_intakes` retain `protectedCurrentOrReference` in individual fragments. Before adding them, the production guard rejected each exact unregistered identity; after adding them, both pass. All 262 identity/classification pairs equal main's registry, independently evaluated from its Git blob.
- One serial focused Vitest invocation passed 111 tests across 11 files, including migration, all four mutants, unchanged third-party test, A/B merge, activation/manifest negatives, protection/boundary tests, FLY-2567 budget compatibility and terminal archive tests. CLI testTimeout=30000 was explicit for subprocess tests; this does not change CI defaults. Log: `/tmp/fly2413-post1199-targeted.log`.
- Consumer tests and production scanner passed; FLY-1645 passed; FLY-1674 passed 82/82. No local aggregate or old CI rerun. Fresh exact-head CI and review remain pending.
- The earlier aggregate-live references above are historical: that aggregate was stopped under the Lead host-contention instruction and is not relied on.
