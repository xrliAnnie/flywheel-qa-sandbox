# FLY-2807 额度页数据层四处修复 — 实施计划
Issue: FLY-2807 (https://linear.app/geoforge3d/issue/FLY-2807/额度页q5-修两处读错spec-e22-e23founder-正在用的-codex)
日期: 2026-09-22
基于: 无

## 1. 锁定范围与假设

按 Lead 的 `[lead-instruction 5834e66f-6a31-4b36-a5f3-ae11e41367ac]`，原 FLY-2804/2805 已关闭并入本单。本单实现 FLY-2777 `spec.md` 的 E20–E23：

1. E20：Claude 充值卡接真实 prepaid credits 数据，按 `tranches` / `promo_tranches` 逐张显示到期日；机器源无明细时允许 provenance 完整的手填项，不用余额或样例值冒充卡。
2. E21：Codex `rateLimitResetCredits` 按对象结构解析；张数只取 `availableCount`，区分 `credits:null` 与 `credits:[]`，逐张显示到期日；绝不兑换卡。
3. E22：Codex 正在使用的账号不能再因 `in-use` 保护而整行没有读数；改走不刷新、不写凭据、不拿账号 lease 的只读 usage GET。
4. E23：Claude `personal1` 的探测失败必须区分「瞬时探测错误」与服务端确认的取消订阅；确认取消时页面显示「已取消」，不继续把 9/08 的旧百分比当成当前值。取消状态只是每轮可自愈的页面 observation：绝不写 `AccountEntry.unavailable`，不改变 failover 候选池，也不调用或修改 `classifyAccountLiveness`；后续 profile 恢复 active 时下一轮自动清除「已取消」。

明确不做：不改排序、分组、灰标或角标来遮数据缺口；取消行仍用既有 quota snapshot 计算排序键，只替换该行显示单元格，不把它标为 `unusable` 或沉底；不切 canonical 账号；不登录/登出；除承载 E20/E21 真数据所必需的列内容外，不实现 FLY-2777 E1–E19/E24 的页面重做；不兑换 Codex 卡；不部署、不重启服务。

假设：Codex 的 `GET https://chatgpt.com/backend-api/wham/usage` 与 Claude 的 OAuth usage/profile/prepaid GET 都是只读接口；本单允许用现有本机凭据做受控真机只读验收，但任何输出只保留状态码、用量窗口、到期时间和枚举状态，不输出 token、账号 id、email 或未经筛选的 raw 响应。

## 2. 根因证据（实施前）

### E20 — Claude 充值卡源从未接入页面

- 当前 `account-quota-view.ts` 对 Claude credits 固定返回 `—`，没有任何 prepaid reader 或 durable detail store。
- `/api/oauth/organizations/:orgUUID/prepaid/credits` 的真实返回除了余额，还包含 `tranches`、`promo_tranches` 与 `next_expires_at`；这些才是逐卡到期数据源。
- 合并前 FLY-2805 的只读证据：business/shopping 对应数组为 null，personal/school 为空数组，personal1 返回 403；尚无非空真机样本，因此 parser 必须严格、保留 unknown/null/empty 的区别，不能拿余额推算卡数或到期日。
- 当前也没有带 `confirmedBy` / `confirmedAt` 的手填入口；硬编码 `MANUAL_CLAUDE` 只有旧百分比与日期，不满足 provenance 合同。

### E21 — Codex 兑换卡对象被标量 parser 丢弃

- `rate-limit-detail.ts:127-142` 的 `parseResetCredits` 只接受 null、number、数字字符串；上游对象 `{availableCount, credits}` 必然落到 `known:false`。
- 当前 durable type 只有 `{known,value}`，无法表达 `availableCount`、`credits:null` 与 `credits:[]`，也无法逐卡保存 `expiresAt`。
- 仓库已有 `reset-credit-selector.ts` 对 count/detail/truncation 的安全语义可复用，但页面 store/parser 尚未采用。

### E22 — Codex in-use 账号被跳过

- `codex-accounts-observer.ts:323-335` 对 `inUse !== false` 直接写 `in_use_unshared` / `inventory_unavailable` 后 `continue`，不会发任何额度读取。
- 生产 store 的 active=`personal2`，该行 `observedAt/fiveH/weekly` 全为 null、`note=in_use_unshared`；同轮其余五个账号均有读数。
- 当前 active slot 的 OAuth access token 仍有效。用该 slot 做一次不写盘的 `GET /backend-api/wham/usage` 返回 HTTP 200、`plan_type=prolite`、周窗口 100% 与 reset；证明「凭据在用」不等于「只读 usage 不可读」，缺口来自 observer 主动跳过。

### E23 — personal1 不是继续重试就会变绿的普通错误

- `claude-accounts.json` 的 `personal1.lastObservedAt=2026-09-08T21:33:20.161Z`，仍保留 70% 与已过去的 09/09 reset。
- quota monitor 近期反复记录 `personal1:usage_forbidden`；旧 ledger 的 `runner login_expired` 是 9/07 的旧状态，不是当前失败的完整根因。
- 用当前 pooled credential 做只读 GET：`/api/oauth/usage` 返回 HTTP 403、safe code `oauth_not_allowed_for_organization`；同一 access token 的 `/api/oauth/profile` 返回 HTTP 200、`subscription_status=canceled`、`organization_type=claude_free`。
- 现有 candidate probe 在 usage 非 `ok` 时只产出泛化的 `usage_forbidden`，不读取 profile、不持久化 `profile_canceled`；capacity snapshot 又只投影 `authUnusable` 布尔值，页面只能显示泛化的 `auth_unusable`，并继续带旧读数。

## 3. TDD 与最小改动

### A. Claude 充值卡真实源 + 手填 provenance

1. 先加 RED：prepaid payload 的 `tranches` / `promo_tranches` 分别覆盖 null、空数组、多张、畸形、重复/乱序、`next_expires_at` 不得冒充逐卡等分支；403/401/timeout 不制造卡。
2. 增加页面专用、无秘密的 Claude account-detail observer/store：逐 slot 只调用纯文件读取、无锁无刷新的 `readPoolMonitorCredentialSnapshot`，绝不调用 `readCandidateCredential` / `verifyCandidate`、不拿 accounts lock、不写凭据。若恰逢切号/原子替换而读到缺失、畸形或 digest 变化，本轮记 `credential_unavailable` 并保留上次 observation，不做第二种解释。用 access token 做 profile GET，且只有 organization UUID 通过标准 UUID 格式（`8-4-4-4-12` hex）后才拼入 prepaid URL；输出只持久化 slot、观测时间、subscription 枚举与逐卡到期日，不落 token、digest、org/account id、email 或余额。
3. Claude 单请求最多 5 秒、整轮最多 45 秒，固定 `https://api.anthropic.com` origin、`redirect:"error"`，生产不接受 env origin 覆盖；fetch/base URL 只由测试依赖注入。`?refresh=1` 同时 single-flight 执行 Claude detail observer 与已有 Codex observer，整轮 deadline 到达后其余 slot 明确记 deadline/沿用上次值，不拖住页面；capacity snapshot 合并该 detail store。机器数组 null/empty 均如实保留，绝不用 amount/balance 推断卡。该 observer 每轮重读 profile；store 只是最近一次页面 observation，不是 terminal account state。
4. 增加独立 manual input JSON（生产固定在 Flywheel state dir 内，测试通过显式函数参数注入路径，不读任意 process env），schema 至少包含 `account`、逐卡 `expiresAt`、`confirmedBy`、`confirmedAt`。读取时要求 state dir 内的当前用户所有、非 symlink regular file、无 group/world 写权限，并严格限大小、字段、时区、账号名及拒绝重复；机器有逐卡数据时机器源优先，机器明确空数组时显示无卡，只有机器 unknown/unavailable 时才使用手填项并保留 provenance。
5. 页面 Claude 第五列展示「充值卡」，每张卡一行到期日；无卡、未知、手填来源三种状态不得混为一谈。

### B. Codex 兑换卡对象语义

1. 先加 RED：`availableCount` 是唯一张数来源；`credits.length < availableCount` 显示明细不全；`credits:null` 是张数已知/明细未知；`credits:[]` 是已查且无明细；逐卡 expiry 严格校验并稳定排序；旧标量输入不再误报已知。
2. 将 `CodexResetCreditsDetail` 做 version-1 加法扩展：保留 legacy `known` / `value`（新 writer 也继续写，保证旧版本回滚可读），追加 `availableCount: number | null` + nullable details，复用 reset-credit-selector 已有的安全边界；同步 store validator、capacity projection 与 carry-forward。reader 接受生产现存 `{known,value}` 并逐行归一化，不因一条旧形状把整份 store 作废；安全十进制 legacy value 可归一化为 count，其余变 unknown。JSON store 只接受非负 safe integer，避免持久化 `bigint`。测试覆盖旧形状保留其它字段、新形状 write→read 往返，以及新 writer 输出仍通过 legacy validator，形成无需 host 备份的回滚兼容路径。
3. 页面 Codex 第五列只显示「兑换卡」：按 `availableCount` 报张数，`credits[]` 每张一行到期日；截断时明确「还有 N 张，明细未给全」。本单没有任何 consume RPC 或写动作。

### C. Codex 不抢占只读探测

1. 在 teamlead Codex quota 单元测试先加 RED：`isInUse=true` 时必须调用只读 reader、得到当前窗口；不得启动 isolated app-server、不得调用 refresh persistence、不得改 auth 文件。`unknown` inventory 仍 fail-closed，不发请求。
2. 新增小型只读 reader：
   - active slot 从 `canonicalAuthPath` 读当前 Codex 正在维护的凭据，避免长期 in-use 时 profile slot access token 过期；其它 in-use slot 只能只读各自 slot，若 token 过期则明确降级为 401 note，绝不代替账号 owner 刷新。读取前用 `identifyCodexAuth` 证明 auth 的 account key 与目标 slot/registry 一致，并校验 JWT/account id 与 `ChatGPT-Account-Id` header 一致；任何缺失/不一致 fail-closed 为 `identity_mismatch`。WHAM 响应本身不含 email，因此身份绑定由「已验证 token 身份 + 服务端按 account-id header 授权的响应」完成，不能证明这两点就不投影数据。
   - 只发最多 10 秒的 `GET /backend-api/wham/usage`，固定 HTTPS origin，`redirect: "error"`，携带 Codex 官方同形 headers；测试可注入 fetch/endpoint，但生产不接受任意 env origin。它不调用 refresh endpoint、不写 auth、不创建 candidate workspace、不取得账号 lease。
   - 严格校验 snake_case payload，复用并导出既有 600 分钟边界：`limit_window_seconds / 60 <= 600` 才归 5h，大于则归 weekly；时长缺失/无效不猜测，计入 `unclassifiedWindows`。同时映射 `has_credits`/credits 与 `reset_credit_count`。WHAM 只给兑换张数、不提供逐卡明细时，持久化 `availableCount` 且 `credits:null`，不把明细冒充空数组；若字段未暴露才保留同身份上一轮的 credits/reset inventory。401/403/网络/畸形响应只返回安全枚举。
   - 成功结果必须构造完整 `CodexAccountReading`：`observedAt=nowIso`；`planType` 取受 1–64 字符 token 校验的 `plan_type`（否则 null）；`fiveH/weekly` 为上述窗口；`credits/resetCredits` 始终为完整对象；`unclassifiedWindows` 始终为非负整数；observer 再补 `name/registeredProfile/authHealth/note`。测试必须把成功 reading 写盘并用 `readCodexAccountQuotaStore` 原样读回。
3. `observeCodexAccounts` 仅在 `inUse === true` 时走该 reader；映射表固定为：成功=`authHealth:valid,note:null`；身份不符=`unknown,identity_mismatch`；401=`unknown,readonly_unauthorized`；403=`unknown,readonly_forbidden`；timeout/network/malformed=`unknown,read_failed`。失败沿用同身份上次值，并为新增 note 补齐明确页面文案。`inUse === false` 的既有 app-server+refresh 持久化路径保持不变；inventory `unknown` 保持跳过。同步更新 observer 文件头的不变量：禁止共享 refresh，而不是禁止同凭据的只读 GET。

### D. Claude 取消订阅的探测与呈现

1. 先加 RED：detail observer 的 usage 403 + safe code 时仍读取只读 profile；profile 明确 `canceled` 才持久化 subscription=`canceled`。403 但 profile active/unknown 时不得冒充取消；曾经 canceled 后 profile 恢复 active 必须在下一轮自愈。
2. 页面专用 Claude detail observer 独立解释同轮 usage/profile 结果：profile 明确 `canceled` 才写 detail store 的 subscription observation；它不复用 `classifyAccountLiveness`（该函数会先把 personal1 的 403 分类为 `usage_forbidden:*`），不写 `AccountEntry.unavailable`，不改变 active-account 死亡判定、切号、告警或 candidate selector。证据只保存安全枚举，不保存 response/token。
3. capacity snapshot 只投影受限的 subscription observation；account quota view 将 `canceled` 显示为「已取消」，该行用量/reset 单元格不再展示 9/08 的旧值，但排序键继续按改动前的 quota snapshot 计算。其它失败仍沿用原有错误语义；下一轮 profile active 会覆盖 canceled observation 并恢复正常展示。

## 4. 验证

定向测试先 RED 后 GREEN：

- `packages/teamlead/src/codex-quota/__tests__/codex-accounts-observer.test.ts`
- 新增只读 Codex usage reader 测试（成功、401/403、畸形、timeout、身份/字段缺失、无写盘副作用）
- 新增 Claude account-detail observer/store 测试（prepaid null/empty/multi/truncated-invalid、canceled / active / profile unavailable、manual provenance/precedence、无秘密落盘）
- `packages/teamlead/src/codex-quota/__tests__/rate-limit-detail.test.ts`
- `packages/teamlead/src/codex-quota/__tests__/codex-account-quota-store.test.ts`
- `packages/teamlead/src/bridge/__tests__/capacity-snapshot.test.ts`
- `packages/teamlead/src/bridge/__tests__/account-quota-view.test.ts`

按 implement 节点合同运行：`pnpm lint`；`pnpm --filter "flywheel-teamlead..." build`；若类型/API 变化则 `pnpm --filter "...flywheel-teamlead" typecheck`；对所有 changed TS 运行 owning package 的 `vitest related <files> --run`，并运行消费者搜索保留下来的直接测试。不会跑本地全包 suite。

真机只读验收（不切号、不登录/登出、不写凭据）：

- 用修后的 Codex reader 读取当前 in-use slot，记录 safe JSON：HTTP/结果枚举、plan、窗口百分比与 reset；前后记录 auth 文件 SHA-256/mtime 不变。
- 用修后的 Claude probe 读取 `personal1`，记录 usage=`forbidden:oauth_not_allowed_for_organization` + profile=`canceled` + 页面 view=`已取消`；前后记录 pooled credential SHA-256/mtime 不变。
- 用修后的 Claude prepaid reader 逐号记录 safe shape（null/empty/403/若有卡则到期列表）；没有非空真机样本时不伪造成功，使用 contract tests 证明多张逐行，并在 PR 如实披露真机边界。
- 用修后的 Codex reader 记录 active 号的 `availableCount` 与卡到期明细；若服务端只给 count/null 或截断，页面和证据必须如实显示 unknown/truncated，不兑换卡。
- 增加 canonical auth 与目标 slot 身份不一致的负向测试；模拟 active canonical token 比 slot token 更新，证明 reader 选 canonical；模拟非 active in-use slot 401，证明只显示 `readonly_unauthorized`、不刷新/写盘。
- Codex store 加 legacy fixture 迁移、new writer→new reader 往返、new writer→legacy validator 回滚兼容测试；Claude observer 加半写/替换凭据、per-request timeout、整轮 deadline、redirect 与非固定 origin 拒绝测试；WHAM parser 加 600 分钟边界与 app-server parser 的跨源一致性测试。

## 5. 交付与门禁

实现完成后只做 targeted local verification，提交并推送当前分支；按注入流程请求 effective code review，处理 blocker 后重新评审；创建 PR，最后一个 commit 仅新增 `engineering/doc/milestones/FLY-2807.md`。implement 节点不请求 full CI、不派 QA、不 merge；完成回执明确把 legacy store 读回、new→legacy 回滚兼容和两处真机只读证据列为下游 QA 的 frozen-head 验收项，由 DAG orchestrator 推进。
