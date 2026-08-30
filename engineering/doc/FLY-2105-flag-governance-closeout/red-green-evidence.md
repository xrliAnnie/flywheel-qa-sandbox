# FLY-2105 Flag 治理关门 — RED/GREEN 证据
Issue: FLY-2105 (https://linear.app/geoforge3d/issue/FLY-2105/flagd关门-ci-守卫改判据env-configyaml-出现任何-flag-值即红legacy-unmanaged-baseline)
日期: 2026-08-30
基于: plan.md

## Slice A：registry ↔ store

RED：`feature-flags-store-policy.test.ts` 在旧实现上得到 5 个预期失败，其中核心诊断为：

```text
expected STORE_MANAGED_FLAGS.size 10 to be FEATURE_FLAGS.length 17
expected LEGACY_UNMANAGED_BASELINE [7 names] to equal []
pipeline_dag: expected STORE_MANAGED_FLAGS.has(name) false to be true
```

GREEN：closed-world policy、StateStore global/project scope guard、route/runtime 与 truth tests 共通过：

```text
config focused: 123 passed
teamlead focused: 83 passed
```

## Slice B：raw env / tracked config.yaml

分支基线 RED：新增 tracked-config test 通过生产 `ConfigLoader` 读取 `git ls-files -z` 的
`config.yaml`，在旧 tidal-echo 样例上得到：

```text
doc/engineer/onboarding/tidal-echo/config.yaml:
checkpoints.brainstorm.enabled was retired (FLY-2103)
```

删除两个 checkpoint `enabled` 与 `doc_flow.enabled` 后 GREEN。

真实 mutation drill（坏状态均未提交）：

1. 在 production TS 暂加 `process.env.FLYWHEEL_X === "1"`，真实
   `scanSources + auditFlagAccounts` 门失败：
   `FLYWHEEL_X: register it, classify it ... or add an owned FLAG_EXEMPTION`。
2. 反向 patch 删除该读点后，同套件 GREEN。
3. 在 tracked `.flywheel/config.yaml` 暂加 `doc_flow.enabled: true`，生产 judge失败：
   `doc_flow.enabled was retired (FLY-2103)`。
4. 反向 patch 删除该 key 后，同套件 14/14 GREEN。

清理核验：production TS 与 `.flywheel/config.yaml` 均不存在 `FLYWHEEL_X`、mutation marker 或
`doc_flow.enabled`；`git diff --check` 通过。

## Slice C：closed-world ledger、codec 与 exemptions

GREEN 合同：

- `LEGACY_UNMANAGED_BASELINE` 是冻结空数组，测试同时断言未来不得新增；
- `STORE_MANAGED_FLAGS` 直接由 `FEATURE_FLAGS` 全量派生，断言
  `STORE_MANAGED_FLAGS.size === FEATURE_FLAGS.length`；
- `PROJECT_STORE_MANAGED_FLAGS` 与 registry 的 `scope === "project"` 精确相等；
- 每个 registry flag 都必须存在 codec，codec 的默认有效值与 `polarity` 一致；enum codec
  另断言每个合法值与非法值 fallback，防止 `qa_auto` 式 registry/parser 反相；
- `FLAG_EXEMPTIONS` 只允许 `qa_isolation`、`dry_run`、`one_time_migration` 三种 bounded seam，
  每条有 owner、reason、retireWhen，env seam 全部 `persistentEnvAllowed: false`；新 exemption key
  被 frozen allowlist 拒绝。

最终 ledger/store authoring focused suite：`34 passed`。

## Slice D：删掉 legacy 写入与读点

按 Ponytail 最小化原则没有保留“暂时不用”的兼容抽象：删除 `env-file-writer.ts`、
`applyFlagToggle` 与相应测试/route/management fallback；Gemini advanced env mode、voice env seam、
cmux/runner legacy guard 均改为固化行为或 store read。净删除大于新增（当前分支对 main：
`1406 insertions, 3171 deletions`）。

相关 executable proof：

```text
config governance: 94/94 passed
Teamlead store/route runtime: 68/68 passed
config truth/profile/skill: 72/72 passed
Claude Runner TmuxAdapter: 159/159 passed
legacy writer/route/management/acceptance/voice: 76/76 passed
qa generalized helper: 8/8 passed
cmux sync: 576/576 passed
```

## Slice E：repository gates 与环境例外

- `pnpm lint`：PASS（14 条既有 warning，0 error）；
- `pnpm -r build`：PASS；
- core hermetic（排除 GUI-only 文件）：`19 files / 219 tests passed`；
- Teamlead full parallel：`742 files / 9848 tests passed`，六个失败文件均在独立进程重跑
  `89/89 passed`；Claude Runner 的两个 host-contention 失败也独立重跑 `2/2 passed`。

`pnpm test:packages:run` 在 resident sandbox 的唯一稳定硬失败是
`packages/core/test/tmux-viewer.macos.test.ts` 的两个真实 Terminal.app 测试：

1. `closes a single-tab Terminal window opened with the matching custom title`
2. `returns closedTab=false (not_found) when no matching tab exists`

原文证据：`Connection Invalid error for service com.apple.hiservices-xpcservice.`。根因是该测试的
preflight 只执行 `which osascript`，没有验证当前进程拥有可用 GUI session。Lead 裁示本 PR 不修改
这条无关 preflight；PR 的 GitHub CI 是权威 full-suite 判据，并在 PR body 留 follow-up：preflight
应探测 GUI session 可用性。

## Slice F：真实退役扫描

Production auth-required `{}` trigger 返回 HTTP 200，恢复 durable run `3`。真实结果是 4 个候选、
6 个 no-clock，不伪报 0；`#flywheel-notification` root `1543690293814239324` 已回读到 exact run
marker 与 hosted report。完整候选、fail-closed access 修复和远端 evidence 见 `scan-evidence.md`。
