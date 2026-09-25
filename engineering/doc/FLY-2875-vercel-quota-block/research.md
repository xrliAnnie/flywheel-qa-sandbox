# FLY-2875 额度页加 Vercel 一块 — 调研
Issue: FLY-2875 (https://linear.app/geoforge3d/issue/FLY-2875/额度页-加-vercel-一块personalxrlianniegmailcom已升-pro-用作报告托管-显示-plan-在用号)
日期: 2026-09-25
基于: exploration.md

所有探测都是本机只读 GET（2026-09-25 01:00 PDT 前后），脚本不打印 token；下列样例已脱敏（team/store id 以 `*` 代替）。

## 1. 本机凭据

- `~/.flywheel/.env` 里与 Vercel 有关的键：`VERCEL_TOKEN`、`REPORT_HOSTING_VERCEL_TOKEN`、`BLOB_READ_WRITE_TOKEN`。
- `VERCEL_TOKEN` 与 `REPORT_HOSTING_VERCEL_TOKEN` **是同一个值**，都属于 personal 号（`/v2/user` 读到 personal 号的邮箱，username `xrliannie`）。
- 旧 Hobby 号（xrliannie.2）**本机没有 token**，没有任何接口能读它。
- Bridge 已有 `FileReportHostingCredentials`（按 `.env` mtime/size 热读，不需重启）。本单只取 `REPORT_HOSTING_VERCEL_TOKEN`：它按 retarget 合同就是「报告托管账号」的 token。

## 2. 接口与字段（全部 GET，`https://api.vercel.com`）

### 2.1 `GET /v2/user`（206 字节）

```json
{"user":{"id":"…","email":"<personal 邮箱>","name":"…","username":"xrliannie","avatar":"…",
 "defaultTeamId":"team_*","version":"northstar","limited":false}}
```

- northstar 账号的 user 对象**没有 billing**；计费在默认 team 上。

### 2.2 `GET /v2/teams/{defaultTeamId}`（约 25 KB，主要是 `billing.invoiceItems` 价目表）

```json
{"id":"team_*","slug":"xrliannies-projects","name":"xrliannie's projects","softBlock":null,
 "billing":{"plan":"pro","status":"active","platform":"stripe","planIteration":"plus",
  "period":{"start":1790233200000,"end":1792825200000},
  "planChangedAt":1790319299000,"cancelation":null,"trial":null,
  "invoiceItems":{"pro":{"price":2000,"quantity":1,…},"includedAllocationUsd":{"quantity":20,…},…},
  "usageStatus":{"kind":"flat"}, "email":…, "address":…, "tax":…}}
```

- `period.start` = 2026-09-24T07:00:00Z（PT 9/24 00:00），`period.end` = **2026-10-24T07:00:00Z（PT 10/24 周六 00:00）**。
- `planChangedAt` = 2026-09-25T06:54:59Z = PT 9/24 23:54:59，和 founder 23:55 升 Pro 对得上。
- `status:"active"`、`cancelation:null` → 在续费。下次扣费 = 账期结束 `period.end`。
- 时间是**毫秒整数**，不是 ISO；解析时按安全整数 + 合理范围校验后转 canonical ISO。
- `billing` 里有邮箱、地址、税号等付款信息：**只取 plan/status/period/cancelation 四项，其余一律不落盘、不打印**。

### 2.3 `GET /v1/storage/stores/{storeApiId}?teamId={teamId}`（685 字节）

```json
{"store":{"id":"store_*","ownerId":"team_*","type":"blob","name":"fw-reports-6da062-blob",
 "billingState":"active","status":"available","size":1051925,"count":23,
 "usageQuotaExceeded":false,"access":"private","projectsMetadata":[…]}}
```

- `ownerId` 等于上面 team 的 id → 证明报告托管 store 就在这个号上（「在用」的判据）。
- 旧号被停时的 `status` 是 `limits-exceeded-suspended`（FLY-2751 thread，现有 `evaluateReportHostingUsage` 已按 `limits-exceeded` 前缀判停）。
- store 不存在：`404 {"error":{"code":"not_found",…}}`。

### 2.4 错误形状

| 情形 | 响应 |
|---|---|
| token 无效 | `403 {"error":{"code":"forbidden","message":"Not authorized","invalidToken":true}}` |
| store 不存在 / 不在该 team | `404 not_found` |
| 其它 | 按状态码归类，不回显响应体 |

## 3. 「本期用量占比」能不能读

- store 接口只有 `size`（字节）、`count`、`usageQuotaExceeded`、`status`，**没有额度上限**。
- `team.billing.invoiceItems` 里 Blob 各项只有单价（`threshold:0`），Pro（`planIteration:"plus"`）是「$20 含量额度 + 按量」，没有按资源的免费上限。
- `GET /v1/billing/charges`（FOCUS JSONL）能读，但 378 KB、按天汇总且当天为 0（有延迟），把订阅费本身也算在 EffectiveCost 里，拿来算占比需要自己定口径 = 猜。
- 结论：显示「已存 1.1 MB · 23 个对象」这类直接事实；占比写「读不到（接口不给额度上限）」。

## 4. 报告托管当前指向

- `~/.flywheel/reports/registry.json`：`vercelProjectName = fw-reports-6da062`，`hosting.storeApiId = store_*`，`hosting.retargetedFrom = fw-reports-356a6d`（旧号），`migratedAt = 2026-09-25T07:09:39Z`。
- `ReportRegistry.hostingBinding()` 已导出 `{storeId, storeApiId, vercelProjectName}`；注册表写入是原子 rename，读不需要锁。

## 5. 隐私不变量与别名

- FLY-2688 定版：托管页只显示别名，不显示完整邮箱。页面已有 `claudeEmails`（Claude 账号名 → 邮箱，来自 `claude-accounts.json`，只在 Bridge 内存里）。
- 做法：Vercel store 只存 `emailSha256 = sha256(小写邮箱)`；GET 时对 `claudeEmails` 同样求哈希，对上就显示那个别名（personal）。对不上时显示 Vercel username，不显示邮箱。
- Codex 表已有别名 `personal2`（= xrliannie.2 号），旧 Vercel 号沿用这个名字。

## 6. 现有模式（照抄）

- store：`codex-quota/codex-subscription-store.ts` —— 0600、临时文件 + fsync + rename、读取上限、严格校验、任何失败返回 null。
- 刷新：`bridge/account-quota-refresh.ts` —— single-flight，Codex 与 Claude 分支 `Promise.allSettled` 并行；订阅读失败只 warn、不让刷新失败。
- 页面：`bridge/account-quota-page.ts` —— 全部动态文字 `escapeHtml`；`active-account` 类整行绿底。
