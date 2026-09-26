# FLY-2897 Claude 扣费日读收据 — 验证记录
Issue: FLY-2897 (https://linear.app/geoforge3d/issue/FLY-2897/额度页claude-扣费日-定时读各号-gmail-里-anthropic-的-stripe-收据-额度页显示下次扣费日取消邮件则显示已取消)
日期: 2026-09-25
基于: plan.md（v5，Codex 设计评审 Round 4 APPROVED）

## 1. 真邮箱只读验收（2026-09-25 18:32 PDT）

做法：用本分支构建产物（`packages/teamlead/dist`）跑一次 `observeClaudeCharges`，gog 为本机真实 gog（v0.10.0 / a92bd63），
目标号取自 `~/.flywheel/claude-accounts.json` 的 `identity.email`。结果只写到临时目录的 `charge-receipts.json`，**不碰生产文件**；
再用 `buildAccountQuotaView`（当前 `account-details.json` 的套餐 + 这份临时文件）算出页面格子。
脚本只调用 `gmail messages search`（仅元数据）和 `gmail get --select=body,headers.from,headers.subject`，只打印下表字段。

| 号 | 状态 | 本期 | 付款日 | 金额（分）| 张数 | 页面格子 | 对照 |
|---|---|---|---|---|---|---|---|
| business | ok | 2026-09-16 .. 2026-10-16 | 2026-09-16 | 20001 | 2 | `10/16 周五` / `本期 9/16–10/16 · 已付 $200.01` | 收据 ✓（FLY-2894 实测 10/16）|
| personal | ok | 2026-09-04 .. 2026-10-04 | 2026-09-04 | 20000 | 1 | `10/04 周日` / `本期 9/4–10/4 · 已付 $200.00` | = claude.ai `next_charge_date` 2026-10-04 ✓（FLY-2894 对照）|
| school | ok | 2026-09-17 .. 2026-10-17 | 2026-09-17 | 20000 | 1 | `10/17 周六` / `本期 9/17–10/17 · 已付 $200.00` | 收据 ✓（FLY-2894 未测到，本单补测）|
| shopping | ok | 2026-09-20 .. 2026-10-20 | 2026-09-20 | 20000 | 1 | `10/20 周二` / `本期 9/20–10/20 · 已付 $200.00` | 收据 ✓（FLY-2894 实测 10/20）|
| personal1 | auth_missing | — | — | — | — | `免费号，无扣费`（当前明细套餐 free）| ✓ |

- 5 个号一轮 3.9 秒；摘要日志 `{"accounts":5,"ok":4,"canceled":0,"failed":["personal1:auth_missing"]}`。
- 临时文件 4000 字节，检查 `@`、`Anthropic`、`Receipt`、`PBC`、`Amount paid`、`subscription` 全部 0 命中（不含邮箱、发件人、主题、正文片段）。
- 每行都有「收据读于」时间（验收时刻）。
- 取消场景在真实邮箱里目前没有（4 个号最新收据之后都没有取消邮件），按验收要求用构造数据验证，见 §2。
- 授权失效（invalid_grant）现在 4 个号都有效，没有去弄坏授权；文案用假 gog 覆盖，见 §2。

## 2. 构造数据覆盖的场景（全部在测试里）

| 场景 | 测试 |
|---|---|
| 最新收据之后有取消邮件 → `已取消 · 10/16 周五 到期` | `charge-receipt-e2e.test.ts`（gog 输出 → 文件 → 页面）、`charge-receipt-observer.test.ts`「marks a constructed cancellation…」|
| 取消后在本期内重订 → 仍是原扣费日 | observer「keeps the anchor through a constructed cancel-then-resubscribe」、parse 的 personal 真实时间线 |
| 较新的明细 `active` 不清掉取消邮件（期末取消）| view「keeps a newer detail 'active' from clearing a cancellation mail」|
| 明细在最新收据后读到 `canceled` → 已取消 | view「keeps a cancellation the account detail saw after the latest receipt」|
| invalid_grant / 未授权 / 超时 / 限流 / 输出过大 / 格式损坏等 | observer「failures」表、view「names the real reason…」|
| 非订阅收据跳过、6 封正文预算、翻页 `nextPageToken`、3 页截断、重复 id、损坏信封 | observer 对应用例 |
| 邮箱改绑后旧读数不显示 | view「never shows another mailbox's reading…」、capacity-route FLY-2897 用例 |

## 3. 本地定向验证（只跑相关测试）

| 命令 | 结果 |
|---|---|
| `pnpm lint` | exit 0（25 个 warning 均为既有，改动文件无新 warning）|
| `pnpm --filter "flywheel-teamlead..." build` | 通过 |
| `pnpm --filter "flywheel-voice-codex^..." build` 后 `pnpm --filter "...flywheel-teamlead" typecheck` | teamlead、voice-codex 均通过 |
| `pnpm exec vitest run <下列 15 个文件> --pool=forks --poolOptions.forks.maxForks=1`（packages/teamlead）| **15 文件 453/453 通过** |
| `pnpm exec vitest run test/kill-path-inventory.test.ts`（packages/claude-runner）| 5/5 通过（新增的 gog 子进程不触发 kill-path 清单）|

15 个文件：`claude-quota/__tests__/charge-receipt-{parse,store,observer,scheduler,e2e}.test.ts`、`claude-quota/__tests__/account-detail.test.ts`、
`bridge/__tests__/account-quota-{page,view,refresh,vercel}.test.ts`、`bridge/__tests__/switch-refresh-trigger.test.ts`、
`bridge/__tests__/capacity-snapshot.test.ts`、`__tests__/capacity-route.test.ts`、`__tests__/patrol-tick-render.test.ts`、`vercel-quota/__tests__/vercel-account-reader.test.ts`。

### 消费者闭包与排除

用 `git grep` 找每个改动源文件的直接 importer：

| 改动文件 | 直接 importer（测试已全部纳入）| 排除 |
|---|---|---|
| `claude-quota/charge-receipt-{parse,store,observer,scheduler}.ts`（新）| 彼此、`account-quota-view.ts`、`account-quota-refresh.ts`、`plugin.ts`、5 个新测试、capacity-route、account-quota-refresh 测试 | — |
| `bridge/account-quota-page.ts` | `account-quota-view.ts`、`account-quota-vercel.ts`、`plugin.ts`；测试 page / capacity-snapshot / capacity-route / vercel-account-reader / account-quota-vercel | — |
| `bridge/account-quota-view.ts` | `account-quota-page.ts`、`hook-payload.ts`、`plugin.ts`；测试 page / view / capacity-snapshot / e2e；`hook-payload` 的额度消费者 patrol-tick-render | tick 文案函数 `formatAccountQuotaTickLines` 不读 `nextCharge` / `sources` / `receiptReadAt`（已核对），其余 `hook-payload` 测试不涉及 |
| `bridge/account-quota-refresh.ts` | `plugin.ts`；测试 account-quota-refresh / capacity-route | — |
| `bridge/switch-refresh-trigger.ts` | `plugin.ts`；测试 switch-refresh-trigger | — |
| `bridge/plugin.ts` | 枢纽：几乎整个 teamlead 测试集都经它可达 | **没跑 `vitest related`**（会展开成整包，implement 角色禁止）。改动只在 accounts-page 路由（capacity-route 覆盖，含 FLY-2897 用例）和 `startBridge` 的接线（各组件单测 + typecheck 覆盖）|

## 4. 设计评审

- 独立全新上下文评审 1 轮（`design-review-independent-round1.md`，只作输入，不替代 Codex）。
- Codex 设计评审 4 轮（`design-review-codex-round{1..4}.md`，thread `01a0db0d-cf07-7423-bf26-1192b594afca`），Round 4 APPROVED；`await-codex-gate design` 通过（manifest rev 6，requestId `1a6ab794-cb67-46a5-849c-3dce60509319`，plan blob `aee1f01954fb249aa3ab12f8ade21633396fa4bb`）。

## 5. 部署前置（需 Lead / founder 确认）

plan §6 的残余风险：Gmail 模糊匹配命中的邮件的 `id / threadId / labels / from / subject / date` 与翻页 token 会短暂进入 gog 子进程与 Bridge 内存（不含正文），不落盘、不进日志；取正文时 gog 子进程会拿到该 Anthropic 收据的完整消息。

## 6. 与 main 同步（FLY-2830 #1330 已 squash 合入）

- 合入 `origin/main` 9034bddc3（merge 94689f848）。冲突的 9 个文件里，8 个在 main 上与 `origin/flywheel-FLY-2830` 最终版逐字相同（squash 带来的同一批改动），取本分支版本；
  `bridge/plugin.ts` 在 main 上还有其他 PR 的改动，以 FLY-2830 版本为基底三方合并（`git merge-file`，0 冲突）：相对 main 只多本单接线，相对本分支多 main 的其他改动。锁文件与各包 `package.json` 未变。
- 合并后复跑：`pnpm --filter "flywheel-teamlead..." build` 通过；`pnpm --filter "...flywheel-teamlead" typecheck` 通过；同 15 个文件 **453/453 通过**；`pnpm lint` exit 0（25 个既有 warning）。

## 7. 代码评审

- Codex Round 1（PR #1338 review 5324089932，thread `01a0db61-772c-7243-81b1-18c1cadc7866`）：CHANGES REQUESTED，2 个 MEDIUM，均采纳并修复（ea255704e）：
  1. 找到最新订阅收据后，本期内一封「有套餐行但周期认不出」的较早收据被跳过，会把部分金额 / 张数当成完整 → 改为本期不完整（金额、张数为 null）。测试「drops the totals when an earlier receipt of the period is unreadable」。
  2. 调度器缓存的到期时刻在切号 / 按需刷新重写文件后不会更新，可能错过更早的「扣费次日」补读 → 至多每 5 分钟重读一次文件重算（仍不在每个 3 秒 tick 读文件）。测试「notices within minutes an earlier due that another trigger's write created」。
- 修复后复跑：claude-quota 全部 + account-quota view / page / refresh + switch-refresh-trigger + capacity-route，12 文件 299/299 通过；teamlead typecheck 通过。
- Codex Round 2（review 5324116732）：R1 两项确认修好；新提 1 个 MEDIUM 采纳并修复：失败轮次后的退避期内，3 秒 tick 因「已到期」而每次重读文件 → 退避判断提前到重算之前（退避期内不能启动，也就不读）。测试「waits before retrying a failed round」加了退避期 10 个 tick 零读取的断言；claude-quota 153/153 通过。

## 8. QA@1 返工（完整 CI run 36210664788，head dc979c30e）

| 红任务 | 原因 | 处理 |
|---|---|---|
| Script Tests 1/6 #11 path-hygiene | **本单**：`charge-receipt-observer.ts` 的 gog 候选列表同时含 `/opt/homebrew/bin` 与 `/usr/local/bin`，是未登记的混合前缀声明 | 登记到 `scripts/lib/path-hygiene.sh` 的 native-first 首个命中注册表；`check-global-path-hygiene.test.sh` 21/21 |
| Unit (light) `feature-flags-drift` | `execFileSync("git", ["ls-files"])` 默认 1 MiB 缓冲溢出（ENOBUFS）：分支的跟踪路径清单 1,052,492 字节 | 合入最新 `origin/main`（f17144919，FLY-2860 删除了一批文件）后为 1,045,116 字节；本地 14/14 |
| Unit (teamlead 1/4) `required-wall-clock-thresholds` | 同样 ENOBUFS；它还掩盖了**本单测试**的一条真实耗时上限（`charge-receipt-observer.test.ts` gog 超时用例 `< 3000 ms`）| 改为断言结果（`error === "timeout"`、`signal === "SIGTERM"`，子进程睡 60 s，只有被杀才可能在测试超时内返回）；审计测试通过 |
| Unit (teamlead 4/4) `tmux-lookup.real-tmux` dead_pin | 与本单无关：本 PR 不改任何 tmux 代码；本地返工 head 上 7/7 通过；当天 main 自己的 push CI 也红在其他套件 | 已附证据报 Lead |

- 全仓隐患已报 Lead：main 的跟踪路径清单离上述测试的 1 MiB 默认缓冲只剩约 4.8 KB。
- 返工后复跑：`pnpm lint` exit 0；`pnpm --filter "...flywheel-teamlead" typecheck` 通过；18 个文件 464/464（原 15 个 + `required-wall-clock-thresholds`、`tmux-lookup.real-tmux`、`bridge-child-process-census`）。
