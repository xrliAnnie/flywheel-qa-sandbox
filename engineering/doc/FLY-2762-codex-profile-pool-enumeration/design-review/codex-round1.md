# Design Review — plan.md (Round 1)

Date: 2026-09-22  
Author: Codex  
Status: CHANGES REQUESTED

## Summary

方向正确：以目录为账号池唯一真相、把 registry 收缩为 primary 策略、复用 Bridge 唯一的安全探测链，并用现有总闸控制自动切号，整体没有不必要的新状态机。

但当前计划尚有 8 个会改变实现结果的缺口。其中几个会让承诺的正向路径直接失败（空槽 `save`、热插入后的 recovery），几个会在生产自动切号开启时造成错误的持久化判断或凭据风险（旧 pool-exhausted 证据、重复 email 探测、`account-*` 审计拒绝）。本轮不能批准。

## What's Good (Keep)

- 保留“目录名 = profile 名、auth.json = 身份、v2 registry = 策略”的单一真相，消除了今天两份账号清单漂移的根因。
- 核心枚举对根目录读失败 fail closed，拒绝 symlink，并把 `not_logged_in`、`invalid_credential`、`invalid_name` 分开；这比把读失败误当空池安全。
- 重复 email 两边都排除，而不是按目录顺序静默选一个；这是正确的身份冲突策略。
- CLI 不另起 app-server，而是读取 Bridge 快照并通过 loopback 请求同一单飞刷新函数，保留了在用检测、账号租约和 refresh-token 持久化的唯一实现。
- 删除旧 loader 来强迫消费者迁移、每个 runtime operation 使用同一 pool snapshot、所有测试使用 `mkdtemp` 的意图都应保留。
- 已明确自动切号会立即扩到新账号，并保留 `codex_quota_auto_switch` kill switch；部署前检查旧 accountKey 的 pending receipt 也是必要的。
- 回滚不要求 SQLite migration，且新 note 值对旧页面降级显示；兼容方向合理。

## Issues & Recommendations

1. **`save <not_logged_in-slot>` 按计划无法通过现有前置识别流程，且 accountKey 迁移没有并发 fencing。**

   **Issue:** 计划一方面要求 `expectedProfile` 只接受 `pool.profiles`，另一方面允许保存到只存在目录、没有 auth.json 的槽（plan.md:95-104）。但这类槽必然不在 `profiles`，只在 `slots/problems`。现有 `withManualCredentialLocks` 在进入 `save()` 前先调用 `expectedProfile`，再用目标名字执行 `verifiedAuth`（packages/claude-runner/bin/flywheel-codex-profile.mjs:31-50,196-216）。对空槽而言，home 凭据在旧 pool 下只能被识别成 `account-<slug>`，不可能先被识别成 `newslot`。

   **Why:** 按当前文字实现，验收中的 `save newslot` 会先报 unknown/not_logged_in；若只绕过 `expectedProfile`，`verifiedAuth(..., "newslot", oldPool)` 仍会 identity mismatch。并且写入目录后身份从 `account-*` 变成目录名，`codexInstallAccountKey` 也随之变化；只锁旧 key 会让并发 observer 在新 key 下绕过租约。

   **Fix:** 为 `save` 单独定义 target resolution：目标必须是一个真实、非 symlink 的 `ready` 或 `not_logged_in` slot；其它 problem 拒绝。对空槽先离线解析 home email/accountId，确认该 email 不属于任何其它 ready slot，再计算旧身份 key 与写入后的目标身份 key，以稳定顺序同时持有两把 account lease（相同则一把）和 home install lock；原子写入后重新 `loadCodexAccountPool`，验证目标已成为唯一 ready profile，最后才记 ledger。测试除成功/重复 email 外，加一个 observer/lease 并发阴性用例。

2. **CLI 要求的“同名且同 email”快照关联目前没有可用字段，页面也会按槽名继承换号前的旧读数。**

   **Issue:** 计划要求 CLI 仅在快照 `name + email` 都匹配时使用 token/额度读数（plan.md:106-119），但 durable store 明确保证“不落 email”，`CodexAccountReading` 也没有 email（packages/teamlead/src/codex-quota/codex-account-quota-store.ts:1-7,40-55,121-139）。现有测试还断言快照/容量投影不含邮箱（codex-accounts-observer.test.ts:171-177；capacity-snapshot.test.ts:131-143）。observer 的 `carried()` 和 `previousByName` 仅按 slot name 继承旧 plan/quota（codex-accounts-observer.ts:95-115,267-271），所以同一目录重新登录后，页面也可能把旧账号读数挂到新账号上。

   **Why:** CLI 合同不可实现；如果为方便直接把 email 写进快照，又会破坏现有非 PII 持久化边界及 API 输出保证。只修 CLI、不修 carried 逻辑，账号页仍会张冠李戴。

   **Fix:** 在 v1 reading 中增加可选、非 PII 的稳定 `identityKey`（可复用 observer 已算出的 SHA-256 account key，见 codex-accounts-observer.ts:302 与 codex-account-install.mjs:316-318），CLI 对当前目录凭据计算同一键并按 `name + identityKey` 关联。旧快照缺该字段时显示“未探”；旧 reader 忽略新增字段。observer 只在 identityKey 相同的情况下 carry 旧读数，`not_logged_in`/`invalid_credential` 或身份变化必须清空旧额度。增加 v1 upgrade/rollback、换号不继承、快照不含 email 的测试。

3. **observer 对 problem slots 的策略不完整；重复 email 槽若继续探测，可能伤害 refresh-token 链。**

   **Issue:** Chunk F 只规定 `not_logged_in` 出行、`invalid_name` 不出行，没有定义 `invalid_credential` 与 `duplicate_email`（plan.md:162-167）。当前坏 auth.json 会保留一行 `missing/read_failed`，且已有测试依赖（codex-accounts-observer.ts:284-300；codex-accounts-observer.test.ts:133-177）。更严重的是，`enumerateCodexProfileSlots` 本身不知道跨槽重复 email；两个重复目录都会是 ready。若 observer 仍逐目录探测，同一 credential 会被启动两次 app-server：第一份可能轮换 token 并只写回一个目录，第二份再使用旧 token。

   **Why:** 坏凭据目录可能从页面消失或被误标成“未登录”；重复凭据探测违反本方案强调的 refresh-token 单写者安全模型，并可能把本来还能用的链变成 reused/revoked。

   **Fix:** 每轮页面刷新也应先取得一次完整 `loadCodexAccountPool` snapshot，而不是只消费裸枚举结果。只 probe `pool.profiles` 中的唯一 ready 槽；`not_logged_in`、`invalid_credential`、`duplicate_email` 都输出非探测 problem row，`invalid_name` 跳过。明确每个 problem 到统一 token 文案/note/红色样式的映射，尤其不能把坏 JSON 静默归成“未登录”。补坏 JSON、auth.json 非普通文件、重复 email 不启动 probe 的测试。

4. **“每个入口取一次 pool”尚未贯穿 coordinator、host inventory 和 recovery，热插入后可能选中账号却无法恢复 run。**

   **Issue:** 当前 `observe()` 只返回 observations，而 selection 在 coordinator 内另行发生（runtime.ts:134-255；coordinator.ts:193-213），计划没有定义 pool snapshot 如何随这轮观测传到 selector/rotate。更明确的遗漏是 `createCodexQuotaRunRecovery`：plugin 目前把启动时固定的 identity reader 传进去（plugin.ts:8633-8641），`canRecover` 随后要求该 reader 的 profile 与已提交 root 相等（run-recovery.ts:167-193）。仅把 `CodexQuotaRuntime.registry` 改成 getter不会更新 recovery。

   **Why:** Bridge 启动后新建 `shopping`，第二轮 observe 可以看见并切入它，但 recovery 仍可能把 canonical 识别为 `account-*`，于是 `canRecover` 永远 false，已暂停的 run 不能恢复。同一 observe 内多次 getter 还会产生“前半轮旧池、后半轮新池”的混合证据。

   **Fix:** 定义显式 round 对象（例如 `{ pool, poolNames, observations }`）：入口开头只加载一次，observer、selector、rotate、notification 全部消费它。host readiness/credentialIdentity 在一次 inventory 内也复用同一 pool。`createCodexQuotaRunRecovery` 改收 pool getter，并在每次 `canRecover/recover` 开头取一次、调用内复用。测试覆盖：factory 创建后热插入账号，observe→rotate→commit→canRecover/recover 全链成功；同一轮中途目录变化不影响当前轮，只在下一轮生效。

5. **持久化 `pool_exhausted` 证据不能从 observation 名单反推 pool；空池还会被 vacuous `every()` 判为全池打满。**

   **Issue:** plan.md:143-145 要求持久层两个 replay caller 从 observations 自带的 profile 集合推出 pool。这样既丢失“pool 成员缺观测时不得判全满”的信息，也无法识别 pool 后续热插入。当前 selector 的 `pool.every(...)` 与 recovery `Math.min(...)`（candidate-selector.ts:130-147）在 `pool=[]` 时会得到 `pool_exhausted + Infinity`，随后 store 对 Infinity 调 `toISOString()`（codex-quota-store.ts:1416-1449）。`hasCurrentCapacityGuard` 又只重放 observation_json（codex-quota-store.ts:1464-1481）。

   **Why:** 升级前持久化的“三号全满”事实可能在新增三个可用号后继续挡住 admission；缺失账号被 observation 推导彻底抹掉；全是未登录/坏凭据/重复 email 的合法空池会走错误分支甚至抛 RangeError。

   **Fix:** selector 明确校验 pool 为合法、唯一、非空；空池返回 `no_usable_credentials`，不得生成 exhausted fact。新 capacity evidence 必须持久化 `{ pool, observations }`（可在现有 JSON blob 中版本化，无需 SQLite schema migration），`recordPoolExhausted` 和 `hasCurrentCapacityGuard` 都用保存的 pool 重放，并将其与当前 pool 比较；当前 pool 变化时旧 fact 不再是 current guard，必须重新 observe。legacy array row 可按旧三号解释，但一旦当前 pool 集合不同就失效。测试覆盖空池、六号只五号打满、旧三号 fact 后热插入 `shopping`。

6. **`account-*` 只在 `reconcileExternalRoot` 放行不够，自动切号会在审计/通知阶段失败。**

   **Issue:** 计划保留无目录身份的 `account-<slug>`，并仅为 `reconcileExternalRoot` 选用允许该前缀的 regex；但又要求 `recordSwitchAudit`、outbox、switch-notification 使用排除 `account-*` 的 `isCodexProfileName`（plan.md:25,69-70,146-148）。`recordInstalling` 会把当前 root profile 作为 audit `from`（codex-quota-store.ts:397-407），runtime 也把它写进通知快照（runtime.ts:274-293）。

   **Why:** canonical 当前是一个没有目录的合法 FLY-2750 身份时，从 `account-*` 切到 `shopping` 会在已持久化候选凭据之后被 audit validation 拒绝，安装降级成 uncertain；即使绕过，通知解析和 outbox fallback 仍把真实源账号降为 unknown。

   **Fix:** 明确区分 slot name 与 identity label。目标槽、pool membership 用 `isCodexProfileName`；root/audit `from`、通知 snapshot `from`、outbox source 使用允许保留前缀的安全 identity-name validator（原始 `CODEX_PROFILE_NAME` 或命名更清晰的函数）。`to` 仍需 pool membership。增加 `account-* -> shopping` 的 install journal、switch audit、通知与 recovery 全链测试。

7. **refresh route 与 CLI 的失败/JSON/path 合同还不闭合。**

   **Issue:** `tokenAuthMiddleware(undefined)` 会直接放行（plugin.ts:1360-1366）；现有敏感路由是 `if (config.apiToken)` 才挂载、否则显式 503（plugin.ts:1946-1955,2023-2034）。计划只写 middleware，且测试“无 token 401”没有区分“服务端未配置 token”。此外当前单飞函数是 `Promise<void>`（plugin.ts:8693-8724），计划却要求 route 返回刚写入的 metadata。CLI 也没有定义快照路径从何而来：现有 parser/wrapper 只有 home/profiles/ledger/registry（flywheel-codex-profile.mjs:75-109；bin/flywheel-codex-profile:19-29）。最后，`--refresh --json` 若按计划在 stdout 首行打印 `REFRESH FAILED`，会破坏 JSON。

   **Why:** 未配置服务 token 时会暴露主动探针入口；route 可能在完成后另读文件形成竞态；不同安装 shim 可能读取不同 state root；机器调用无法解析失败时的 stdout。

   **Fix:** 把 POST route 放进现有 `if (config.apiToken)` 分支：配置 token 但请求缺/错 token = 401；服务未配置 token = 503 且不调用 refresh。让单飞 promise 原子写完后直接返回 `{ generatedAt, accountCount }`，并为并发 POST 断言只执行一次。CLI 增加显式 `--snapshot`（由 private/global shim 从同一 state root 固定传入）或规定从已显式传入的 state root 推导，不能猜 ambient home。human 模式失败 banner 写 stderr；JSON 模式 stdout 始终是单个 JSON object，内含 refresh outcome，退出码仍为 3。补 success body、固定 503 body不泄露路径、并发 single-flight、`--refresh --json` 测试。

8. **消费者/type/deploy sweep 尚未闭包，且一条测试期望与现有 public status 不符。**

   **Issue:** 删除/重命名 `CodexAccountRegistry` 后，不只 core `.d.mts` 要改：`codex-account-install.d.mts:1-4,44-49,91-123`、teamlead runtime/probe/observer、claude-runner re-export 都直接引用旧类型。Chunk C 未列 install `.d.mts`。新的 ledger/identity APIs 又需要 `profilesRoot`，但现有 ledger tests 大量只传 `ledgerRoot`（codex-account-ledger.test.ts:85-236）；若实现给它一个 ambient 默认值，测试/工具就可能误读真实目录，违反本计划边界。另一个事实错误是“池外 install 仍 `invalid_profile`”：当前 `installCodexQuotaCredential` 抛出的 `invalid_profile` 被 blanket catch 转成 `install_uncertain`，public union 也没有 `invalid_profile`（codex-account-install.mjs:329-345,441-446；codex-account-install.d.mts:32-40）。最后，installer 的 stage/self-check 只在 `release_dir` 不存在时执行（scripts/install-codex-guard.sh:108-145）；若只把 policy 校验放进该分支，预先存在的同 hash 坏 release 仍会被 current symlink 选中。

   **Why:** 按计划逐 chunk 实现会在 typecheck 或测试阶段断裂；更坏的是为省事引入真实 home fallback；错误 status 断言会促使无意的 API 扩张；installer 的“坏 registry 不发布”保证存在绕过路径。

   **Fix:** 在计划中列出完整类型传播：core `.d.mts`、install `.d.mts`、claude-runner identity/ledger/index re-export、teamlead runtime/probe/observer 及其测试。`profilesRoot` 必须显式传入且运行时缺失即失败，所有测试补 mkdtemp pool。池外 install 要么保持现有 `install_uncertain` 并改测试文字，要么明确扩展 public result union/callers，不能写成不存在的 status。installer 应在计算/选择 release 前无条件校验 source policy，并在切 current 前无条件校验 selected release；增加“已存在同 hash 坏 release”用例。

## Advisory

- Chunk F 的状态表有 8 个互斥值，但验收写“六号 + 一个未登录目录 = 七行，每种状态各一行”（plan.md:171-187），数学上无法同时成立。拆成 8 状态参数化单测，再单独保留“六 ready + 一未登录 = 七行”集成测试。
- profile 正则禁止 `<`，而页面也会拒绝非法 account name；因此“名字含 `<`”不是可达的 XSS 用例。用允许自由文本的 `planType` 或 note 做 hostile input，再断言 HTML escaping。
- `reset-credit-selector` 不只要删除常量，还要把 `CodexQuotaProfile` 联合、三号/三个账号文案及 `profile_order` 说明改成动态集合/字典序语义（reset-credit-selector.ts:1-3,92-105,182-209）。
- `quota-reader`/exploration/research 对 expired 错误码不一致：exploration 包含 `token_expired`，当前正则和 research 只覆盖 `refresh_token_expired`。统一码表，并测试同一错误文本含多个码时 revoked/expired/invalid 的确定优先级。
- `git show <base>` 阴性对照未定义稳定 base，也要求旧 CLI/core/install/registry 的完整依赖闭包。若保留为 CI 测试，固定不可变 commit SHA并在 mkdtemp 中物化完整旧 release；否则把 exploration 的实测作为历史证据，避免测试依赖分支拓扑。

## Verdict

**CHANGES REQUESTED**

在重新评审前，计划至少需要补齐：空槽 save 的双身份/双租约流程、非 PII 快照身份键、problem slot 不探测策略、跨 runtime/recovery 的单轮 pool snapshot、带 pool 的持久化 capacity evidence、`account-*` 的身份边界、refresh 的 auth/JSON/path 合同，以及完整的类型与 installer 发布闭包。
