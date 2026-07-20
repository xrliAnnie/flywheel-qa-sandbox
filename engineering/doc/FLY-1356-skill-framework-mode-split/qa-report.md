# FLY-1356 skill_framework_mode 三选一开关 + 生产分流 — QA 验证报告

Issue: FLY-1356 (URL 不可得,只写 issue 号)
日期: 2026-07-20
基于: plan.md · runbook.md · 被验 head `6e2190c2d` (PR #654)

> 三段式 QA 段独立验证。**判定:PASS(附两条 ship 前置条件,见 §6)。**
> 本段不改实现代码;新增 QA 测试 1 个文件,提交在同一分支同一 PR。

---

## 1. 验了什么(证据一览)

| # | 验证项 | 手段 | 结果 |
|---|--------|------|------|
| 1 | 反向兼容哨兵(红线 #1) | `Blueprint.fly1356-off-sentinel.test.ts` 5 例,**自带突变验证** | ✅ 5/5 |
| 2 | resolver §0 优先级全表 | `skill-framework-mode.test.ts` 17 例 | ✅ 17/17 |
| 3 | Blueprint 双层生效 + envelope | `Blueprint.fly1356-skill-framework.test.ts` 20 例 | ✅ 20/20 |
| 4 | StateStore 两列 + 迁移幂等 + sticky 查询 | `StateStore.fly1356-skill-framework.test.ts` | ✅ |
| 5 | 臂定义冻结(变体/vendor 合同) | `scripts/__tests__/skill-framework-variants.test.sh` | ✅ 32/32 |
| 6 | **真机:三臂注入可见性** | `scripts/qa-fly-1356-mode-visibility.sh`(真 `claude -p`) | ✅ 5/5 |
| 7 | **真机:matt 探针 = Blueprint 用的那一条** | `claude plugin details matt-skills@matt-skills` | ✅ exit 0,6 skill |
| 8 | 生产接线不是"纸面参数" | 实读 `run-infra.ts` 构造位点 + 位置参数对位 | ✅ 已接 |
| 9 | vendor 供应链自查(不信 VENDOR.md checklist) | 独立 grep + **阳性对照** | ✅ 无风险模式 |
| 10 | 包级回归 | edge-worker 全套 / config 全套 | ✅ 1177 + 515 |
| 11 | CI @ 被验 head | `gh pr checks 654` | ✅ 9/9 全绿 |
| 12 | QA 新增覆盖 | `Blueprint.fly1356-qa.test.ts` 8 例(新) | ✅ 8/8 |

### 1.1 真机证据(§1 表第 6 项,原文)

阳性对照先行 —— 尺子先证明没坏,再谈"没有":

```
Step 1  默认 session 有 Superpowers 注入            → YES  ✓ (阳性对照)
Step 1b 默认 session 看不到 matt catalog            → NO   ✓ (机器级 OFF 守住)
Step 2  bare 臂 per-launch disable 后无注入         → NO   ✓
Step 3  matt 臂无 Superpowers 注入                  → NO   ✓
        matt 臂 grilling/tdd catalog 可见           → YES  ✓
5 passed, 0 failed
```

**Step 1b 是关键控制项**:它证明 Step 3 的 YES 来自 per-launch `--settings` 打开,
而不是机器上本来就全局可见 —— 否则 matt 臂"生效"是假的。

---

## 2. QA 新增测试(`Blueprint.fly1356-qa.test.ts`,8 例)

补了 implement 段留下的两个口子:

**A. kill × 在飞 successor 旧 override(plan §验收标准 4 明确点名,集成层缺测)**
resolver 层有 R1#1 total 语义测试,Blueprint 层有"forced superpowers(kill 位)"测试,
但**两者交叉的那格没有** —— 而那格恰恰是真实 kill 场景(ops 把 flag 拨回
`superpowers`,此时 529 pipeline 还带着 `skillFrameworkMode=matt` 在飞)。新增 3 例:
kill→A 且插件字段全 absent、kill 到 bare 时旧 matt override 不渗进插件层、不抛错。

**B. sticky × fallback 交互的特征化测试(见 §3)**
把 runbook §5 已写成散文的边界,钉成可执行断言。

---

## 3. 发现 QA-1 —— 已知边界,现已"钉进测试"(非新缺陷)

**行为**:一张哈希落 B 臂的单,若首次 admission 时 matt 探针失败 → 记
`superpowers/fallback_superpowers`;此后 `getSkillFrameworkStamp` 无 via 过滤地重放这个
值,该单**永久留在 A 臂**,且后续行 via 记 `sticky` —— 与"本来就该在 A"的单在 SQL 里
长得一样。

**已实证**(不是读代码推的):`Blueprint.fly1356-qa.test.ts` 用 `FLY-1299`(实测哈希桶 =
`matt`)跑三段 —— 探针失败→记 A;之后探针转绿 + 带 stamp→仍是 A/`sticky`;
**对照组**(不带 stamp、探针绿)→ 正常进 `matt/hash`,证明钉住确实来自 stamp。

**定性:不是 blocker。** 三条理由:
1. 方向是安全的(回落朝 A = 现状),生产不受影响;
2. **归因没有全丢** —— 该单**第一行**如实记 `fallback_superpowers`,分析时按 issue 查首行仍可识别;
3. runbook §5 已经写了这条 + 给了处置口径(Bar-Raiser LOW-7:正式评测把这些 issue 整个排除)。

QA 的增量 = 把散文变成会红的测试,将来若有人改 sticky 语义,是可见 diff 而非静默漂移。

---

## 4. 顺带查实的两件事(Tadashi 需知)

**4.1 `event-route.test.ts` 3 例失败 = main 既有红,不是本 PR 带的。**
判据:把 `packages/teamlead/src` **整体换成 main 的**再跑,同样这 3 例、同样错法
(`expected "completed", received "awaiting_review"`,均属 FLY-58/FLY-60 W2 landing-status
路径);本分支该文件的 diff 只碰 `session_started`,与失败路径无交集。同 head 的 CI
teamlead 三片全绿 → 属本机环境相关的既有 flake/红,建议单独开单,不阻塞本单。

**4.2 生产 `~/.claude` 已经装了 matt-skills(deployment 步骤已被执行)。**
`settings.json` 里 `matt-skills@matt-skills: false`(机器级钉 OFF),探针 exit 0。
这是 runbook §0 的前置动作,已提前做掉。**已验证它不泄漏**:Step 1b 证明默认 session
(含所有 Lead / 现状 Runner)看不到该 catalog。此处只作事实备案,让 Annie/Tadashi 知情
"生产机配置已被动过一次"。

---

## 5. 没验到的(诚实边界 —— 不要读成已验)

| 项 | 状态 | 说明 |
|---|---|---|
| **529 房三臂"能力级"冒烟**(plan §验收标准 3 后半 / v2.2③ HL) | ❌ **未执行** | 要求 A/B/C 各真跑通一张单、且四观测量对每臂真采得出来。需隔离 529 Bridge + 3 个真 runner 各自完成一张单,是小时级机器时间;本机当前 load ≈ 11。**这是 FLY-1299 正式实验的前置健康检查,不是 merge 的前置**(merge 默认 A、字节兼容)。 |
| 四观测量真采数 | ❌ 未执行 | 同上,依赖三臂真跑 |
| direct-toggle 真机不重启翻转 | ⚠️ 部分 | 机制已核实(`flag-toggle.ts` 确实 in-proc 改 `process.env`,Blueprint call_time 读)+ 单测/HTTP 路由测试绿;**未在真 Bridge 上做一次 console 翻转 → 下一次 dispatch 观察**。 |
| Codex code review | ❌ deferred | school 额度封顶(唯一有权限 profile),plan §Ship 前置清单已写明 = Bar-Raiser 替补,额度恢复后补增量审。**呈 Annie 时必须明说。** |

---

## 6. 判定

**PASS**,附两条 ship 前置条件(交 Tadashi / Annie 决定,不由 QA 代拍):

1. **开 `split` 之前**必须补跑 529 三臂能力级冒烟 + 四观测量采数(plan 验收标准 3)。
   merge 本身不受阻 —— 默认 `superpowers`,哨兵 + 突变验证证明字节兼容。
2. **Codex 审 deferred(quota)** 这件事按 plan 要求原样呈给 Annie,由她知情拍板。

判定依据的口径:代码正确性 / 字节兼容 / 真机机制生效 / 接线真实性 / 供应链 —— 这五项
QA 验到位且有阳性对照;**评测能力级验收未验,已单列**。

---

## 7. 复现命令

```bash
# 单元 + 合同
cd packages/config    && npx vitest run
cd packages/edge-worker && npx vitest run src/__tests__/Blueprint.fly1356
bash scripts/__tests__/skill-framework-variants.test.sh

# 真机(需 claude 已登录;只读,不写任何配置)
bash scripts/qa-fly-1356-mode-visibility.sh

# 注意:本机 QA session 的 env 带 FLYWHEEL_RUNNER_BACKEND=codex,会污染 teamlead
# 套件的 vendor 默认值断言 —— 跑 teamlead 测试请 `env -u FLYWHEEL_RUNNER_BACKEND`。
```
