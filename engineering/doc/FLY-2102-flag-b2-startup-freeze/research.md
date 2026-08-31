# FLY-2102 flag·B2 启动期 flag 固化删 — 调研

Issue: FLY-2102 (https://linear.app/geoforge3d/issue/FLY-2102/flagb2固化-9-个启动cli-时读的-env-flag-固化删flag-store-写死常开删-env-旁路cmux-三个-ghost)
日期: 2026-08-27
基于: exploration.md

## 1. flag_store 旁路机器的完整解剖(删除面最深的一个)

三层结构,全部随本单删:

1. **入口**(`flag-store-runtime.ts:19-34`):`FLYWHEEL_FLAG_STORE === "0"` ⇒
   写 fence(`store.markFlagStoreBypassSeen`)+ 快照 STORE_MANAGED env ⇒ 返回 `{mode:"bypass", env}`。
2. **运行时双态**:`FlagStoreRuntime = {mode:"ready"} | {mode:"bypass"}`。bypass 分支消费者:
   - `readFlagValue`(:50-56 env fallback)
   - `enrichFlagViewsWithStore`(:129-149 `legacyEnvIsAuthority`、split_brain divergence、`no_clock:bypass`)
   - `flag-routes.ts:177 / :284`(bypass 时管理面 409)
3. **恢复重播**(`StateStore.ts`):`flag_store_meta` 表(:4585)、`markFlagStoreBypassSeen`(:4660)、
   `isFlagStoreBypassSeen`(:4670)、`ensureFlagValueRows` 的 `recovering` 分支(:4686-4790,
   写 `bypass_recovery` changelog 行)、恢复完自清 fence(:4853)。

删除后 `FlagStoreRuntime` 塌缩为单态 `{mode:"ready"; store}`(或直接换成 StateStore——
实现时取签名改动最小者)。`flag_store_meta` **表定义保留**(schema 稳定性;老库里可能残留
`bypass_seen=1`,删掉唯一读者后它是无害孤儿行)。`bypass_recovery` changelog 历史行是
append-only 史料,不动。

风险核验:生产 `.env` 无 `FLYWHEEL_FLAG_STORE` ⇒ 生产从未走过 bypass 入口;fence 恢复逻辑
在生产从未被触发过(如果曾触发,恢复完也已自清)。删除恢复臂不存在「把生产卡在半恢复态」的窗口。

## 2. publish broker 的挂载与 sweep(FLY-1914 纪律)

消费者 sweep 三 root(执行于 2026-08-27,工作树 = 本分支):

| root | 结果 |
|------|------|
| 主仓 `packages/` + `scripts/` + `.github/` | 见 exploration §4 清单;此外 `automated-message-inventory.test.ts:140` 与 `flywheel-log-rotate.test.sh:187` 各有一行 wire.ts 清单条目 |
| 插件 fork `external_plugins/` | `rg FLYWHEEL_PUBLISH_BROKER\|broker-request\|publish-broker ~/.claude/plugins/cache/*/` 与 fork 源:**零命中**(broker 是 Bridge 内部件,从未暴露给插件) |
| 本机插件缓存 `~/.claude/plugins/cache/*/` | 同上零命中 |

(插件两 root 的零命中在 plan 落地时随 PR body 附带时间戳重扫——本调研先证结构上不可能:
broker 只有 unix-socket 面 + 一个 scripts/release 客户端,无 flywheel-comm 子命令。)

关键副作用再确认:`readAndScrubPublishTokens`(wire.ts:40-49)是 **flag 无关**的无条件 scrub。
它守护的注入路径 = 「操作员为 broker 在 Bridge 启动环境注入 FW token」。broker 删除后该注入
路径失去存在理由;token 正身在 GitHub Actions secrets + `payload-endpoint` worker env
(`serve-node.mjs` / `worker.mjs` / `wrangler.toml` 是服务端校验方,不受影响)。
Code Review R1 后 Lead 覆盖初始取舍：broker 注入路径仍整段删除，但 Bridge 保留独立的启动前 scrub，先于项目校验和任何子进程工作无条件删除两个旧 credential 名；runbook 同步禁止注入。这样该边界由机制而非流程保证。

## 3. cmux 三 flag 的 shell 面

- `converge-flywheel-bin.sh:318-325`:读 + 非法值 warn 回 1;`converge-fly1389.test.sh:371-383`
  有 C5(=0 bypass)与非法值两个用例 —— C5 删,非法值用例改为「env 无效直接收敛」。
  :410 的 FLY-1577 Block A 注释提到本 flag(说明 alert closure 故意在开关之外)—— 措辞随删。
- `flywheel-cmux-sync.sh`:
  - `build_attach_command`(:3767, :3775-3783)=0 走一次性 `tmux attach` —— 整分支删;
    `test-cmux-sync.sh:6497-6510` 的 legacy 断言删,换「=0 置位仍产出 helper 命令」的反旋钮断言。
  - `node_presence_enabled()`(:1090-1093)+ 12 处调用(1165/1335/1690/1841/2909/9679/9997/
    10046/10075/10279/11714 + 定义)—— 函数删,守卫 `|| return 0` / `if` 分支展开为无条件。
- **最大测试重工面**:`test-cmux-sync.sh:37` 全局 `export FLYWHEEL_CMUX_NODE_PRESENCE=0`,
  注释明说「Existing regression sections assert the pre-FLY-1884 cleanup byte shape」。
  node 层写死开后这个全局关不复存在,依赖 node-off 的回归节要么改预期字节、要么用现有
  `reset_mocks` 桩掉 node 层入口。11633 行的套件,受影响节数只有跑起来才知道 —— 这是
  本单最大的实现期不确定性,plan 里排为最早执行的验证步。
  (专门测 on-path 的 `fly1884-node-presence.test.sh` 自己 `export =1`(:9)且 :248-256 有
  一段 =0 控制组 —— 控制组删,换反旋钮断言。)
- fly1944/fly1884-attach 系列用的是 `FLYWHEEL_CMUX_VIEW_HELPER_BIN`(helper **路径**,
  非本单范围)—— 不动。

## 4. lead_lease_bypass:生产者/史料读者的边界

生产者(删):`lead-lease.ts:2806-2821` bypass 分支、`persistFault("bypass_used")` 调用、
disposition union 的 `"bypass"` 臂(:1126)、`emitIndependentLeaseAlert(..."lead_lease_bypass_used")`。
`founder-consent-audit.ts:85` 的 `AuditDecision "bypass"` 是**另一个体系**(founder consent),不动。

史料读者(留):`lead-dual-active-scan.ts` 的 lease-audit outbox 从耐久 fault DB 读历史行,
`auditEventType()`(:274-276)把历史 `bypass_used` 行映射为 `lead_lease_bypass_used` 告警;
`kind-contract.ts:270`、`alert-kind-copy.ts:233/475`、`LeadAlertNotifier.ts:325`、
`lead-alert.sh:200` 是该 kind 的渲染/放行链。历史行可能存在 ⇒ 渲染链保留。
`lead-lease-enforce.test.ts` 中的 bypass 用例改写为「=1 置位仍 deny」的反旋钮断言。

## 5. voice_qa_presence_override 的豁免落位

治具存活证据:`e2e/gemini-staged.mjs:87`、`e2e/gemini-voice-loop.mjs:116` 均 `??= "1"`;
FLY-1353 rig 最近一次改动是 #828(重构保活)。⇒ 走「仍在用」臂。

落位形状(仿 `FLYWHEEL_LEAD_DRY_RUN` 单条模式,不并入 FLY-1455 数组——issue 归属要准确):

```ts
{
  name: "FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
  kind: "env",
  persistentEnvAllowed: false,
  reason: "FLY-1353 headless 语音 E2E 的 presence QA seam;armed 时 wiring 只放行
           http://127.0.0.1:9877 loopback staged Bridge,其余 boot 拒启;生产永不置位",
  owner: "flywheel-eng-lead",
  issue: "FLY-2102",
}
```

+ `LEGACY_FLAG_EXEMPTION_BASELINE` 追加 `"env:FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE"`。
账本纪律:baseline 注释写明 "existing entries may be deleted, but a new kind:name must fail
governance" —— 本次追加是 founder 裁定的账本间迁移(registry -1 → exemptions +1),
plan 与 PR body 都要显式声明这一条 baseline 修订及其授权来源(FLY-2102 issue 正文)。
`persistentEnvAllowed: false` ⇒ 该 var 出现在持久 .env 会被 `validateFlagTruthEnvironment`
报错 —— 与 tombstone 等强度的持久面防护,只是允许一次性进程注入(治具正是这么用的)。

wiring 读点(`wiring.ts:135`)与 loopback 白名单(:137-151)原样保留;
`assistant-wiring.test.ts` / `rig-config.test.ts` 不动。

## 6. 「路已不存在」断言与残留守卫的形状

沿用 `fly1674-residue.test.sh` 的结构模式(精确 `文件|token` allowlist + 每条豁免的
liveness 自检,防死豁免拓宽),新建 `scripts/__tests__/fly2102-flag-freeze.test.sh`:

1. **rg 残留 sweep**:9 个 env 名全仓 rg,allowlist 只放行:
   - `packages/config/src/feature-flags/truth.ts`(8 个 tombstone)
   - `packages/config/src/feature-flags/exemptions.ts`(voice 豁免)
   - `packages/voice-bridge/src/assistant/wiring.ts` + `e2e/gemini-*.mjs` + voice 测试(裁定保留的读点)
   - 新 residue 测试自身 + 各包「路已不存在」断言测试(测试必须引用 env 名才能证明它死了)
   - `engineering/doc/**`、`product/doc/**`、`doc/**`(历史证据,fly1674 同款排除)
2. **行为级反旋钮断言**(每删除路一条,分布在 owning 层):
   - TS/vitest:flag_store(=0 仍 ready)、ghost_guard(env 置位仍 90000)、
     sweep_ticks(env=0 仍按 60 sweep)、lead_lease(=1 仍 deny)、
     registry(9 个 name 不在 FEATURE_FLAGS;8 个 envVar 在 RETIRED_FLAGS;voice 在豁免账)
   - shell:converge(=0 仍收敛)、view_helper(=0 仍出 helper 命令)、
     node_presence(=0 仍做 node 变更)
   - 结构:publish-broker 目录不存在、plugin.ts 无 import、ci.yml 无步骤
3. **CI 接线**:`ci-shell-suite-enumeration.test.sh` 强制 scripts/__tests__ 与 ci.yml 步骤
   一致 ⇒ 新增测试要加 CI 步骤,删 `publish-broker-structure.test.sh` 要删对应步骤(:975)。

记忆纪律的落点:守卫要从「会让它失败的方向」测 —— 反旋钮断言全部是**把旧值真实置位**再断言
行为不变,不是 grep 字符串不存在;rg sweep 的 allowlist 每条带存在性自检。

## 7. 验证策略(实现期步序建议)

1. 先跑 `bash scripts/test-cmux-sync.sh` 基线(node-off 全局态)→ 改 flywheel-cmux-sync.sh →
   重跑,量化受影响节 → 决定逐节改预期还是桩。最大不确定性最先消化。
2. TS 侧按包 TDD:config(registry/truth/exemptions/store-policy)→ teamlead(flag-store-runtime/
   plugin/runs-route/StateStore/flag-routes)→ flywheel-comm(lead-lease)。
3. 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 全部 scripts/__tests__ 触及项。
4. `payload-activation.yml` 发布路径:`shell-publish-preflight.sh --founder-local` 本地 dry-run 一次
   (验收点:preflight 不受注释改动影响)。
5. Bridge 启动日志断言:无 `[publish-broker]`、无 `[flag-store] ... bypass` 输出
   (529 隔离房或本地 slot 起一次,grep 启动段)。
