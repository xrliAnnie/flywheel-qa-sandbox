# FLY-247 WI-6: Fleet Config 迁移与部署 runbook(一次性)

**Issue**: FLY-247
**Date**: 2026-06-11
**基于**: `doc/engineer/plan/new/v1.40.0-FLY-247-fleet-config-dashboard.md` §WI-6

> 本文是 merge 后生产迁移的操作步骤。**全程不需要重启任何生产 Lead 之外的东西**;
> Bridge 需一次重启以装载 FleetPoller(Dashboard 区块)。

## 1. 种子(把现状写进真源)

编辑 `~/.flywheel/projects.json`,把当前手编 plist 的事实落进 `leads[]`:

- Peter / Hiro(现 Fable):`"model": "claude-fable-5"`
- Mufasa / Belle(codex companion):`"backend": "codex-app-server"`(两者已有 `companion: true`,需确认 `canSpawnRunners: false` —— schema 会 fail-close)

种子前先看三方现状(只读安全):

```bash
scripts/flywheel-fleet.sh plan
```

预期:Peter/Hiro 显示 "plist 有 model 但 config/manifest 没有" 的 drift(APPLICABLE);
Mufasa/Belle 显示 EXTERNAL(bespoke 路径,无标准载体,不算 drift)。

## 2. 首次 apply(把 model 从手编 plist 固化进载体链)

```bash
scripts/flywheel-fleet.sh apply --dry-run        # 生产只读安全,先看将做什么
scripts/flywheel-fleet.sh apply --lead geoforge3d-product-lead   # 逐个,有确认
```

- apply 自动完成:Phase W 部署 FLY-224 wrapper(补 F1 缺口)→ staged manifest(含 model)
  → plist 从 manifest 再生(从此 `daemon install` 不再抹 model,FLY-241 根治)→ 重启 verify。
- **红线**:每个 Lead 重启前有 [y/N] 确认;失败自动回滚(备份 plist 直接 bootstrap,绝不 regenerate)。
- codex Lead(Mufasa/Belle)apply 一律 UNAPPLIED —— 走 FLY-250 bespoke 路径,本版不自动碰。

## 3. Bridge 重启(装载 Dashboard Fleet 区块)

按 [[feedback_coordinate_bridge_restarts]] 纪律攒批重启。重启后 `:9876/` 出现 Fleet
区块(默认关:只有 ≥1 lead 配了 model/backend 才显示 —— 种子后即满足)。

## 4. 退役

- `~/.flywheel/fleet-model-setup.md` 删除(内容固化进 projects.json + Dashboard)。
- 手编 plist 不需要手动改 —— 首次 apply 已把它换成 manifest-派生的可复现版本。

## 5. 验收(plan §9)

- `fleet plan`:所有标准 Claude Lead 零 drift;codex Lead 显示 EXTERNAL/UNVERIFIED 且无 CONFLICT。
- Dashboard Fleet 区块浏览器实看 7 Lead 三层状态。
- 改 projects.json 里某 lead 的 model → 30s 内 Dashboard drift 变红(不重启 Bridge,要求⑤)。
- 真机 apply 验收只在 test-slot Lead 上做(QA 纪律:绝不对生产 Lead apply)。

## 注意

- **`apply --dry-run` 在存在 UNAPPLIED 项(如 codex Lead)时按合同 exit 1**(QA F-4)——
  这不是失败,是"有项目不可自动 apply"的信号;脚本/运维判断成功与否看输出行,不要只看 RC。
- `FLYWHEEL_PROJECTS` 环境(QA slot)下 fleet 一律 fail-close —— 在生产 shell 跑。
- 任何中断的事务:下次 fleet 命令会拒绝开新事务,按提示 `recover --txn <ts> --yes`。
- **Runner follow-lead 尚未接线**(Dashboard 有诚实标注)—— FLY-247 Increment 2,issue 不以本 PR 关闭。

---

# inc2a(v1.41.0):Fleet 控制台 + 级别批量切换 — 部署增补

**Issue**: FLY-247 Increment 2a
**基于**: `doc/engineer/plan/new/v1.41.0-FLY-247-fleet-console.md`

inc2a 在 inc1 之上加:① `GET /` 从旧 Dashboard 换成 **Fleet 控制台**(卡片式 × 7 Lead,chip 切级别);② 引擎 `apply --changes-file`(批量 model-only 事务,config-write flock + write-ahead journal + per-key 条件还原 + crash 对账);③ Bridge `/api/fleet/{snapshot,progress,stage,apply}`(loopback + same-origin + confirmToken,**不走 Bearer**)。**后端切换本期不生效**(chip 置灰,标 FLY-264 / FLY-245)。

## A. 生效方式(merge 后)

- 控制台前端 + 路由在 `flywheel-fleet.sh`(scripts/)+ teamlead dist 内 → **生效 = merge + 生产 `git pull` + 一次 Bridge 重启**(`createBridgeApp` 在 boot 时挂路由 + 实例化 `FleetConsole`)。
- **kill-switch**:`FLYWHEEL_FLEET_CONSOLE=0` → 回落旧 Dashboard + 不挂任何 `/api/fleet/*` 路由(字节兼容逃生口)。`FLYWHEEL_PROJECTS`(env-pinned,如 QA slot)下控制台**自动禁用**(引擎对 env-pinned 一律 fail-close,split-brain 守卫)。
- **启动期零落盘**:不用控制台时 `audit.db` 的 `fleet_admin_audit` 表 lazy-init(首次 stage/apply 才建)、`fleet-txns/` 与 `fleet-logs/` 首次写才建 → 未用控制台 = boot 零磁盘变化(字节兼容)。

## B. Mufasa 后端迁移(deploy-time,§2.4)— **ship 前必做**

生产 `~/.flywheel/projects.json` 的 Mufasa(`growth-mufasa-lead`)条目**当前无 `backend` 且 `canSpawnRunners` 未设(归一化默认 = true)** → `effectiveLeadBackend()` 把它当默认 Claude,控制台会把这个 Codex 陪聊 Lead 显示成 Claude/Fable/Opus,且引擎/API 的「Codex Lead 拒改 model」闸够不着。

> ⚠️ **plan §2.4 的前置假设(「Mufasa 本就 canSpawnRunners:false」)与生产实际不符** —— 实测 `canSpawnRunners` 未设(默认 true)。故迁移必须**同时**补 `canSpawnRunners: false`,否则 FLY-245 cross-field(`ProjectConfig.ts` 第 424 行:`codex-app-server` 仅合法于 `companion===true && canSpawnRunners===false`)会**拒绝整份 config**。设 `canSpawnRunners:false` 对 Mufasa 既是必需也语义正确(companion 不开 Runner)。

迁移(经受支持路径,**勿手改后裸跑** —— 引擎在每次 rename 前调 CLI 校验器):给 Mufasa 条目加两个字段:

```jsonc
{
  "agentId": "mufasa-lead",
  // …现有字段…
  "companion": true,            // 已有
  "canSpawnRunners": false,     // ★ 新增(FLY-245 必需 + 语义正确)
  "backend": "codex-app-server" // ★ 新增
}
```

- 因 Mufasa 仍走 bespoke wrapper(非标准 manifest 载体)→ inc1 把它 classify 为 **external/UNAPPLIED**:控制台**显示** Codex/GPT-5(只读,单选项)、**不触发任何 cutover**。
- **预期可观察变化(byte-compat 收窄,§2.4 R7#5)**:给 Mufasa 加显式 `backend` 会打开 inc1 `hasExplicitFleetConfig()` 闸 → legacy `/sse` 从此对 Mufasa 含 `fleet` 区,Mufasa 的 pane-watchdog 归属随之变(无 cutover)。这是**有意例外**,不属于「不用控制台全链字节不变」。
- Belle(`personal-assistant-belle-lead`)生产跑 **Claude**(mockup v3 基准)→ **本期不迁移**;若以后 Belle 改 Codex,同样需补 `backend` + `canSpawnRunners:false`。

**验证(ship 前)**:控制台 `GET /` 浏览器看 Mufasa 卡 = Codex 后端 + GPT-5 级别**只读**(无 caret、不可下拉);后端 chip 其余项置灰带 reason;其余六 Lead 不动。

## C. 批量级别切换操作流(控制台)

1. 浏览器开 `:9876/` → 点某 Claude Lead 的「级别」chip → 选 Fable 5 / **Opus 4.8 (1M)**(FLY-360,= `claude-opus-4-8[1m]`,真用满 1M 窗口)/ Opus 4.8(account default,~200K)→ 卡片蓝框 +「未应用」。
2. 顶部「应用 N 项更改」→ 确认框列全部 from→to(+ 重启/自动回滚警示)→「确认应用」。
3. 逐项串行执行,同框 SSE 进度(备份→应用→验证→✓);失败项标红 + 自动回滚该项(成功项保留);回滚冲突 / 需恢复 → 标红 + runbook 提示(**绝不假称已保原状**)。
4. **批量引擎细节**:API 在 spawn 前 exclusive-create `launching` 批次记录(`~/.flywheel/fleet-txns/batch-<id>.json`)→ detached 跑 `flywheel-fleet.sh apply --changes-file <cf>` → 每 key 走 inc1 已验证的 model-apply 相位机。锁序 `restart.lock.d`(inc1 mkdir,不动)→ config-write flock(新,python3 fcntl,短持自释)。

## D. 中断恢复

- Bridge 重启时 `FleetConsole.reconcileOnStartup()` 对每个未完成批次按引擎死活判定(R8#2):**活引擎**(`owner.pid` alive)→ 只观察续推、不改相位;**死引擎** → 调引擎自己的 `flywheel-fleet.sh recover --batch <id>`(`launching` 过 deadline → `rejected` 零 mutation;`running` → per-key 对账 → `recover-required` 或终态归约)。
- 手动:`scripts/flywheel-fleet.sh recover --batch <batch-id> --yes`(`recover` 是 mutating,**必须带 `--yes`**,否则脚本拒绝)。

## E. inc2a 验收(plan §5)

- 控制台浏览器实操:7 卡渲染、Mufasa 只读 Codex/GPT-5、后端 chip 置灰带 reason、级别可切「Account 默认/Fable」。
- test-slot 真级别批量切换(一败一成):失败项回滚保原状、成功项保留、无关 Lead 不动。
- Bridge 重启中断恢复:活引擎不改相位 / 死引擎 recover-required。
- config flock 并发写:一胜一 rejected,释放后不再写。
- **真机 apply 只在 test-slot Lead 上做**(QA 纪律:绝不对生产 Lead apply)。

## F. 归属说明

- **受管后端切换引擎 + 启用后端选择的 UI/API = FLY-264**(一体交付,inc2a 不埋休眠 UI)。
- **write-capable Codex Lead 解禁 = FLY-245**(inc2a 控制台对 write-lead 的 Codex 选项置灰带此 reason)。
- **Runner follow-lead 接线 = Increment 3**(`v1.40.1-FLY-247-runner-follow-lead.md`,改动面与本期无交集;控制台副标如实标「接线 = 下一期」)。
