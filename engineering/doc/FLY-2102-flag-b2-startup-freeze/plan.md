# FLY-2102 flag·B2 启动期 flag 固化删 — 实施计划

Issue: FLY-2102 (https://linear.app/geoforge3d/issue/FLY-2102/flagb2固化-9-个启动cli-时读的-env-flag-固化删flag-store-写死常开删-env-旁路cmux-三个-ghost)
日期: 2026-08-27
基于: research.md

## 0. 裁定摘要(founder 8-27 v3/v4)

9 个启动/CLI 时读的 env flag 都不迁 DB,固化删。生产 .env 九个全 absent(2026-08-27 实测)
⇒ 全部改动对生产是零行为变化,删掉的只是「未来关掉」的旋钮语义。吸收 FLY-1977。

三个显式设计裁定(exploration §3,评审重点):
1. **token scrub 随 broker 删**,不留孤儿 scrub;「FW token 永不进 Bridge env」写入 runbook 退役横幅。
2. **exemptions baseline 修订 +1**(voice 从 registry 账迁到 exemptions 账,授权来源 = FLY-2102 issue 正文;治理总面 -9+1)。
3. **lead_lease_bypass 只删生产者**;`lead_lease_bypass_used` 告警 kind 的历史渲染链保留(耐久 fault DB 可能有历史行)。

## 1. 分步改动(TDD:每步先写/改断言再动实现)

### Step 1 — cmux shell 三 flag(最大不确定性最先)
1. 基线:跑 `bash scripts/test-cmux-sync.sh` 记录通过数。
2. `scripts/flywheel-cmux-sync.sh`:
   - 删 `build_attach_command` 的 `view_helper_enabled` 读取(:3767)与 =0 分支(:3775-3783);
   - 删 `node_presence_enabled()`(:1090-1093),12 处守卫展开为无条件执行。
3. `scripts/converge-flywheel-bin.sh`:删 :318-325 读取/校验块;:410 FLY-1577 注释改述(不再提开关)。
4. 测试重工:
   - `scripts/test-cmux-sync.sh`:删 :37 全局 `export FLYWHEEL_CMUX_NODE_PRESENCE=0`;
     :6497-6510 legacy 断言 → 反旋钮断言(=0 置位仍出 helper 命令)。依赖 node-off 的回归节
     逐节判:目的是「pre-1884 字节形状」的 → 用 `reset_mocks` 桩 node 层入口或改预期;
     目的是「off 路本身」的 → 删,由反旋钮断言接棒。
   - `scripts/__tests__/fly1884-node-presence.test.sh`:删 :248-256 =0 控制组 → 反旋钮断言。
   - `scripts/__tests__/converge-fly1389.test.sh`:C5(=0 bypass)删;非法值用例改为「置任何值仍收敛」。

### Step 2 — config 包治理账(单一 PR 内的原子层)
1. `registry.ts`:删 9 个 spec(flag_store / ghost_guard_wait_ms / publish_broker /
   converge_cmux_symlink / cmux_view_helper / cmux_node_presence / issue_display_sweep_ticks /
   voice_qa_presence_override / lead_lease_bypass)。
2. `truth.ts`:RETIRED_FLAGS +8(retiredBy: "FLY-2102";voice 不 tombstone);
   NON_FLAG_ALLOWLIST 删 3 行 broker plumbing(SOCKET / AUDIT_PATH / APPROVAL_CHANNEL)。
3. `exemptions.ts`:+1 单条 `FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE`(kind env,
   persistentEnvAllowed: false,issue "FLY-2102",reason 注明 loopback staged Bridge only);
   `LEGACY_FLAG_EXEMPTION_BASELINE` +1(账本修订,注释标注授权来源)。
4. `store-policy.ts`:LEGACY_UNMANAGED_BASELINE 删 9 个名。
5. 测试:`feature-flags-registry.test.ts`(两组断言换幸存同类 fixture;env 源 governance_gate
   类随 lead_lease_bypass 消亡 → 改为断言该类为空)、`feature-flags-drift.test.ts`
   (:469-471 三条 cmux 条目删)、`feature-flags-store-policy.test.ts` 同步;
   新增断言:9 名不在 FEATURE_FLAGS、8 envVar 在 RETIRED_FLAGS、voice 在豁免账。

### Step 3 — teamlead 包:flag store 常开 + broker 整段删 + 两个数值固化
1. `flag-store-runtime.ts`:删 bypass 入口/双态/env fallback;`FlagStoreRuntime` 塌缩单态;
   `enrichFlagViewsWithStore` 删 `legacyEnvIsAuthority` / split_brain / `no_clock:bypass` 臂。
2. `StateStore.ts`:删 `markFlagStoreBypassSeen` / `isFlagStoreBypassSeen` /
   `ensureFlagValueRows` recovering 臂(:4686-4790)+ fence 自清(:4853);
   **保留** `flag_store_meta` 表定义与 `bypass_recovery` changelog 历史行。
3. `flag-routes.ts`:删 :177 / :284 bypass 409 分支。
4. `plugin.ts`:删 broker import(:448)/挂载块(:4299-4319)/close(:10871);
   删 :8754-8763 sweep-ticks env 读(直接不传 → GatePoller 默认 60)。
5. `gate-poller.ts`:`displayReconcileEveryNTicks` 保留为注入参数(测试 seam,默认 60),
   删「0 → sweep disabled」语义与 :731 `displayCadence > 0` 守卫,注释同步。
6. `runs-route.ts`:`GHOST_GUARD_SESSION_WAIT_MS` 写死 `90_000`,删 env 读(:238-241);
   `positiveInt` 若再无他用随删。
7. 删目录 `packages/teamlead/src/bridge/publish-broker/`(14 文件);
   `automated-message-inventory.test.ts:140` 清单行删。
8. 测试:`flag-store-runtime.test.ts` bypass 用例 → 「=0 仍 ready」反旋钮断言;
   `flag-routes.test.ts` / `flag-toggle.test.ts` / `feature-flag-render.test.ts` /
   `fleet-console-model-flags.test.ts` / `StateStore.flag-value-store.test.ts` fixture 换血;
   `runs-route.dag-entry.test.ts` → 「env 置位仍 90000」;GatePoller 测试 → 「0 仍 sweep」。

### Step 4 — flywheel-comm:lease 无旁路
1. `lead-lease.ts`:删 :2806-2821 bypass 分支、disposition `"bypass"` 臂(:1126)、
   `persistFault("bypass_used")` 生产者;TypeScript 顺藤删死分支(只删不加)。
2. 史料链不动:`lead-dual-active-scan.ts` / `kind-contract.ts` / `alert-kind-copy.ts` /
   `LeadAlertNotifier.ts` / `lead-alert.sh` 的 `lead_lease_bypass_used` 渲染保留。
3. `lead-lease-enforce.test.ts`:bypass 用例 → 「=1 置位仍 deny + 无 bypass 告警」。

### Step 5 — scripts/release + CI + 文档
1. 删 `scripts/release/broker-request.mjs`;`shell-prepare.mjs` / `payload-promote.mjs` /
   `shell-publish-preflight.sh`(:59)/ `shell-pack-install-dryrun.test.sh` 注释改述(功能零改动)。
2. 删 `scripts/__tests__/publish-broker-structure.test.sh` + ci.yml:975 步骤;
   `flywheel-log-rotate.test.sh:187` 清单行删。
3. 新增 `scripts/__tests__/fly2102-flag-freeze.test.sh`(fly1674-residue 模式:
   9 env 名 rg sweep + 精确 `文件|token` allowlist + 每条豁免 liveness 自检)+ ci.yml 步骤
   (`ci-shell-suite-enumeration` 强制两边一致)。
4. `doc/engineer/implementation/fly-1062-payload-release-runbook.md` 顶部加 RETIRED 横幅
   (broker 路径已删于 FLY-2102;真发布 = `payload-activation.yml`;FW token 永不进 Bridge env)。

### Step 6 — 全仓门 + 端到端验收
1. `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 触及的全部 scripts/__tests__。
2. `bash scripts/release/shell-publish-preflight.sh --founder-local` dry-run 一次(发布路径无损)。
3. 起隔离 Bridge(529 房或本地 slot),grep 启动日志:无 `[publish-broker]`、无 flag-store bypass 输出。
4. PR body 附:FLY-1914 消费者 sweep 证据(三 root + 时间戳;broker-request.mjs 净删)+
   baseline 修订声明 + FLY-1977 吸收声明。

## 2. 验收判据(把 issue 判据翻成可执行形)

| issue 判据 | 可执行形 |
|-----------|---------|
| 现有测试全绿 | Step 6.1 全仓门 |
| 每个删除路一条「路已不存在」断言 | §1 各步的反旋钮断言(全部是**真实置位旧值**再断言行为不变,不是 grep 缺失) |
| `rg` 九个 env 名零命中 | `fly2102-flag-freeze.test.sh`:零命中 = 排除 tombstone 账(truth.ts)、豁免账(exemptions.ts)、voice 治具+wiring(裁定保留)、断言测试自身、`doc/**` 历史证据后全仓零命中;allowlist 逐条 liveness 自检(词面冲突的量化处理见 exploration §6) |
| publish-broker 目录不存在;CI 无步骤;payload-activation 不受影响 | 结构断言 + Step 6.2 dry-run |
| Bridge 启动日志无 broker / bypass 输出 | Step 6.3 |

## 3. 风险与回退

- **test-cmux-sync 重工量未知**(11633 行,node-off 全局态死亡):Step 1 最先做,若受影响节
  超预算(> ~15 节),按节列清单向 Lead 报量再继续,不静默扩 scope。
- **回退**:单 PR 原子回退即可;无 DB 迁移(表保留)、无生产 env 依赖(九个全 absent)。
- **不可回退面**:无。tombstone 可撤,豁免可删,行为固化即默认值。

## 4. 不做(边界)

B1 的 13 个运行时 flag;config.yaml(C 批);任何新旋钮;`lead_lease_bypass_used` 历史渲染链;
`founder-consent-audit.ts` 的 `"bypass"`(另一体系);shell-prepare / payload-promote /
shell-publish-preflight 的功能;`FLYWHEEL_FLEET_SANITIZE` / `FW_ENDPOINT` / `FW_NPM_REGISTRY` /
payload-endpoint 的 FW token 用法;`flag_store_meta` 表结构。
