# Design Review — plan.md (Round 2)

Date: 2026-09-22  
Author: Codex  
Status: CHANGES REQUESTED

## Summary

本轮只核验了 Round 1 的 8 项处置及其直接引入的回归，并将结论绑定到 commit `d5171e85a5b8db4976dd20744c6c3d33f9c3edce`。

更新解决了大部分架构缺口：取消空槽 `save`、observer 单轮加载完整 pool 且不探 problem slots、runtime/coordinator/recovery 显式传递 pool snapshot、空池不再被判全满、refresh 路由的鉴权与返回合同、mandatory `profilesRoot`、`install_uncertain` 兼容，以及 installer 两次无条件策略校验，方向都正确。

但 8 项尚未全部闭环。仍有 6 个会改变实现结果的阻断点：ready-slot `save` 仍只按 email 而非 account identity fencing；CLI parser 与 private shim 没有完成 `identityKey` 快照链；持久化 capacity fact 既不绑定当前账号身份，也没有定义 pool 变化后的立即重探；identity-label validator 覆盖不了现有 `account-*` 生成域；删除旧 loader 后的测试/fixture 迁移不在验证闭环内。因此本轮仍不能批准。

Round 1 disposition 核验：

| R1 项 | 结论 |
|---|---|
| 1. 空槽 `save` | 部分解决：空槽路径已删除；ready-slot 的“同一身份”与租约合同仍不完整 |
| 2. 非 PII 快照身份 | 部分解决：`identityKey` 与 same-key carry 正确；CLI parser 仍写成 `email` |
| 3. problem slots | 已解决 |
| 4. 单轮 pool 传播 | 已解决；实现时需确保 `recover()` 内层复用同一 snapshot |
| 5. capacity evidence / 空池 | 部分解决：空池与 v2/legacy 格式已覆盖；current-identity 与重探闭环未解决 |
| 6. `account-*` 边界 | 部分解决：from/to 语义已分开；validator 与派生标签域不一致 |
| 7. refresh / JSON / path | 部分解决：route 与输出合同已解决；private shim 和 parser 未闭环 |
| 8. type / deploy sweep | 部分解决：生产类型、mandatory root、status、installer 已解决；现有测试/fixture sweep 未闭环 |

## What's Good (Keep)

- 保留“目录 = pool、auth.json = 身份、v2 registry = primary 策略”的单一真相，以及 duplicate email fail closed。
- 删除空槽 `save` 是正确的减法；新号直接在目标 `CODEX_HOME` 登录，避免双 identity/accountKey 的并发协议。
- observer 每轮只加载一次完整 pool，只 probe `pool.profiles`；`not_logged_in`、`invalid_credential`、`duplicate_email` 各自输出非探测行，`invalid_name` 跳过。该处同时保护了 refresh-token 单写者模型。
- `identityKey = codexInstallAccountKey(identity)` 延续非 PII 快照边界；旧 reader 忽略新增字段、旧快照降级为“未探”、换号不 carry，兼容策略合理。
- `observe()` 返回 `{pool, observations}`，coordinator 将同一 round 交给 selector/rotate/notification，recovery 改收 pool getter，消除了启动时冻结 registry 的主要问题。
- selector 拒绝空 pool 并返回 `no_usable_credentials`，避免 `every([])` 与 `Infinity.toISOString()`；legacy array 有唯一、可审计的三号常量。
- slot name 与 identity label 的使用位置已经正确区分：目标/池成员严格，root/audit/notification/outbox source 可接受派生身份。
- refresh 路由放在 `apiToken` 分支、未配置时 503 且不调用刷新；单飞写完后直接返回 metadata；human stderr、JSON 单对象、exit 3 的 CLI 合同完整。
- `profilesRoot` 无 ambient fallback、池外 install 保持现有 `install_uncertain`、installer 在 hash 前和切换 current 前各校验一次，这三项均已按现有代码事实收口。
- Round 1 的 5 条 advisory 已实质采纳：10 状态单测与 7 行集成测试分开、XSS 改用自由文本、reset-credit 文案/类型动态化、错误码优先级固定、旧版阴性对照退出 CI 拓扑依赖。

## Issues & Recommendations

1. **Issue: ready-slot `save` 仍按“同 email/同 profile 名”判断，不等于用户总结中的“同 identity”。**

   **Why:** plan.md:110 仍写“已有凭据且同 email”；而账号身份包含 `accountId`，实际并发租约键优先使用 `accountId`：`codexInstallAccountKey(identity) = SHA256(profile + accountId/email)`（`packages/claude-runner/bin/codex-account-install.mjs:316-318`）。当前 `save` 前置只从 home auth 算 key 并持有该 lease（`flywheel-codex-profile.mjs:31-50`），写目标前没有读取并复核目标槽 identity（`:368-381`）。若 home 与目标槽 email 相同但 accountId 不同，两者会得到不同 key；按计划的 email 检查会在只锁 home key 时覆盖另一个账号的 ready 槽，observer/live process 仍可能持有目标 key。

   **Fix:** 将合同改成“home 与目标槽的 `codexInstallAccountKey` 必须完全相同”，而不是只比 email/profile。先读取双方并确认 key 相同，持有该唯一 lease 后在写入前重读双方、再次断言 key 未变，再原子写；补“同 email、不同 accountId 必须拒绝且目标字节不变”的测试。

2. **Issue: CLI 的 `identityKey` 解析合同自相矛盾。**

   **Why:** plan.md:117-119 明确要求按 `name + identityKey` 关联且快照绝不落 email，但 plan.md:130-131 的宽容 parser 字段仍列 `email`、没有 `identityKey`，并规定字段形状不对即“未探”。durable store 的既有合同明确不保存 email（`codex-account-quota-store.ts:1-7,40-55`）。照字面实现会要求一个被禁止写入的字段，使新快照读数全部降级。旧 reader 不做 exact-key 校验（`:121-139`），所以新增 key 的向后兼容本身没有问题。

   **Fix:** 将 parser 字段清单中的 `email` 改为 `identityKey`；明确 ready row 的 key 为可选 64 位小写 SHA-256 hex，缺失/不匹配只令该行“未探”，problem row 可无 key。正向测试必须证明同名同 key 的额度会显示，而不只测试 mismatch。

3. **Issue: `--snapshot` 只接到全局 shim，漏掉 repo 内实际使用的 runner-private launcher。**

   **Why:** plan.md:120-121、233 只要求全局 shim 传参。`packages/claude-runner/bin/flywheel-codex-profile:19-29` 是另一个真实入口，已经从 `FLYWHEEL_STATE_DIR` 推导 ledger，却未传 snapshot；`codex-shim.test.ts` 也直接通过该入口运行 CLI。按当前计划实现，repo/QA 入口即使刷新成功、临时 state dir 中已有有效快照，仍固定显示“未配置快照路径”。这正是 R1-7 要消除的路径分叉。

   **Fix:** Chunk B/G 明确同时修改 private 与 global shim。private shim 传 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/codex-quota/codex-accounts.json`；global shim 继续固定 `$HOME/.flywheel/...`。通过现有 `PROFILE_BIN` 加一条正向测试：仅设置临时 `FLYWHEEL_STATE_DIR` 即能读取同 identityKey 快照，`list --refresh` 完成后也读取同一路径。

4. **Issue: v2 capacity fact 只比较 profile 名，且“pool 已变化 → 必须重探”没有接入 coordinator 的重试时序。**

   **Why:** plan.md:161-167 持久化 `{v:2,pool:[name],observations}`，当前 provider 也只返回 `currentCodexPoolNames`。已有 observations 带 `accountKey`，但同名槽从已打满账号 A 重新登录为账号 B 时，name set 不变，旧 A 的全满事实仍被视为 current。反过来，成员删除/失效或 provider 抛错的安全语义也未定义。更直接的是，计划虽然说 pool 不同后“必须重新 observe”，现有 coordinator 会在未来的 `next_attempt_at` 前直接 continue（`coordinator.ts:138-142`）；`hasCurrentCapacityGuard` 变 false 本身不会触发 tick 重探，而 incident 的 pause 仍存在。新增可用号可能因此一直等到旧账号的 5h/周 reset，无法热插入。

   **Fix:** capacity evidence 与 current provider 都应使用排序后的 `{profile, accountKey}`（或等价 identityKey）成员，而不只是名字。当前出现旧事实未覆盖的新/替换身份时，使旧 fact stale，并让 coordinator 对 `pool_exhausted` 绕过旧 `next_attempt_at`、立即 observe；removal-only 时用旧 observations 中仍属于当前成员的子集重放，不能因集合不等就解锁。provider 抛错/返回非法值必须按 unknown fail closed，不能把 safety guard 清掉。测试至少覆盖：reset 前热插入账号会立即 observe/select、同名换号会使旧 fact stale、删除成员不解锁、provider 抛错不 fail-open。

5. **Issue: `isCodexIdentityLabel` 仍不能覆盖 `identifyCodexAuth` 的完整输出域。**

   **Why:** plan.md:30-43 把 identity label 定义为同一个最多 32 字符的 `CODEX_PROFILE_NAME` regex，只放开 `account-` 前缀；但当前 `unregisteredProfileName` 对 email local part 不截断，直接返回 `account-${slug}`（`codex-account-core.mjs:199-203`）。合法池外账号的 local part 稍长就会生成超过 32 字符的派生身份，随后仍被 reconcile/audit/notification/outbox 边界拒绝。现有短 `account-* -> shopping` 测试无法发现它。

   **Fix:** 让生成器与 validator 共享一个明确、有界且稳定的合同。优先为长 local part 使用确定性截断 + hash 后缀，同时写清现有长标签/accountKey 的兼容或迁移策略；或者定义一个安全的 identity-label 上限并证明它覆盖生成器全部输出。增加长 local-part 的全链测试，不只测短 `account-owner`。

6. **Issue: R1-8 的 consumer/type sweep 仍没有覆盖会在 CI 失败的既有测试与 v1 fixtures。**

   **Why:** plan.md:79 删除 `loadCodexAccountRegistry`，`:81-83` 又让 identity/ledger API 强制接收 `profilesRoot`；但 `:85-88` 的清单只列生产声明/再导出和笼统的“它们的测试”，验收只写每 chunk `pnpm -r typecheck`。`packages/claude-runner/tsconfig.json:8-9` 明确排除 `*.test.ts`，所以 typecheck 捕不到 `codex-account-identity.test.ts:5-10,74-150` 继续导入旧 loader/使用 v1 registry，也捕不到 `codex-account-ledger.test.ts:85-90,131-152` 等调用缺少 mandatory `profilesRoot`。现有 install/profile-refresh/home/Tmux 测试也仍有 v1 registry fixtures；若计划不列迁移和执行相关 Vitest，按 chunk 完成后仍可能留下红 CI。

   **Fix:** 在 Chunk A/C/D 明列旧 identity、ledger、install、profile-refresh、codex-home、CodexTmuxAdapter 等 fixtures 全部迁为 `mkdtemp` profiles + v2 policy，并补上所有 mandatory `profilesRoot`。验收除 `pnpm -r typecheck` 外，至少执行 claude-runner 与 teamlead 的相关 Vitest（或完整 package test），再用 `rg` 断言已删除 loader 与 v1 registry fixture 不再残留在本 issue 的 Codex 测试中。

## Advisory

- `recover()` 当前会在一次调用的多个内层 callback 中反复调用 `canRecover`（`run-recovery.ts:295-331,458-480`）。计划文字已经要求整次调用只加载一次 pool，实施时建议抽出 `canRecoverWithPool` 并用 getter 调用次数/中途目录变化测试锁定该语义。
- plan.md:111 的空槽登录提示硬编码 `~/.codex/profiles/<name>`。CLI 支持显式 `--profiles`，QA 使用临时根时该提示会指向真实目录；建议从 `context.profiles` 生成并做 shell-safe 展示。
- `identityKey` reader 应显式验证 64 位小写 hex；problem row 没有 identity 时允许缺省。该项可与 Issue 2 的 parser 测试一起完成。

## Verdict

**CHANGES REQUESTED**

第 3、4 项主体与第 7、8 项的大部分已收口，但第 1、2、5、6、7、8 项仍有上述直接影响安全或功能的缺口。修正后无需重开架构讨论；下一轮只需验证这 6 个窄 delta。
