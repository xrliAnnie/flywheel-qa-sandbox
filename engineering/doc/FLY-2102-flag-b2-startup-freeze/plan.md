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
1. 基线:跑 `/bin/bash scripts/test-cmux-sync.sh` 记录通过数(**必须系统 /bin/bash 3.2**;
   裸 `bash` 会命中 Homebrew bash 5.3,套件自身合同直接拒——Codex R1 实测)。注意本机 sandbox
   会 skip 真 tmux/AF_UNIX 集成节:基线绿 ≠ node-off 删除后的全覆盖证明,受影响节判定只以
   实际执行到的节为准,skip 节单独列账。
2. `scripts/flywheel-cmux-sync.sh`:
   - 删 `build_attach_command` 的 `view_helper_enabled` 读取(:3767)与 =0 分支(:3775-3783);
   - 删 `node_presence_enabled()` 定义(:1090-1093),并展开 **11 个调用点**的守卫为无条件执行
     (:1165/:1335/:1690/:1841/:2909/:9679/:9997/:10046/:10075/:10279/:11714;定义+调用共 12 次
     文本出现 —— 验收按 caller 清单核,不按 occurrence 计数,Codex R2 LOW 修正)。
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
   被拒备选:「只删 registry 不进豁免账」—— 持久 .env 会报 unknown(更严),治具按进程注入
   也不受影响,但 wiring.ts 的 env 读点会变成**无账读点**(违背 FLY-1455「必须登记、不许野建」
   的治理意图,也违背 issue 原文「进 exemptions.ts 有账豁免」)。
4. `store-policy.ts`:LEGACY_UNMANAGED_BASELINE 删 9 个名。
5. 测试:`feature-flags-registry.test.ts`(两组断言换幸存同类 fixture;env 源 governance_gate
   类随 lead_lease_bypass 消亡 → 改为断言该类为空)、`feature-flags-drift.test.ts`
   (:469-471 三条 cmux 条目删)、`feature-flags-store-policy.test.ts` 同步;
   新增断言:9 名不在 FEATURE_FLAGS、8 envVar 在 RETIRED_FLAGS、voice 在豁免账。
6. **baseline 固定快照断言**(Codex R2 MEDIUM,漏列):
   - `fly1981-final-ledgers.test.ts`(:280-287)硬断言 `LEGACY_UNMANAGED_BASELINE` 长 31 且
     31+4=35。**不改数字为 22** —— FLY-1981 落地时的 31 项在该测试内冻结为独立历史快照常量
     (test-local literal),断言改为:当前 baseline ⊆ 历史快照(只许 shrink)+ 被移除的名字
     必须能在 RETIRED_FLAGS 或 FLAG_EXEMPTIONS 找到去向(shrink 有账)。
   - `feature-flags-registry.test.ts:16` 的 `toHaveLength(31)` 改为与上述同语义的断言
     (子集 + 有账去向),不再锁死总数。

### Step 3 — teamlead 包:flag store 常开 + broker 整段删 + 两个数值固化
1. `flag-store-runtime.ts`:删 bypass 入口/双态/env fallback;`FlagStoreRuntime` 塌缩单态;
   `enrichFlagViewsWithStore` 删 `legacyEnvIsAuthority` / split_brain / `no_clock:bypass` 臂。
   **公共类型词汇同步**(Codex R2 MEDIUM):`packages/config/src/feature-flags/resolve.ts`
   (:99-103)的 `FlagView.clockReadiness` union 删 `"no_clock:bypass"` 值;
   `feature-flag-render.test.ts`(:77-95)把它当活模式的用例随删;残留守卫加一条语义断言:
   活代码(非历史 changelog 值、非 doc)中 `no_clock:bypass` 零命中。
2. `StateStore.ts`:删 `markFlagStoreBypassSeen` / `isFlagStoreBypassSeen` /
   `ensureFlagValueRows` recovering 臂(:4686-4790)+ fence 自清(:4853);
   **保留** `flag_store_meta` 表定义与 `bypass_recovery` changelog 历史行。
   **部署前置检查**(Codex R1:「所有旧库一概无害」是过强断言):删除恢复臂的前提是目标库
   不处于未完成恢复态 —— canonical 生产 `teamlead.db` 已实测 `flag_store_meta` 无
   `bypass_seen` 行(2026-08-27,Codex R1 只读核验);PR 验收再跑一次
   `sqlite3 -readonly ~/.flywheel/teamlead.db "SELECT value FROM flag_store_meta WHERE key='bypass_seen'"`
   确认空/0。非 canonical 库(QA slot 等)不逐一保证,行为定义为「store 行原样即权威」并写入
   honest boundary。
3. `flag-routes.ts`:删 :177 / :284 bypass 409 分支。
4. `plugin.ts`:删 broker import(:448)/挂载块(:4299-4319)/close(:10871);
   删 :8754-8763 sweep-ticks env 读(直接不传 → GatePoller 默认 60)。
5. `gate-poller.ts`:`displayReconcileEveryNTicks` 保留为注入参数(测试 seam),但**入口
   sanitize**:非有限数或 ≤0 一律回默认 60(Codex R1:只删 `> 0` 守卫会留下 `(tick-1) % 0`
   = NaN 的静默永不触发路,等于 0=关 换了个写法活着)。sanitize 后 :731 守卫自然消失,
   「0 仍按 60 sweep」的反旋钮断言才真成立。
6. `runs-route.ts`:`GHOST_GUARD_SESSION_WAIT_MS` 写死 `90_000`,删 env 读(:238-241);
   `positiveInt` 若再无他用随删。
7. 删目录 `packages/teamlead/src/bridge/publish-broker/`(14 文件);
   `automated-message-inventory.test.ts:140` 清单行删。
8. **stale dist 字节清理**(Codex R2 HIGH):`tsc` 不会替源码删旧输出,而
   `scripts/package-onboard.sh` 会把整个 `dist/` 原样拷入交付 payload —— 曾构建过 broker 的
   checkout 在本 PR 后重 build 仍会携带 `dist/bridge/publish-broker/` 旧字节。修法沿用
   `packages/teamlead/package.json` build script 既有的退役产物清理模式:在 `tsc` 成功后的
   `rm` 链追加 `dist/bridge/publish-broker`(含其 `__tests__` 输出)。**不用 pre-build 清空
   整个 dist**(保持 last-known-good build 纪律)。验收:预置 stale sentinel 文件 →
   `pnpm --filter teamlead build` → 目录消失;`fly2102-flag-freeze.test.sh` 把该 prune
   写进合同断言(package.json 的 build 行含此目标)。
9. 测试:`flag-store-runtime.test.ts` bypass 用例 → 「=0 仍 ready」反旋钮断言;
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
   `shell-publish-preflight.sh`(:59)/ `shell-pack-install-dryrun.test.sh` /
   `scripts/__tests__/payload-release-pipeline.test.sh`(:298/:346-347 引用已删的
   `publish-broker/release-commit.ts`,Codex R1 补漏)注释改述(功能零改动;
   payload-release-pipeline 的断言逻辑不动,只改叙述)。
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
| publish-broker 目录不存在;CI 无步骤;payload-activation 不受影响 | 结构断言 + Step 6.2 dry-run + stale dist prune 验证(Step 3.8:sentinel → build → 消失;交付 payload 无 broker 字节) |
| Bridge 启动日志无 broker / bypass 输出 | Step 6.3 |

## 3. 风险与回退

- **test-cmux-sync 重工量未知**(11633 行,node-off 全局态死亡):Step 1 最先做,若受影响节
  超预算(> ~15 节),按节列清单向 Lead 报量再继续,不静默扩 scope。
- **回退**:单 PR 原子回退即可;无 DB 迁移(表保留)、无生产 env 依赖(九个全 absent)。
- **旧库 fence 残留**:canonical 生产库已实测无 `bypass_seen` 行;部署前置检查见 Step 3.2。
- **不可回退面**:无。tombstone 可撤,豁免可删,行为固化即默认值。

## 4. 不做(边界)

B1 的 13 个运行时 flag;config.yaml(C 批);任何新旋钮;`lead_lease_bypass_used` 历史渲染链;
`founder-consent-audit.ts` 的 `"bypass"`(另一体系);shell-prepare / payload-promote /
shell-publish-preflight 的功能;`FLYWHEEL_FLEET_SANITIZE` / `FW_ENDPOINT` / `FW_NPM_REGISTRY` /
payload-endpoint 的 FW token 用法;`flag_store_meta` 表结构。
