# FLY-1991 老环境变量清理 — QA 验收报告(Wave 1 / 代码波)
Issue: FLY-1991 (https://linear.app/geoforge3d/issue/FLY-1991/flag治理env清理-1778-生效后删除全部失效的老环境变量行5-条已纳管-flag-的死-env-行-生产-env-里-16)
日期: 2026-08-23
基于: plan.md

## 0. 结论

**PASS**(限 Wave 1 代码波)。

被验证 head:`1557be5b9`(= PR #930 的 head,非 draft、MERGEABLE、base=main)。
本报告与随后可能的台账 commit 之间若出现 head 漂移,见 §7。

Ship 报告(founder 面,已发布未投递):
https://fw-reports-a53de2.vercel.app/r/066f0539d2d252ea5df3eed4a2b574f0/

## 1. 我把它当成什么产品来验

这单的用户有三类,我按这三类各走了一遍:

| 用户 | 关心什么 | 我验了什么 |
| --- | --- | --- |
| founder / operator 看 Bridge FlagView | 控制台说的话是不是真的 | 正常模式下不再出现「CLI 与 Bridge 见值不同」这句假话;改成一句可执行的「删这行,改值走 stage/apply」;应急模式与 degraded 下**不**显示这句(那两种情况 .env 或异常才是真相) |
| 跑部署前静态体检的人 | 还没删的死行会不会被点名 | `check-flag-truth` 现在对 store-managed 名字直接报错并给出改法;对生产 `.env` 只读实跑,21 条 RED,其中 1 条正是新规则命中的 `FLYWHEEL_SKILL_FRAMEWORK_MODE` |
| 第二波真去删行的人 | 删完会不会丢值 | 真产物 + 真 SQLite 库跑完整序列,并与改前代码对照(§4) |

## 2. Discord 面判断:本单无 N-to-N 面

diff 覆盖 `packages/config/src/feature-flags/{resolve,truth}.ts`、
`packages/teamlead/src/StateStore.ts`、`packages/teamlead/src/bridge/{flag-store-runtime,feature-flag-render}.ts`。
**没有**触及 Discord send / relay / render(thread 标题·徽章·置顶头·状态行)/ founder 交互 /
roundtable / 跨 Lead 协调中的任何一处。`ff-badge` 是 Bridge HTML 控制台里的徽章,不是 Discord 渲染面。

⇒ **no N-to-N surface — verified via**:真编译产物 + 真 SQLite 库的行为对照(§4)、
真脚本执行的静态体检(§3)、生产 `.env` 只读体检(§3)、founder 周报 HTML 真渲染(§5)。
本单**没有**开 529 房,原因是没有可跑的 Discord 链路,不是跳过。

## 3. 硬门与静态证据

| 门 | 结果 |
| --- | --- |
| `pnpm -r build` | rc=0(22 workspace) |
| `pnpm lint` | rc=0,0 error / 7 条既有 warning |
| `packages/config` 全包 | 661/661 |
| `teamlead` flag 套件(flag-store-runtime + feature-flag-render) | 49/49 |
| `scripts/__tests__/check-flag-truth.test.sh` | 3/3 |
| PR #930 CI(head `1557be5b9`) | **11/11 全绿**(Quick Gate、teamlead 3 分片、Unit light/heavy、Script Tests 两片、NPM payload、Classify、CI OK) |
| `fleet/example/env.example` | `flag truth OK`(1 key) |
| `packages/gemini-agent/.env.example` | `flag truth OK`(3 keys) |
| 生产 `~/.flywheel/.env`(**只读**,只读变量名不读任何值) | 21 条 RED = plan §7 预期的「加 guard 后、清理前 21」;其中 `FLYWHEEL_SKILL_FRAMEWORK_MODE` 由**新规则**命中 |

`check-flag-truth.test.sh` 第一次跑 `PASSED=0 FAILED=3`,是宿主 `TMPDIR` 过长导致 tsx IPC
`EINVAL` —— 换短 `TMPDIR` 后 3/3。这是环境项,不是被测代码。

## 4. 行为面:真产物 + 真 SQLite 的改前/改后对照

这是本单最关键的一条证据。脚本模拟第二波真正要做的动作序列:

```
A 带 legacy env 行启动 → B operator 经公共 stage/apply 改值 → C 删行后普通重启
→ D 用一次应急开关 FLYWHEEL_FLAG_STORE=0 再切回正常
```

| | 改前(当前生产代码,merge-base `7362a675c`) | 改后(本 PR) |
| --- | --- | --- |
| `skill_framework_mode` | `split` → **`superpowers`**(rev 2→3) | `split` → `split`(rev 2 不变) |
| `workflow_rework_reentry` | `false` → **`true`**(rev 1→2) | `false` → `false`(rev 1 不变) |
| `flag_retirement_scan` / `loop_profiler` / `shipped_husk_force` / `workflow_turn_divergence_alerts` | 全部被重写(rev +1) | 全部未触碰 |
| 审计 | `bypass_recovery: split → superpowers` | `bypass_recovery: split → split`(no-op 留痕) |

⇒ **在本 PR 之前删掉 .env 行,是一个会静默丢值的动作。** 这条修复是第二波的前置条件,不是可选优化。

C 步(不经应急开关的普通重启)在改前改后都保值 —— 丢值只发生在经过一次 bypass 窗口之后。

### 端到端投影(真 dist)

- 带陈旧 `.env` 行时:`storeEffective=split`、`fileEffective=undefined`、`divergence=undefined`、
  `error=undefined`、`fileConfigured=true`;console 与 phone 两种投影都出现「删这行」提示,
  且**不**出现「CLI 与 Bridge 见值不同」。
- 删行后:`fileConfigured=false`,提示消失,`storeEffective` 不变。

## 5. founder 周报 HTML 真渲染

`renderFlagReport` 用真产物渲染:25,139 bytes、`<head>` 完整、尖括号收支平衡、
恰好 1 条新提示(对应生产里唯一还活着的 store-managed 行)。

## 6. 阳性对照(证明这些测试会变红)

把 5 处产品改动**逐一**回退到 merge-base,跑对应测试:

| 回退的文件 | 结果 |
| --- | --- |
| `bridge/flag-store-runtime.ts` | 5 个测试变红 |
| `StateStore.ts` | 3 个变红 |
| `bridge/feature-flag-render.ts` | 1 个变红 |
| `config/feature-flags/truth.ts` | config 1 个变红 |
| `config/feature-flags/resolve.ts` | **首轮假绿** → 见下 |

`resolve.ts` 首轮显示「全绿」,一度被我记成「这条改动无测试覆盖」。追下去发现是我自己的隔离方式
出了问题:teamlead 测试 import 的是 `flywheel-config` 的 **dist**,只改 config 的 `src` 不重建
不会生效。重建 config 后 4 个测试正常变红。**记录在这里是因为「阳性对照本身也要有阳性对照」**。

对照全程在 `/tmp` 的 APFS clone 副本里做,**没有修改共享 worktree 的源码**;
共享 worktree 在全程结束时 `git status --porcelain` 为空。

## 7. 宿主失败的归因(不认领不属于本单的红)

本机 `teamlead` 全包:722 files,**13 failed / 40 failed tests**。
我用同一台机器上的「改前」状态(clone 内把 5 个产品文件 + 3 个测试文件退回 merge-base 并重建
config/teamlead dist)跑**同一批 13 个文件**做基线:

- 改后隔离跑:12 failed files / **38 failed tests** / 281 passed
- 改前隔离跑:12 failed files / **38 failed tests** / 281 passed
- 失败用例名逐条 diff:只有 1 组一对一互换,两条都在 `codex-lead.sh` 系的真进程 shell 测试里;
  第三次单 worker 复跑又换了一组 ⇒ 宿主抖动,与本 diff 无关(这两个文件本 diff 未触碰)。

外部权威:PR #930 在 exact head 上 CI **11/11 全绿**(无沙箱)。
⇒ 本机 38 个红全部归因宿主环境(真 tmux / launchctl / 真进程 / 负载),**不是本单造成的**。

## 8. 诚实边界(什么没验)

1. **生产 `.env` 的实际删除动作没有做**。只做了只读体检。这是 plan 的 Wave 2,必须在本 PR 合入
   并正常部署之后执行 —— 在旧代码还在跑的机器上删行,恰恰就是 §4 那个坑。
2. **没有重启生产 Bridge、没有做受控翻转、没有跑周扫描四类桶的生产前后对比**。同上,属 Wave 2。
3. **周扫描分类有一处会变**(我实测量化了,不是推测):带陈旧 `.env` 行时,
   `skill_framework_mode` 的 scan 样本从 `indeterminate/observed_instability`(改前)
   变成稳定 `value`(改后);其余 5 个 store-managed flag 两边完全相同。
   这是预期行为(数据库本来就是权威且稳定),后果是该 flag 满 7 天稳定后**可能被周报列为退役候选**
   —— 周扫描只提议、不自动删。删行之后改前代码也会给同样的稳定样本。
4. **删行本身带来的一处行为差**(不是 bug,但 founder 应该知道):行删掉之后,如果有人用
   `FLYWHEEL_FLAG_STORE=0` 应急开关,这 6 个 flag 在**应急窗口内**会按注册表出厂默认跑
   (不是 store 里的值);切回正常模式后 store 值原样恢复(§4 的 D 步已证)。
5. 分支基于 `7362a675c`,`origin/main` 已前进到 `5940f4220`(仅多 FLY-1987 docs);
   我没有 rebase,PR 仍 MERGEABLE。合入时的最终 tree 我没验过。

## 9. 会过期的结论

| 结论 | as-of | 重核 |
| --- | --- | --- |
| PR #930 CI 11/11 全绿 | head `1557be5b9`,2026-08-23 | 头一动就作废,重跑 `gh pr checks 930` |
| 生产 `.env` 21 条 RED、store-managed 只剩 1 条 | 2026-08-23 只读体检 | Wave 2 开工前重跑 `scripts/check-flag-truth.ts` |
| `origin/main` = `5940f4220` | 2026-08-23 | `git fetch` 后重看 |
| 本机 38 红 = 宿主项 | 2026-08-23 同机改前基线 | 换机器/换负载要重做基线,不要引用这个数字 |
