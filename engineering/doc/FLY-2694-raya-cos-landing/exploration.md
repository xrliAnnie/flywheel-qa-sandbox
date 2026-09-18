# FLY-2694 cos 落地 Flywheel — 探索

Issue: FLY-2694 (https://linear.app/geoforge3d/issue/FLY-2694/raya-并仓s1-packagescos-落地-flywheel-仓包名-flywheel-raya-cos接入-workspace)
日期: 2026-09-17
基于: 无(施工依据是已合入 main 的 `engineering/doc/FLY-2680-raya-merge-plan/plan.md`,PR #1239)

> 本节点**只设计**。不改代码、不动生产、不碰 Raya 仓、不重启。
> 本单是 Epic FLY-2679 的 **S1**:把 Raya 仓的 `packages/cos` 搬进 Flywheel 仓。
> 上游 plan 已经把边界(§4)、包名位置(§5.1)、script(§5.2)、QA 判据(§5.3 / §12 S1 行)
> 全部写定;本文档的任务不是重新设计,而是**把 plan 落到 file:line 级的施工书**,
> 并把 plan 没核过的两件事核掉(见 §3)。

## 1. 工单要求(逐条对照上游 plan)

| 工单原文 | 上游 plan 出处 | 本单动作 |
|---|---|---|
| 按 §4 边界清单搬 `packages/cos`(不带 git 历史,§4.4) | plan §4.1 表 + §4.4 | 只搬 `src/**`(120 `.ts`)、`package.json`、`tsconfig.json`、`README.md`;**不搬** `scripts/verify-business-package.mjs`(§5.4 退役) |
| 包名 `flywheel-raya-cos`,目录 `packages/raya-cos/` | plan §5.1 | 原样采用;bin 名沿用 `raya-cos` |
| 按 §5.2 补齐 package.json scripts | plan §5.2 | 补 `test:run`;删 `lint`(根 biome 覆盖);`build`/`typecheck` 保留 |
| 接入 workspace / package-gate / CI light shard | plan §5.2 表 | **零改动接入**:`pnpm-workspace.yaml` 已是 `packages/*`;两个发现器都按 `scripts["test:run"]` 认包(research §3 有实测) |
| 纯增量,不碰任何 raya / updater 脚本 | plan §9.4 末行「S1–S4 全部不触碰 updater / migration / patrol 文件」 | 变更面白名单见 plan.md §2;`git diff --name-only` 自证 |
| §14 点名的位置按修订后文字施工 | plan §14 | **§14 的六条修订全部落在 §12 S4 行 / §12 S3 行 / §7A 三节点表 / §11 合计行 / §10.4 / §10.5,没有一条触及 S1 行、§4、§5。** 本单无需按 §14 改施工口径;PR 描述里写明「已逐条核对 §14,不涉及 S1」 |
| §13 未验证清单不当事实 | plan §13 | §13 九条中与 S1 相关的为 0 条(1/2/3 是 Epic 与 2657 的事,4/5 是巡检与 updater,6 是 M0,7 是 S2 的 shim 沙箱,8/9 是 launchd 与 packaged) |
| 旧壳 `com.xrli.raya.brain` 已于 2026-09-17T22:01Z bootout + disable | (plan 写成之后的现场更新) | 与 S1 无关:S1 不部署、不重启、不碰 launchd。记录在 research §7 作为现场事实 |

## 2. 现场基线(设计时读到的)

| 对象 | 值 | 读法 |
|---|---|---|
| Flywheel 本 worktree HEAD | `f01754584`(`docs(FLY-2642)… (#1242)`) | `git log -1` |
| Raya `origin/main` | `90e433e87a68287ed59ba64f2584e3a6bc0da151` | scratchpad 里 `--filter=blob:none` 克隆后 `git rev-parse origin/main`;**与 plan §4.4 钉的 SHA 一致,未前移** |
| `packages/cos` 子树 hash @pin 与 @main | `d72da8b9667a2a848ff26ce521b914a657fa4583`(两者相同) | `git rev-parse <sha>:packages/cos` |
| cos 文件清单 | `README.md`、`package.json`、`tsconfig.json`、`src/**`(55 测试 + 65 源 = 120 `.ts`,无非 `.ts` 文件) | `git ls-tree -r` |
| 触碰 `packages/cos` 的 Raya commit | 6 个(`9d63a2b`、`5913bb4`、`c320c66`、`fe6cc76`、`69b709b`、`97b8eaf`),与 plan §4.4「5 个代码 commit」相比多 1 个(`97b8eaf fix(cos): retain indeterminate memory recovery`)——不影响「不带历史」的结论 | `git log --oneline origin/main -- packages/cos` |
| Flywheel 现有 `packages/*` 数 | 23 个目录,其中 18 个有 `test:run` | `readdirSync` 复刻 package-gate 过滤器 |
| Raya 生产 checkout | `~/.flywheel/raya/code`(research FLY-2680 §1 表:HEAD `0f77e977`,落后 105 commit;`packages/cos` 只有孤儿 `dist/`)| **本节点未读、未 fetch**,只从 scratchpad 克隆取源 |

## 3. plan 没核过、本单必须先核的两件事

### 3.1 `tsconfig.base.json` 的严格开关会不会把 cos 编译打红(**会**)

plan §4.1 只说「`extends` 必须改成 `../../tsconfig.base.json`,照抄原文件会 build 失败」,
但没有核 base 里比 Raya 根 tsconfig **多出来**的开关:

| 开关 | Raya 根 `tsconfig.json` | Flywheel `tsconfig.base.json` |
|---|---|---|
| `strict` | ✅ | ✅ |
| `noUncheckedIndexedAccess` | ✗ | ✅ |
| `noUnusedLocals` / `noUnusedParameters` | ✗ | ✅ |
| `noImplicitReturns` / `noFallthroughCasesInSwitch` | ✗ | ✅ |
| `module` / `moduleResolution` | `NodeNext` | `ESNext` / `node`(voice-core 在包级覆盖回 `NodeNext`) |

**实测**(research §4):直接 extends base 后 `tsc --noEmit` 报 **170 个错误**(26 个源文件),
**全部**由 `noUncheckedIndexedAccess` 引起;包级 `"noUncheckedIndexedAccess": false` 后 **0 错误**,
`noUnusedLocals` 等其余开关对 cos 全部通过。

**裁定(见 plan.md §3.2)**:包级 tsconfig 只关这一个开关,**源码 120 文件字节不改**。
理由:(a) plan §4.1「原样落盘」+ §4.4 provenance 的可核性;(b) 这是 Raya 侧编译语义的**原值**,
不是放松;(c) 改 26 个文件 170 处会让 S3「Raya 仓删 cos」时的对照失去意义。
Flywheel 23 个包里目前**没有**任何一个覆盖 base 的严格开关(`grep -L tsconfig.base` 与
`grep noUncheckedIndexedAccess packages/*/tsconfig.json` 都为空)——本单是第一个,
所以要在 tsconfig 里写注释说明来源,并用测试锁住「只关这一个」。

### 3.2 `pnpm install --frozen-lockfile` 会不会因为新 importer 直接失败(**会,所以 lockfile 必须一起提交**)

新 workspace 包带 `devDependencies`(`@types/node` / `typescript` / `vitest`)。
`pnpm-lock.yaml` 的 `importers` 段没有 `packages/raya-cos` 条目时,
CI 的 `pnpm install --frozen-lockfile` 会拒绝。**实测**:`pnpm install --offline`
后 lockfile 净增 12 行(只多一个 importer 条目,**零新 resolution**——三个 devDep 都已被
其它包锁到同一版本 `20.19.21` / `5.9.3` / `3.2.4(patch)`);随后
`pnpm install --frozen-lockfile --offline` 通过。上一次新增包(FLY-546 `voice-headphone`,#496)
也只改了 `pnpm-lock.yaml`(+19 行),仓内没有其它包注册表。

## 4. 不做什么(S1 的边界)

- 不新增 `scripts/raya-cos.sh` shim,不改 `converge-flywheel-bin.sh`(那是 S2)。
- 不改 `.lead/raya/identity.md`、不碰 Raya 仓(那是 S3 / S4)。
- 不改 `scripts/lib/updater-raya-deploy.sh`、`update-flywheel.sh`、`lead-patrol-snapshot.sh`、
  任何 `raya-*` / `*-raya-*` 脚本或测试(plan §9.4「S1–S4 全部不触碰」)。
- 不进 packaged 闭包:`scripts/package-onboard.sh` 的 `PO_PACKAGES` **不加** `raya-cos`
  (plan §6.2 裁定「Raya 是 Annie 自托管宿主独有的 Lead」)。
- 不删 Raya 仓的 `packages/cos`、不改 Raya CI(S3)。
- 不部署、不重启、不 `launchctl`。

## 5. 待 Lead 确认(非阻塞,不等答复)

1. **tsconfig 单开关覆盖 vs 改源码**:本单按 §3.1 裁定「只关 `noUncheckedIndexedAccess`、源码不动」施工。
   若 Lead 更想让 cos 一次到位满足 base 全部开关,应另开一张「cos 类型加固」单,
   放在 S3 之后(那时 Raya 仓的副本已删,不再有两处对照问题)。
2. plan §4.4 的「5 个代码 commit」实际是 6 个,差异仅是措辞,不改任何施工动作。
