# FLY-2393 项目 beta 分频 — 实施计划
Issue: FLY-2393 (https://linear.app/geoforge3d/issue/FLY-2393/1143b6-bridge-按项目分频独立泳道只阻塞-3每项目-beta-分频目标态不阻塞-flywheel-only-每周-release)
日期: 2026-09-10
基于: research.md

> 状态：待有效 design review。本文件是设计，不是已实施或真实发布验收证明。
> 一句话：Bridge 按各项目自己的时钟触发内部 beta 发布，复用各仓工作流；客户每周 release 保持独立。

## 1. 范围、两态与 Lead 裁定

PRD §3.2 的产品基线为「此前全 6h」。代码审计已找到 flywheel 的 Actions 6h cron，未找到 Bridge beta 调度器或 GeoForge3D beta 发布入口；不能把产品基线写成实测每项目均已发版。

| 状态 | 有效节奏 | 激活条件 |
|---|---|---|
| 未接管 | 原入口仍每 6h；Bridge 不发新定时任务 | 兼容现状，不把默认值偷偷改为 24h |
| 已接管 | 每项目配置；省略频率默认 24h，flywheel 显式 6h，GeoForge3D 24h | 真实内部 beta workflow 已绑定、旧入口排空并停用、控制值为 bridge |
| 缺入口 / 配置错误 / 状态未知 | 该项目不激活或暂停新任务，并展示原因 | 不默认为成功，不借生产部署顶替 |

2026-09-10 Lead 对问题 `2ecaa2f2-3aa4-46f4-9e5e-ae3dd321585b` 同意 Bridge 到期 → 显式 workflow dispatch、接管停旧 6h cron、flywheel publisher 只服务 flywheel；对 `a51e5c7e-57e4-433e-aeb9-6156fc7b61bd` 裁定 Geo 真实 beta workflow 为激活前置，缺则该泳道不激活并在状态页明示，模拟测试不能写成双项目上线。这是范围裁定，不代替最终 design review。

B6 不加入 B0→B1/B2→B3→B5→B4 的依赖链，不改客户 release 的频率、manifest、判据或授权，不发 npm/R2、不操作 updater、不改真实项目配置、不部署。合入与部署分离，独立 updater 在自己的窗口部署。当前设计节点不编写实现代码、不派后继节点。

## 2. 配置和稳定身份

复用 `ProjectEntry.projectName/projectRoot/projectRepo`。当前身份为 `flywheel`、`geoforge3d`；Flavio 是 PRD 展示名，不作为键。频率只存在每项目 canonical root 的 `.flywheel/config.yaml`，不存频率的 env override、不写 projectName→频率硬编码映射、不复制到 roster 或 feature flag store。

新增可选 `beta_release` 字段，由 `packages/config/src/beta-release-config.ts`（新增）定义类型、常量和纯校验，`types.ts` 导出、`ConfigLoader.ts` 调用相同校验。样例（不是本次生产配置变更）：

```yaml
beta_release:
  interval_hours: 6
  workflow_file: payload-beta-release.yml
  token_env: FLYWHEEL_BETA_ACTIONS_TOKEN
```

- `beta_release` 整段缺失 = unconfigured，不 dispatch；存在但省略 interval_hours = 24。`interval_hours` 必须为 1–168 的安全整数；null、字符串、浮点、0、负数、NaN/Infinity、未知键全部拒绝。数值范围是本计划工程边界。
- `workflow_file` 可缺失，此时显示 unconfigured；存在时必须是单个安全 `.yml/.yaml` basename，不允许路径、URL、`..`、首字符 `-`；不接受任意命令或动态 inputs。
- `token_env` 只存环境变量名，匹配 `^[A-Z][A-Z0-9_]{0,127}$`，不存 token 值；省略或值不存在时该 lane credential_missing。只允许该项目明确绑定的变量，不回退到 GH_TOKEN/GITHUB_TOKEN/ship token。不同项目不能绑定同变量或相同 token 值；只在内存比较、拒绝后不输出内容。每份凭据在 GitHub 侧仅授权它的目标仓，A 凭据 dispatch B 必须被平台拒绝；验收实际受限权限，不仅 mock。频率禁止 env override 不禁止按名读取凭据。
- repo 唯一真相仍是 `projectRepo`，校验 `owner/repo` 并用 GitHub metadata 解析稳定 numeric repository ID，必须与存量 lane 的绑定一致；不从用户 issue 文本、git 工作目录或展示名推断 repo。ref 固定目标仓默认分支；Flywheel 既有 main-only guard 保留。
- 首次接入保存 `{projectName, repositoryId, canonicalRepo, workflowId, defaultBranch}` 绑定。项目重命名、repo/工作流重绑需要 paused + 全部在途排空 + 显式重新接入，绝不复用旧游标。目录变化仍必须由 roster 提供并验证 canonical path。
- 每 tick 重新核对文件 revision，错误只隔离该项目，不回退成默认或沿用旧频率继续发；项目 A 错误不阻塞 B。读取同一文件的 ConfigLoader / 管理台必须有缺省与错误一致性测试。

## 3. 调度所有权：唯一控制值与接管

目标仓库 GitHub Actions 变量 `FW_BETA_SCHEDULER_OWNER` 为唯一控制真相，值 `legacy | paused | bridge`，缺省按 legacy 兼容。YAML 不另存 enabled/mode；DB 中 owner 仅为带 observedAt 的观测值，不是授权。变量只能由既有仓库设置授权者修改；Bridge 只读取它。使用独立、受限目标仓库的 Actions write + Variables read + metadata/contents read 凭据，不能借用 ship/merge token、customer-release token、Cloudflare 或 npm 凭据。

`.github/workflows/payload-beta-release.yml` 保留 6h schedule 声明用于 legacy；改为无发布锁的 preflight job，先验证事件与 owner；只有 eligible=true 的 publish job 才进入共享锁并构建：

| 来源 | legacy | paused | bridge |
|---|---|---|---|
| 原 schedule | 正常 6h | no-op | no-op（旧定时器逻辑停用） |
| Bridge 输入组 | 拒绝 | 拒绝 | 完整合法组才执行 |
| 原人工 dispatch（无 Bridge 输入） | 保留原 main-only 行为 | 拒绝 | 保留原人工路径，仍受共同发布锁约束 |
| 缺/错 owner 读取、非法值、半组输入 | 缺变量=legacy；其他读取错误拒绝 | 拒绝 | 拒绝 |

### 3.1 发布队列不挤掉客户任务（作者自审补强，须新一轮评审）

当前四个消费者均为 workflow-level `concurrency.group: payload-release`：`payload-beta-release.yml`、`payload-promote.yml`、`payload-promote-commit.yml`、`payload-activation.yml`。GitHub 默认 single pending 会取消旧等待任务，包括客户任务；`cancel-in-progress:false` 只保护正在运行者，不能保护 pending。

- beta 工作流移除顶层 concurrency；preflight job 无共享锁，只有通过 owner/main/input/FW_ENDPOINT 条件的 publish job 获得 `group: payload-release`，不合格旧 cron 不进队列。preflight 的 not_activated 回执用无发布权限的结果 job 产生，不冒充发布成功。
- 四个消费者统一 `queue: max` 且 `cancel-in-progress: false`（GitHub 2026-09-10 官方文档支持最多 100 个 pending，满时拒绝新进入者）。其余三个只改这两个排队字段，不改触发、environment、输入、凭据或动作；保留同一个跨 workflow/job 的发布锁，不把 beta 分到另一组。
- 增强 S2：四处同组 + queue:max + 无 cancel-in-progress:true；增强 S3：beta 顶层无组，publish job 同时依赖 eligible/activated；失败/no-op preflight 无发布步骤。负例必须能杀死“恢复顶层组”“漏 queue:max”“改 group”三种变异。
- 共享锁仍可能让客户等待已经运行的 beta（既有串行保护）；承诺不新增 B6 gate、不取消客户等待任务，不能承诺零排队延迟。激活前在隔离仓验证“占用发布锁 + 排队客户任务 + 后来 beta/停用 cron”客户 run 未被取消；队满时 beta 被拒属于其自身失败，不能宣称发布成功。

Bridge 每次 POST 前读取新 owner，只有变量列表 API 成功 200 且分页完整、列表确实无该键才按缺省 legacy；403/404/超时均为 unknown，不把权限不明当变量缺省。未知时拒绝该次；没有管理台时也能运行。不要用 GitHub disable-workflow 停旧 cron，那会同时禁用 dispatch。停用的是旧 schedule 的执行资格。

接管步骤必须由实现/QA/运维阶段完成并记录：
1. 先部署兼容 workflow guard 和 Bridge 代码；owner 保持 legacy，频率配置不会改变当前行为。
2. 验证真实 beta workflow、凭据和 receipt 合同；Geo 缺入口时保持 unconfigured，不启用。
3. owner 改 paused；确认变更可读；枚举旧 schedule/人工/Bridge 的 queued、in_progress 运行和已提交未确认请求，取消或等待全部终态。无法排空则不继续。保留已有 manifest 操作状态用于恢复。
4. owner 改 bridge 后，**第一个完成配置/绑定/凭据检查的 tick** 以事务初始化 lane：`activatedAt = 本 tick 的 now`、`nextDueAt = activatedAt + interval`；并发初始化只一方成功，重启不能重置。paused 不写首次 activatedAt；因此首次接管不补历史周期，首次到期恰为接管后 interval。已有 lane 从 paused 恢复则保留原锚与 due，按 coalesce 补一轮。
5. 证据包括旧入口 no-op、首次合法 dispatch、receipt、项目下次时间，之后才报告该项目已接管。

停止/回滚：先设 paused，Bridge 停新提交；已受理运行可能继续完成，不能承诺撤回已发布内容。列出并取消/排空在途，必要时按既有 quarantine/withdraw 流程处理坏版，本单不赋予该权限。之后恢复 owner=legacy，原 6h 执行资格恢复；保留 DB 账本，不删表、不回滚 manifest、不重新启用一个无法判断的旧运行。仅回滚 Bridge 二进制而 owner 仍 bridge 会停发 beta，因此必须先完成上述交接。客户发布全程不被 pause beta 所控制。

## 4. 持久化与时间语义

在 `StateStore.ts` 既有 additive migration 中新增两张表；用现有 SQLite 连接和事务，不开第二个数据库。所有查询参数化。类型/状态常量在新增 `beta-release-contract.ts` 同源；UI 仅消费枚举和标签函数。

| 表 / 主键 | 核心字段 | 含义 |
|---|---|---|
| beta_schedule_lanes / project_name | repo_id、workflow_id、binding_revision、activated_at_ms、last_due_at_ms、next_due_at_ms、active_occurrence_id、status、last_error、observed_at_ms | 每项目一个游标；interval 来自当前配置，记录的 revision 只作证据 |
| beta_schedule_occurrences / occurrence_id | project_name、binding_revision、scheduled_at_ms、source_commit、state、run_ids_json、attempt_count、retry_at_ms、last_error、result_json、created_at_ms、settled_at_ms | 某次到期及其所有 HTTP/run 尝试；唯一约束 `(project_name,binding_revision,scheduled_at_ms)` |

`occurrenceId = sha256(canonical JSON [projectName, bindingRevision, scheduledAtMs])`；`schedule-key` input、`scheduleKey` receipt 与 `occurrenceId` 完全相等，均为完整 64 位小写 hex，不截断；不是发布 releaseId。所有时间为 UTC epoch 毫秒；展示转换本地时间，保存原值。`bindingRevision` 不因普通频率修改改变，只因完成排空后重新接入改变。

- 单个 60s tick，按 projectName 稳定遍历；每项目最多一个 active occurrence，单项目异步执行不得持有全局网络锁；固定最多 4 个并发 HTTP 任务，每请求 10s timeout，可取消，公平轮转。网络调用期间无数据库事务；不得同步 exec/构建卡 Bridge 主循环。
- due 判断为 `now >= nextDueAt`。事务先创建 occurrence 并占该项目 active 指针，再做 POST；并发 tick/重复启动只可一个事务赢。运行态与结果在重启后从 DB 继续。
- 停机错过多个周期只补一个最新到期项：`due = nextDue + floor((now-nextDue)/interval)*interval`；不积压所有历史周期。完成后 `nextDue = due + interval`；若完成时已过该值，前推到严格晚于 now 的同一网格点，不立即连发补偿。
- 空闲修改频率：以 lastDue（或首次 activatedAt）为锚重算下一次；若已到期，当下 tick 合并一个 occurrence。缩短可更早触发，延长不会按旧周期提前发。active occurrence 保持冻结源和 due，结算后再用新频率算 nextDue；其他项目不动。missing/invalid 配置只暂停派发，保留在途供结算。
- 时钟倒退不使已消费 due 再次出现；时钟前跳按 coalesce 规则；不改变客户周周期。删除项目保持其行停用且不 dispatch，仍按旧冻结绑定核对已知 run；不把遗留记录转移给新项目。

## 5. Dispatch、关联与发布回执

新增 `beta-release-github.ts`：只对固定 `https://api.github.com` 调用结构化 JSON API；固定 API version `2026-03-10`，校验 URL/仓库 ID/响应类型，不跟随带 Authorization 的任意跨域重定向。日志不输出 token、完整请求头或下载临时签名 URL。

每次 occurrence 冻结默认分支 source SHA（40hex），POST inputs 严格为 `schedule-key`、`source-commit`、`project-key`。workflow 已声明这些字段，ref 为默认分支。禁止自动传 `release-id`；混合 force 与 schedule 参数拒绝。

HTTP 200 + 合法 run ID 只表示 accepted，不表示 published。保存 run ID，后续 GET 同仓 run 核对 workflow、event=workflow_dispatch、ref、状态及 run-name 中的 schedule key。workflow `run-name` 包含固定前缀 `beta-schedule:<schedule-key>`；它仅用于找回回执，不授予发布权限。

状态机：`prepared → dispatching → accepted → running → succeeded | failed`；网络响应丢失/超时为 `dispatch_unknown`，保留同 occurrence 和冻结 SHA。下一 tick 先分页查指定 workflow 从 createdAt 前 60s 起的运行，以完整 run-name 和 workflow/ref 匹配，收集全部重复 run。404、认证失败、限流不是成功或无运行证据。API 旧版返回 204 归 unknown，不能凭空制造 run ID。

未知提交允许同 key/同 SHA 重发：先至少等待 2 分钟并成功查完所需时间窗的分页；仍无记录才 POST。退避 2、5、15 分钟（上限 15 分钟）；尊重 Retry-After，只有本 lane 暂停。发现多个 run 时全部记录并等待终态；重复 dispatch 可能发生，发布必须同源幂等。终态失败也以同 occurrence 查清所有 run 后才能退避重试；不得仅因观测超时重启已知 live run。continuous auth/binding/receipt schema 错误进入 attention，不无限发请求；修复后继续原 occurrence。任何可重试终态错误最多 5 次 POST（包括 unknown 重发），或存活超过 min(interval,6h)，停止新 POST 并告警。仅当全部尝试被权威查明已终态且没有未知提交时，标记 exhausted、保留失败证据并清 active，推进严格晚于 now 的下个网格点；下周期可用新 SHA 再试。存在 live/unknown 运行则保持 attention，持续低频查同 handle，绝不凭年龄抛弃外部仍可发布的任务。取消和超时分别记录 reason，取消不等于发布失败已无副作用。

每个 beta workflow 必须满足 receiver 合同：
1. 验证 owner、project-key（必须对应目标仓绑定）、完整 schedule-key/SHA、默认分支；输入经 env 或 argv 数组传递，禁止 shell 文本插值。
2. 自动路径在共同发布并发锁内验证冻结 SHA **可从当前默认分支到达**（同源 git ancestry 检查），随后 checkout 精确 SHA、确认 HEAD 相等；普通后续 merge 不让本轮失效，因此排队 20 分钟后 main 前进仍发布已冻结、已进入默认分支的版本。仅 force-push 后不可达/身份错误才 fail-closed attention。发布前读取当前 internal-beta 的 source：若已经有相同 SHA，走既有 no_change；若已经有冻结 SHA 的后代 beta，输出 covered_by_newer（记录并核对该真实版本），禁止把指针退回旧代码；两者无祖先关系则 attention。workflow 执行字节来自受信任默认分支，不能取 PR workflow。
3. flywheel 仍使用 `payload-release.mjs` 自动路径，不传 `--release-id`；既有 `beta-<SHA>` 幂等、CAS 和激活门不变。人工 force 路径保持显式。`payload-release` concurrency group 不拆分；按 §3.1 统一 queue:max 且 cancel-in-progress:false。
4. 成功必须上传一个小型 `beta-schedule-receipt` artifact，文件仅 `receipt.json`，解压后 ≤4 KiB、非链接、拒绝路径穿越和多文件。字段严格为 `{schemaVersion:1,projectName,scheduleKey,sourceCommit,publishedSourceCommit,repositoryId,workflowId,runId,outcome,publishedVersion,publishedAt}`；outcome=`published|no_change|covered_by_newer|not_activated`。sourceCommit 恒等于请求的冻结 SHA；前三种都必须有真实版本、publishedSourceCommit 和有效 UTC 发布时间。published/no_change 的 publishedSourceCommit 必须等于冻结 SHA；covered_by_newer 则必须是已发布、仍允许的后代 SHA，Bridge 用同仓 compare API 核验 ancestry。not_activated 的发布字段为空。
5. flywheel publisher 增加可选、机器可读结果文件输出（选项名 `--result-file`），保留既有 CLI 默认和 exit code：新发布 → published；现有同 SHA committed → no_change；workflow 前置 helper 读取并验证 manifest 后产生 covered_by_newer；未配置端点的 preflight 产生 not_activated。新 helper 复用既有 endpoint client 和 release-contract validator，不造另一套 manifest 校验。结果只从已成功读取/提交的 manifest 导出，不解析自由日志。测试保留 force、abandon、CAS 等原语义。
6. Bridge 必须验证 receipt 绑定等于冻结 occurrence 及真实 API run ID/仓库/workflow，run conclusion=success 且 receipt 有效才能结算成功。not_activated 单独显示未激活，不计发布成功；covered_by_newer/no_change 因已有真实覆盖版本而消费本周期、不新增版本数。删除 superseded 这个成功 outcome；正常 merge 不能让整周期零产出。无 artifact/过期/非法 JSON 进入 attention；run success 不替代发布回执。

### 5.1 Artifact 安全解析机制

C3 在 teamlead runtime dependencies 加入 `yauzl`，在 pnpm-lock.yaml 锁定实现时选定的具体稳定版本；相应类型依赖如需一并锁定。使用异步 `fromBuffer`、`lazyEntries:true`、`validateEntrySizes:true`、`strictFileNames:true`，不调用同步 unzip、不写解压文件到磁盘。artifact metadata size_in_bytes >64 KiB 先拒绝；下载流计数 >64 KiB 即 abort，不能只信 Content-Length。zip 只许一个 regular `receipt.json`，拒目录/链接/加密条目/重复文件/绝对或回退路径；entry uncompressedSize >4096 拒绝，read stream 实际累加 >4096 同样中止。读错误/超时必须关闭流，拒整份回执，不允许部分 JSON。

GitHub artifact 的首次 API 请求固定 api.github.com、带 scoped token、redirect=manual；302 的 Location 仅接受 HTTPS、无 userinfo、经过精确 GitHub artifact 下载域白名单校验，第二请求无 Authorization、无 cookie、redirect=error。新下载域必须更新白名单并测试，不能自动信任任意 Location。具体初始白名单 `*.blob.core.windows.net` 与 `*.actions.githubusercontent.com`，仅用于 GitHub API 签发的单次 Location，不接受输入 URL；10s timeout 与 64KiB 流限制相同。A7 绑定 yauzl 测试 zip-slip、symlink、两文件、伪造 sizes、压缩炸弹、损坏 deflate/截断、重定向到内网/跨域带 token 等反例。

### 5.2 S3/S8 工作流安全门同步

S3 从全文件 step 数量相等改为解析 YAML 后按 job 的闭合白名单验证：preflight 只可校验身份/owner/配置并写非发布结果；publish job 必须 needs=preflight 且 eligible && activated，所有构建/打包/endpoint 变更仅在这个 job；not-activated-receipt job 只在已验证合法 Bridge 输入且 activated=false 时运行，步骤只可生成结构化 receipt JSON 和 actions/upload-artifact，无发布凭据、checkout/install/build、shell 任意命令、endpoint 请求。删 job 条件、把构建挪到 receipt job、给它发布 secret 等 mutation 都必须使 S3 失败。成功发布 artifact 仍在 gated publish job 内。这样保留激活门真正阻挡副作用，而非放松成字符串存在即算。

S8 增加精确顶层 run-name 的非 shell 插值例外；解析所有 run 文本禁止 inputs 与 github.event.inputs 两种拼法的插值，不用后者绕过现有扫描。S4d/S4e 凭据隔离、S7 main-only、S13 exact trigger sets 均重跑；只新增 beta dispatch inputs，不改三个客户工作流的输入集合。

跨项目隔离来自各自 repo、workflow、凭据授权与 publisher；不共享 beta cursor / occurrence / manifest。仍共享宿主与 GitHub 配额，不能承诺故障绝对物理隔离。

## 6. 状态页与错误可见性

管理台项目视图新增只读 `betaSchedule`：模式、配置频率、有效频率、nextDueAt、active run 链接、最近发布版本/时间、状态更新时间和原因。未接管显示「旧入口 6 小时」；Geo 未绑定显示「尚未激活：缺少内部测试版工作流；目标 24 小时」，不可显示「已按 24h 发版」。owner 观测 stale 超 2 个 tick 或查询失败显示 unknown；绝不延续绿色旧状态。

实际消费者：`management-console-contract.ts` 定义 optional DTO 与 validator；`management-console-snapshot.ts` 增加按 projectName 合并的只读 provider fragment；`fleet-console-html.ts` 在现有项目节奏信息旁渲染；`plugin.ts` 绑定 provider。snapshot provider 只能同步读取调度器已缓存的观测与 DB 投影，不在页面请求内做 GitHub HTTP。兼容旧 snapshot 缺 optional 字段，既有管理台 schema 版本不变（加法字段）。沿用已有管理台鉴权，无新增公网路由/写接口；derived 文本 HTML escape / textContent，run 链接限制 github.com 和冻结 repo/run id。

停止控件由仓库 owner 变量操作承担，页面不新建权限面。日志按 project/reason/occurrence 去重；错误修复后再出现可产生新事件。不得写入 release gate、Lead 巡逻或 auto-ship 的状态记录。

## 7. 实施分块（TDD：每块先有失败测试）

| 块 | 文件与工作 | 完成证据 |
|---|---|---|
| C1 配置与身份 | 新 `packages/config/src/beta-release-config.ts`，改 `types.ts/ConfigLoader.ts/index.ts`；新增 config 测试；Bridge resolver 复用 roster，按 canonical root 读同源配置 | missing=unconfigured；24h default；6/24；非法值；项目隔离；reader 一致性 |
| C2 状态机与存储 | 新 `packages/teamlead/src/bridge/beta-release-contract.ts`、`beta-release-scheduler.ts`；StateStore additive tables/API；新增 StateStore 与 fake-clock tests | 事务竞争、重启、失败退避、时间边界、coalesce、频率调整、两个 lane 不互相推进 |
| C3 GitHub 与接收端 | 新 `beta-release-github.ts`；teamlead/package.json 与 pnpm-lock.yaml 增加 yauzl；修改 beta YAML 输入/owner/run-name/source/receipt；`payload-release.mjs` 增加结构化结果；新 `scripts/release/beta-schedule-receipt.mjs` 校验/写 receipt；脚本和 adapter stub tests | 丢响应/分页/多个 run/活跃不重启、正确凭据与源绑定、重复无新版本、普通 merge 不跳过；已有后代 beta 不回退、artifact 攻击拒绝 |
| C4 生命周期与状态页 | plugin 启停 60s scheduler、刷新 canonical config；上述 management DTO/provider/render 与 DOM 测试 | 管理台禁用时调度仍工作；停止 abort 无悬挂；A 卡住 B 仍推进；unconfigured/unknown 不冒充成功；XSS 反例；改 DOM 前全族 grep，运行完整 management-console-* 与 fleet-console-html 测试族 |
| C5 回归与接管证据 | S3 扩为 legacy+bridge+paused 路由；S2 按 §3.1 增强；S3 按下述分 job 合同改写；S8 显式允许顶层 run-name 并禁止 shell 插值；S4/S7/S13 不删；CI 注册新增 suite；本目录 runbook/acceptance evidence | 旧全 6h 兼容；接管双入口不会执行；rollback；客户每周链路不变；真实 receiver 绑定后再验发布 |

ConfigLoader、StateStore、plugin、workflow 为可能并发触点；实现开始先核对 B0–B5 当前分支，不覆盖其他节点新合同。设计交接不合并其他 worktree、不自行改 Geo 仓。

## 8. 验收矩阵与命令

| ID | 场景 | 必须断言 |
|---|---|---|
| A1 | 两个已绑定测试项目 6h / 24h，T0 同锚，虚拟钟推进 48h | T6/12/18 仅 A，T24 两个，至 T48 A 8 次、B 2 次；独立版本 sink 收到对应项目 tuple |
| A2 | 全部 legacy，配置有 6/24 或省略 | Bridge 零 POST；旧 6h schedule 仍可执行；不偷偷切默认 |
| A3 | bridge 且 interval 缺省 / Geo 无 workflow | 已绑定项 24h；Geo unconfigured/零 POST/页面明示，非「已上线」 |
| A4 | 同 tick 并发、重启各持久化断点、HTTP 结果丢失、重复 run | 一个 occurrence；已知 live handle 继续查询；可能重复 dispatch 但发布同 SHA 幂等；不跨项目锁住 |
| A5 | 时钟前后跳、停机 3 天、6→24/24→6、in-flight 改配置 | 不重放过去、不突发补队列；改变只影响对应项目下一次 |
| A6 | paused、非法配置、repo 重绑、无 token、403/404/429/超时、A 挂起 | A 有明确状态；已全终态的反复失败触达 5 次/期限后可在下周期自愈，live/unknown 不被伪弃；B 仍正常；A 凭据不能用于 B；客户周发布不读取这些状态作为前置 |
| A7 | 错 project/SHA/ref/workflow、半组 inputs、schedule+force、错/缺 receipt、zip 路径攻击 | 零错误发布/零伪成功；所有动态文本安全 |
| A8 | 冻结 A 后排队 20 分钟期间合入 B；同 SHA 重试；已有后代 beta；FW_ENDPOINT 未激活 | 普通 merge 仍发布冻结 A；已发布 B 则 covered_by_newer 且不回退；无新代码 no_change；not_activated 非成功；每周期不因 merge 被跳过；customer-release 指针不变 |
| A9 | legacy→paused→排空→bridge，反向回滚 | 在途未排空不能接管/复旧；旧 cron 与 Bridge 不同时获得执行资格；不改客户流程 |
| A10 | 客户 release 的既有 trigger、判据、veto、manifest 通道与共享 concurrency | 既有发布回归通过；beta 新模式不作为其 gate、不取消它的 running/pending；先占用锁再排客户后排 beta，客户保持等待；停用 cron 不入锁；不改每周排程 |
| A11 | 真实两个项目已绑定不同频率 | 每项目 due/accepted/start/publish 时间、run URL、真实内部版本/产物回执；若代码未变化记录 no_change 而非虚构新版 |

实现期新增 tests 路径按 C1–C4；执行范围：

```sh
pnpm --filter flywheel-config test:run -- beta-release-config
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/beta-release-scheduler.test.ts src/bridge/__tests__/beta-release-github.test.ts src/__tests__/StateStore.beta-schedule.test.ts src/__tests__/management-console-*.test.ts src/__tests__/fleet-console-html.test.ts
bash scripts/__tests__/release-workflows-structure.test.sh
bash scripts/__tests__/payload-release-pipeline.test.sh
node --test scripts/__tests__/beta-schedule-receipt.test.mjs
pnpm --filter flywheel-config build
pnpm --filter flywheel-teamlead typecheck
```

命令是实现期验收计划，尚未执行新增测试。CI 分类需保证新增文件被相应测试 job 覆盖；不得使用全仓 pnpm test 触发无关 macOS/tmux 场景。

A1 mock 验的是调度和隔离，不能替代 A11。按照 Lead 裁定，Geo 缺真实入口不阻塞本设计/通用能力交接，保持激活前置；A11 未证实时不能声称完整双项目 beta 已上线。flywheel-only 每周 release 不等待这个缺口关闭。真实验证由后继在其授权环境执行，本设计节点不发布任何 beta。

## 9. 取舍与风险

首轮非阻塞建议中的独立 Bridge 失联告警需要由 Lead 决定复用的外部监控所有者；本单不自建第二套托管告警/issue 通知系统。保留为明确 residual risk：owner=bridge 时宿主长停机会停止供给新 beta，可能减少客户候选；客户自动发布仍按已有 green/hold/unknown 自行处理，不新增 B6 功能 gate。向 Lead 报告 `no-bridge-liveness-alarm` 以决定 follow-up，不能宣称已具备独立失联告警。

采用固定间隔而非任意 cron/timezone 表达式，降低迁移和夏令时歧义；目标 6/24h 均覆盖。新增专用 beta 调度器而非借 Lead 巡逻或重做发布系统，保持权限与责任清楚。共享发布并发组保留，因此 flywheel beta 可能等待客户操作，属于既有单 manifest 保护，不引入 B6 功能依赖。GitHub 队列改为保留等待者，满队拒绝新进入者；只有准确 run/receipt 能证明结果。

退避、未知状态和缺入口会降低发布及时性，但不会越过发布边界。DB/宿主故障可能影响整个 Bridge，故只承诺逻辑项目隔离；不承诺零停机或秒级发布 SLA。Artifact 过期导致 attention 时可从可信 manifest/run 重新核验恢复，不直接清空账本放行。

## 10. 设计交付与审查

本目录包含 exploration.md、research.md、plan.md、progress.md、Mermaid 源和 founder-design.html。HTML 所有 section 有本地评论；汇总标记 `【页面意见汇总】FLY-2393` 只是修改反馈。单个带 `__CSP_NONCE__` 的 inline script，无外部依赖，无自带 CSP；runtime derived 内容只写 textContent/value。

作者受限 runner 的 PATH mmdc 两轮均因 Chromium bootstrap 权限失败，记录属实；这不能推断其他 runner 也无法渲染。R1 reviewer 用本地 npx mmdc 成功渲染同目录两份源，提供 /tmp/fly2393-d1.svg 与 d2.svg。本节点复核源标签并将全部 SVG id/CSS 引用命名空间化为 fly2393-d1/d2 后收入仓内与 HTML；使用的是可核实的本地渲染产物，不再交付占位图。标准再生成命令须逐图带 --svgId fly2393-d1 / fly2393-d2。

有效 APPROVED 后才 commit/push 最终交付、publish-report --publish-only、向 Lead 报 DESIGN-HTML ready，随后 phase_design_complete 并 park。实现与独立 QA 才证明代码/真实发布验收，本设计不代替它们。


## 11. R1 修订记录

唯一 HIGH `superseded-burns-cycle` 已修：取消“必须仍是 HEAD”与 superseded 成功状态，固定发布可达的已合入 SHA；如果已有真实后代 beta，核验后记 covered_by_newer，禁止回退。常规 merge 不再烧掉 6/24h 周期。

同时处理 S3/S8 硬门冲突、凭据绑定位、zip 解析载体、管理台全族测试、scheduleKey 恒等关系、activatedAt 首个 tick；加入有上限且保留 live/unknown 证据的重试规则。作者自审另补 §3.1，保护客户 pending 免被 beta 顶掉。独立 Bridge 存活告警保留为明确非阻塞 follow-up 建议，未假装已实现。
