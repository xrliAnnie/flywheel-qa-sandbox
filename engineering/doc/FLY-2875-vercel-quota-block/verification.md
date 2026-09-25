# FLY-2875 额度页加 Vercel 一块 — 验证记录
Issue: FLY-2875 (https://linear.app/geoforge3d/issue/FLY-2875/额度页-加-vercel-一块personalxrlianniegmailcom已升-pro-用作报告托管-显示-plan-在用号)
日期: 2026-09-25
基于: plan.md

本文件是 implement 节点的本机定向验证，不代表精确头 full CI、独立 QA 或部署后验收。

## 1. 设计评审

- Codex（server-selected gpt-6-astra, xhigh）两轮：R1 CHANGES REQUESTED（2 BLOCKER：写盘失败会让旧成功读数继续显示；扣费日没限定 Pro），R2 APPROVED。原文：`design-review-round1.md`、`design-review-round2.md`。
- R2 两条 NIT 的处理：①`vitest related` 在本 Vitest 版本没有 `--list`，且所有改动文件都被 hub `plugin.ts` 传递引用（82 个测试直接 import `plugin.js`），related 会退化成全量 → 不跑 related，改为下面的直接消费者清单；②路由层补了「共享 holder + 真 `createAccountQuotaRefresh`」的失败→恢复用例（`capacity-route.test.ts` 最后一条），并让 `discardStale` 抛错。
- Lead 裁定（qid `cf983569`）：只显示别名，不显示完整邮箱；旧号写死一行，不用任何旧 token。

## 2. 定向测试（最终代码 head）

```
pnpm --filter flywheel-teamlead exec vitest run <下列 8 个文件>
 ✓ src/bridge/__tests__/capacity-snapshot.test.ts (39)
 ✓ src/__tests__/capacity-route.test.ts (21)
 ✓ src/vercel-quota/__tests__/vercel-account-store.test.ts (26)
 ✓ src/vercel-quota/__tests__/vercel-account-reader.test.ts (38)
 ✓ src/bridge/__tests__/account-quota-view.test.ts (25)
 ✓ src/bridge/__tests__/account-quota-page.test.ts (25)
 ✓ src/bridge/__tests__/account-quota-vercel.test.ts (30)
 ✓ src/bridge/__tests__/account-quota-refresh.test.ts (11)
 Test Files 8 passed (8) · Tests 215 passed (215)
```

消费者发现（`git grep -lF <文件名>.js` + 目录 `vercel-quota/`）：

| 改动文件 | 直接消费者 | 处理 |
|---|---|---|
| `vercel-quota/vercel-account-store.ts` | reader、refresh、vercel view、plugin + 5 个测试 | 全部跑 |
| `vercel-quota/vercel-account-reader.ts` | plugin + reader 测试 | 跑 reader 测试；plugin 见下 |
| `bridge/account-quota-vercel.ts` | page、view、plugin + 2 个测试 | 全部跑 |
| `bridge/account-quota-refresh.ts` | plugin + refresh 测试、capacity-route | 全部跑 |
| `bridge/account-quota-page.ts` | view、vercel view、plugin + page/capacity-route/capacity-snapshot 测试 | 全部跑 |
| `bridge/account-quota-view.ts`（只加可选参数与 type import） | page、plugin、`hook-payload.ts` + view/page/capacity-snapshot 测试 | 跑 view/page/capacity-snapshot；`hook-payload` 的测试没有一个触及账号额度（grep 为 0），排除 |
| `bridge/plugin.ts`（hub） | 82 个测试文件 | 只跑 `capacity-route.test.ts`（账号页路由 + refresh 路由）；其余 81 个与账号页无关，排除，交给 CI |

负对照（删掉守卫、确认对应测试变红、再还原）：
- reader 去掉 `ownerId` 校验 / 去掉 `content-length` 上限 → 2 条红。
- view 去掉「只有 Pro 才显示扣费日」→ enterprise 与未知 plan 2 条红。
- 路由去掉「最新尝试优先于文件」→ 2 条红（含失败→恢复用例）。

代码评审 R1（Codex gpt-5.6-sol xhigh）HIGH：响应里的 `username`/`plan`/`billingStatus`/Blob `status` 若回显 token（全文或前 8 字符，大小写不敏感），会被落盘并在别名对不上时渲染。已修：reader 对这些字段 fail-closed（整条按 `malformed`），新增 5 条对抗用例（含「reader 输出 → 渲染 HTML」全链路断言无 token 片段）。

## 3. 构建 / 类型 / lint

- `pnpm --filter "flywheel-teamlead..." build` → exit 0。
- `pnpm --filter flywheel-teamlead typecheck` → exit 0。
- `pnpm --filter "...flywheel-teamlead" typecheck`（先 build `flywheel-voice-codex^...`）→ exit 0。
- `pnpm lint` → exit 0（26 条 warning 均为既有，改动文件 `biome check` 干净）。

## 4. 本机真数据（分支 dist，只读 GET，store 写到临时目录）

脚本记录的请求只有三条 GET：`/v2/user`、`/v2/teams/team_*`、`/v1/storage/stores/store_*`。输出（id 已脱敏）：`evidence/real-ok-stdout.json`。

| 行 | 档位 | 下次扣费日 | 报告托管 Blob | 在用 |
|---|---|---|---|---|
| personal（team xrliannies-projects） | Pro | 10/24 周六 | 正常 · 已存 1.1 MB · 27 个对象 · 本期占比读不到 | 是（绿） |
| personal2 | Hobby | 已停用 | 不再使用 | 否 |

- 失败演练（无效 token）：只发出 `/v2/user` 一条 GET；Vercel 块三格都是「读不到（token 已失效）」、不染绿、旧号行照常、整页照常（`evidence/real-bad-stdout.json`、`evidence/vercel-invalid-token-desktop.png`）。
- token 前 8 个字符：HTML 0 命中、store 0 命中；Claude 账号邮箱在 HTML 中 0 命中。
- 截图：`evidence/vercel-ok-desktop.png`、`evidence/vercel-ok-mobile.png`（窄屏与其它表一样在容器内横向滚动）。

## 5. 合并冲突返工（2026-09-25，land base refresh 冲突）

合入 `origin/main` 59123848a（含 FLY-2869 #1326、FLY-2877 #1327、FLY-2873 #1324、FLY-2829 #1311），合并提交 9601039f2。冲突 3 个文件：

- `bridge/account-quota-refresh.ts`：FLY-2869 把刷新拆成共享单飞的 Codex 轮（`createCodexAccountQuotaRefresh`，页面和读数调度器共用）和按需的页面刷新（`createAccountQuotaRefresh`：`refreshCodex` + Claude）。Vercel 分支只挂在页面刷新上，和 Claude 分支一样用自己的 `withCeiling`；调度器跑的 Codex 轮不读 Vercel。`warn` 依赖保留在页面刷新上，给 Vercel 分支用。
- `bridge/__tests__/account-quota-refresh.test.ts`：harness 把 `vercel`/`warn` 传给页面刷新；原「Vercel 与 Codex 共用同一个 ceiling signal」断言改成「Vercel 挂起时在自己的 ceiling 被中止，刷新照常成功、发布固定失败、warn 不含 token 前 8 字符」；新增「调度的 Codex 轮不读 Vercel」。
- `bridge/plugin.ts`：保留 main 的 `refreshCodexReadings` + 调度器，Vercel 的 store 路径 / 内存 latest 声明放在它前面；Vercel 配置已在页面 `createAccountQuotaRefresh` 里。
- 自动合并但语义需要跟改：`__tests__/capacity-route.test.ts` 的失败→恢复用例改为用 `createCodexAccountQuotaRefresh` 构造 `refreshCodex`。`account-quota-view.ts` 两边改动正交，自动合并无需改。

合并后验证（head 9601039f2）：

```
pnpm --filter "flywheel-teamlead..." build        → exit 0
pnpm --filter flywheel-teamlead typecheck         → exit 0
pnpm lint                                          → exit 0（26 条既有 warning；plugin.ts 的 2 条 useConst 在 main 上同样存在）
pnpm --filter flywheel-teamlead exec vitest run <原 8 个文件> src/codex-quota/__tests__/reading-scheduler.test.ts
 Test Files 9 passed (9) · Tests 229 passed (229)
```

`reading-scheduler.test.ts` 加进来是因为调度器与页面共用新的 Codex 轮。`git grep -lF account-quota-refresh` 的消费者只有 `plugin.ts`、`capacity-route.test.ts`、`account-quota-refresh.test.ts`，都已覆盖。

负对照：把 Vercel 分支的 `withCeiling` 换成一个永不中止的 signal → 「aborts a hung Vercel read at its own ceiling」变红，其余 12 条绿；已还原。

## 6. 未做 / 交给后续

- 没有请求 full CI、没有派 QA、没有合并或部署。
- 部署后需要真跑一次 `flywheel-comm accounts-page`（refresh=1）并检查 Bridge 日志中 token 前 8 字符 0 命中 —— 属于 QA/ship。
