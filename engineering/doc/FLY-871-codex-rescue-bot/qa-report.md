# FLY-871 QA 报告 — R1 token 保鲜守卫(incident 根治)

Issue: FLY-871 (https://linear.app/geoforge3d/issue/FLY-871/infraresilience-codex-救援-bot-账号体系外的看切救696-交叉自愈架构的-codex-半边token)
日期: 2026-07-05
基于: plan.md §11(R1 核心,本 PR),design-review.md,commit c8106c0a(HEAD)

## 1. 验证范围

本 PR 只交付 **R1**(plan.md §11 交付物清单第一项):

- C1 `use_profile` 切走回捕(bash)
- C2 Node freshness helper(`freshness.ts` + `freshness-cli.ts` + bin wrapper)
- C3 `use` 结构化退出码(30/31)+ `switchAccount` 候选循环
- sentinel 扩展(`account-selfheal-bytecompat.test.ts` + `feature-flags-drift.test.ts`)
- S1 spike:按 Annie 批准的 lead-instruction(fe514116)推迟到 enable gate,本 PR 只落 env-可覆盖的契约 + 全 mock 测试(不违反计划)

**明确不在本次验证范围内**(plan.md §11 后续段,均未在本 PR 交付代码):
- R1 fast-follow C4 keep-fresh 巡检 → 已开 tracked issue FLY-875(commit `17468972`)
- R2(Codex Infra Bot 部署 + `/api/account-switch` 路由)
- R3(救援 playbook)

## 2. 代码审阅

逐文件读了本 PR 的全部 diff(`git diff main...HEAD --stat` 20 个文件,核心逻辑在
`packages/teamlead/src/account-heal/{freshness.ts,freshness-cli.ts,switch-executor.ts,claude-profile-cli.ts}`
+ `packages/claude-runner/bin/flywheel-claude-profile`)。逐条核对 plan.md §3/§4/§6 的契约:

- ✅ **active 账号绝不 pool-refresh**:`verifyPoolCredential` 在任何文件读/网络调用前先判 `name === activeName` 并 throw(freshness.ts:150-155)。
- ✅ **无 static-ok 放行态**:`expiresAt` 只作 telemetry,永远走 probe-refresh。
- ✅ **凭据不进 argv**:freshness-cli 只收 `--name/--active/--pool`(非秘密名字),refresh_token 经文件读 + fetch body,从不出现在进程参数里。
- ✅ **超时覆盖 body 读**(Codex R1 HIGH 修复,commit c8106c0a):`fetch` + `resp.json()` 现在共享同一个 `try/finally`,`AbortController` 在两步都生效 —— 验证了 finally 只在两步都完成后才 `clearTimeout`,不会让被拖住的 body 读绕开锁内 120s stale 窗口。
- ✅ **expires_in 校验**(commit c8106c0a):非 finite / ≤0 一律判 stale,不放行"已过期"或"缺字段"的轮转结果。
- ✅ **exit 30(stale)/ 31(helper 不可用)语义分离**:`switchAccount` 候选循环只在 `TargetStaleError` 时标记 `authExpired` 并重选,`FreshnessUnavailableError` 直接 `failed`(环境性,不循环、不误标账号)——bash 侧、`claude-profile-cli.ts` 映射、`switch-executor.ts` 三层逐一读过,行为一致。
- ✅ **bypass 防继承双层**:`claude-profile-cli.ts` 主动 `delete childEnv.FLYWHEEL_CLAUDE_FRESHNESS_BYPASS`(scrub);bash `freshness_guard` 只在 `FLYWHEEL_CLAUDE_LOCK_DELEGATED` 未设时才认 bypass。
- ✅ **capture-back 安全性**:`capture_back()` 对 active 名字做字符白名单校验、拒绝非 JSON-object / 带空白值、拒绝 symlink 目标/文件,写入走 temp+rename+chmod 0600,任何失败只 warn 不 fail 切换。
- ✅ **feature-flags-drift 白名单**:`FLYWHEEL_CLAUDE_OAUTH_ENDPOINT`/`FLYWHEEL_CLAUDE_OAUTH_CLIENT_ID` 标注为 config-value override(非布尔 flag),理由字段写明用途,不是绕过检查。

未发现偏离 plan.md 契约或引入新风险的代码路径。

## 3. 测试执行(真跑,非只读代码)

全部命令在本地真实执行,构建产物为 `pnpm -r build`(根目录,17 个 workspace 包全绿)。

### 3.1 FLY-871 目标测试(全新增 + 修改的测试)

```
cd packages/teamlead && npx vitest run \
  src/__tests__/freshness.test.ts src/__tests__/freshness-cli.test.ts \
  src/__tests__/switch-executor.test.ts src/__tests__/claude-profile-cli.test.ts \
  src/__tests__/claude-profile-cli.integration.test.ts src/__tests__/account-selfheal-bytecompat.test.ts
```
→ **6 files / 54 tests 全 PASS**(含真锁 + 真 bash 脚本的 real-seam 集成测试:stale 目标 exit 30 → `no_account` + Keychain 未写 + `.active` 未提交 + 账号标 `authExpired`)。

```
cd packages/claude-runner && npx vitest run test/claude-profile.test.ts
```
→ **44 tests 全 PASS**,含 FLY-871 新增 11 个用例(freshness guard 调用契约 / stale exit 30 / 非 30 退出码归一为 31 / EMERGENCY bypass 生效 / **bypass 在 delegated-lock 模式下被拒绝(Codex R2#1 layer 2 断言)** / 写回轮转凭据 / capture-back drift 快照 / capture-back 首次切换跳过 / re-select 当前 active 不触发 refresh / capture-back 拒绝 symlink)。

红线断言逐条核实存在且通过:active 拒绝(0 fetch + pool 零写)、future-expiresAt 不放行、helper 不可用 exit 31 全程零 Keychain 写、bypass 防继承双层、超时覆盖 body 读、expires_in 校验、写回顺序(先写 pool 后返回 fresh)。

### 3.2 全量回归(teamlead 包,4814 个测试)

```
cd packages/teamlead && npx vitest run
```
→ **342/346 test files pass, 4773/4814 tests pass**(+16 skipped,与 FLY-871 无关的既有 skip)。失败的 25 个测试分布在 3 个文件,**全部与本 PR 改动的文件无关**,且可归因于本次 QA 是在一个**真实运行中的 Flywheel Runner 会话**里执行(而非全新沙箱),两类已知环境伪影:

1. **`codex-lead-runtime.test.ts`(22 个失败)**:`FLYWHEEL_CODEX_LEAD_WORKSPACE (...) must not overlap ~/.flywheel` —— 本会话 `TMPDIR=/Users/xiaorongli/.flywheel/runner-state/<execId>/browser-tmp`,测试用 `mkdtemp(tmpdir())` 生成的 workspace 天然落在 `~/.flywheel` 下,撞上 FLY-245 的 overlap 安全检查。这是团队记忆里已归档的已知环境问题(`reference_qa_codex_lead_runtime_tmpdir_overlap.md`),与 FLY-871 无任何代码交集(该文件本次 PR 未改动)。
2. **`LeadAlertNotifier.test.ts`(1 个失败)+ `createLeadRuntime-preflight.test.ts`(2 个失败)**:单独重跑这两个文件 —— `createLeadRuntime-preflight.test.ts` **4/4 全过**(证明是全量跑时的顺序/环境干扰,非真失败);`LeadAlertNotifier.test.ts` 剩一个失败,断言收到的 `Authorization` header 是本机真实 Discord bot token 而不是测试期望的 mock 值 `"resolved-bot-token"` —— 这是本会话环境里真实存在已配置的 bot token 泄漏进未隔离的进程环境,同样与 FLY-871 无关(该文件本次 PR 未改动)。

**结论:上述 25 个失败均为运行环境产物(真实 Runner 会话的 TMPDIR/env 污染),不是 FLY-871 引入的回归** —— 全部落在本 PR 未触碰的文件里,且其中一个在隔离重跑时即转绿。

### 3.3 Lint

```
pnpm lint  # biome check, 根目录
```
→ 0 errors,13 warnings(全部是既有文件里的 `noExplicitAny` suppression 未生效提示,与本 PR 改动文件无关)。

## 4. Byte-compat 核实

- `account-selfheal-bytecompat.test.ts` 新增的 R1 断言(`switchImpl` 在 flag off 时从未被调用)通过 —— 证明 R1 的候选循环/freshness 逻辑对自动路径在 flag off 时完全不可达。
- plan §5 声明的"唯一常开例外"(人工 `use` 的 stale 拦截)在 `claude-profile.test.ts` 里有直接测试覆盖,行为符合预期(拦截,不静默放行)。

## 5. 结论

R1(本 PR 范围)代码审阅 + 98 个目标测试 + 4814 个全量回归测试(排除 25 个与本 PR 无关的环境性失败)全部通过,契约与 plan.md/design-review.md 记录的 4 轮 Codex 批准内容一致,无新发现问题。

**PASS** — 建议按三段式 pipeline 进入 approve/ship 流程。R1 fast-follow(C4)已开 FLY-875 跟踪;R2/R3 按计划另开 PR。
