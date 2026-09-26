# FLY-2875 额度页加 Vercel 一块 — 探索
Issue: FLY-2875 (https://linear.app/geoforge3d/issue/FLY-2875/额度页-加-vercel-一块personalxrlianniegmailcom已升-pro-用作报告托管-显示-plan-在用号)
日期: 2026-09-25
基于: 无

## 1. founder 要什么

- 原话（2026-09-24 23:57 PDT）：「Weso（= Vercel）这边也 update 在那个额度页吧，主要就是我记得我有这个 subscription」。
- 真正的需要：**别忘了自己在给 Vercel 付费**。所以页面上最要紧的是「哪个号、什么档位、下次什么时候扣钱」；其次是报告托管现在健康不健康（上一次就是托管号被停导致 publish-report 全 502）。
- 背景：9/24 23:41 PDT 旧的免费号（Hobby）操作额度用完，store `limits-exceeded-suspended`；23:55 PDT founder 把 personal 号升到 Pro，报告托管 retarget 到 personal 号（`fw-reports-6da062`）。

## 2. 现状

- 额度页 = Bridge `GET /api/accounts-page.html`（FLY-2688 → 2803 → 2807 → 2864 四轮），两张表：Claude、Codex。行式样：首列账号别名 + 档位小字，「在用」号整行绿底 + 左侧绿条 + `在用` 小标。
- 页面数据：`refresh=1` 时才跑外部读取（single-flight 的 `createAccountQuotaRefresh`），读数写进 `~/.flywheel/*-quota/*.json`；普通 GET（切号通知 5 秒预算里的 `--publish-only`）只读 store，不发网络请求。
- 已有 Vercel 代码：报告托管（`report-hosting-*.ts`、`vercel-hosting-api.ts`）用 `REPORT_HOSTING_VERCEL_TOKEN` 管 Blob store，含 `getStore`（读 store 状态 / 大小 / 对象数）。注册表 `~/.flywheel/reports/registry.json` 记录当前托管的 store（`hosting.storeApiId`）。
- **已定版的隐私不变量（FLY-2688）**：托管页只渲染账号别名，完整邮箱不进托管页、容量 JSON、patrol tick；`capacity-route.test.ts` 断言页面不含 `@example.com`。

## 3. 冲突与决定

| 点 | 单子写法 | 现有约束 | 取舍 |
|---|---|---|---|
| 账号 email | 行里显示 email | 托管页不显示完整邮箱 | 显示别名（personal / personal2，与 Claude/Codex 表同名）+ team slug；已向 Lead 发问（非阻塞，qid `cf983569`），若 Lead 要明文再改 |
| 旧号 xrliannie.2 | 列出来，标已停用 | 本机没有它的 token，读不到任何实时数据 | 写死一行：别名 personal2、档位 Hobby（founder 给的事实）、「已停用，不再使用」，其余格不显示实时数 |
| 本期用量占比 | 能读到就加 | Pro 的 Blob 没有额度上限字段（见 research） | 显示已存大小与对象数，占比写「读不到（接口不给额度上限）」 |

## 4. 方案比较

1. **每次 GET 实时打 Vercel API**：简单，但会把网络调用带进切号通知的 5 秒预算，违反现有「普通 GET 不发网络」的约束。否。
2. **refresh 时读一次、写 store、GET 读 store（选）**：与 Codex 订阅、Claude 明细同一模式；API 失败只影响这一块。
3. **塞进 `/api/capacity` 容量快照**：Vercel 不是 LLM 容量，塞进去会改容量 JSON 合同与巡检消费者。否。

## 5. 假设（明确列出）

- `REPORT_HOSTING_VERCEL_TOKEN` 就是报告托管账号的 token（retarget 命令的合同）。本机 `VERCEL_TOKEN` 与它是同一个值（已只读核实）。
- 「在用」= 注册表当前 store 的 owner 就是这个 token 读到的 team（用 store 的 `ownerId` 证明）；证明不了就不染绿。
- 「下次扣费日」= `team.billing.period.end`，前提是 `plan=pro`、`status=active`、`cancelation=null`、日期未过期。Vercel Pro 是按月订阅，账期结束即续费扣款；这是 API 给出的真值，不是推算。
- 只读：只发 GET；绝不调用任何写接口。
