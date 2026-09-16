# FLY-2519 Codex Lead 能力对等 — 实施计划
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-14
基于: plan.md

## 来源与适用范围

本附录记录本次重派任务正文注入的「QA 判据（Lead 2026-09-14 02:4xZ）」；不是设计 runner 新创的治理裁定。后续读取 preserved commit 的 `review.md`，核实浏览器裁定完整 question 为 `96a9b996-4994-44c9-b831-4c73cbd54dbb`；Git 180s 补充裁定为 response `e709ace2-7e79-4854-b4ad-209a380a4c79`，替代早期 120s。未补造其他 id 或 settled 记录。原 R2 question `c2a10f39-eec6-4ee4-8db1-895dee044167` 已在本轮实时查询，effective APPROVED；原意见和审阅版本保持历史可追溯。

实施与 QA 一起读取 `plan.md`、本附录和 `research.md` P01–P17。本附录对下述具体冲突处优先：StateStore 所有者、feature push 时限、浏览器 QA cookie 判据、当前 QA 的生产边界。其余已批方案、完整能力范围、R1–R5、secret 仅经可信 broker 内存通道均不变。

恢复起点为 `origin/flywheel-FLY-2519@63a1448062e6afdf3112e5d7be2d409fcc68f985`，2026-09-14 查询远端一致且 `gh pr list --state all --search FLY-2519` 无结果。随后收到 Lead 指令并找到了具名 stash 与父提交 `ce0e761a9` 中的已有实现。当前 design checkout 未包含这些祖先，但不能据此说实现不存在；恢复证据和五项具体剩余方案见 `gap-checklist.md`。它们尚无本次可核对的 PR/CI/生产 parity 结果。

## 1. 可信 parent 与唯一状态写入者（C2/C3）

Parent 是启动并管理 Codex 的可信父进程。CLI 与 MCP 都经同一个 result-only broker 协议，只返回动作结果；UUID 是用于识别同一次请求的唯一编号。重放同一请求必须去重，同 UUID 改 payload 拒绝；只有 authorization、没有动作回执不能被当成动作完成。已有内部 startup authorization probe 可以返回零副作用的就绪结果，但它不是模型动作成功回执。

StateStore 是 Bridge 持有的业务状态数据库；Bridge 是该数据库的唯一写入者。这里的窄 typed Bridge provider **在当前 canonical identity、department 和 carrier claim 校验通过后执行业务写入，不提供修改这些授权事实的操作**；typed 表示入口只接受事先定义的操作和字段。Department 来自 projects.json/DepartmentRegistry，identity/lease/claim 依照现有 registry 与 CommDB/lead-lease；它们并非新的 StateStore 表。相关配置或 ownership 变更继续经过既有 updater/治理授权通道，broker 不增加 identity/department/claim 写权限。

Lead runtime 不打开、加载、迁移或写 StateStore，也不得使用启动时缓存冒充调用时的同步权威状态。复用 preserved `bridge/lead-capability-discord.ts` 的 `resolveLeadIdentityRow`、`forwardedLeadAuthorizationEnv`、当前 carrier 检查和 `authorizeDepartment`：共享 master token 单独不足以授予某 Lead 的权限，必须绑定真实 current carrier 与业务目标。异步等待后及真正写入前重新核验；Bridge 不可用时拒绝写入。两个 runtime 只消费既有受限 provider，不新增任意 SQL/URL/method 代理。

`plan.md` §4.1 的 parent per-Lead journal/outbox 仍记录操作回执，不能与 StateStore 混用。持久重放使用 `broker.ts`/`receipts.ts` 的 request UUID+payload digest，以及现有 `CodexOutboundSender`/Bridge durable outbox 的 parent journal-context、精确目标和正文 digest 去重（preserved commits `97e42c658`、`6c18a7c40`、`07293b66f`、`141573281`）。**不声称旧 `/chat-threads/send` 自带 request UUID 幂等**；旧 route 的共享 token+body 校验也不是本 provider 的充分授权模板。保留跨进程/SQLite 重启的同请求不二次发送、改 payload 拒绝、不同 context 不误去重、unknown 不重发的实际集成测试。

## 2. 日常操作与 Git 的有界执行（C3）

| 对象 | 必须实现与验收的合同 |
|---|---|
| Discord | 线程读取、创建、回复、消息编辑和反应；reply evidence 包含精确 thread/message 引用；状态不明只读对账，不重复发送。原 P04 附件范围仍保留。 |
| Linear | 七个 typed handler：get、search、create、update、assign、relations.set、comment.create；逐项复用项目、团队和目标归属门禁。 |
| GitHub | PR create/edit/comment；diff/run/log 为只读。固定可信 HTTPS 目标，处理 ZIP 时限制压缩包与解压字节，分页同时限制条数和总字节。原目录其他适用能力不能因此删去。 |
| `git.feature.push` | 可信 parent 持有最多 180s 的可取消异步操作；拷贝与磁盘预算均有 4GiB 上限。子进程无凭据、无 hooks；禁止生产 push、main/force push 与任意 remote/helper。 |
| 其他能力 | `plan.md` §4 的 15s 时限继续适用；不能把 push 的 180s 例外扩大为所有 provider 的等待时限。 |

v2 无凭据 Git 子进程已有实现：preserved `handlers/git.ts` 接 `GitPushRunner.ts` 的 `materializeAndPushV2` 与 `git-push-transport.ts`，parent 持有 token 并代转受限 Git HTTP 请求。该路径不同于保留的 legacy `pushFeatureBranch` askpass/env 路径；G1 必须接 v2 transport，不能把 legacy 带凭据子进程当成 v2。保持现有 4GiB 私有副本、固定 repo/head/branch 和取消约束。

超时/取消发生在外部结果未确定时保留 unknown；先对账再决定是否可发新请求。超时绝不证明 provider 没有执行，也不自动重放外部写入。

## 3. 原生 Chrome 与凭证边界（C4）

浏览器使用 Chrome DevTools MCP；不得依赖 Claude-in-Chrome。每个 run 使用隔离的一次性 profile，在 Seatbelt 下启动。Seatbelt 是 macOS 对进程可访问文件和网络施加的系统限制。Preserved `browser-config.ts` 已锁定 `1.9.0` 与 upstream schema digest `93634c4bb94d23957cb3907af5b7b29d01fc70e1d0746d457e318eb98c97f492`，`browser-schemas.ts` 定义 21 工具严格子集；parent 使用现有校验，不授权运行时新增工具。该事实属于 `ce0e761a9`，不是本次只含设计的 checkout 里 legacy MCP 版本。

Cookie/Set-Cookie 头在边界脱敏；页面 JavaScript 的输出是未受信数据。根据任务注入的裁定 `96a9b996`，**不设「任意页面 JavaScript 下 QA cookie 字面不外泄」的验收判据**。这修正 `plan.md` §6.2 对浏览器 cookie 的绝对承诺：允许使用获准产品 QA 身份的受管会话，不把 QA 页面可见的同站数据保证成绝对秘密；仍禁止 action credential 输出、founder/生产 admin session 转授、Chrome 读取主机凭证和访问保留管理写入口。run 结束后使浏览器会话作废。

宿主证明必须包含原生 Chrome MCP 在 Seatbelt 下的实际启动与 canary：验证 Node dylib 加载、Chrome IPC 兼容。Dylib 是 Node 启动所需的系统动态库；IPC 是 Chrome 主进程与子进程之间的通信。Canary 是专门用于验证访问限制的合成测试值，不能读取真实 secret 代替。启动失败须保留失败证据，不把单测或配置名单当真机通过。

R2 advisories 继续非阻断留档，不额外变成本轮 QA 条件；上面宿主 canary 本来就是新注入的显式 QA 要求。若实际启动要求改变已批准隔离方案，仍按既有 Lead 裁定流程处理，不自行关闭沙箱。

## 4. 配置与进程清理（C2/C4）

v2 marker 严格识别：缺 marker 保持 v1；畸形 marker 和混入 legacy sandbox 配置的 v2 明确拒绝。不能靠宽松类型转换或旧配置静默降级启用 v2。

初始化失败时关闭已经创建的 process、broker、outbox、journal，包括只启动一部分的路径。Broker shutdown 是显式原语：先拒绝新请求，取消在途操作，将仍未确认的 pending 写入持久标为 unknown，再关闭资源；重启后不能自动再发这些写操作。验证失败注入覆盖各初始化阶段，以及 provider 已执行但回执未写完时的退出/重启。

## 5. 当前 QA 与原始最终验收的证据边界（C5）

当前 QA **不激活生产 v2、不重启任何 Lead、不对生产 provider 做写操作、不进行生产 push**。所有集成使用隔离 registry/home/socket。UDS 是同一机器内的 Unix socket 通信通道；必须交付可复跑的 UDS + broker + SQLite 联调用例，并记录本地命令、精确 commit、版本、退出码与脱敏日志。数据库仅用隔离 SQLite fixture；如确需生产只读快照，必须使用既有快照管理命令，不复制活库。

| 证据层 | 通过所需证据 | 不得推导的结论 |
|---|---|---|
| 当前设计 | 原 R2 + 本附录的当前评审回执、提交文档、托管 HTML 与 Lead report | 不能证明代码已经实现或上线 |
| 实现体当前 PR head | 非 draft PR；同一精确 head 的 CI 绿；P01–P17 逐项证据 | 不能用旧 head 的绿或若干单测宣称全能力对等 |
| 隔离真机 QA | 上述 Chrome 宿主 canary、UDS/broker/SQLite 可复跑联调；模拟 provider 的写结果和只读对账 | 不激活生产，也不能冒充 Honey Lemon 已完成生产 issue |
| 原始最终业务验收 | `plan.md` §9 同一 Honey Lemon Codex 会话完整 issue 驱动，原生浏览器与 Linear/Discord 可核对留痕，未调用 Claude 工具；生产动作只由后续独立获准通道安排 | 当前 QA 边界没有授予上线、迁移或生产写入权限；缺少最终证据不得勾成生产 parity 已完成 |

宿主全量套件争用红而隔离绿、以及 onTaskUpdate flake，按已注入的既定处置不算阻塞；仍需记录实际失败和隔离证据，不能泛化为忽略未知失败。Review 的非阻断 advisory 不在本轮 QA 判据内。差集 PR checklist 的每个勾选必须对应这一行实际声称的证据层，production unverified 保持明确。

本节点只补设计交接；不实施、不创建或派发 successor、不请求 shipping authority、不合并或部署。阶段完成使用本次 activation 的结构化 receipt，然后 park，保持 issue goal 由控制器持有。

## 6. 当前 Lead 范围裁定（2026-09-14）

Question `e7cc5a18-0c70-4bb6-8685-f0ed3513a9aa` 与补充 `75bd38de-0b3a-46e2-bc03-30362def2cde` 优先于上文 generic GitHub/git 实施范围：A 读操作仅要求当前 canonical projectRepo；B PR comment、仅 COMMENT review、PR edit（title/body/labels）、PR ready、run rerun 必须经现有 StateStore session/PR 绑定证明同 project 且同 lead_id，无绑定明确 `pr_not_bound_to_lead`；C PR create、GitHub issue comment/create、branch create/push/force-push、merge/approve/release/tag 一律 parent 拒绝且零 upstream I/O。Runner 拥有分支和创建 PR；不得让 Lead 接 generic push。保留旧实现作为历史/内部组件不代表启用其能力。新增 ready/rerun 不能以其他写操作替代。

Question `faf43d4f-67fd-4e78-8d78-ea34d41b43ff` 要求 gbrain 复用 Claude 当前 host config 与每会话 `gbrain serve` stdio 子进程，不使用隔离生产服务替代；启动前锁定 0.9.0 与代码 digest，漂移则不 spawn，禁止 DB URL 环境覆盖。PGlite 仅 fixture。Lead 已确认 connect 迁移按 schema 版本执行且当前版本只读 no-op；实际 host 证据须为零 `Migration N applied`，尚未执行。

浏览器来源裁定 `d090db17-c554-4f8a-8cc8-98c86d4fa80c`：不创建私有 Chrome/Node 可执行副本。使用 host Chrome.app 与 host Node；Chrome pin bundle version 且执行 `codesign --verify --deep --strict`；Node pin version、binary SHA256 与动态 libnode SHA256，pre-spawn 漂移拒绝。正常 macOS group-write mode 只记入 receipt，不据此拒绝。Seatbelt 允许 Chrome.app、`/opt/homebrew`（Brew dylib）与系统 frameworks 的 read/map，绝不 write；写仍仅私有 profile/tmp，保持既有 egress、Bridge/admin/CDP 边界。实施后重跑准确 policy canary/IPC；如再因其他原因失败，报告准确 denial line 并停止，不继续扩大 policy。此裁定尚待代码落实，首次 host canary 仍失败。

签名补充裁定 `c22ce772-e8b3-434b-8282-d3bf10a1a54d` 覆盖上述 strict/version 条件：Chrome 使用 `codesign --verify --deep`（不用 strict）且 `codesign -dv` 的 Identifier 必须为固化的 `com.google.Chrome`、TeamIdentifier 必须为 `EQHXZ8M8AV`；版本 153.0.8010.37 漂移仅记录 warning，签名/Team 漂移拒绝。Node 版本与 binary/libnode 摘要仍漂移拒绝。不修改 host xattr/mode，不复制。继续原策略 canary，如再遇拒绝则报告准确行并停止。

语法裁定 `7754b935-b2de-4cb6-96da-ea8ab94cc1f8`：Seatbelt remote tcp host 使用 `localhost:<exact-port>`，与既有 loopback 目标范围一致；保留显式 `(deny network*)`。未授权通配端口；本次不添加监听端口或 Unix socket。重跑如遇下一拒绝则报告并停止。

### 2026-09-14 persona skill source ruling (question 4b1bfb67-e2b3-47ba-a30c-a1a5ce9eee51)

Lead explicitly ruled that minimalist-entrepreneur is a collection, expanded to ten installed skills at ~/.claude/plugins/marketplaces/minimalist-entrepreneur/skills/: company-values, find-community, first-customers, grow-sustainably, marketing-plan, minimalist-review, mvp, pricing, processize and validate-idea. The nonexistent research alias means the real ~/.claude/skills/deep-research and ~/.claude/skills/synthesize-research. Canonical Honey Lemon wording now says this explicitly; no generic research tool is invented. The twelve actual SKILL.md paths and SHA-256 values are committed in persona-skill-baseline.ts.

This ruling supersedes the earlier required-persona-skill fail-closed assumption: missing or unresolvable persona skills remain visible startup receipt gaps with the existing manual-framing fallback, not startup blockers or advertised tools. The selector now emits skillGaps and marks persona skill sources non-blocking; supplied pins with changed content are unavailable, with an explicit changed-source gap. Strict native six-skill/deployment admission remains separate and unchanged. Factory consumption and startup receipt propagation are still outstanding; selector output alone does not prove runtime assembly.

### 2026-09-14 explicit skill admission and full inventory (question 34034413-99b4-4960-916e-ffe8848bb9aa)

Lead ruled that Codex adapters cover only the corrected canonical Honey persona map plus rule-bundle named skills: founder-html-delivery, xiaohongshu-learning, xiaohongshu-deep-learning, proofshot, deep-research and synthesize-research. The ten minimalist sources remain explicitly admitted even though the plugin is globally disabled; enabled=false is evidence, not a reason to edit global settings. Other enabled Claude methodology plugins/frameworks are inventoried, not adapted. Their name, source, digest, enabled flag and not_in_persona_map reason enter the hashed public inventory. A future persona edit may admit one through the same map path without a hardcoded filename exception. Native six remain the Codex methodology baseline.

## Authored text ingress and ProofShot ruling (2026-09-14)

Lead answer 371d5706-e742-4c91-a0c8-840d5e23049d approves artifact.text.create with exactly mimeType (text/html, text/plain, text/markdown, application/json) and text, at most 512 KiB UTF-8. Parent secret scan rejects before any storage; the activation-owned store returns only an artifact handle. No path, URL, credential, base64 or other MIME inputs. report.publish retains its independent authorization. This supplies the equivalent of authoring a file before publish-report.

The ProofShot adapter may use only the approved 21 native Chrome tools for screenshots/console/network evidence. It must visibly report missing video recording, server start/kill and process takeover. No extra process/video permission or full ProofShot parity claim is authorized.

## XHS Runner workflow boundary and Lead memory delegation (2026-09-14)

Lead answer 31ce91bb-927e-40c7-89f8-9ab4cc3d7055 says not to build xhs-state/xhs-analysis/scheduler/Gemini ingress in this issue. The two Xiaohongshu learning skills are Runner workflows. Retain explicit runner_workflow_not_lead_capability gaps with dispatch-Runner fallback; never mark their workflows implemented or substitute caption-only analysis. XHS founder write-gate work remains FLY-2551.

Lead parity still requires the [XHS-MEMORY-WRITE v1] delegation: verify marker project equals the Lead project, typed parent/Bridge memory.add per item with op_id/run_key metadata, best-effort dedup via memory.search, then answer the ask with the ACK. Audit and add those narrow operations and response path where absent. This ruling does not authorize direct Lead StateStore access or arbitrary memory/credential helpers.

## Default native source and public browser ruling (2026-09-14)

Lead answer 67ca977b-d8dc-43fc-b303-e8589dac769d rejects a new FLYWHEEL_CODEX_NATIVE_SKILLS_ROOT launcher override. Use the exact installed Codex 0.153.2 native tree where the approved six hashes were captured, recorded as an absolute source path and per-file digests in the manifest. Existing Honey skills/.system is verified against pins; absent trees may be copied from the fixed source with bounded no-symlink handling. Missing/drifted source rejects. Never generate expected hashes at runtime or copy auth.

Default browser may use only its disposable activation profile/generation and public-web egress, with no localQaTargets and no minted application QA identity. The management-console acceptance is satisfied through typed Bridge reads; public QA reports use the browser. Explicit local QA targets and externally issued QA identity/revocation need future trusted configuration and remain visible gaps, outside this issue. No production activation or browser-canary retry is authorized by this ruling.

### TUI transport ruling (question a2a08b4c-1d81-46b6-bb71-d47bf83a36e2, 2026-09-14)

Lead confirms activation-owned lifecycle, washed env + permission/MCP overrides, post-connect config/read + skills/list checks, and refusal of old/unattributable daemons. At most one bounded remote-control proof attempt is allowed; it qualifies only when this activation started the manifest-pinned binary and live binary/argv/env digests can be read back. If unavailable, the canonical v2 TUI transport must be parent-owned app-server Unix socket, with receipt transport=app_server_socket. Never run both transports in one activation. Real propagation/lifecycle evidence belongs to isolated-home/socket QA without production provider writes.

Implementation choice: app_server_socket, because the current launcher has no live daemon argv/env attestation. v1 keeps its existing remote-control path. v2 production startup remains guarded until the owned-child lifecycle and socket routing are connected; the readiness/parent-session wiring is already independently testable.

### Research persona gaps (question 69b1e642-04b6-46ee-8df1-3b30311bb745, 2026-09-14)

Lead confirms both research skills are explicit persona gaps for this round, accepted for QA as visible gaps rather than implemented capabilities. deep-research is authenticated_research_not_available: its original workflow requires headed logged-in ChatGPT and native export; the disposable public-only native browser cannot be represented as subscription Deep Research. last30days is research_provider_not_admitted: SCRAPECREATORS plus additional platform/helper credentials constitute a new surface outside this scope. Record both reason codes in the hashed inventory and startup receipt. Manual fallback is an authorized Runner or interactive research. Do not add a provider/credential ingress or silently substitute ordinary web browsing.

## Schema2 integration after main sync (2026-09-15)

Lead ruling 78ea9ac2-83ff-4d78-9927-a0815ae57c63 explicitly includes #1198 patrol schema2 integration in FLY-2519 parity. Main f022a0a7e was merged as cea457c95, without conflicts. The prior PR CI evaluated its merge tree and exposed five incompatibilities: three snapshot consumers required title/project adjacency before the new schema header; completion/ judgment fixtures and serializer lacked explicit schema2 mechanism review and finding identities. Local post-merge evidence: five failed, twenty passed. This was a contract mismatch, not a flake; no retry allowance was consumed.

Only the Codex-side parser, typed catalog, serializer, completion adapter and fixtures are adapted. Require schema2; findings carry explicit stable id/category; mechanism review is supplied explicitly, never defaulted to none. Declarations preserve identities and cannot be removed or rebound by later requests; dispositions carry the exact canonical fields, including structured Linear readback records. No provider action or authority is synthesized from these records. Completion includes the existing canonical validatePatrolReport check, preserving mechanism dispositions and activity evidence requirements. #1198 source/rules semantics remain unchanged.

## Accepted risk — Chrome renderer sandbox (QA1176 / Lead ed48f532)

Authority: Lead mailbox ed48f532-eef0-4fd3-b9f7-16e3ac20600c and gate5058a1de-74d7-43aa-b204-f2ade09824a5, 2026-09-15. QA's host execution at0f5afbddd proves Chrome's internal sandbox cannot initialize inside the outer Seatbelt, including an allow-default outer policy. A real headed launch, not --version, is the required acceptance.

**Accepted risk:** Chrome runs with `--no-sandbox` inside the outer Seatbelt. Renderer isolation is lost: a renderer compromise can reach other browser processes and disposable session data. The Lead explicitly accepts this loss; the outer Seatbelt is the security boundary. Public page content remains untrusted. This does not make page JavaScript safe or establish arbitrary-JS secret confidentiality. Credential-root read denial, symlink escape denial, writes confined to qaRoot, direct-egress denial with pinned proxy, and disposable profile cleanup remain mandatory executable guards. Their assertions are unchanged. No production activation or resident Lead restart is authorized by this change.

First bounded configuration attempt adds `--disable-crash-reporter`, `--disable-breakpad`, `--crash-dumps-dir=<qaRoot>/crashpad`, plus the pinned Chrome-supported `--breakpad-dump-location=<qaRoot>/crashpad` redirect. Official153.0.8010.37 source: [CrashReporterClient::Create](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.37/chrome/app/chrome_crash_reporter_client.cc) accepts the latter switch and overrides DIR_CRASH_DUMPS; [chrome_paths.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.37/chrome/common/chrome_paths.cc) otherwise derives Crashpad from the default user profile regardless of user-data-dir. Source inspection establishes the configuration path, not successful host execution. No global Mach permission or host-profile exception is added in this first attempt.

Conditional authority only if host evidence still requires it: Crashpad handshake-name-scoped mach-register/mach-lookup; or metadata on the one exact host Chrome/Crashpad directory, with all host profile data reads denied. No blanket Mach allowance. At most two rework rounds for this blocker; if these bounded changes still fail, preserve the host ladder and report the exact stage instead of widening the policy. No separate browser-broker redesign in this issue. Head stays frozen during review.

### Unaccepted host-file exposure — blocking review6b0ae131

At b485257bf, effective review is CHANGES_REQUESTED, findingKey `browser-worker-broad-file-read-allow`. The accepted-risk paragraph above is incomplete: with renderer sandboxing disabled, a compromised renderer can use the outer policy's broad file-read allowance to read host files outside the enumerated deny roots, and can send those bytes through the permitted public egress proxy. The reviewer executed pinned Node under the actual final policy: registered credential roots were EPERM, but two other repositories' .env files and .zprofile/.zshenv/.bash_profile/.profile were readable; ~/Dev and ~/Library/Application Support could be enumerated. No secret values are included in this report.

The existing synthetic denied-path probe establishes only enumerated denial, not a general host-secret boundary. This broader exposure has NOT been accepted or settled by the prior no-sandbox ruling. CI success alone cannot pass this review gate.

### Deny-home correction and final bounded Crashpad trial

Lead gate4bc8df26-eb7c-47f0-9fc9-d043160b7063 chose remediation, not acceptance: deny home data and metadata by default, with only necessary runtime exceptions. Commit c23ef9986 applies this boundary, excluding the verified MCP package subtree, Chrome bundle, exact Node executable and disposable qaRoot. It does not expose the surrounding worktree or Library. Existing credential/project deny roots remain in force. No cache exception has been justified by host evidence. One remediation round is authorized; if the runtime fails, report the required paths rather than broadening them speculatively.

Host gatebe1736d0 confirmed the first flags-only trial at b485257bf failed chrome-launch after59562ms. Supplement3d3a3c43 records the Crashpad handshake failure and host Crashpad stat denial. The second and final authorized Chrome trial adds only a regex anchored to Crashpad's PID/thread/random handshake namespace for mach-register/mach-lookup, and file-read-metadata on the exact host Chrome/Crashpad directory. Host profile contents, directory enumeration and descendants remain denied. No global Mach allowance is added. This trial is not yet host-proven.

The root real-process regression now also constructs a synthetic home with previously unlisted Dev/repository/.env, shell profiles, an unknown future secret and Library/Application Support. It requires data and metadata denial, symlink denial, Library enumeration denial, and only exact Crashpad directory metadata access while Crashpad contents remain denied. It uses the generated production policy and pinned Node; an explicit nested-sandbox skip supplies no acceptance evidence. Fresh host execution and effective review remain required.

### Crashpad child metadata correction — 2026-09-15

Replacement handoff a8122d4f-dbed-4b10-b0c7-c62816efa80a and host gate 1620cb21-c87e-45a1-aa54-50a5d718cc4c supersede the exact-directory-only metadata wording above. Host proof at 19a7e6725 passed synthetic-home denial but failed browser startup: shipped reporter-disabled flags reached exit21, stat Crashpad/new denied. The Lead authorizes one final evidence-driven correction: file-read-metadata on the Crashpad subpath, with data reads and enumeration still denied. No other permission changes; retain disabled crash reporting, qaRoot dump redirect and handshake-only Mach grants. If this candidate still fails headed Chrome, report the exact stage and stop widening.

Review round9 at 19a7e6725 returned effective APPROVED, resolving the prior HIGH to a non-blocking MEDIUM residual outside-home read surface; full response is review-round9.json. This historical review does not certify the child-metadata change. Source39c9f72ea implements only that change. Real-process regression now stats Crashpad/new and requires both Crashpad directories' enumeration and a nested synthetic dump read to fail. Nested Seatbelt execution cannot prove host acceptance.

### Final Crashpad xattr correction and new profile HIGH — 2026-09-15

Host proof #3 at e9eb59e42 passed the synthetic-home and Crashpad child stat probe but failed browser_lost: real browser regression25.0s, canary isolation-and-mcp-startup66652ms. Reporter-disabled Chrome failed reading org.chromium.crashpad.database.initialized and com.googlecode.crashpad.initialized extended attributes. Full Lead receipt: host-round3.txt. Lead b0f95b33 authorizes file-read-xattr solely on the Crashpad subpath as the closing metadata step, never data/enumeration. If the next host test fails, stop widening, retain diagnosable fail-closed browser behavior and document the evidence chain; Lead owns the headed-Chrome follow-up.

Lead9cb98b1d permits a clearly test-only process-exec/file-map-executable grant for /usr/bin/xattr, leaving generated file permissions untouched; production never admits that executable. Sourceabd09303d includes that probe on Crashpad and /new, plus outside-subpath denial, and preserves real Node data/enumeration assertions. Final host retest gatefe7feec4-1c72-41d0-be92-4dbc2416ab53 is pending.

Review round10 at e9eb59e42 returned effective CHANGES_REQUESTED for HIGH v2-profile-project-dot-codex-writable, despite exact-head CI34942215588 success. Review evidence is preserved in review-round10.json. The model can write the trusted project's .codex configuration and .git metadata; effective config assertion omits MCP definitions. This HIGH remains unresolved, not covered by browser metadata authority. Direction questions52bf81ab and34300eac are pending; no scope reduction or acceptance claimed.

Current [official permission documentation](https://learn.chatgpt.com/docs/permissions) says workspace rules cover runtime cwd plus profile-defined roots, and extends=:workspace retains metadata protections unless overridden. Therefore changing only the helper's writableRoot is not assumed sufficient while .:write remains; verify the pinned CLI rather than infer confinement from generated TOML. A smaller restore-scoped-default experiment and effective-MCP pin should be evaluated before changing workspace placement.

### Browser hard stop after host proof #4; bounded Lead-profile correction — 2026-09-15

Host result fe7feec4 (host-round4.txt) at sourceabd09303d failed browser_lost again: root Chrome test35.8s; canary isolation-and-mcp-startup60163ms. Crashpad now attempts data open of settings.dat in the real host profile. Full chain: handshake IPC -> Crashpad stat -> Crashpad/new stat -> getxattr -> settings.dat data open. Lead explicitly refuses that next data-read/write expansion. Retain existing metadata/xattr grants and browser's diagnosable fail-closed browser_lost/chrome_launch_unproven path. Native headed Chrome host parity is an accepted deferred item, not a pass; Lead owns the follow-up issue. No further browser canary or permission widening in this round.

The xattr probe failed separately at the synthetic Crashpad directory. Lead allows explicitly binding the test-policy xattr exception to that synthetic subpath. The probe now does so, while preserving data/enumeration denials and outside-subpath xattr rejection. No real host Chrome profile xattrs are seeded/read by this probe.

Lead34300eac (profile-high-ruling.txt) supersedes the initial subtree-only direction52bf81ab: preserve normal project editing to match Claude Lead. Do not relocate writes in this candidate. Source876f585e6 removes the explicit .:write scoped override, retaining :workspace inheritance and restoring nested .codex/.git read rules. The pre-thread effective-config gate also requires the exact manifest-selected MCP server names and pinned launch fields, rejecting injected servers, command/env/args/tool changes, alternate URLs/cwd/credential env forwarding. Runner profiles are unchanged. Both new assertions failed before the implementation. Host proof must establish normal source writes succeed, config/git/hooks writes fail, and an attempted planted MCP is absent from codex mcp list. If the pinned-CLI experiment fails, return evidence to Lead before considering root relocation.

### Host validation of the retained editing policy and native xattr probe — 2026-09-15

The metadata canary initially exited41 from its CONFIG_WRITABLE branch with the isolated home under /private/tmp; no success is inferred from that run. With the same source876f585e6 and isolated home/project relocated beneath ~/.flywheel/qa, Lead's unsandboxed run at08:12:18Z exited0: ordinary source writes succeed, .codex/config.toml and .git/config/hooks writes fail, attempted evilprobe absent from codex mcp list. Lead7fe7d0cf explicitly accepts this first-sufficient result and rejects root relocation; ordinary project editing remains. See profile-host-pass.txt and profile-final-ruling.txt. This proves the tested non-temp home shape, not all possible Codex home placements.

The earlier xattr CLI probes failed even with an explicit synthetic-subpath grant. The final test-only C helper loads the exact generated policy and calls sandbox_init before direct getxattr(path), avoiding possible data opens by the xattr CLI. No additional execution/mapping/file grants. The generated Crashpad grant is explicitly checked against the synthetic path before running. Lead's unsandboxed probe at d53736acc on08:14:04Z passed1/1, no skips, stderr empty (xattr-host-pass.txt). Production browser grants are unchanged.

Lead b70623a1 authorizes proceeding to fresh review and QA under the revised acceptance: browser remains fail-closed, native headed Chrome compatibility is tracked in follow-up FLY-2587. This does not claim native Chrome launch or complete live Honey Lemon parity.
