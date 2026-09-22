# FLY-2755 Script Tests 六片再平衡 — 实施计划
Issue: FLY-2755 (https://linear.app/geoforge3d/issue/FLY-2755/main-红挡全部-pr-script-tests-35-分片耗时-1036s-超预算-1020sfly-1870-容量闸1260-合入后)
日期: 2026-09-18
基于: research.md

> **For agentic workers:** Follow this plan inline under the injected implement TURN. Use TDD for both the mailbox harness and workflow contracts; do not dispatch subagents or redesign the allocation.

**Goal:** 新增第六个 required Script Tests job，把 105 个完整 named step 均衡到六片并保留 FLY-1870 保护，同时消除 FLY-1572 测试把 stderr 混入 JSON 导致的 exit 5。

**Architecture:** 六片保留相同的独立 checkout/install/build/tool setup 和 20m/85% tripwire；只改变完整 workflow step 的 owner。`ci-structure.test.sh` 是 job graph、exact inventory、聚合与 tripwire 语义的可执行真值；mailbox shell suite 分离 JSON stdout 与诊断 stderr。

**Tech Stack:** GitHub Actions YAML、Bash、embedded Python structure guard、jq、pnpm/TypeScript monorepo。

---

## 1. 锁定不变量

### 必须实现

1. required checks 变为 Script Tests 1/6…6/6，全部只依赖 `classify`，只在
   heavy scope 运行。
2. 六片都保持 `timeout-minutes: 20`、第一条 record-start、相同 setup、最后
   一条 `if: always()` 的 85% tripwire；不使用 now override、swallow 或
   continue-on-error。
3. 105 个当前 Test/Integration step 的完整 YAML 对象多重集合守恒，并恰好
   归属一片。只有 owner/order 改变；各 step 的 name/run/env/timeout/if 不改。
4. `script-tests` 保留 `fetch-depth: 0` 以服务 FLY-2007；2–6 使用默认 shallow
   checkout。
5. `ci-ok.needs`、heavy job list、full-mode success assertions 和 required-jobs
   manifest 全部纳入第六片；skip mode 仍只接受分类器授权的全体 skipped。
6. FLY-1572 success case 的 stdout 单独交给 jq，stderr 单独保留；非零 rc、
   JSON state、权限修复和 sidecar negative guards 不弱化。

### 明确不做

- 不改 `scripts/ci-job-elapsed-tripwire.sh`、20m cap 或 85% threshold。
- 不删、拆、条件化或缩短任何已登记 suite 命令。
- 不改 mailbox migration 产品代码或迁移断言来迁就 CI。
- 不重构 Ubicloud canary、unit matrix、payload-distribution 或 classifier。
- 不改 `CLAUDE.md`，不 dispatch QA，不请求 ship，不 merge/deploy。

## 2. 六片 exact inventory

以下顺序是 `ci-structure.test.sh` 的目标清单，也是 workflow 中 setup 与 tripwire
之间的 named-step 顺序。

### `script-tests` — Script Tests 1/6 — balanced shell suites A

1. Test — FLY-1389 path-hygiene + 529-Room repair batch
2. Test — FLY-2598 voice host configuration
3. Test — FLY-1496 model resolution + Lead derivation
4. Test — FLY-2007 phase-0 analyser contract
5. Test — FLY-1887 one-shot Codex hard timeout
6. Test — FLY-2237 slot Bridge cycle
7. Test — onboard-shell public install chain
8. Test — FLY-2145 Lead memory private repository
9. Test — FLY-2144 retired dispatch residue guard
10. Test — Lead in-flight mailbox adoption contracts
11. Test — FLY-1189 multi-Lead campaign harness
12. Test — FLY-1961 dual-vendor workspace trust
13. Test — FLY-1959 updater sources + body provenance contracts
14. Test — FLY-2102 startup flag freeze residue guard
15. Test — FLY-2664 merged worktree read-only audit

### `script-tests-2` — Script Tests 2/6 — balanced shell suites B

1. Test — FLY-2331 Bridge async-child guard regression
2. Test — FLY-2444 generalized Lead launcher
3. Test — FLY-2598 voice client coexistence
4. Test — FLY-1081 notify-path migration
5. Test — FLY-913/2204 restart + calendar isolation guards
6. Test — FLY-1955/2211 Codex daemon mutation safety
7. Test — FLY-1330 log janitor
8. Test — FLY-2465 isolated Codex quota contracts
9. Test — FLY-2549 summary preflight with stale workspace dist
10. Test — FLY-2139 database maintenance
11. Test — FLY-2598 readonly voice preflight
12. Test — FLY-2454 slot isolation contracts
13. Test — FLY-1393 flag truth CLI
14. Test — FLY-1338 matrix coverage parity (QA)
15. Test — FLY-1759 reap-first worktree teardown

### `script-tests-3` — Script Tests 3/6 — balanced shell suites C

1. Test — FLY-1434 unified restart + quota caller
2. Test — payload real-install smoke
3. Test — FLY-1501 restart brake + heartbeat guard contracts
4. Test — FLY-1678 statusline model-scoped bar + installer
5. Test — FLY-2456 hermetic restart drill evidence
6. Test — FLY-1189 assert library + driver trap owner
7. Test — FLY-648 one-command setup wizard
8. Test — FLY-2134 artifact freshness monitor
9. Test — Discord adapter orphan reaper (FLY-183)
10. Test — resident Codex recovery contracts
11. Test — FLY-1729/1743 restart update + consistency guards
12. Test — FLY-1707 incident replay
13. Test — FLY-1944 host terminal cutover brake
14. Test — FLY-2446 two-Lead voice driver
15. Test — FLY-1830 non-Lead daemon convergence

### `script-tests-4` — Script Tests 4/6 — balanced shell suites D

1. Test — FLY-1364 cmux sync repair
2. Test — FLY-2404 shared Codex credential truth
3. Test — FLY-1905 CI apt-install helper
4. Test — Lead rules single-bundle load chain (FLY-1402)
5. Test — FLY-2270 QA report host stub
6. Test — FLY-1634 restart net-deletion contracts
7. Test — FLY-2519 read-only Lead parity inventory
8. Test — FLY-2403 Astra/Fable design outcome report
9. Test — FLY-2383 voice concurrency measurement contract
10. Test — FLY-1887 bounded Flywheel logs
11. Test — FLY-957 record_deployed_range best-effort
12. Test — FLY-2459 Codex department capability and migration
13. Test — FLY-1018 gemini-agent guard
14. Test — FLY-880 PM executor role contract
15. Test — FLY-2015 diagram-design role routing
16. Test — FLY-2022 diagram-design project install
17. Test — FLY-1787 CoS identity contract
18. Test — FLY-1461 QA executor 529 N-to-N contract
19. Test — FLY-1463 QA executor ship-report contract
20. Test — FLY-1981 runtime role auto-QA retirement
21. Test — FLY-1715 runner boundary shell contracts
22. Test — FLY-1945 trusted patrol helper closure
23. Test — FLY-1870 job elapsed tripwire contract
24. Test — FLY-2034 Belle staged credential gate
25. Test — FLY-1356 skill-framework vendor + variant contracts
26. Test — FLY-2270 slot Bridge launch boundary
27. Test — FLY-513 global-codex repoint apply-path
28. Test — FLY-697 codex-log-guard
29. Test — FLY-1436 work-kind cutover CLI
30. Test — FLY-1867/2026 Playwright lifecycle tools
31. Test — FLY-2278 attempt-version rollback

### `script-tests-5` — Script Tests 5/6 — balanced shell suites E

1. Test — FLY-1855 executable Lead patrol snapshot
2. Test — FLY-1929 voucher watch contracts
3. Test — FLY-1986 load probe contract
4. Test — FLY-2146 Lead memory remote sync
5. Test — FLY-1023 Buddy onboarding (step CLI + provider contract)
6. Test — NPM packaging pipeline + packaged-mode seams
7. Test — FLY-1572 mailbox migration CLI
8. Test — FLY-1861 CI cancellation and classification contracts
9. Test — FLY-2533 packed phase protocols
10. Test — FLY-519 fleet provisioning + zero-secret gate
11. Test — FLY-1189 fault injector safety lock
12. Test — FLY-2126 Raya voice scenario wrapper
13. Test — FLY-1674 legacy-path residue guard
14. Test — FLY-882 Discord bot token pool

### `script-tests-6` — Script Tests 6/6 — balanced shell suites F

1. Test — FLY-1663 launchd-native Lead lifecycle
2. Test — FLY-1814 launchd fleet contracts
3. Test — FLY-1726 canonical Lead identity delivery
4. Test — FLY-2274 cutover window artifacts
5. Test — FLY-2570 dynamic design ratio operator
6. Test — FLY-1948 slot Discord channel evidence
7. Test — FLY-1775 generalized-DAG 529 room
8. Test — FLY-1649 r4 migration-window hardening
9. Integration test — cmux-sync hooks
10. Test — FLY-2033 meeting artifact closure
11. Test — FLY-927 infra-alert shell path
12. Test — FLY-2190 host tmux selection S0
13. Test — FLY-1764 legacy swap broadcast retirement
14. Test — FLY-1609 four-arm analysis contract
15. Test — FLY-1327 cycle-time report

## 3. TDD 实施步骤

### Task 1: FLY-1572 输出通道回归

**Files:**

- Modify: `scripts/__tests__/migrate-fly1572-mailbox.test.sh:239-248`

- [ ] 在 migrated-success command substitution 内、CLI 输出后打印固定
  `[slow-sql]` stderr fixture；保留现有 `2>&1`，精确复现 CI 行列签名。
- [ ] 运行 `bash scripts/__tests__/migrate-fly1572-mailbox.test.sh`，确认 RED：
  jq 以 parse error/exit 5 失败，而不是业务断言失败。
- [ ] 将 stdout 保留在 `MIGRATED_OUTPUT`，stderr 重定向到 TEST_ROOT 内独立文件；
  保留 rc 捕获和 `test "$MIGRATED_RC" -eq 0`。
- [ ] 只把 `MIGRATED_OUTPUT` 传给 jq，并 grep stderr 文件确认 fixture 到达正确
  通道；若 stderr 文件有内容，带前缀回显供 CI 调试，但不污染 JSON。
- [ ] 连续运行套件三次，全部应打印 `migrate-fly1572-mailbox: PASS`。

### Task 2: 六片结构守卫 RED

**Files:**

- Modify: `scripts/__tests__/ci-structure.test.sh`

- [ ] 把 expected job ids/order、job variables、heavy loops、required check names、
  `ci-ok.needs`、aggregate exact jq、timeout/setup/tripwire 遍历扩为六片。
- [ ] 用 §2 的六份清单替换 `expected_shard_tests`；`all_script_steps`、
  `script_shards`、display names 也扩为六片。
- [ ] 把仅写死 owner 但本质要求 exactly-once 的 FLY-2404、FLY-2134、
  FLY-1948、FLY-2446 与三个 FLY-2598 内容守卫改为从 six-shard union 定位；
  保留其命令内容断言，并更新 FLY-1715/1830/1814 的过期 owner 文案。
- [ ] 运行 `bash scripts/__tests__/ci-structure.test.sh`，确认因 workflow 缺
  `script-tests-6`、旧名称/owner/aggregate 而 RED。

### Task 3: Workflow 与 required manifest GREEN

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/ci-required-jobs.json`
- Modify: `packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts`

- [ ] 修改前从 YAML 读取 105 个 Test/Integration step 的完整对象，保存只读
  baseline 到 `/tmp`；不提交临时文件。
- [ ] 将五个现有 job 显示名改为 1/6…5/6，新增同骨架 `script-tests-6`；六片
  容量注释指向本 research/plan，明确 p75=565s 与 exact-head `usage ≤70%`
  （20m cap 下 `elapsed ≤840s`）真机验收。
- [ ] 严格按 §2 整体剪切 named step（连同注释、env、timeout、run）；不得
  复制后遗留旧 owner。
- [ ] `script-tests` checkout 保留 `fetch-depth: 0`；2–6 默认 shallow。
- [ ] `ci-ok.needs`、heavy list 和六个 success assertions 纳入 job 6。
- [ ] required-jobs heavy check 名称精确改为 1/6…6/6。
- [ ] `fly-889-ci-workflow-timeout-guard.test.ts` 的冗余 shard/timeout/helper
  inventory 纳入第六片。
- [ ] 再次解析 workflow，比较 Test/Integration 完整对象多重集合与 baseline
  完全相等，union count=105，owner count=15/15/15/31/14/15。
- [ ] 运行 `bash scripts/__tests__/ci-structure.test.sh`，应 GREEN。

### Task 4: 聚焦与聚合验证

**Files:** none unless a failing in-scope contract proves a required correction.

- [ ] `bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`
- [ ] `bash scripts/__tests__/ci-job-elapsed-tripwire.test.sh`
- [ ] `bash scripts/__tests__/migrate-fly1572-mailbox.test.sh`（再次连续三次）
- [ ] `pnpm lint`
- [ ] `pnpm -r build`
- [ ] `pnpm test:packages:run`
- [ ] 若 package aggregate 只出现允许的完整 zero-assertion-failure
  onTaskUpdate RPC artifact，按注入 PACKAGE_GATE_RECEIPT 规则保存分类证据；
  任一真实断言失败都保持红并修根因。

### Task 5: Commit、PR 与 code review

**Files:**

- Create last: `engineering/doc/milestones/FLY-2755.md`

- [ ] 更新 progress ledger；检查 inbox/TURN。
- [ ] 分批提交 mailbox fix、workflow/guards、文档；不扫入无关文件。
- [ ] 最后创建 milestone，使其成为 literal last commit；不改 `CLAUDE.md`。
- [ ] push feature branch，创建 non-draft PR。
- [ ] `stage set code_review` 后用 `gate review_code --no-block` +
  `request-review --type code` 注册有效评审；CHANGES_REQUESTED 修复后新开 gate。
- [ ] APPROVED advisory 用 `ask --report` 交 Lead；任何修订后重新保证 milestone
  为 literal last commit 并复测。

### Task 6: Exact-head CI 与交接

- [ ] 不手动调用 `ci-full ensure`；代码 PR 的自动 full CI 应覆盖六片。只有注入
  handoff 明确冻结当前 head 时才允许 ensure。
- [ ] 绑定 PR head 与 run head，确认 CI OK green；逐片读取 tripwire 日志，
  记录 `elapsed` 与 `usage`，六片都必须 `usage ≤70%`（即 `elapsed ≤840s`）。
- [ ] 确认 FLY-1572 step green；若 exact head 仍失败，按保存后的 stderr 证据
  回到根因调查，不能 rerun 当修复。
- [ ] 通过 `ask --report` 汇报 commit、PR、review、local/package/CI 证据。
- [ ] 提醒 Lead：本单合入后，在飞 PR 在 frozen gate 前必须先同步 main；旧
  5-shard manifest 配新 merge workflow 会 fail-closed 为 `inconsistent`。
- [ ] 执行注入命令 `complete --route needs_review --pr <NUMBER>`；不 merge、不
  dispatch QA、不 deploy。

## 4. 风险与回滚

- **六片仍接近 70%：** 历史最慢公共开销轮投影最高 734s；自动 PR CI 是
  决策证据。若单片超线，使用该 run 的逐 step timestamp 在现有六片间移动
  完整 step，再更新 exact inventory；禁止加第七片或抬阈值，除非 Lead 改 scope。
- **大范围 YAML 搬家漏项：** structure exact inventory + 完整对象 multiset
  conservation + shell enumeration 三层证明，不能靠目测。
- **stderr 分流藏住错误：** rc 仍 fail-closed，stderr 文件保留并回显；只有
  JSON parser 不再消费诊断。所有业务正负断言继续运行。
- **并发 main 漂移：** PR 前 fetch/rebase 或 merge origin/main 只做技术同步，
  然后重新跑 guards/review/CI；不 force-push，除非 Lead 明确确认并使用一次性 ACK。
- **scoped mode 漂移：** 自动 full 证据依赖 `CI_SCOPED_MODE=off`；若期间切为
  on，不自行 `ci-full ensure`，由 Lead 明确授权 full 标签或 frozen-head ensure。

## 5. 完成审计映射

| 要求 | 权威证据 |
|---|---|
| 六片均 ≤70% | exact PR head 的六条 tripwire `elapsed/usage` 日志 |
| cap/threshold 未弱化 | workflow diff + structure guard + tripwire contract suite |
| FLY-1572 不再 exit 5 | stderr fixture RED→GREEN、三次本地 PASS、exact-head CI step green |
| 套件登记守恒 | 105 个完整 step 对象 multiset 相等、structure exact owner inventory、shell enumeration green |
| implement handoff 完整 | commit/push、non-draft PR、effective APPROVED、CI OK、`complete --route needs_review` receipt |
