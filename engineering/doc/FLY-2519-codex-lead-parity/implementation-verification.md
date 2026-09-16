# FLY-2519 Codex Lead 能力对等 — 实施验证
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-13
基于: plan.md

## 当前边界

实现进行中，C1–C5 均未整体完成。R2 design question `c2a10f39-eec6-4ee4-8db1-895dee044167` 已重新读取，effective reviewVerdict=APPROVED。Implement TURN epoch=2，execution `eb9fb39b-2fea-49bd-9fba-6d497a5ef678`。

没有 production migration/restart/drill、QA dispatch、ship/merge。配置/目录/receipt 单测不是完整能力对等或真实浏览器证明。未修改 pinned plan。所有 P01–P17 生产验收行仍未勾选。

## 已实施的基础

- C1：显式 `codexCapabilityBundleVersion: 2`，非法版本/后端/profile/companion/external 拒绝；canonical identity 层拒绝 CoS；JSON/env/shell 分别投影，v1 identityDigest 不变，旧配置不补字段。selector 已复用 common capability resolver。
- C1：固定 operation catalog、严格 bounded Zod schema、reserved 无 handler、manifest 独立摘要及有序 ruleSources。配置 resolver 仅投影有实际 handler 和认证服务的操作；缺失继续列入 missingOperationIds，目录不是授权。
- C1：只读 inventory 和 source AST 采集、CI literal registration，详见 implementation-inventory.md。配置、静态声明、live tools/list 严格分开。
- C2：既有 per-Lead journal.db 内 additive `lead_operation_receipts`，参数化 SQL、复合 key、input digest 冲突、CAS transition、unknown 禁止自动重发、原 handle 生命周期、回滚/重开/跨连接测试。
- C2：named profile renderer/validator，默认拒读、明确项目/资料/凭证路径、公共网络代理、本 Lead UDS allowlist、拒绝 legacy sandbox 和配置覆盖。尚未接入 runtime，尚未取得 OS canary 证明。

## TDD 与本地验证

| 命令/范围 | 红侧 | 绿侧 |
|---|---|---|
| config `exec vitest run src/__tests__/codex-lead-capabilities.test.ts` | 非法版本8项失败；不适用carrier/版本投影6项失败 | 37 passed |
| teamlead `exec vitest run src/__tests__/ProjectConfig.test.ts` | Claude配置非法版本4项失败 | 175 passed |
| comm `exec vitest run src/__tests__/lead-identity-cli.test.ts` | env版本丢失1项失败；CoS未拒绝1项失败 | 19 passed；identity既有10项也通过 |
| `bash packages/teamlead/scripts/__tests__/canonical-lead-identity.test.sh` | 11 passed / 1 failed，版本未传递 | 12 passed |
| catalog/manifest/resolver/profile | 新模块缺失红侧；canonical backend/order/control修订断言红侧 | 包含在下方36项 |
| receipts + journal | operationReceipts缺失，4项预期失败 | 新receipt 5项与既有journal 16项包含在下方36项 |
| teamlead `exec vitest run src/lead-capabilities/__tests__ src/lead-backends/codex/__tests__/SqliteJournalStore.test.ts` | — | 6 files / 36 passed |
| `node --test scripts/__tests__/qa-codex-lead-parity.test.mjs` | 新模块/额外source采集先失败 | 5 passed |
| comm `exec vitest run src/__tests__/lead-registry-cli.test.ts` | 初次缺teamlead dist validator；构建后1项5000ms timeout | 单独 `--testTimeout 20000` 重跑31 passed；原默认超时不改写成通过 |

`pnpm install --frozen-lockfile` 成功；config、teamlead依赖、comm、teamlead build 已成功。最终 teamlead typecheck 已通过；全仓 gates/代码评审/PR exact-head CI 尚待收口。一次 catalog 草稿曾在依赖未装齐时先写出，随后移出并确认真实 missing-module 红侧；这不冒充严格先红后实现，后续修订遵循 TDD。

## 权限/浏览器事实

本机 `codex --version` 为 0.153.2。`codex sandbox macos --help` 在本 runner 环境返回 `sandbox-exec: sandbox_apply: Operation not permitted`、exit71；未尝试绕过沙箱或扩权。非嵌套 host/QA 执行证据仍缺失。

2026-09-13 核对 [OpenAI permissions 官方文档](https://learn.chatgpt.com/docs/permissions)：named profiles 与旧 sandbox 设置不混用；必须启动 network proxy 才能执行网络规则；MCP 自身不受 shell network policy 统一控制。生成器遵循这些配置语法；文档与TOML解析不证明 OS 强制隔离。

Lead报告 `603e800a-cf38-46db-9e3b-7c36fba4b6e8` 已入 durable queue（即时nudge timeout不撤销）；内容明确实现中和host证据缺失。

## 继续位置

### C3 回复和GitHub写入（2026-09-14 00:20Z）

- Discord原 `CodexOutboundSender` outbox增加nullable reply_to，原表additive migration；enqueue冲突比较包含回复目标。只读getDeliveryStatus可核对预期Lead/channel/text/replyTo，不匹配不出具sent证明。旧schema迁移和关闭重开后证据/去重已测，无新增平行outbox或dedup表。
- `createBrokerDiscordOutboundSender`在可信parent内部组合原sender、CodexLeadOutboundHandler、buildLeadDiscordSend和既有dedup store。API token和bot token留在父进程；guard函数不序列化到HTTP/body。分块实际HTTP写点均接异步+同步+signal检查，缺guard拒绝；撤销/丢回复保留ambiguous，禁止重发。旧非能力调用路径保持兼容。
- DiscordFetcher增加单条消息固定REST读取，核对exact messageId/channel_id后才能引用replyTo。`thread.reply` handler按project/Lead/thread/operation/eventId-or-requestId的JSON tuple SHA256去重；eventId只是本作用域业务去重标签，不是授权。reconcile只读原outbox并核对完整输入，不能把冲突正文的旧sent结果冒充本次发送。
- GitHub新增pr.create/edit、pr.comment、issue.comment、pr.review。创建仅接受可信当前head/base集合；写入同时需要现行异步授权和贴近SDK调用的同步业务绑定检查。review固定COMMENT并绑定当前commitId，不开放APPROVE/merge/close。验证provider返回的repo/head/base/draft和ID，未知不重发。
- TDD：outbound新测试先修正测试括号语法错误，再确认真实missing-module红侧；精确消息读取红侧为fetchMessage缺失。回复新增8项红侧后通过；GitHub写入和provider证据错配红侧后通过。联合命令覆盖DiscordFetcher、capability-outbound、原outbound sender/handler/send、Discord/GitHub capability handlers和broker，8 files / 133 passed；typecheck与Biome通过。
- 当前仍是局部handler/服务装配，无daemon启动接线、live provider调用或生产切换。自动最终文本回复与显式工具回复的runtime去重协调仍待完成，不能用工具自身去重测试代替该验收。

### C2 第二批基础（23:38Z）

- `broker.ts`：纯typed执行器，原始请求64KiB、完整结果256KiB、15秒超时/AbortSignal；异步目标检查后重验activation/operation允许集；持久write去重、unknown仅只读对账、secret output拒绝。原provider/lease/current-registry检查必须由后续可信装配注入，当前没有生产provider。
- `broker-socket.ts`：每连接一个JSON请求、私有目录和socket、拒绝覆盖既有路径、畸形/多请求/超大请求在dispatch前拒绝、受管连接关闭。连接本身不返回secret。UDS fixture运行成功不代表Chrome或Codex模型沙箱证明。
- `model-env.ts` 与两个runtime env builder：可信 `capabilityModelEnv` pins 选择正向非秘密表，旧路径不变；无启动/config parser自动采用。显式bot/api/carrier/runner context后续spread不会回灌。
- 环境接线红侧3项预期失败后，新增边界+runner-action-MCP+两个旧runtime套件共165 passed；最后 broker/receipt/model-env/socket/catalog/manifest/resolve/profile/env接线共42 passed（9 files）。一次合并运行撞上尚未修完的结果envelope上限测试，已在修复后完整重跑42/42通过。
- Biome通过。该批仍未完成C2装配，不能激活v2；下一步需要proxy/CLI、可信source与credential解析、handler以及配置/profile/argv/thread启动链。

### C2 第三批基础（23:49Z）

- `flywheel-comm lead-operation --request-file <absolute-path|->` 与共享 UDS client：只使用非秘密 socket 坐标，输入64KiB、输出256KiB、UUID关联、无HTTP回退/自动重试；断链返回unknown并保留requestId。拒绝FIFO，避免打开阶段阻塞。命令在CommDB/actor选择之外分发。
- 原生MCP façade 仅暴露manifest批准的 `lead_operation`，tools/list由operation schema生成；校验manifest digest，拒绝未知/reserved操作及额外输入。proxy重建保留请求UUID；未接入受管launcher。
- missing-module红侧以及FIFO阻塞回归红侧后，comm客户端+命令+**编译后的真实CLI入口**共21 passed。MCP SDK内存传输8 passed；额外MCP→真实UDS→broker→SQLite→CLI-client的跨入口去重测试通过，同UUID只执行一次，改payload拒绝。该联通测试初次因断言未解析MCP文本封装失败，仅修正测试解析后通过；不是行为修复红侧。
- 本批是本地协议证明，不是live provider或模型启动/OS隔离证明。Linear等处理器与完整runtime装配仍在实施。

### C3 Linear 第一批（23:52Z）

- 七个Linear目录操作已有真实typed SDK handlers：get/search/create/update/assign/relations.set/comment.create。可信policy getter提供team/project、创建标签和可修改字段集合；department labels authorizer必须由后续parent装配连接现行项目源，尚未完成该接线。
- authorize在broker标记dispatched前校验目标；execute重验，await之后立即复核policy/activation/abort。跨项目/部门、self relation、非法state/label/assignee、缺失分页证据均拒绝；blocked_by交换源/目标。读取不依赖创建标签权限。
- missing-module与策略变化/授权时机回归红侧后13 passed，联合broker/实际transport共27 passed。teamlead typecheck与Biome通过。检查已安装Linear SDK request/client实现为一次fetch并抛出错误，无内建重试循环；这是源码检查，不是provider真机证明。SDK credentials只由parent注入client持有。
- 无live Linear写入，无runtime注册或生产验收勾选。Discord当前接口缺cursor/replyTo/eventId，必须扩展真实服务后再兑现这些目录输入。
- 后续outbound需要稳定去重key：broker的可信handler context现包含validated requestId，直接取协议UUID，不从业务input复制或重新生成。预期缺字段红侧后，broker/Linear/transport共28 passed，typecheck通过。
- `ChatThreadCreator.ensureChatThread`内部包含root POST、canonical注册、start POST及恢复/清理写入；外层handler检查不能覆盖中间await后的撤销。需要在实际写点传递可信beforeSideEffect guard，再注册thread.create；不能用空adapter宣布支持。
- 既有 `DiscordFetcher.fetchThreadMessages` 增加可选 `{before, signal}`，严格numeric cursor，旧调用请求字节保持不变；预期URL/signal红侧后，fetcher12 + 既有founder-consent evaluator21，共33 passed。此扩展仅读取历史，不改founder授权判定。
- Discord `thread.resolve/read` handler复用现有真实parent lookup与DiscordFetcher，要求可信canonical双向binding、policy revision、department authorizer、credential闭包。请求前后重验绑定/parent/activation，撤权不释放消息；分页拒绝不递减/不推进的结果。20 tests通过，与Linear/broker/transport联合48 passed。create/reply仍未注册；调用注册表尚未接入生产runtime。
- `ChatThreadCreator.ensureChatThread`支持opt-in异步 `beforeSideEffect` + 同步 `assertSideEffectCurrent` + signal。检查在root/start/recovery retry/member/cleanup/rename/notification的实际HTTP调用以及canonical DB claim前执行；拒绝异常穿过helper catch，不伪装成功。能力调用者必须提供同步当前source检查，覆盖await返回后未abort的策略撤销窗口。旧调用无hook时原行为不变；最终guard+creator/helper145 tests、typecheck与Biome通过。create handler装配仍在实施。
- fresh创建会自己发布canonical记录，不能无条件接受任何null→thread变更。新增同步 `onCanonicalThreadRegistered(rootId)` 仅在本调用CAS结果为registered时触发，异常停止后续动作；现有/竞争记录不触发。handler据此验证确切root并接纳自己的revision更新。observer红侧后guard13+既有creator73，共86 passed；typecheck/Biome通过。前一145范围未重复无改动的attach-pin9（其早先通过）；最终全仓gate仍待完成。
- `thread.create`现已注册到局部handler factory（仍无runtime装配）：固定issue/Lead/parent/token，name进入既有canonical title生成；可信createContext仅提供issueIdentifier/owner/route/model metadata。只接纳observer证实的自身canonical发布，其余revision变化拒绝；未证实结果unknown且不重试。6项红侧后Discord handler28 + creator guard13，共41 passed；其中2项使用真实ChatThreadCreator+内存StateStore+模拟HTTP验证fresh成功和root POST后撤权。teamlead typecheck通过。reply仍待既有outbound服务补齐字段和受管调用。

### C3 GitHub 第一批

- 按批准设计使用[官方Octokit REST SDK](https://github.com/octokit/rest.js)，固定依赖 `@octokit/rest=22.0.1`。安装成功，保留既有edge-worker/voice-codex peer warnings，未顺手改其他依赖。已检查安装源码仅组合request-log/rest/paginate，无retry plugin；parent须注入无重试插件且日志受管的client。
- 四个局部handler：pr.list/view/checks、issue.view。固定当前project/Lead/repository/revision，可信business-target authorizer；仅typed REST，numeric page cursor，不跟随模型或provider任意Link URL。provider返回外仓、缺失分页、未知状态与撤权拒绝。
- checks同时读check-runs与legacy commit statuses，校验各自SHA和完整计数/上限，并再次读取PR以拒绝中途head漂移；返回 `pr:N:SHA` providerRef。所有SDK读取传递AbortSignal。
- missing-module与head-drift/SHA/cancellation红侧后11 passed；teamlead typecheck与Biome通过。无GitHub provider真机调用；PR写操作、diff/run/log/push、parent可信source接线仍未完成。
- 本批收口联合命令 `pnpm --filter flywheel-teamlead exec vitest run src/lead-capabilities/__tests__ src/lead-backends/codex/__tests__/lead-capability-proxy.test.ts src/lead-backends/codex/__tests__/capability-model-env.test.ts src/__tests__/ChatThreadCreator.write-guard.test.ts`：15 files / 117 passed。这是聚焦联合回归，尚未运行本任务最终全仓gates。

1. C1：补全 P07 审计后的编译期 adapter 枚举、P15–P17 实际 tools/list/角色适用源；runtime/home/launcher 必须消费 v2 marker。当前没有可用v2 runtime，不得激活。
2. C2：可信 broker/socket/proxy、凭证消费者内存闭包、正向env、source metadata realpath、有效profile/config/argv/thread完整接线；重放与授权在await前后复核。
3. C3：逐组实际provider handlers + 原授权/foreign/stale/unknown/重放测试，不以catalog schema代替实现。
4. C4：共用实际rules/skills selector、原生Chrome worker/独立OS策略/egress/只读qa-view，真实正负例。
5. C5：runbook/机器证据收集器；完整 gates `pnpm lint`, `pnpm -r build`, `pnpm test:packages:run`，required shell tests，exact-head review/CI/PR，milestone最后commit，needs_review completion。

### C2 最终进程边界与当前身份；C3 编辑/反应

- `spawnCodexAppServer` 新的显式v2 parent pins在最终spawn处优先使用positive allowlist，旧washSecrets=false和late carrier injection不能覆盖。真实Node stub捕获token/custom auth/carrier泄漏红侧后转绿；旧两项spawn行为保持通过。尚未接到runtime assembly，不宣称仅此已解决上线启动链。
- 可见TUI同样在最终命令使用 `/usr/bin/env -i` 加安全shell quoting后的allowlist，拒绝与window不同的身份/home；不加入carrier `tmux -e`，不加入旧 `-s` 覆盖。真实stub poisoned env、tmux注入、identity mismatch三组红转绿。permissions仍须由实际home/config/thread装配保证，目前未接线。
- `runtime-context` 复用实际canonical resolver、v2 capability resolver及 `validateLeadCarrierAuthorization`。不要求runner actions；当前registry撤销/角色变化/伪造canonical环境/项目根变化拒绝。carrier exact evidence替换会同步拒绝，processIndeterminate不当作有效；无原始claim/env返回。12项通过；carrier测试使用合成evidence和确定性process probe，不是host证明。该context仍需在实际generation建立并传入broker/写点。
- Discord `message.edit` 仅可信policy.botUserId自己的消息，超过2000字符拒绝；`message.react` 使用固定PUT @me和编码emoji。均复用实际Discord HTTP helper、当前canonical/actual parent/message校验和写点guard，失去响应unknown不重发。外thread/author、mid-read撤销、PATCH/PUT断言与helper共75项通过。
- 联合回归：`pnpm --filter flywheel-teamlead exec vitest run src/lead-capabilities/__tests__/runtime-context.test.ts src/lead-capabilities/__tests__/discord.test.ts src/bridge/__tests__/discord-utils.test.ts src/lead-backends/codex/__tests__/spawn-env-wash.test.ts src/lead-backends/codex/__tests__/tui-window.test.ts src/lead-backends/codex/__tests__/codex-lead-runtime.test.ts`：6 files / 233 passed；teamlead typecheck通过。不是最终全仓gate。
- 架构问题 `f1f927d2-8ed5-48dd-8e7b-eb6906365860` 已向Lead非阻塞登记：Bridge持有canonical StateStore/ChatThreadCreator，Lead runtime没有该store；建议窄typed Bridge provider在原authority内做写点校验，不在Lead侧运行StateStore迁移或缓存响应伪装同步authority。等待答复期间继续其他能力和进程边界，不宣称已完成装配。

### C4 出口解析与实际代理第一批

- `browser-egress.ts` 每次连接重新解析全部DNS结果，拒绝私网/混合结果、映射IPv6、数字IPv4变体、userinfo、非HTTP(S)与控制字符，产出固定address/family；同一hostname下一次解析漂移到本机也拒绝。仅显式可信local QA origin可固定到loopback，且配置必须列出Bridge/admin/CDP保留端口；不允许外域/local wildcard。依据[Node BlockList文档](https://nodejs.org/api/net.html#class-netblocklist)、[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry)、[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry)设置保守范围；另外拒绝[Azure host virtual IP](https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16)。这些文档不替代连接/OS测试。
- `browser-egress-proxy.ts` 实际HTTP/CONNECT/WebSocket代理连接使用固定IP，HTTP Host保持原hostname，不再次DNS解析；连接前后检查当前activation/policy。监听本机动态端口，限制连接/header/timeout，关闭销毁socket；去除proxy-auth及hop headers，无认证凭证和URL日志。
- missing-module、userinfo/Azure负例、local QA目标、CONNECT和WebSocket红侧后2 files / 41 tests通过。测试使用真实本地HTTP/TCP/upgrade fixture，覆盖禁止本机目标、DNS之后撤权、CONNECT buffered bytes、重复close。WebSocket fixture最初错误地假定握手前就能收到客户端数据，造成echo缺失/cleanup超时；修正为等握手后data后通过，未改测试超时掩盖失败。
- 尚未接native worker、Seatbelt、Codex permission runtime或QA projection；实际Chrome/OS canary仍未执行，不能启用v2。当前代理测试不是TLS/真实浏览器/OS隔离证明。header/redirect/升级拒绝负例和长存连接生命周期仍需收口验证。
- 架构问题 `f1f927d2-8ed5-48dd-8e7b-eb6906365860` 已回复同意：typed Bridge provider内做canonical/department/claim同步复查和StateStore写入；禁止Lead runtime打开或迁移StateStore。outbox继续只归Lead parent；Bridge仅持现有outbound dedup/HTTP服务。nonreply入口正在接线；parent journal在HTTP前标记dispatched，未知结果跨重启不重发，不宣称Bridge进程内重复请求缓存是持久receipt。

### C3 GitHub diff / workflow run / logs；C4 锁定包配置

- 新增实际Octokit `github.pr.diff`、`github.run.view`、`github.run.log`：diff绑定head/base SHA，run要求明确workflow-run业务目标授权，核对run/repository/linked PR/head。logs仅已完成run，手工处理SDK 302；签名Location不返回模型、不向storage转发GitHub auth、不跟随storage redirect。固定[GitHub文档中的storage域](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，实际HTTPS request连接固定DNS地址，原hostname用于TLS SNI/Host。
- 复用已锁定yauzl3.4.0内存读取，不解压到文件系统；compressed8MiB/expanded32MiB/单entry8MiB/最多512项、时间/取消上限，拒绝遍历/symlink/encrypted/异常比例/non-UTF8 archive。网络和ZIP负例已测，没有live GitHub请求。
- 原草稿每页262144字符超出broker256KiB上限。真实broker红侧后，diff/log共用128KiB JSON编码后UTF8 text预算，保持surrogate pair并按实际UTF16 offset推进cursor。ASCII与Unicode/control多页通过真实broker，结果每页低于256KiB且完整重建。日志cursor还绑定run/head/attempt/archive digest；未知写操作无关，本批只读不增加认证权限。
- 独立GitHub两文件67项通过；与浏览器配置/出口/实际代理联合5 files / 110 passed。typecheck曾在并行未完成Bridge provider上报possibly undefined，不能记作该时点全包绿；最终联合typecheck另记。
- `chrome-devtools-mcp=1.9.0` 精确锁定到package/lockfile，npm integrity为 `sha512-RnzXoJiUQ44hpOihWk90uOhLD/CnwDkDy0ldHMZONJ2nYQ+dWN1fq1luHHqyd+7FuYnyIlCY6uTThbN5ut9kSQ==`。首次npm view因默认cache权限失败；改用 `/tmp/fly2519-npm-cache` 成功，无sudo/chown。安装使用ignore-scripts，保留既有peer warnings，不改旁支依赖。
- 已检查该版本安装源码browser.js的 `pipe:true`、默认autoConnect=false，CLI支持独立userDataDir/visible/禁遥测/禁CrUX/固定proxy/URLPattern/filesystemRoot；[官方README](https://github.com/ChromeDevTools/chrome-devtools-mcp)说明浏览器按工具需要延迟启动。`browser-config.ts` 仅生成固定worker argv与无凭证env，拒绝部署路径/QA目录与模型项目根重叠；未启动worker或Chrome。实际安装包parseArguments与URLPattern测试通过；parser会删除false autoConnect键，测试核对其不是true。安装包allowlist需要Chrome149+，实际host支持与OS隔离尚未证明，不能启用v2。

### C4 取消与转发尾部回归；Bridge 联合检查

- DNS stalled时取消原本要等lookup返回，真实红侧后增加15s等待上限和AbortSignal竞速。HTTP/CONNECT/WebSocket每个连接绑定独立signal，peer close/end取消等待与后续连接；三种断开后继续到dispatch guard的红侧均转绿。
- CONNECT 2MiB慢读fixture在单独执行通过，但联合范围复现正常上游close立即destroy客户端造成尾部截断。改用正常end刷新输出；没有降低payload或放宽断言。修复后出口/代理46项通过。
- 重新执行包含新Bridge provider/department membership、既有chat-thread routes/Codex Bridge wiring、Discord/GitHub/browser的联合范围：10 files / 276 passed，teamlead typecheck通过，9文件Biome通过。这仍是聚焦联合回归，不是最终 `pnpm lint` / `pnpm -r build` / `pnpm test:packages:run`。
- Bridge非回复入口代码已经挂入真实plugin，当前注册resolve/create/read/edit/react；peer abort、indeterminate carrier、异步lookup后department撤销均有拒绝回归。读取unknown可回收，65次失败后恢复读取不会capacity锁死，未确认写入仍不被缓存淘汰。parent broker adapter和真实journal重启证明正在实施；Bridge new-create HTTP fixture也在补证，不替代既有creator/CAS测试。

### Bridge 非回复 provider 收口批次

- `/api/lead-capabilities/discord` 已在Bridge plugin真实挂载，仅configured token + chatThreadsEnabled启用。严格五操作/UUID envelope；Bridge重新解析实际registry/carrier/canonical mapping，以当前Linear team/project/labels检查department，写点最终异步检查之后再同步检查。Lead parent不打开StateStore。
- 新 `DepartmentRegistry.isLeadDepartmentMember` 复用原有无歧义label matcher和role排除，用于普通能力；原spawn API/权限保持。当前schema只有match.labels，没有另造excludes配置。
- parent carrier processIndeterminate、第二次Discord lookup后Linear归属变化、caller HTTP断开三个实际失败回归已修复。Bridge缓存仅进程内并发/重放辅助，不能当持久receipt；read失败可回收，uncertain write不淘汰。durable不重发仍由parent journal负责。
- 追加完整HTTP新建两项characterization：请求UUID或identifier，实际StateStore session UUID、ChatThreadCreator及真实route，root正文/title均使用已验证Linear identifier，canonical记录保留UUID，不产生identifier重复行。既有代码立即通过，未冒充新红侧。provider共5项、typecheck和Biome通过；前一联合276项包含旧3项provider，新增两项单独通过，不虚报重跑联合。

### Parent → Bridge Discord durable adapter

- `handlers/bridge-discord.ts` 仅五个已注册非reply操作，固定canonical Bridge endpoint；token/claim仅保留parent闭包。请求前及响应后复查实际registry/carrier，严格UUID关联、64KiB请求/256KiB响应、15s取消、禁止redirect，不返回原始错误或credential。
- 真实Express provider + Bridge StateStore + parent SQLite journal/broker联合fixture证明HTTP之前receipt已dispatched、成功一次、响应丢失unknown、parent重启后pending/unknown不重发、同UUID不同input拒绝。carrier使用实际registry/evidence validator，仅ps系统边界因sandbox EPERM替换；没有声称真实process身份证明。
- root复跑adapter22项 + provider5项：2 files / 27 passed。agent另报typecheck/Biome通过；实际runtime generation/socket/handlers assembly仍未接入，不启用生产v2。

### C4 长存 MCP 连接、工具过滤与只读 QA 入口

- `browser-transport.ts` 在最终spawn使用精确env、不合并SDK默认环境；`sandbox-exec` 是唯一命令，无裸worker fallback。真实Node MCP fixture验证两次调用复用同一PID、父token/SHELL不继承、4MiB超长消息/进程崩溃使RPC失败、不自动重启。macOS child会自行增加CoreFoundation locale变量，测试单独排除该非凭据值并严格断言传给spawn的env。
- 真实worker父进程退出后，忽略SIGTERM的同组子进程曾残留；红侧后对独立spawn的本process group做有界TERM/KILL清理。测试证明其消失，不杀其他Lead/个人Chrome。该fixture不是实际Chrome helper进程归属证明。
- `browser-tools.ts` 明确21个准许工具的strict/bounded schemas；禁止upload/extension/未知工具和任意filePath/requestFilePath/responseFilePath，包括nested未知字段。new/navigate在当前authority下经过出口解析；截图由parent分配固定artifact area路径。对锁定安装包实际工具schema逐个兼容性验证，无Chrome启动。
- `browser-worker.ts` 一次activation一条持久MCP stdio连接，mandatory隔离验证callback通过后才能启动；核对manifest预期tools/list schema digest，拒绝未知变化/缺项。操作串行，独立generation拒绝旧页面引用；RPC取消/崩溃后标记lost，不隐式重连。两Lead真实fixture进程互不影响。callback尚未接真正OS canary，raw结果仍是parent内部值，必须经过后续output/artifact projection才可发给facade；当前不宣称browser能力可用。
- `browser-sandbox.ts` 只生成默认拒绝的独立Seatbelt launcher：canonical/disjoint source、非group/world-write部署树、0700QA、限制exec/map/network/process inspection，网络仅本proxy端口。语法依据[Codex Seatbelt](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)、[Chromium mac policy](https://github.com/chromium/chromium/blob/main/sandbox/policy/mac/common.sb)与宿主Apple wfs.sb；9项是规范/路径fixture测试，不能替代OS执行。宿主Node依赖Homebrew dylib closure、Chrome PID绑定Mach rendezvous仍待处理。已读host Chrome plist版本153.0.8010.37，只证明安装元数据，不证明可启动/隔离。
- `qa-view.ts` 实际loopback HTTP入口仅GET/HEAD固定root/snapshot/allowlisted-run，parent DTO callback不接收任意upstream path，strict DTO拒绝额外字段并escape HTML；所有已列stage/apply/action/method-override/SSE/WS/未知路径在provider调用前拒绝。限制header/请求/连接/响应，client disconnect/关闭取消读取；实际65th socket/half-open upgrade/concurrent close/listen错误恢复红侧后11项通过。仍需parent实际secret-free DTO mapper和proxy registration。
- Lead question `96a9b996-4994-44c9-b831-4c73cbd54dbb` 对cookie范围的澄清已记`review.md`，不改plan。上游CLI默认redactNetworkHeaders=false，真实parser红侧后显式加入 `--redact-network-headers`；额外实际NetworkFormatter验证text+structured Cookie/Set-Cookie/Authorization值不泄露且普通Content-Type保留。产品QA身份的run-end撤销还未接线。
- 联合8文件89项通过，之后追加上游NetworkFormatter一项、worker双Lead/并发取消两项分别通过（config3、worker6）；未虚报该时点联合92已跑。全包typecheck和12文件Biome另行记录收口结果。没有执行最终全仓gates/code review/PR，也没有生产激活。

### C4 Browser façade → broker → worker 输出；规则源比较

- `LeadArtifactStore` 为当前activation登记非秘密项目artifact，provider按handle读取时校验inode/size/SHA与当前身份；拒绝外来handle、symlink、内容替换、closed store。每件25MiB、总256MiB/128件，读取缓冲按已登记大小上限分配；artifact目录要求项目直接子目录，避免模型可写中间目录重定向。named profile将受管artifact root改为read；运行时仍必须证明模型不能rename/replace该目录或项目root，当前fixture不是这项OS证明。
- `browser-output.ts` 截图只读取parent分配的固定worker artifact路径，O_NOFOLLOW/nonblock+regular file+大小/mtime/格式头校验后转成项目handle；不转发private profile路径。普通工具仅受限text content，丢弃structured metadata，拒绝embedded file/resource与profile路径；known Cookie/Set-Cookie/Authorization头另做输出脱敏。上游错误仅通用失败码，JS/page文本仍是未信任QA数据。
- 21个native工具schema拆到纯`browser-schemas.ts`并逐个注册`browser.<name>` catalog操作；read/write分类、strict参数、generation与broker receipts均在parent执行。新增handler调用长存worker后经过输出转换。原始upload/未知工具没有catalog入口，直接socket调用也不能越过过滤。
- `browser-capability-proxy.ts` 是薄原生MCP façade，只广告manifest中明确的native工具；绑定browserGeneration、锁定包version和公开schema digest，使用既有Unix request client。它不启动Chrome或读取provider凭据。manifest可选generation进入digest，旧无browser projection保持兼容。尚需真实home/argv/runtime启动接线与保留现有lead_actions八工具兼容。
- 真实InMemory MCP client→原生façade→Unix socket→broker→SQLite journal→browser handler fixture证明：HTTP外的本机浏览器操作同样先dispatched、成功UUID重放不重做、外generation拒绝、worker响应丢失unknown后不重发。worker在本fixture被替代，不宣称实际Chrome/OS验收。最初fixture用macOS /tmp alias被canonical root检查拒绝，改为realpath后通过，未放宽安全检查。
- 新共享规则selector按实际Claude组装顺序记录base/shared/persona/skill原始SHA与adapter SHA；真实consumer receipt reader读取完整实际路径（含staged/new sources），双向检查遗漏/顺序/内容。13 PM来自canonical persona Skill map，研究/HTML/额外advertised skills缺失保持gap；namespaced skill red侧后支持安全namespace，拒绝遍历/控制字符。selector8项通过；真实双launcher消费、staged路径、技能安装inventory和backend adapter内容仍未接线。
- 本批联合12文件73项通过（包含selector此前7项），后来namespace追加一项单独通过；typecheck在并行Git transport尚未完成时仅报其58/59两处类型错误，不记录为当时全包绿。整仓gate、code review、PR和宿主canary仍未执行。

## Git feature push 私有 transport 与 deadline

- 新v2 handler从parent策略取得仓库、Git路径、目标分支与HEAD，拒绝default/main/master、变化的HEAD/身份/作用域；不运行模型提供的cwd/config/hooks。Git子进程只看到隔离staging、清洁env和一次性loopback地址，GitHub认证仅parent HTTP transport附加。旧gateway路径未切换。
- smart HTTP transport限定owner/repo、discovery/receive-pack和确切HEAD/分支，限制请求/响应字节，拒绝redirect/额外push；broker durable dispatched先于发送，unknown不自动重发。真实本地git-http-backend测试证明一次push、成功receipt replay、远端已更新但响应丢失后unknown与重开journal不重发；不是生产push证明。
- 私有对象复制拒绝模型alternates和静态symlink，限制4GiB/250000files及磁盘余量。FIFO metadata原先会卡在open，新增隔离子进程红侧后改NONBLOCK和bounded read；HEAD/loose ref/packed refs均有负例。父进程复制仍依赖运行时保护目录祖先不被模型替换；NOFOLLOW只保护末级，尚无敌对rename/OS canary证明，不得据此启用v2生产权限。
- 真实源对象193329files、1464465382logicalbytes：15秒初次失败，获Lead Git-only120秒裁定后私有复制烟测116866ms通过并验证清理。该烟测只运行真实clean-stage对象可达性，push由no-op替代；复制接近deadline，不宣称真实远端完整push能在120秒内完成。
- 根broker使用服务端operationId固定选择deadline，UDS服务端/客户端同步Git120秒+传输余量；模型不能提交timeout。fake-clock证明15秒时Git仍运行、120秒abort；真实17秒socket测试证明Git能跨过旧16秒限制，普通操作仍超时。实际MCP启动配置的tool timeout接线尚待完成。
- Git focused3文件36项通过；broker/socket2文件19项通过；comm client/command/CLI3文件21项通过。comm build、teamlead typecheck和scoped Biome通过。最终整仓gate/review/PR仍未运行。

## Bridge typed read 第一批

- `bridge.read`仅四个严格discriminated子资源：health、admission.status、sessions.list、session.status；输入request与输出result按资源分型。Bridge-owned StateStore、当前registry/v2dept/carrier与新鲜Linear作用域检查，parent只持固定endpoint adapter，不打开StateStore。
- 实际createBridgeApp已挂载 `/api/lead-capabilities/read`，不依赖Discord chatThreadsEnabled；parent runtime尚须注册handler map。foreign项目/部门、身份变化、缺失或未完整分页标签等拒绝或unknown。sessions.list是活动session投影，最多1000候选/每页100，offset不是一致性快照。
- 中断/超时使16个悬挂读请求释放容量，不产生迟到DTO；SDK不支持此处传入per-call AbortSignal，底层只读网络请求仍可能完成。三文件14项通过，含实际plugin路由404→200红绿；typecheck和scoped Biome通过。
- diagnostic/holds/questions/review/fleet/menu/epic/dependency/report等其余计划子资源仍缺；此批不是P07整体完成。

## v2 MCP实际stdio入口与Git deadline补充

- `buildCodexLeadMcpArgv`新增capabilityV2分支，严格验证manifest/browser generation/integration/schema digest，拒绝与任何旧gateway/leadActions/chrome配置共存（包括disabled Chrome）。仅生成lead_actions+chrome_devtools两项，固定actions/browser模式、两个公开坐标，无env_vars或裸Chrome URL。parent最终env隔离仍须runtime接线证明。
- `capability-mcp-entry.ts`为实际stdio进程入口，不启动Chrome；异常仅输出固定错误。测试用真实子进程、空临时HOME和无provider凭据完成两个入口的MCP initialize/tools/list；保留旧MCP31项测试。新入口暂只广告lead_operation，旧八工具兼容转发仍未完成，不能宣称完整工具对等。
- v2工具白名单变化曾导致configHash不变，红侧确认后将v2 enabledTools纳入摘要；保留旧spec摘要形状。测试同时覆盖篡改manifest、缺失浏览器、相对路径/控制字符和旧配置混用。
- 本机Codex在临时空HOME/CODEX_HOME下使用app-server --strict-config，接受tool_timeout_sec配置并成功响应initialize，随后关闭子进程；这只证明参数解析，不证明Chrome/MCP业务调用或OS隔离。
- Lead追加180秒裁定后，先改broker/transport/private-copy/façade测试，5项预期失败，再共用comm leadOperationTimeoutMs固定策略。broker、socket/client、Git relay和复制均用该策略；actions MCP185秒含传输余量，browser20秒，普通broker操作仍15秒。120秒记录仅为历史证据，不再是当前策略。

## 下一批实际runtime入口审计

- 当前parseCodexLeadRuntimeConfig不识别bundle marker；buildCodexLeadRuntime仍走旧full-access argv/env。新的argv入口尚未被这两处消费，不能启用v2。
- 最先接线切片：保留同一个SqliteJournalStore引用，v2 parent assembly先完成carrier发布/当前身份验证、handler与browser准备、manifest/home有效配置校验、socket监听，再spawn。spawnCodexAppServer已支持capabilityModelEnv但调用未传；必须接入并防止后续叠加秘密env。
- startProcess内部必须catch回收部分启动资源，因为外层runtime只在startProcess完整成功后执行shutdown；spawn/descriptor失败应证明socket与store关闭、intake零启动，重启同journal不重发unknown。
- headless/TUI均需完成named profile与实际start/resume descriptor校验；TUI ensureDaemon/home shell/tui-window旧-s workspace-write必须独立v2分支。不能猜RPC字段、复用未经验证的旧daemon/thread或以argv单测代替这些接线。

- 本批最终联合6文件87项通过（broker15、transport7、private-copy25、v2argv/stdio5、旧argv31、socket4）；comm build、teamlead tsc --noEmit、scoped Biome和git diff --check通过。尚未运行最终整仓三gate/code review/PR/host验收。

## 实际runtime部分启动失败清理

- buildCodexLeadRuntime保留同一SqliteJournalStore引用，统一shutdown关闭process、broker、parent outbox、journal；每层finally保证前一清理失败不跳过后一资源，重复stop不重复关DB。startProcess内捕获listen/initialize/outbound preflight失败并调用此清理，保留原始启动错误，避免外层processUp=false漏回收。未修改通用CodexLeadRuntime的旧阶段契约。
- 红侧：两个实际runtime测试在initialize失败时发现stop零次调用。绿侧：初始化失败及stop本身失败均关真实journal/outbox且不进入thread；追加真实parent socket先监听、initialize后失败并验证socket移除与journal关闭。runtime130+通用生命周期7，共137通过；teamlead typecheck、scoped Biome、diff check通过。
- 此批修复实际父进程失败路径，不是v2 parent assembly完成：marker/current registry、提前carrier发布、受限browser准备、manifest/home有效权限、v2 broker/socket和模型env/descriptor尚须接线。真实socket用现有write-capable broker测试，不能冒称v2权限/浏览器证明。

## v2 broker关闭与journal顺序

- 新close拒绝后续请求并abort所有在途context，等待broker结果/receipt处理结束后返回，供parent在关闭共享journal前调用。授权中请求rejected、不创建receipt；已dispatched写入unknown，不自动重发。close重复调用安全，迟到handler在guard处停止，不再访问receipt。
- 红侧两个测试均缺close；实现后修正fixture将无receipt预期null改为实际API的undefined。17个broker测试通过。联合broker/socket/browser facade/Git transport4文件31项通过；随后增加真实磁盘journal关闭再打开、同UUID仍unknown且provider零重发的断言，broker17项再次通过。teamlead typecheck、scoped Biome和diff check通过。
- close只等待broker协议/receipt收敛，不声称强制终止任意不遵守AbortSignal的底层SDK；provider必须继续遵守context guard。实际parent还须先关闭socket admission、await broker.close，再结束受管worker/底层资源并关闭store。本批未完成v2 parent装配。

## installed Codex named-profile协议与Process校验

- 本机codex-cli0.153.2通过 `codex app-server generate-json-schema --experimental --out <临时目录>` 导出协议，明确thread/start和resume使用`permissions`且不得与`sandbox`合用；initialize需capabilities.experimentalApi=true，响应`activePermissionProfile={id,extends}`仅为profile来源。普通schema只暴露legacy sandbox，不能据此证明named profile生效。
- `ThreadStartParams.json` experimental schema SHA256 `25f490368ec6df52a2a3b82a5469d2413307eb93439121b309f415b5648eee7a`。
- `ThreadStartResponse.json` experimental schema SHA256 `a338467af5fc271ace917f9d1262405642c3df3b66116aa105343db86cc9a76d`。
- `ThreadResumeResponse.json` experimental schema SHA256 `1d40932ee38f92f363424542d7581985cc627ea0ab2beff89663772c5f9f29c7`。
- `InitializeParams.json` experimental schema SHA256 `6f0094be9a65242ec779a40794cbd4fdfa32fca1e45084a16adfb50501d33ea2`。
- 临时空HOME/CODEX_HOME，合成 `[permissions.flywheel-lead-v2] extends=":workspace"`，initialize成功；ephemeral thread/start以permissions/cwd/approvalPolicy发出后返回-32603：`sandbox-exec: sandbox_apply: Operation not permitted`，exit71。未执行模型turn、未读取真实凭据、未绕过限制；没有activePermissionProfile实际响应或OS隔离证明。生成schema临时目录取hash后删除。
- CodexLeadProcess的start/resume普通与WithResult入口共享检查。携permissions请求必须显式实验性协商、固定profile、absolute normalized cwd、approval=never且无legacy sandbox/config权限覆盖；响应必须匹配profile id/extends、cwd和approval。此处仅验证provenance/cwd/approval，不宣称有效profile完整内容或网络/文件隔离。
- 红侧：start/resume错误profile被接受；缺协商请求进入RPC后测试超时。绿侧：Process34+实际runtime130=164通过；teamlead typecheck、scoped Biome、diff check通过。主runtime仍须识别v2 marker并实际选择此permissions字段、协商experimentalApi，之后完成有效home/config与OS gates。

## runtime v2显式选择（实施中，禁止交付为完成）

- parseCodexLeadRuntimeConfig只接受缺失或精确字符串2；空值、1/3/false/空白变体拒绝，v1缺失路径保持旧行为。v2调用当前registry context校验dept/backend/profile/version/identity与canonical项目根，旧FLYWHEEL_CODEX_LEAD_SANDBOX即使workspace-write也拒绝。
- buildThreadParams在v2输出固定permissions=flywheel-lead-v2、approval=never和项目cwd，不输出legacy sandbox。dry-run明确parent assembly pending，不展示误导性的旧full-access启动方案。
- **临时边界必须在本单交付前替换**：headless build和TUI parse当前抛capability_parent_not_assembled，防止已识别v2进入旧的凭据转发分支。该边界是未完成工作的标记，绝不是最终验收方案；必须接入真实parent/browser/handler/home/clean-env/lifecycle后移除，并补正向启动/失败清理/重启测试。
- 红侧非法marker被忽略、合法v2被旧workspace-write要求拒绝；完善fixture botUserId后重现真实红侧。TUI有效fixture原本继续旧路径，追加失败断言后守住该临时边界。runtime136+TUI29+Process34=199通过，typecheck/Biome/diff check通过；TUI既有测试输出缺少bot-token环境名警告，没有凭据值。

## parent组件接入headless生命周期

- `runtime-parent.ts`持有每activation私有目录/只读manifest/Unix socket/broker，复用外层传入的SqliteJournalStore.operationReceipts。先验证当前权限、manifest/handler/public路径，再执行真实部署验证callback，监听后再次检查current；失败和关闭均按socket→broker→providers→自建目录清理，不关闭外层journal。callback必须由生产装配实现有效配置/隔离验证，测试中的stub不是此证明。
- buildCodexLeadRuntime新增可信parent factory依赖；v2在startProcess中先发布carrier并创建parent，再初始化模型。实际spawn传capabilityModelEnv pins，使用parent MCP/named-profile argv，省去legacy full-access secret env/claim；experimentalApi=true，ensureThread前等待exact MCP server inventory，Process负责profile来源/cwd/approval响应校验。shutdown在关journal前await parent.close。
- root初始化失败集成测试使用同一个真实SQLite journal、真实parent socket和真实临时假app-server子进程：子进程捕获socket已监听、公开pins/named-profile argv、无TOKEN/SECRET/CARRIER_INSTANCE环境名，然后返回合成initialize错误；验证provider/socket/journal关闭。没有运行真实模型或浏览器；publisher与部署校验为测试替身，不能冒充live carrier或OS验收。
- 红侧缺parent模块/现有headless仍拒绝factory；真实socket路径在长临时目录超macOS限制，fixture缩短而未放宽限制。最终parent1+broker17+Process34+runtime136，共188通过；typecheck/scoped Biome通过。
- **仍未交付**：生产main尚未安装默认provider/browser/home factory，无factory时仍明确拒绝；TUI保留临时拒绝，dry-run仍标注pending。这些必须继续完成，不能以可注入的测试factory作为最终替代。新增待接线核对：model-env目前把TMPDIR指向artifactRoot，而profile已将artifactRoot设只读；生产装配须提供可写模型临时目录并验证，不能让普通CLI临时文件写入受管产物目录。

## 模型临时目录与受管产物分离

- LeadModelEnvPins和runtime-parent要求显式modelTempRoot，TMPDIR仅使用该坐标；artifactRoot仍只读受管产物，不回退为临时工作区。拒绝relative路径、相同artifactRoot或其子目录。生产provider/home装配须创建并验证项目内可写临时目录；本批只接坐标和实际spawn传递，没有放宽产物权限。
- 红侧TMPDIR仍为artifactRoot；改动后主runtime的真实假app-server子进程在project/.lead-tmp创建/写入/删除临时文件，捕获的TMPDIR与预期一致，仍无action secret/claim。同步更新headless/TUI/pane真实边界fixture。
- 联合6文件163项中两项旧完整env断言仍期待/trusted/artifacts，其他161通过；修正literal旧断言后env相关2文件7项通过。其余5文件此前159项通过，涵盖runtime136、pane16、spawn3、parent1、model-env3。typecheck运行至正常exit0，scoped Biome/diff check通过。最终整仓gate/代码评审/PR和真机OS验收尚未执行。

## Linear可信元数据装配

- 新增createLinearProviderHandlers：可信parent持有LinearClient和env，使用现有canonical/carrier context、当前projects文件、DepartmentRegistry生成真实SDK策略。团队按配置key、项目按name精确且唯一匹配；部门标签与可选项目scope标签在创建时强制写入，跨部门标签不可作为更新白名单，只有active团队成员可分配。
- 每次authorize与execute独立读取元数据，无按requestId保留的授权缓存；读取后和原有handler的同步policy/写前边界都检查当前registry revision与activation。分页不完整、重复ID、缺失标签、重名项目和中途配置变更拒绝；单连接上限250，超限保持拒绝，未实现无限分页。未配置明确Linear project的registry保持不可用，不能猜测项目。
- 红侧新增provider模块缺失；绿侧新增9项与既有Linear13项，共22通过。新用例覆盖成功创建的强制标签、分页/重名/缺标签/配置漂移/跨部门标签/停用成员/错误activation以及authorize后元数据变化。teamlead typecheck exit0，scoped Biome通过。测试使用SDK与carrier替身，真实解析临时registry；不声称在线Linear操作或实际carrier证明。
- 此组件尚未由生产默认parent factory注册；SDK凭据装配、其他provider/浏览器/home、TUI、规则包、剩余差集、整仓gate与PR仍待完成。StateStore未打开，未引入缓存Bridge授权。

## 实际有效权限配置接线

- 本机Codex0.153.2的实验schema确认config/read支持cwd和includeLayers。使用临时空HOME/CODEX_HOME、清洗env、合成profile，实际initialize→config/read探针证明：未设置sandbox_mode/sandbox_workspace_write返回null；permissions额外含description、filesystem.glob_scan_max_depth、network.socks_url/mode/mitm的null字段。旧validator会误拒绝两种正常响应。
- TDD分别重现legacy-null误拒绝和permission对象规范化误拒绝；只忽略明确观测的unset null字段，保留非null覆盖和未知字段（即使null）的拒绝。生成配置与真实config/read合并结果经实际assertLeadPermissionProfile验证通过。探针未创建模型thread或turn，未调用生产provider；临时home/schema/profile/响应已删除。这是协议/有效配置验证，不是OS confinement proof。
- parent现在独立保存预期permission spec（brokerSocket/artifactRoot取自身pins），部署callback获得副本；verifyEffectiveConfig直接执行既有权限validator并前后检查current，不让callback自行宣布模型实际配置正确。
- headless实际startup在initialize后调用config/read(cwd=canonical项目根, includeLayers=false)，拒绝RPC错误/缺config/权限不匹配；ensureThread在创建或恢复前再查一次。真实假app-server子进程新增初始化成功但config被覆盖场景，验证拒绝并关闭provider/socket/journal。红侧旧runtime未查config，进入inventory等待而测试超时；接线后绿侧快速拒绝。
- 最终runtime137+parent1+permission5=143通过，teamlead typecheck exit0，scoped Biome和diff check通过。生产默认factory、home生成、OS canary、TUI及剩余差集仍待接入；没有用测试factory代替生产交付。

## v2 home实际写入接线

- 新增ensureLeadCapabilityHome，并由startLeadCapabilityParent在verifyDeployment前实际调用；生成受管profile的config.toml，不写action credentials、auth链接、MCP env或启动daemon。home与activationRoot须已存在、canonical、owner-only且在模型项目外；目录创建与auth既有provisioning仍由生产装配负责。
- 首次生成采用独占临时文件、0600与fsync后rename。重启仅允许旧文件严格等于当前策略（可变化项仅同一activationRoot内run-*/broker.sock及合法loopback代理端口），然后更新坐标；其他旧版/显式修改的配置不覆盖。输入文件有NOFOLLOW、regular/nlink/uid/mode/1MiB检查；await current后复核目录inode与原文件内容/身份，撤销时清除临时文件且保留原文件。该路径依赖runtime独占activation与模型对home的OS写入禁止，不宣称防住任意同uid敌对进程的rename竞态。
- 红侧缺模块；随后parent测试证实部署验证前没有生成真实配置。接线后home6+parent1+runtime137=144通过，teamlead typecheck exit0与scoped Biome通过。用例涵盖幂等、socket/port轮换、旧sandbox配置、额外MCP、符号链接、公用权限home、外来socket和写入时撤销；实际headless假子进程测试经过真实home写入。
- 默认factory仍未完成，旧shell ensure-home尚需由v2 launcher路径替代；未执行生产配置迁移/覆盖、daemon启动或OS隔离验收。profile/permission验证不可当作完整能力对等、规则包或浏览器交付。

## 浏览器provider生命周期装配

- 新增startBrowserProvider，串接真实egress proxy、activation专用browser-*目录(profile/tmp/artifacts)、持久BrowserWorker与createBrowserHandlers；worker拿实际proxy端口，公开返回generation/handler map/proxyPort和幂等close。共享LeadArtifactStore继续由外层拥有。
- close按worker→proxy→QA identity revoker→自建QA目录执行，每步finally确保后续清理。启动失败也运行同一清理链并保留原启动错误。QA parent目录必须canonical、owner-only且与项目目录不重叠；只删除自身mkdtemp目录。
- 红侧模块缺失；绿侧provider2+handler2+egress-proxy8+worker6=18通过。provider用真实HTTP代理及真实临时目录，worker/host-verifier/product-identity是替身；覆盖成功关闭两次、代理关闭后连接拒绝、worker启动失败以及worker关闭/revoker同时失败时仍清理目录并保留原启动错误。调用revoker不等于远端QA身份已撤销，错误路径没有冒充成功。
- 该装配入口尚待默认parent factory调用。真实host verifier仍强制传给BrowserWorker，不能用常量callback开启生产；没有真实Chrome启动、模型浏览、产品QA账号使用或权限放宽。
- 本批teamlead typecheck exit0、scoped Biome与diff check通过；整仓gate、评审、PR仍未执行。

## Browser实际Seatbelt探针与固定provider接线

- 新增verifyBrowserIsolation：用worker同一policy、node executable、cwd和纯净env执行固定Node探针。只创建随机合成文件与本地临时服务，验证QA目录写入/指定proxy TCP连接成功，同时外部文件读取、QA内symlink越界读取、外部文件写入、未允许的本地TCP连接和额外监听均返回EACCES/EPERM。父进程要求nonce/全部布尔检查/精确字段数，空响应、非零退出、超时或缺证据均browser_isolation_unproven；stdout4KiB/运行5s有界，stderr不转发，临时目录与服务finally清理。
- startBrowserProvider固定调用该实现，不再接受生产调用者提供空verifyIsolation；BrowserWorker仍负责在校验后启动上游和检查schema/generation。这只覆盖列明的文件/网络探针，不代表Chrome功能兼容、所有model shell/keychain/process-info canary或完整隔离验收。
- 红侧缺模块，测试ESM spawn无法spy的问题改为Vitest模块mock后，真正启动不经Seatbelt的Node：正向probe全成功、负向probe全失败，verifier拒绝；补空stdout和exit71拒绝及临时目录清理。provider红侧旧外部callback未调用实际verifier，固定接线后通过。最终isolation3+provider2+worker6=11通过；teamlead typecheck exit0、scoped Biome/diff check通过。
- 当前host在runner内直接执行/usr/bin/sandbox-exec（allow default + /usr/bin/true）仍返回71及`sandbox-exec: sandbox_apply: Operation not permitted`。这不是测试绿，也不是OS通过；未绕过环境限制。仍可继续其他实施工作，真实启动若遇该环境必须拒绝。没有运行真实Chrome或修改生产配置。

## P07 resident hold只读投影

- bridge.read新增固定session.resident-hold子资源，真实Bridge route在现有registry/carrier/Linear部门校验后读取Bridge-owned StateStore.getResidentHold，返回nodeId/state/revision/grace期限/releaseCause或null。无新增StateStore表/写入，parent不打开数据库；run/activation/boundary/closed_reason/release_source不外传。
- 查询Linear期间session转出项目的红侧返回200；改用已有projection同步复核最新session业务绑定后，403且不读取hold。parent对新增DTO同时核对executionId，错execution响应为unknown。
- 红侧新resource400、session变更漏检、parent错execution误接受；绿侧Bridge6+parent-adapter4+catalog6=16通过，teamlead typecheck exit0/scoped Biome/diff check通过。新测试使用真实Bridge HTTP/SQLite session和persisted-shape hold getter替身，证明route投影与范围守卫，不声称新增hold存储或恢复证明；既有hold生命周期存储未改。
- 默认factory部署选择问题已发Lead：f1bab1b6-9d8d-4b5b-8c24-e79fc274bd41。当前codex-lead.sh仍从SCRIPT_DIR/../dist或npx tsx源码启动；询问已有updater-managed immutable runtime+dependencies bundle机制，若无拟采用项目外versioned descriptor并禁止v2源码fallback。不是ship授权请求；等待期间继续独立实施。

### 部署问题已裁定（待实施）

- q f1bab1b6-9d8d-4b5b-8c24-e79fc274bd41：无独立immutable bundle机制，本单禁止新增外部versioned descriptor/供应子系统。沿用scripts/update-flywheel.sh对生产~/Dev/flywheel的ff-only/build及~/.flywheel/deployed-sha；启动验证checkout HEAD==deployed-sha，并将dist关键入口sha256写入journal/receipt。不改updater。
- v2 launcher只绑定SCRIPT_DIR/../dist；生产禁止npx tsx fallback，仅显式dev变量可启用。parent与MCP worker使用该dist；模型拒写生产checkout除worktrees/外所有路径。生产checkout由updater单写，Lead/Runner模型只写worktrees。已向用户简短确认收到；下一批落实后向Lead报告，不能把此裁定当作已实现或部署通过。

## updater部署真相验证与receipt组件

- 按q f1bab1b6裁定新增verifyLeadDeployment：固定/usr/bin/git、清洗Git环境、限时rev-parse HEAD，前后两次与现有deployed-sha比较；固定7个dist入口读取SHA256。拒绝非canonical/symlink、缺失/空文件、special/hardlink、group/world可写入口、读取中stat变化与SHA不一致。读取有界，无fetch/build/updater改动。
- recordLeadDeployment将验证结果原子0600写入现有stateDir/capability-deployment.json，包含schemaVersion、checkoutRoot、HEAD、observedAt和固定入口摘要；失败保留上一份receipt。不新建bundle供应或数据库表。摘要是观测产物证据，不宣称可重复构建或自动证明dist来自该源码。
- TDD缺模块/缺record入口红侧后，真实临时Git仓库+固定dist文件测试绿；覆盖GIT_DIR环境干扰、部署SHA错误、缺入口、符号链接、公用可写入口，以及receipt落盘和失败不覆盖。focused1pass、teamlead typecheck exit0/scoped Biome/diff check通过。
- **部署裁定尚未全部落实**：本组件尚待launcher/default factory调用；生产禁tsx fallback、生产checkout只读/worktrees写root与journal启动链仍须接线。没有运行生产部署校验或修改生产receipt，不能把此组件测试当作生产收敛证明。

## v2 launcher部署预检与生产源码回退关闭

- codex-lead.sh在v2生产路径先调用SCRIPT_DIR/../dist/bin/verify-codex-deployment.js；缺入口或预检失败exit78，位于旧home/daemon操作之前。helper从自身固定dist位置推导checkout，读取HOME/.flywheel/deployed-sha；dry-run仅验证，正常预检将receipt写入已有stateDir。该helper也纳入固定摘要清单（现8项）。
- headless与TUI的隐式npx tsx fallback在v2生产均关闭；只有显式FLYWHEEL_CODEX_LEAD_DEV_SOURCE=1允许开发源码路径并跳过生产部署预检。旧bundle保持原行为。v2 TUI不再执行旧ensure-home/ensure-daemon写入，home由已接线的parent组件拥有；TUI runtime本身仍待完整接入，不能声称已能启动。
- TDD红侧两个v2模式都默默执行源码；加入拒绝后绿。TUI non-dry-run红侧仍运行old-home；分流后不再调用。实际脚本测试覆盖dist优先、源码dev选择、预检失败在home之前终止；既有core mention launcher4项保持通过。
- 新增真实Node CLI验证：将真实TS helper/deployment实现编译到临时packages/teamlead/dist，真实Git与marker支持dry-run无receipt、正常预检落receipt、marker错配exit78且不覆盖旧receipt。不是生产执行或model运行证明。最终launcher2+既有4+deployment2=8通过，teamlead typecheck exit0、scoped Biome、bash -n、diff check通过。
- q f1bab1b6裁定中launcher/预检/receipt部分已接；默认factory、生产checkout模型只读/worktrees写边界仍待落实，不能提前报告整个裁定完成。

## updater生产checkout模型写入边界

- LeadPermissionProfileSpec现在要求显式deploymentRoot，renderer及有效配置validator共享leadModelWritableRoot规则。projectRoot等于生产checkout时只把其worktrees/列为写root，生产checkout显式read；项目若位于checkout内，只接受worktrees/及其子树，拒绝packages/、相似前缀worktrees-escape和包含整个checkout的祖先目录。与生产checkout独立的项目保留既定写root，受credential deny限制。
- parent已调用同一规则检查modelTempRoot：必须是写root的真子目录、realpath等于pin且已存在的目录；不能把TMPDIR落到只读生产区或home。home materialization/实际config-read比较自然携带deploymentRoot派生的预期策略。生产default factory仍须从既定dist推导真实deploymentRoot，不接受model路径输入。
- 红侧生产根仍整体write；修复后配置覆盖/危险root拒绝。追加红侧parent允许TMPDIR指向home；修复后启动前拒绝并清理。最终permission6+home6+parent1+runtime137=150通过，teamlead typecheck exit0/scoped Biome/diff check通过。测试证明配置和启动校验，不是Seatbelt OS enforcement或production model写入实测。
- q f1bab1b6的launcher+配置策略组件已落实，仍需default factory实际绑定这些组件和完成TUI/生产验收证据，不能声称整体部署裁定已完成。

## 真实browser upstream schema固定值

- 默认factory盘点发现upstream schema摘要此前只能由调用者提供。已对本机锁定chrome-devtools-mcp@1.9.0执行清洗env的initialize/tools-list：两次独立临时HOME均29tools、无分页；再用buildBrowserWorkerSpec完整flags捕获一次，摘要均为93634c4bb94d23957cb3907af5b7b29d01fc70e1d0746d457e318eb98c97f492。未调用browser tools，没有打开Chrome或传业务凭据；capture临时文件已清理。
- BROWSER_UPSTREAM_SCHEMA_DIGEST与锁定version共置browser-config，production browser provider固定使用它，移除任意调用者摘要参数；较低层worker仍按启动时真实inventory比较并拒绝漂移。
- 新增真实已安装上游MCP子进程测试，使用worker完整flags及不可执行的假Chrome路径；tools/list成功并验证29工具和固定摘要，证明metadata阶段无需启动Chrome。红侧常量缺失，provider仍传测试a摘要；固定接线后upstream1+provider2+worker6=9通过，teamlead typecheck exit0/scoped Biome/diff check通过。该证据不代表Chrome操作/OS隔离通过。
- 默认factory仍需实际目录/credentials/provider总装与后续TUI/rules/其余差集；本批解决其schema pin依赖，没有把组件接线冒充整体验收。

## activation实际目录组件

- createLeadRuntimeDirectories使用既定leadModelWritableRoot：生产checkout下只在worktrees/创建本次.lead-runtime-* scratch（artifact/tmp）；不创建Git worktree、不修改源代码。control/a与control/qa来自项目写root外的短tmp mkdtemp，便于后续Unix socket路径限制。公共worktrees目录若缺失可创建但不由activation清理。
- 所有入口与目录要求canonical、当前uid拥有、非group/world可写；固定dev/ino并在assertCurrent重检。close只移除自身两个mkdtemp根，已替换的目录保留并报错，其他控制资源继续清理。外层须先关闭worker/broker/artifact store，再调用该close；这些是短期activation数据，不作为Git源码工作区。
- 红侧缺模块；绿侧真实目录+LeadArtifactStore写读、worktrees symlink拒绝、目录替换失效/保留foreign内容与控制目录关闭。directories3+artifacts5+permission6=14通过，teamlead typecheck exit0/scoped Biome/diff check通过；未创建生产目录或证明OS隔离。
- 此目录组件尚待default factory调用；工厂/凭据元数据/全部provider/TUI/rules/其余差集/全仓gate/评审/PR仍未完成。

### Model named-profile file/network canaries (2026-09-13 local)

- Added `verifyModelIsolation`: invokes the installed Codex `sandbox --permission-profile flywheel-lead-v2 --cd <project> -- <node> ...` with the same allowlisted model environment and fixed synthetic program. Checks scratch write and proxy connectivity, rejects external/symlink reads, external/artifact/deployment writes, private TCP access and local binding. Only EPERM/EACCES count as denials; missing files, connection refusal, timeout, malformed or incomplete results never count as success. Nonce-bound output is bounded to 4 KiB and the subprocess group to 5 seconds; temporary fixtures are removed.
- TDD red: focused test could not import the absent module. Green: three executable negative cases replace only Codex launch with real unconfined Node, empty output or exit 71. The unconfined child demonstrates positive scratch/proxy checks and failed protection checks, and is rejected. Assertions cover exact named-profile argv, absence of inherited synthetic secret/NODE_OPTIONS, and fixture cleanup.
- Local installed CLI help confirms named-profile and cwd switches. Executed the new verifier against installed Codex with a freshly rendered profile and disposable directories: `model_isolation_unproven` (exit 1). This is a failed host check, not positive OS confinement evidence; the verifier intentionally suppresses child stderr. Previously observed nested Seatbelt rejection remains separate evidence, not a diagnosis inferred from this stable error.
- Joint model-isolation (3), model-env (3), permission-profile (6): 12 passed. Teamlead TypeScript check and changed-file Biome passed. This module is not yet bound into the production default factory. Keychain/process inspection, complete credential-source canaries and host acceptance remain outstanding; no production activation or credential access occurred.

### Model canaries bound to parent startup (2026-09-13 local)

- `startLeadCapabilityParent` now directly invokes the actual model verifier after home materialization and before the deployment callback or broker listen. A factory cannot omit this step by providing a successful deployment callback. Codex executable is a required parent option; optional parent env is still washed inside the verifier. Async current-activation checks are awaited before and after probes.
- TDD red: startup order was only `verified`, missing `model-verified`. Green: parent lifecycle fixture proves exact executable/home readiness, broker socket absent during verification, verifier failure skips deployment callback and closes providers. Runtime protocol fixtures explicitly mock the separate OS verifier; these are not host isolation evidence.
- Parent (1), model verifier (3), runtime (137): 141 passed; TypeScript and changed-file Biome passed. Added the model verifier to the fixed deployed dist hash receipt entries (now 9). Default production factory, broader canaries and TUI assembly remain outstanding.

### P07 scoped repository/head code-review record read (2026-09-13 local)

- Added typed `bridge.read` resource `session.code-review`, requiring execution ID, explicit `__main__` or owner/repo identity, and lowercase 40-character HEAD. Bridge reuses current registry/carrier checks, fresh Linear department/team/project scope and post-await session binding checks before reading its own `getCodexReviewRecord` by all three coordinates. Stored project/issue/execution/repository/head must match. No record is represented as null; it is never inferred from another HEAD or repository.
- Projection contains only record status, author/reviewer family, rounds and approved timestamp. No thread, request, event or transport credentials are emitted. A raw durable record is review evidence, not the effective review gate or ship approval. Parent transport independently correlates execution/repository/head before accepting the response.
- TDD red: new resource returned 400; after server implementation, parent mismatch test exposed incorrectly accepted foreign coordinates. Green: real in-memory SQLite review rows and HTTP route prove scoped pending record, missing head/repository, foreign department and changed session binding; parent rejects all three coordinate substitutions. Current carrier and Linear metadata are test doubles, not production proof.
- Joint Bridge read (7), parent read (5), catalog (6): 18 passed. Initial joint run failed the pre-existing actual Bridge mount test at 5000 ms while TypeScript ran concurrently (17 passed, 1 failed); serial rerun passed without timeout changes. TypeScript passed. Changed code formatted with Biome; existing unrelated formatting preserved.
- Default production parent factory still not assembled; this completes the typed read/provider branch, not full P07 or overall parity. No external mutation, production activation, PR or QA handoff.

### Credential-source alias pinning in parent (2026-09-13 local)

- Added metadata-only credential path pinning and bound it into parent construction/current checks. Exact declared paths plus resolved aliases are included in generated filesystem denies. Absent descendants resolve through their nearest existing ancestor; dangling/cyclic links and invalid/unbounded metadata fail closed. The resolver never opens credential contents. Creation of an ordinary previously absent file remains valid; alias retargeting invalidates the activation's current check.
- TDD red: helper absent, then real parent rejected the expected profile containing the resolved alias because it emitted only the source name. Green: filesystem tests exercise a synthetic unreadable credential, missing descendants, alias retargeting and invalid inputs; actual parent-home lifecycle now emits both source and target denies. Parent uses a copied/frozen path set and checks metadata again after asynchronous identity checks.
- Credential paths (2), parent (1), runtime (137): 140 passed; changed helper rechecked after replacing the lint-disallowed control-character regex (2 passed); TypeScript and changed-file Biome passed.
- Source list discovery is still a trusted factory responsibility. This verifies the declared source paths rather than claiming a complete host credential inventory or arbitrary same-user filesystem-race protection. The production default factory, actual source list/skills, TUI, remaining providers and host acceptance remain incomplete.

### Manifest-bound instructions reach v2 thread start/resume (2026-09-13 local)

- Parent reads ordered manifest rule sources once, verifies SHA-256 over their bytes, bounds each file to 1 MiB and aggregate to 4 MiB, rejects missing/empty/changed/non-file/invalid UTF-8/known-secret content, strips only leading tooling frontmatter, and exposes the immutable concatenated instructions. Missing rules cannot become an empty default persona. Errors contain no rule contents or file paths.
- v2 runtime now builds thread parameters from the verified parent text after parent startup. Legacy launcher file reads remain limited to v1; v2 cannot silently select a different `SYSTEM_PROMPT_FILES` set. Both new and resumed threads receive the verified snapshot.
- TDD red: helper absent, then parent returned no instructions, then v2 runtime still tried the absent legacy rule path. Green: file tests cover ordered/frontmatter output and mismatch/missing/empty/secret rejection. Real executable protocol fixtures now reach actual `thread/start` and `thread/resume`, capture parameters, and prove `Verified parent rule` survives changing the source file after parent assembly. The child rejects the thread intentionally so cleanup is also exercised. These fixtures mock OS canaries and carrier, not production host proof.
- Instructions (1), parent lifecycle (1), runtime (139), deployment (2): 143 passed. TypeScript and changed-file Biome passed. Fixed dist receipt now also hashes instructions and credential-path helpers (11 entries).
- Actual complete rule/skill source selection, adapters/provisioning, default factory, TUI assembly and remaining capability providers remain outstanding. This connects declared rule evidence to actual app-server thread parameters; it does not prove complete P13/P14 or full parity.

### Actual v2 launcher base-rule selection gaps (2026-09-13 local)

- Audited the real `rules_bundle_add` sequence in `claude-lead.sh` against the shared shell resolver used by `codex-lead.sh`. v2 now includes `default-enable-policy.md` immediately after doc-flow, and emits department patrol after the summary-duty block, matching the actual Claude consumer. Existing v1 selection/order remains unchanged; the marker must be exactly `2`.
- TDD red: actual shell resolver output lacked default-enable. Green: executable resolver test compares emitted file ordering, actual Claude append statements and legacy behavior. Existing launcher/node-shim cases also pass: 27 tests total, plus `bash -n` and changed-test Biome.
- Initial test invocation inherited a host BASH_ENV that emitted `.bashrc` pyenv/zsh conditional errors; the requested red assertion still failed as expected (26 passed, 1 failed). Verification rerun used `env BASH_ENV=/dev/null` for that test process only. No host startup file was changed.
- The source audit also confirms the existing Discord reply contract names a Claude plugin tool. It is not copied into Codex unchanged: that contract still needs an explicit transport adapter together with the pending automatic-reply/proactive-send dedup work. Project/skill source selection and actual default factory remain incomplete; no claim of complete rule parity or production activation.

### P02 actual typed Bridge reply delivery (2026-09-13 local)

- Added `discord.thread.reply` to both the parent HTTP adapter and mounted Bridge operation route. The route composes the existing guarded `createBrokerDiscordOutboundSender`, current registry token resolver, current canonical thread/channel binding and DepartmentRegistry authorization. The in-process transport requires both asynchronous and synchronous side-effect guards; no model HTTP endpoint/header/token control is added.
- Production `createBridgeApp` passes the same existing `codex-lead-outbound-dedup.db` store to automatic outbound and the typed provider. Typed replies use a Bridge-owned durable outbox at `~/.flywheel/codex-lead-capability-outbox.db`, with the existing CodexOutboundSender schema. Each request closes its sender after settlement; the shared dedup store keeps its existing Bridge lifetime. This is a new durable data file, not a StateStore schema/table change. Preserve it and unresolved parent receipts during rollback/reconciliation; do not delete and replay uncertain writes.
- TDD red: valid reply request returned 400. Green: real local HTTP with SQLite outbox/dedup sends one simulated Discord POST across same-request replay and a second request with the same business event ID; foreign department is rejected. Parent→actual Bridge integration verifies confirmed local receipt replay after parent restart, and lost HTTP response stays unknown across restart with no second Bridge request/Discord write. Discord network and process-start probe are fixtures, not live Honey Lemon acceptance.
- Joint Bridge provider (5), parent adapter (22), guarded outbound (4), sender (26): 57 passed. After adding the two parent reply/restart cases, the full parent-adapter suite passed 24 tests. TypeScript and changed-file Biome passed.
- Ran exact `pnpm lint`: first failed on a formatting error in this task's earlier resident-hold fixture. Fixed that formatting only and reran exact `pnpm lint`: exit 0, 3581 files checked, 16 existing warnings; StateStore remains over the configured Biome size limit. No unrelated warning cleanup. `pnpm -r build` and `pnpm test:packages:run` remain outstanding.
- Shared durable storage does not yet unify automatic-output and proactive-tool business keys. Cross-path duplicate suppression and the Codex Discord instruction adapter remain pending, as do default factory/TUI/full parity/review/PR/host acceptance. No production API call, restart or activation occurred.

### Full repository verification and environment accounting (2026-09-13 local)

- Exact `pnpm -r build` passed at `8f491e13d6b882742eeeacc793ab95a64d04e2c5`; build left the worktree clean. Log: `/tmp/fly2519-build-20260913.log`.
- Exact `pnpm test:packages:run` failed in config: 52 files passed, one failed; 831 tests passed, two failed. Both feature-flags-drift assertions reported four task-owned unaccounted environment names. Log: `/tmp/fly2519-packages-20260913.log`. This run did not verify the whole repository.
- Added explicit reasoned NON_FLAG_ALLOWLIST entries for canonical bundle-version context, manifest and broker socket paths, and the explicitly permitted per-invocation development source selection. No FLAG_EXEMPTIONS or product flag/store changes. The existing development selection remains bounded by the launcher contract and is not a production deployment fallback.
- Existing red drift assertions now pass: 14 tests. Actual headless/TUI launcher development-versus-deployed-dist guards pass: two tests. Changed-file Biome passes. Exact package aggregate rerun is in progress; log `/tmp/fly2519-packages-20260913-rerun.log`.
- Comparing added files against origin/main found no new `scripts/__tests__/*.test.sh`. Formal review, PR, actual runtime assembly and host acceptance remain outstanding.

### Mechanical process-cleanup inventory (2026-09-13 local)

- The aggregate rerun passed all config tests, then reported the claude-runner kill-path inventory mismatch: 675 current entries versus 660 recorded. Reviewed the exact 15 additions; no deletions or reclassifications.
- Ten production hits are bounded Git command cleanup (three), disposable browser/model isolation probe cleanup (six), and owned MCP/Chrome process-group cleanup (one); none accepts an arbitrary runner target. One signal-0 check observes that owned browser group. Four remaining hits are browser transport/upstream test cleanup. Recorded those exact hits in the existing fixture with the scanner's existing classifications; did not broaden the scanner, audited mutation registry or runner authority.
- Focused kill-path inventory: five tests passed, including the audited choke-point and bounded-child guards. Fixture Biome passed. The still-running aggregate retains its original failure and is not made green by this focused rerun.

### Trusted delivery-context dedup foundation (2026-09-13 local)

- Lead response `03dc89e4-7044-4c76-8827-ed3698f59b94` approves a parent-owned journal-entry context plus exact target/body digest, using the existing outbound store. Only confirmed delivery suppresses; uncertain delivery remains unknown without automatic resend. Different context/body/target remain distinct; no content-only time window or parent StateStore writes.
- Added a trusted in-process context argument to the outbound handler and guarded sender composition. The existing durable claim key hashes project, Lead, journal context, channel, reply target and exact body digest. The external/model body cannot supply this context. No database schema or parallel table is added; callers without context retain their existing idempotency keys.
- TDD red: reopening actual SQLite then delivering the same context/body/target through another operation key sent a second message. Green: confirmed replay returns the original message, while different context/body/target sends normally. Another actual SQLite restart test preserves an uncertain send as ambiguous with one provider invocation. A forged body context does not activate this path. The guarded sender integration separately failed with two HTTP calls, then passed with one after forwarding its parent-only option.
- Outbound context (3), handler (16), guarded composition (5), sender (26): 50 tests passed. Context production transport from active journal/router through the typed Bridge envelope and automatic sender remains to be wired; this is not yet end-to-end runtime dedup acceptance.
- The prior exact package aggregate ended exit 1: claude-runner 49 files passed/one failed, 1267 tests passed/one failed/two skipped, plus `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`. The inventory assertion is fixed in 930ddbdf2; the worker error is preserved, not reclassified as passing. Latest exact lint before this context batch passed (16 warnings), log `/tmp/fly2519-lint-20260913-accounting.log`. A fresh exact package aggregate is running at `/tmp/fly2519-packages-20260913-rerun2.log`.

### Parent journal binding and typed Bridge propagation (2026-09-13 local)

- Router now enters a parent-only binding after the actual journal row reaches dispatching and before model start. The binding spans the complete turn/delivery lifecycle and releases on success or error. The v2 runtime supplies the real parent method; legacy routing remains unchanged.
- Parent validates the entry against its existing SQLite journal, refuses concurrent/undispatched bindings, and invalidates bindings on release/close or terminal journal state. Broker snapshots that binding independently of model input and checks it before/after asynchronous authorization. A reply without an active binding is refused when the parent supplies this authority.
- Typed parent HTTP adapter carries the context in the authenticated envelope, separate from strict operation input. Bridge validates the envelope and supplies the context to the existing guarded sender/dedup path. No parent StateStore write or new persistence store.
- TDD red/green: router success/error lifecycle; broker context revoked during authorization and missing active context; actual parent/socket/SQLite binding; actual parent HTTP→Bridge delivery across different request IDs and parent restart. The latter failed with two Discord writes then passed with one while retaining two Bridge requests.
- Router28 + broker19 + parent1 + runtime139 + parent Bridge25 = 212 passed. Separate actual Bridge route5 + parent Bridge25 = 30 passed. Changed-file Biome passed. Automatic-output outbox context persistence and wiring are still outstanding, so full automatic/proactive runtime dedup is not yet proven.
- Latest exact package rerun ended exit1 solely with an unhandled `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` in claude-runner: 50 files passed, 1268 tests passed, two skipped. Log `/tmp/fly2519-packages-20260913-rerun2.log`. Inventory failure is gone, but aggregate failed before all packages ran; no whole-repository green claim.

### Durable automatic-output context (2026-09-13 local)

- Added nullable `delivery_context` to the existing outbound outbox via additive migration. Router supplies the durable entry ID for v2 enqueue and recovered model output; restart retains that ID without restarting the model. Enqueue and evidence reads reject a changed binding for the same key. Legacy rows remain null.
- Context is trusted transport metadata, never part of the generic outbound body. The legacy HTTP transport refuses context-bearing delivery before fetching; a trusted adapter must consume it. Guarded composition uses the persisted metadata and rejects disagreement with its fixed request context. This deliberately leaves v2 automatic transport assembly pending rather than silently losing context.
- Found and fixed a second dedup layer: typed replies now include journal context in their existing outbox business key and persisted expected payload. Actual parent→Bridge integration with the same explicit event ID across two journal contexts originally suppressed the second legitimate reply; now same-context replay dedups and the other context sends once. Context is carried into the Bridge handler's trusted operation context.
- TDD red/green covers outbox restart/context conflicts, guarded tool-versus-automatic metadata, router enqueue, and the cross-context business-key case. Recovery and legacy-transport rejection negatives added. Sender28 + router29 + guarded5 + Discord52 + parent Bridge25 = 139 passed; changed-file Biome passed. Preserve the additive outbox column/data and uncertain receipts on rollback; no StateStore schema/table or parallel store added.
- Separate full TeamLead run ended exit1: 1057 files passed/8 failed, 14066 tests passed/8 failed/7 skipped, plus onTaskUpdate worker timeout. Log `/tmp/fly2519-teamlead-full-20260913.log`. This diagnostic run overlapped active TDD edits and observed the two expected new outbox/composition red tests before their fixes; it is not exact-head evidence. Other failures: child-process census, git test wording teardown guard, two typed Bridge startup timeouts, bounded-delivery timing, mailbox archive assertion. Census and wording are task-owned and next to fix; timing/archive/worker results remain unproven, not green.
- Actual v2 automatic Bridge transport/current-carrier authority, default assembly/TUI, remaining parity, formal review/PR and live Honey Lemon acceptance remain incomplete.

### Full-TeamLead failure follow-up (2026-09-13 local)

- Registered the exact five task-owned child-process census additions: GitPushRunner raw spawn; browser isolation probe; owned browser MCP transport; bounded fixed git HEAD deployment read (5s,4KiB); Codex model isolation probe. Recorded dispositions in the existing manifest; no scanner/guard exclusions or process authority changes.
- Reworded one Git test title containing a retired family word; the tested FIFO behavior is unchanged. Census1 + teardown7 + Git4 = 12 passed; changed-file Biome passed.
- Reran the other four failed files unchanged with `--maxWorkers=1`: typed Bridge read7, typed Discord5, bounded delivery9 and inbox runtime39 = 60 passed. Log `/tmp/fly2519-full-failures-focused.log`. This isolates a passing focused run; it does not erase the earlier full-suite assertion/timeout/worker failures or establish exact-head aggregate/CI green.
- Outbox context batch TypeScript passed (`/tmp/fly2519-outbox-context-typecheck.log`). Actual v2 automatic transport assembly and remaining parity remain next.

### Bridge authority for automatic v2 output (2026-09-13 local)

- Added internal `discord.output.deliver` handling to the existing authenticated capability Discord route; it is absent from the model capability catalog. A strict separate input accepts only channel/text/idempotency key/nonce, with parent context in the authenticated envelope. Missing context or extra model-style context input is rejected.
- Reuses current registry identity and live carrier checks, pins project policy through asynchronous channel lookup, and rechecks scope before every Discord side effect. Target authorization follows the existing Lead outbound channel/owned-thread rules. Credentials resolve on the Bridge; no parent StateStore writes, new service or dedup table.
- Existing durable outbound handler/store now handles automatic delivery, including same-context tool/automatic confirmation dedup. The route returns explicit unknown for ambiguous delivery; it does not retry or claim a confirmed suppression.
- TDD red: automatic request rejected400. Green actual local HTTP/SQLite integration sends one Discord message for tool+automatic output. Invalid carrier/Lead/missing-context/extra-input cases produce zero writes. Simulated Discord response loss followed by a second request key stays unknown with one Discord write.
- Parent Bridge suite31 passed; earlier joint parent30+mounted Bridge5=35 passed. TypeScript initially caught the union input annotation, then passed after using the validated Record input type. Changed-file Biome passed after formatting. These are hermetic network fixtures, not Honey Lemon host acceptance.
- Parent HTTP transport and actual v2 runtime sender wiring are still pending. Default assembly/TUI/rules/remaining parity/full gates/review/PR remain incomplete; no production activation or action.

### Parent automatic transport and v2 runtime sender wiring (2026-09-13 local)

- Added internal authorization-only startup probe to the same Bridge route. It validates current identity/carrier/channel and configured token without a Discord write or fabricated journal context. Delivery still requires parent context.
- New parent automatic transport fixes the endpoint/identity/token from trusted config, ignores request URL/headers, validates strict input against actual journal output/state/target/key, and rechecks current activation around awaits. It bounds execution to15s and response to8KiB, cancels bodies, rejects redirects/correlation mismatch/credential echoes, and maps ambiguous outcomes without retry. The new helper is included in the fixed deployment receipt (12 entries).
- Actual v2 runtime config now selects Bridge outbound, requires its existing credentials, and connects the durable sender's post callback to the parent. The parent owns cancellation and settlement of outbound requests before closing providers/journal; absent transport fails closed. Legacy non-v2 choice is unchanged. The production default parent factory is still missing and must provide the real adapter; no default activation is claimed.
- TDD red: missing automatic startup route; missing parent adapter; actual v2 thread/resume startup skipped parent outbound probe. Green: actual Bridge probe has zero writes, actual parent adapter sends journal-backed output and rejects changed text before HTTP, runtime executable fixture invokes parent probe before thread/resume, and closing parent cancels an outstanding transport before resource release.
- Negative adapter tests cover mismatched request ID, oversized response, credential echo and an abort-ignoring stalled fetch (15s bounded rejection, one invocation). Parent Bridge37 + runtime139 + parent1 + deployment2 =179 passed. TypeScript and changed-file Biome passed. Network/process fixtures are hermetic; full issue-driven Honey Lemon/browser acceptance remains unverified.
- Complete production parent assembly/TUI, rule/skill adaptation, remaining capability rows, full exact gates/formal review/PR and host acceptance remain outstanding.

### Codex Discord reply rule adapter (2026-09-13 local)

- Exact `pnpm -r build` for the automatic runtime batch passed (exit0), log `/tmp/fly2519-build-automatic-runtime.log`; exact lint previously passed3583 files with16 warnings. These do not resolve the previously failed package aggregate.
- Added the Codex transport adaptation of the existing Discord reply contract. It names the real lead_operation envelope and canonical thread resolution, prohibits narrated/XML fake sends, binds delivery claims to successful message receipts, and preserves unknown outcomes without minting retry IDs. It retains department/founder authority boundaries and does not promise a Claude Stop hook.
- Actual shell resolver emits the required adapter after cross-department rules only for v2 department Leads. Missing adapter fails rule assembly. Existing legacy selection is unchanged; the canonical Claude source remains intact for source/adapter hash comparison in the pending default factory.
- TDD red: real shell resolver omitted adapter. Green: ordered emitted paths and actual rule content verified; missing-file negative proves fail-closed behavior. Resolver suite29 passed, bash syntax and changed-test Biome passed. Host `.bashrc` startup diagnostics appeared in the test's shell fixtures even with outer BASH_ENV=/dev/null; no host startup file was changed and all assertions passed.
- Default parent factory must still map canonical `base/discord-reply-contract.md` to this adapter when building manifest rule evidence. Full source/skill assembly and remaining parity stay incomplete.

### 2026-09-14 — canonical Discord rule adapter selection

The shared TypeScript selector now accepts an explicit backend and selects the required Codex department Discord adapter while retaining the canonical source path/hash. Missing adapter evidence remains missing; an alternate override is rejected. Claude/default selection remains unchanged. This closes a source assembly prerequisite; the selector still needs the production parent consumer and does not establish runtime parity.

TDD: new adapter binding test failed with null adapter and required=false, then passed after minimal selection. Focused rule-source plus actual shell bundle suites: 39 passed. Biome passed. Shell fixtures still emitted existing host .bashrc diagnostics; no host configuration changed. No aggregate/review/PR/host acceptance claim.

### 2026-09-14 — fixed credential aliases wired into parent

Lead response 8711ef2c-a8ac-4365-8540-0643fa88d167 confirms there is no separate authoritative credential-source API to introduce. Followed existing lead-body.sh env source, codex-global-health/cutover/sweep roots, flywheel-claude-profile roots and standard gh/git/ssh/Keychain locations. SecretBroker remains unchanged and receives only memory values.

The existing credential-paths module now derives this fixed alias set from trusted parent environment, retains conventional roots alongside overrides, includes historical suffixed Codex homes by directory metadata, and resolves symlink aliases without reading credential contents. runtime-parent snapshots that environment, always merges these aliases with supplied deny paths, and rejects changed aliases after async authority checks. Synthetic unreadable credential file, alternate roots, invalid relative override and a newly created historical home are covered. Public instruction/skill provisioning must use allowed nonsecret staging paths; denied account storage roots are not public skill roots.

TDD: alias function test failed before implementation; actual parent verification test then failed because .ssh was absent from effective credential paths, then passed after wiring. Credential + actual parent + real runtime suites: 143 passed. TeamLead tsc --noEmit and Biome passed. This is configuration/lifecycle evidence, not host keychain/process-inspection confinement, complete parent assembly, browser acceptance, full aggregate, review or PR evidence.

### 2026-09-14 — report publish queue authorization boundary

Audit found report.publish declared in the capability catalog but no provider handler. Existing reports-route publication queues uploads and commits a ReportRegistry after the external await. Added an optional trusted scope authorizer for the forthcoming capability mount, invoked inside that existing queue after payload validation and before staging. A configured authorizer must return a synchronous live check; rejection or absence gives a stable 403 without staging/upload. The check runs before external upload and again before registry commit. Revocation during upload skips registry commit and uses existing orphan-Blob cleanup. Legacy mounts without the option retain their flow.

TDD: denied-authorizer HTTP test first returned 200/uploaded, then passed after guard wiring. Missing returned-check test first returned 200, then passed after fail-closed validation. Real HTTP + real filesystem registry tests also prove post-upload revocation leaves no registry entry and cleans the exact uploaded token. Existing reports route and actual mount suites: 62 passed, /tmp/fly2519-report-scope-tests.log. TeamLead tsc --noEmit passed, /tmp/fly2519-report-scope-tsc.log; Biome passed.

This is a publication boundary prerequisite only. Concrete Lead/issue authorization, capability route mount and parent report handler remain to connect, including bounded authorization, dispatch-once/unknown handling and managed artifact input. It does not enable report.publish in production or prove P11, default assembly, complete review/PR/host acceptance.

### 2026-09-14 — concrete Bridge report scope authorization and mount

Added lead-capability-report.ts using canonical resolveLeadIdentityRow + forwarded carrier validation and the existing DepartmentRegistry. The strict publish proof binds project, Lead, identity digest, carrier, activation, issue and request ID. Authorization reads the issue team/project and at most 100 complete labels, requires the configured project label and unambiguous department membership, and re-reads registry/carrier after each asynchronous boundary. The authorization query has a 15-second deadline; its returned synchronous commit guard also expires at that deadline. Errors expose only report_scope_denied. This does not open a parent StateStore.

Bridge now mounts only POST /api/lead-capabilities/reports/publish, with master-only auth and a required Linear provider. Other report methods/paths are rejected. Both report router instances share the existing report critical section. The legacy /api/reports mount remains available under its existing auth policy.

TDD: initial authorizer test failed because the module was absent; mount test initially returned 404 instead of the required provider-unavailable response. After implementation, 68 tests passed across concrete authorizer, real HTTP route and real plugin mount suites (/tmp/fly2519-report-authorizer-tests.log). Authorizer tests use actual canonical identity/registry compilation and DepartmentRegistry, with carrier-process and Linear SDK seams; they are not live carrier/Linear proof. Coverage includes scope drift during await, malformed proof, missing/foreign/incomplete labels, stalled SDK, expired commit guard, master-vs-ingest and missing scoped proof before upload. TeamLead tsc passed; full recursive build exited 0 (/tmp/fly2519-report-authorizer-build.log). Full lint exited 0 with 16 warnings (/tmp/fly2519-report-authorizer-lint.log).

Parent managed-artifact report handler, its dispatch-once/unknown transport, report delivery/provenance and verification still need implementation. No P11, default factory, TUI, full package aggregate, formal review, PR or host acceptance completion claim.

## Replacement implementation: restored history and report ownership (2026-09-14)

Execution ed0040d2-b967-4079-b8ce-f8aa2b23cf02 acquired implement epoch 5.
Ordinary merge e2e8a65f7 preserves ce0e761a9 and the current approved design;
only progress.md conflicted, and both implementation details and design handoff were retained.
Named stash 4bd662c013b8253b7eab209deab48b990dc2d382 was verified by full name and parent,
then popped successfully, restoring all five report-publish files.

- Dependency bootstrap: initial vitest unavailable; pnpm install --frozen-lockfile exit 0.
- Restored WIP: report-publish + reports-route, 61/61 pass.
- Full pnpm -r build exit 0 before ownership changes (not final-head verification).
- Ownership TDD: report-registry failed 1/68 (missing persisted owner), then 68/68 pass;
  actual HTTP publish failed 1/7 (route omitted owner), then passed after wiring.
- Persisted owner contains lead/identity/issue/request only, copied at staging and committed
  atomically with the report; no carrier or token. Legacy reports have no inferred owner.
- Shared current issue authorization now supports persisted-owner validation for forthcoming
  verify/deliver routes; wrong owner/issue, unowned legacy report and revoked carrier reject.
- Final batch: four report test files, 134/134 pass; teamlead typecheck exit 0.
- Full lint/build/package gates at final head, G1 remaining providers/default factory,
  G2 TUI, G3 isolated drill/host proof, code review and PR remain outstanding.
  No production v2 activation or provider write occurred.

## Scoped report verification continuation (2026-09-14)

- Added Bridge /api/lead-capabilities/reports/verify and parent report.verify handler.
  The scoped route uses current persisted-owner + department/carrier authorization,
  resolves the HTTPS URL from the existing registry, rejects redirects/model URLs,
  and performs a credential-free read limited to 1 MiB and 15 seconds.
- Reuses existing verify-report static CSP/nonce checks through an additive package
  export; no screenshot path is supplied and no browser is launched by this route.
  Scalar results are bound to exact reportId/requestId; foreign replies become unknown.
- TDD: missing router/parent module and unmounted /verify each failed first.
  Router/parent then 5/5 pass, including real 15-second abort-ignoring fetch (one request).
  Router mount 12/12 pass; deployment 2/2 pass.
- teamlead typecheck initially caught exported Router inference TS2742; explicit
  Router return annotation fixed it, final typecheck exit 0. Changed-file biome
  and git diff --check pass.
- This is report verification plumbing, not browser acceptance. report.deliver,
  upload reconciliation and all remaining G1/G2/G3/G4/G5 work are still pending.

## Report delivery and read-only reconciliation (2026-09-14)

- Added scoped Bridge deliver/delivery-receipt routes and parent report.deliver handler.
  Bridge resolves current registry ownership and canonical issue thread, rechecks scope
  before sends, reloads current project/token/channel providers, and uses the existing
  CodexLeadOutboundHandler + Bridge SQLite outbox. Delivery is explicitly link-only.
  No screenshot failure is represented as successful image delivery.
- Real SQLite restart tests prove sent rows do not resend and uncertain rows remain
  unknown. Parent broker/journal restart then queries only /delivery-receipt; modified
  payload under the same request UUID is rejected before a second provider request.
- Added /publish-receipt lookup keyed by exact project/Lead/identity/issue/request UUID.
  It reads only committed report metadata; no entry remains unknown, multiple matches
  fail closed. Parent reconcile skips old artifact reads and never repeats an upload.
  Test destroys artifact read availability after response loss, restarts journal and
  proves successful lookup via /publish-receipt only.
- Red tests preceded the new delivery module, route mount, upload receipt authorizer,
  receipt router and parent upload reconciliation. Final report regression: 10 files,
  160 tests pass, including real 15-second abort-ignoring HTTP timeout.
- Typecheck caught closure narrowing of optional HTML in the upload branch; scoped
  const fixed it. Final teamlead typecheck exit 0; diff whitespace check passed.
- G1 report primitives now implemented. Default factory wiring, other G1 providers,
  TUI, isolated parity/host proof, final full gates, review and PR remain outstanding.
  No production activation or production provider writes.

## Shared terminal core and Claude parity protocol (2026-09-14)

Lead answered question 6ce1e4d2-fae7-4ad2-b989-a53b935052e6: approve
observedSessionId from actual CommDB execution-to-tmux session/pane binding;
both Claude and Codex must use the same field and rejection codes, reread
owner/execution/target and reject stale/non-waiting input. No production terminal use.

- Added flywheel-comm/terminal-observation shared core, reused by Claude MCP capture,
  search, status and input. Codex terminal.status catalog declares observedSessionId;
  Codex Bridge/provider composition remains the next task.
- Input requires expectedSessionId matching actual session_id + pane_id. The core
  rereads exact project/Lead/execution/target before every guarded send, rejects
  completed/executing/cross-scope/stale targets, and sends only to the pinned pane.
- Preserved legacy standalone observation heuristic export. Shared guarded operations
  inspect the current nonempty line, so an old prompt followed by executing output
  cannot authorize input. This correction had a failing regression first.
- Capture has a UTF8-safe 256 KiB bound. Regex search runs constant worker code with
  empty env/execArgv, a 1-second deadline and termination; pathological regex tested.
- Red tests preceded shared core and stale-prompt correction. Real isolated tmux
  initially failed because literal tab format delimiters become underscores; fixed
  both source adapters to a literal pipe delimiter, then real session/pane binding
  and guarded input passed against a temporary readonly CommDB.
- Final checks: core 9/9 (including real private tmux), terminal MCP 49/49 (including
  actual MCP registration schema/handler exercise), catalog+resolve 10/10; comm build,
  terminal MCP build, teamlead typecheck exit 0. Worker env/execArgv final focused 3/3.
- Still pending: terminal Bridge/provider/list integration, inbox/patrol/remaining
  Bridge/integration providers, default factory/skills, TUI, browser host/parity drill,
  final full gates, frozen-head review/CI and non-draft PR. No production changes.

## Terminal Bridge binding and bounded discovery (2026-09-14)

- Added parameterized CommDB terminal discovery pages, exact project/Lead scope
  before LIMIT, stable execution-id cursor, maximum 100 rows. Legacy null-Lead rows
  are candidates only; downstream issue authorization remains mandatory.
- Added a per-request Bridge adapter for the shared terminal core. It cross-checks
  canonical StateStore issue/project and current CommDB issue/Lead/target, reauthorizes
  the live issue around asynchronous work, and rejects changes to the first binding.
  StateStore is supplied by Bridge; CommDB uses openReadonly and closes each handle.
- Retention classification: current sessions are live binding authority, missing rows
  deny access. This adapter consumes no session_events or retained history. The
  retention consumer gate passed without adding a target-table consumer.
- Red: missing pagination method and missing Bridge adapter module. The first
  teamlead filter matched no package and was rerun with flywheel-teamlead; only the
  actual failed test run counts as red. A rebind fixture initially violated CommDB's
  own immutable receipt-lineage guard; corrected it to exercise canonical UUID
  rebinding while preserving the CommDB identifier.
- Green: comm terminal suite 10/10 including real private tmux; Bridge adapter 6/6
  including cross-database mismatch, authorization-time scope loss, stale pane,
  canonical rebind, and acquired-readonly-handle closure. Comm build and teamlead
  typecheck passed. No production terminals or providers were touched.
- This is adapter/discovery implementation only. HTTP route, parent transport,
  terminal.list composition and default factory wiring are still pending; this is
  not a claim that Codex terminal parity or G1 is complete.

## Terminal read provider and parent transport (2026-09-14)

- Extended the existing authenticated fixed `/api/lead-capabilities/read` route to
  typed terminal capture/search/status/list. It uses the shared Bridge binding core,
  current canonical/department authorization and bounded readonly CommDB pages.
  No model URL, arbitrary command or write operation is accepted by this route.
- Parent read handlers now include these four terminal operations. Successful replies
  require the same receipt UUID and, for single-execution reads, the requested execution.
  Existing token/claim exclusion, byte limits, abort and redirect guards remain in use.
- The fixed tmux read adapter uses an absolute executable, washed environment, trusted
  Runner socket namespace, five-second child deadline and request cancellation.
  A real temporary TMUX_TMPDIR/default socket test exercised session/pane identity,
  capture, cancellation and the read-only send rejection; no production socket used.
- Red tests showed missing terminal handler and rejected terminal route. The updated
  focused pair passed 14/14. Broader parallel focused run was 21 passed/1 failed:
  pre-existing actual-Bridge module-load test exceeded its 5-second timeout. The same
  four files with no file parallelism passed 22/22; typecheck passed. No timeout was
  raised. A final actual-Bridge mount assertion for terminal.list passed independently
  (1 passed/8 intentionally skipped), using an explicitly isolated CommDB root.
- Remaining: terminal.input write dispatch/receipt behavior and default factory
  installation. These reads are implemented providers, not evidence that the v2 Lead
  default runtime or complete parity acceptance is finished. Other G1-G5 work remains.

## Terminal input, durable receipts and reconciliation (2026-09-14)

- Added dedicated authenticated terminal-input and terminal-input-receipt routes.
  Reads continue to reject input operations. Input uses the shared current binding /
  waiting-pane guard and literal text plus Enter, rechecking before each send.
- Reused the existing broker UUID/input-digest state machine on the Bridge outbound
  SQLite connection. Identical requests replay, changed input rejects, and uncertain
  sends remain unknown without redispatch. Parent reconciliation calls only the
  receipt endpoint; missing receipts do not prepare rows or send input.
- Successful and unknown receipts survive a Bridge store reopen. Cancellation settles
  dispatched input as unknown; draining rejects new input. Terminal rejection codes
  are pinned and preserved through both brokers; other provider errors remain generic.
- StateStore remains Bridge-owned. This adds metadata-only operation receipts to the
  existing Bridge connection, not a Lead StateStore handle or another database owner.
  Receipt schema initialization failure now closes the acquired connection (red/green
  regression). No secrets or terminal text are stored in receipts.
- Parent fixed transports bind terminal providerRef and executionId to the request.
  Added the parent transport to deployment entries. Real private tmux exercised
  observed session/pane identity, literal input and resulting INPUT:yes output.
- Red: missing write route, missing parent input factory, generic scope rejection
  code, and missing connection cleanup on schema failure. Green: 57 tests across
  seven broker/provider/store/host files; cleanup follow-up 12/12; deployment 2/2;
  teamlead build and focused lint passed. Typecheck rerun after import/type cleanup.
- The first expanded run had 56 pass and one full-Bridge import timeout at the
  default 5 seconds. Set only that integration test's total timeout to 15 seconds;
  subsequent full-Bridge load took 5.35 seconds and passed. Runtime provider deadlines
  and cancellation assertions were not increased.
- Terminal handlers/providers are implemented but default factory installation is
  still pending. Remaining G1 inbox/patrol/Bridge/integrations and actual skills,
  G2 TUI, G3 complete isolated browser/parity host drill, G4 final gates/review/CI,
  G5 non-draft PR remain outstanding. No production activation or provider writes.

## Skill installation and explicit native baseline (2026-09-14)

- Current audit confirms the default runtime factory is still absent. Besides its
  assembly, remaining G1 includes inbox/patrol providers, concrete GitHub/git business
  authorization, remaining Bridge adapters and P15-P17 integration schemas/providers.
  Terminal/report provider completion does not close those gaps.
- OpenAI Docs confirms SKILL.md requires name/description metadata and describes
  system/user/repository discovery: https://learn.chatgpt.com/docs/build-skills .
  A separate isolated local probe confirmed this deployed Codex also discovers
  CODEX_HOME/skills; this compatibility fact comes from execution, not the docs table.
- Added bounded hash/secret-verified Markdown loading without stripping skill metadata.
  Parent now installs admitted self-contained skill adapters in its activation home,
  reads back actual source receipts, checks drift before use and removes only its
  owned installation on close. Invalid metadata/hash, duplicates and unlisted sources
  reject. Upstream helper directories are not blindly copied; factory must supply the
  approved self-contained adapters and all required skill sources.
- Lead answer 8ca4ab13-e42d-4c25-bfec-f6dfec507de2 requires the six bundled system skills
  to be explicitly admitted as a native baseline, never silently ignored or disabled.
  Added native baseline version/content to the manifest digest and proxy validation;
  verifier records each name, source path, SHA256 and Codex version. Extra entries,
  changed content/version or missing entries raise baseline_drift with receipt metadata.
- Actual discovery validation compares the complete skills/list result with admitted
  installed/native paths, names, enabled state and scope; rejects extra sources and
  discovery errors. Parent exposes this validator for the runtime factory/start flow.
  That startup invocation and production baseline pinning remain pending.
- Red: missing installer/native verifier and parent did not install declared skills.
  Test fixture corrections preserved canonical paths and deliberately chmod the
  read-only fixture before its drift mutation. Final focused set: 24/24 across eight
  files; final discovery/parent assertions 2/2. Teamlead build and focused lint passed.
- Real host test used Codex 0.153.2 with isolated HOME/CODEX_HOME/project and no model
  or provider API call. It emitted six native and one configured source receipt via
  actual skills/list; rerunnable test is manifest-skills-host.test.ts. Log:
  /tmp/fly2519-skills-discovery-last.log. The test captures a fixture baseline to prove
  discovery; production MUST use an explicitly pinned manifest baseline, not learn and
  accept fresh hashes at startup. No production Lead, registry or provider was changed.

### G1 app-server actual skill-consumer startup gate (2026-09-14)

- The v2 runtime now requests `skills/list` with its exact project cwd and `forceReload: true` after verifying effective config, both before outbound preflight and before starting/resuming a thread. It passes the actual response to the parent's existing complete source-set validator. Missing validation support or an RPC error refuses startup.
- TDD: the extra, enabled, non-manifest skill fixture initially reached thread creation instead of rejecting (expected `capability_skills_unverified`, actual `v2_thread_failed`). After wiring the validator, both unexpected-source and RPC-error paths reject before outbound preflight/thread creation and close the parent provider, socket, and journal. Existing initialize/config/thread/resume cleanup paths remain green.
- Verification: runtime + manifest-skills + runtime-parent, 3 files / 144 tests passed; teamlead build and focused Biome passed. Two initial commands used unmatched package filters and ran no tests; verification above used the package directory and the correct `flywheel-teamlead` build filter.
- This wires the app-server consumer check only. Default runtime factory, production baseline pins, remaining provider adapters, TUI, isolated full parity drill, repository-wide gates and final review/PR remain outstanding. No production provider writes or activation.

### G1/P09 trusted parent batch ACK provider (2026-09-14)

- Auditing default factory prerequisites found no production inbox handlers. Added `createInboxBatchAckHandlers` using the existing trusted parent fixed Bridge transport and two fixed endpoints: `inbox-batch-ack` and `inbox-batch-ack-receipt`. Parent checks returned request UUID, batchId, and exact provider reference; reconciliation never invokes the write endpoint.
- Bridge reuses canonical registry/carrier validation and drain admission. Only Bridge opens the existing project-resolved mailbox queue and calls its recipient-bound transactional `ackBatchByRecipient`, closing the handle immediately. Absent/retired batches do not produce success evidence. No new mailbox, StateStore, or receipt schema.
- Extracted the existing terminal-input UUID/digest/unknown/replay lifecycle into `lead-capability-write.ts`, reused by both bounded writes. Original terminal input wrapper preserves its typed input/effect and behavior. ACK lookup is receipt-only and does not open/migrate a queue or apply an ACK.
- TDD: missing ACK module red first; implementation green. Actual SQLite queue tests prove own-batch ACK, other-recipient rejection/no mutation, payload conflict, successful replay after receipt-store close/reopen, and read-only lookup. HTTP tests exercise the mounted route, stale carrier, drain, and request/result correlation. Parent transport tests verify distinct write/receipt URLs and mismatched batch output rejection.
- Verification: 5 focused files / 43 tests passed (ACK core, terminal receipts, mounted Bridge routes, parent Bridge adapters, broker); teamlead build, focused Biome, and diff whitespace check passed. No full-repository/exact-head CI claim.
- Default factory is still absent and cannot yet assemble the complete approved surface. Remaining prerequisites include event ACK handle ingress, patrol, GitHub/git business authorization, additional Bridge adapters and P15-P17; production native baseline pins and source selection also remain. No production ACK, activation, restart, QA dispatch or PR.

### G1/P09 existing-coordinator event ACK adapter (2026-09-14)

- Audit found `appendLeadEvent` writes new events with ACK required=0, the Bridge coordinator uses default enabled=false, and legacy retirement tests seed ACK=1 explicitly. Existing queue/legacy/ingress suites passed 11 tests. Lead answer `7dfeeba4-2dfa-45f7-881a-6c299ab41491` requires current parity: retain the catalog entry, explicit disabled response when disabled, reuse existing ACK behavior when enabled; no legacy revival or new ingress.
- Added typed owned-event read/ACK methods to the existing coordinator. Refactored its existing protocol ingress ACK effect and token helper into shared functions, preserving callers and avoiding a runtime import cycle. Bridge uses the same coordinator created by startBridge, passed through BridgeAppOptions. No new StateStore writer or grant storage.
- Added fixed parent/Bridge event ACK and receipt-only endpoints, using the existing UUID/digest/unknown receipt lifecycle. The broker preserves only the pinned `inbox_event_ack_disabled` code for this operation. Unknown/foreign event references fail ownership checks; disabled mode neither reads credentials nor mutates ACK state. Enabled mode applies a genuine ACK and duplicate requests use durable receipts.
- TDD: two tests failed on the missing coordinator method, then both disabled and enabled SQLite cases passed. Combined event/HTTP/batch/terminal/protocol/legacy/parent/broker verification: 8 files / 53 passed. Catalog schema-description verification: 6 passed. Final missing-event HTTP guard rerun separately. Initial build caught the coordinator being declared in createBridgeApp rather than startBridge; fixed by passing the existing instance through options.
- No production provider call, activation, restart, or ACK occurred. Current production-disabled status is the Lead's confirmed ruling plus checked source defaults, not a fresh host runtime observation. Full repository gates/review/CI/PR and default factory remain pending.

### G1/P10 parent-supplied GitHub facts for the existing snapshot (2026-09-14)

- Lead ruling `b2c5733d-f82e-427c-9542-1c9acd2c7ab1` pins judgment writes to the existing report and its three completion gates, and approves parent-prefetched GitHub data. No new judgment table or dwell-verdict mapping.
- Existing snapshot helper accepts --github-facts <parent-json>. Explicit data input never falls back to gh, including malformed/foreign input. Empty input and combining this read-only input with dwell receipt writes reject before execution. Unset mode retains the existing CLI path.
- New fixed sibling reader limits private canonical single-link files to 128 KiB, rejects symlinks/foreign project or Lead/extra fields/malformed or excessive PR and run lists, and returns only nonsecret bounded fields. Parent prefetch uses the two existing fixed GitHub routes with 50/5 page limits, parent-only SDK credentials, abort signal and current registry/carrier/revision checks around reads; SDK body/actor/extra fields are stripped.
- TDD: reader test first failed on missing module, then exposed the fixture's noncanonical macOS temp path; canonicalized the fixture and passed. Prefetch tests first failed on missing module, then passed fixed-route/projection and scope/repository-change cases.
- Verification: full existing snapshot shell suite 383 passed / 0 failed, including explicit valid and invalid parent-input cases proving zero gh calls. Reader/argument guard shell test passed (rerun after final empty/mixed-mode guards). Parent prefetch 2 tests passed; teamlead build, focused Biome, bash syntax and diff whitespace checks passed.
- Actual snapshot handler execution/artifact registration and report judgment/gate wiring remain open. No production GitHub request, snapshot, write, activation or restart occurred. These tests are not full runtime parity evidence.

### G1/P10 same-report judgment and canonical completion gates (2026-09-14)

- Implemented the report-file part of Lead ruling `b2c5733d-f82e-427c-9542-1c9acd2c7ab1`. Typed judgment input now carries STEP (1–6 or DWELL), unavailable class/token, bounded complete FINDING fields, and pane action/result updates. executionId is used only to correlate pane evidence.
- `applyPatrolJudgment` accepts a trusted snapshot registration (path/digest/tick/evidence handle), refuses stale or foreign input, and updates the same private report pathname via exclusive temporary file + fsync + atomic rename. Only the selected status, its human FINDING rows, and explicitly selected same-execution pane action/result fields change. Machine pane fields remain intact. Explicit unknown causes are retained without duplicate appends on repeat judgments.
- `runPatrolCompletionGates` reads the exact source-hash-pinned runner-patrol-rules.md and extracts its existing completion, disk, and marked finding gates; it does not reimplement their judgments. Executes each with a washed environment, fixed bash/system PATH, bounded time/output, and report path as data. Revalidates report/source hashes around every gate. Returned completion is distinct from individual health status: correctly accounted UNAVAILABLE may complete a report, as in the canonical rules.
- TDD: gate test first failed on missing module, then exposed ambiguous STEP 5 preview/validator selection; tightened to the exact disk gate prefix. Writer test first failed on missing module. Repeat-unknown test reproduced duplicate cause insertion and then passed after deduplication.
- Verification: 3 focused files / 8 tests (including multiple canonical report cases), teamlead build, focused Biome and whitespace check passed. Tests cover candidate refusal, disk contradiction, required finding metadata, valid finding, explicit unavailable, stale digest/evidence handle, newline injection, pane field preservation, and repeat unknown.
- This is the report mutation/gate component, not the completed patrol provider. Actual snapshot execution, owned report/artifact registration, fixed Bridge/parent wiring and broker write/reconciliation receipts remain to be connected. No production report was read or changed; no deployment/activation/QA/PR.

### G1/P10 bounded execution of the actual snapshot helper (2026-09-14)

- Added Bridge-side `executeLeadPatrolSnapshot`: fixed deployment-relative helper and helper-source hashes, strict project/Lead/tick arguments, canonical Node selection, private facts/scratch, washed HOME/PATH/tmux/Git environment, 15-second process-group cancellation, and bounded stdout/stderr. Only the read snapshot and explicit parent GitHub facts arguments are passed.
- After exit, rechecks current authority via the caller and helper hashes, confines REPORT_PATH to the same Lead's report directory and exact tick filename, verifies private regular-file ownership, bounds reads, checks project/Lead headers, and requires stdout to equal the real report bytes. Candidate/Lead-judgment states remain unknown.
- TDD: missing execution module red; real-helper test green using isolated state/registry/comm/control paths with absent DBs. A bad configured Node name initially fell through to the PATH Node; added canonical basename/path verification after the red test. Cancellation fixture initially had a test string-escaping error; corrected before recording green evidence.
- Real fixed helper test produced a verified report and six statuses without creating either missing database. Separate running-process fixture proves credential/BASH_ENV/NODE_OPTIONS washing, actual cancellation, process exit, and scratch cleanup. It does not exercise production provider writes. The helper's native disk probe remains a read-only host observation.
- Verification: execution/prefetch/judgment/gates, 4 files / 6 tests passed; teamlead build, focused Biome and diff whitespace check passed.
- This executes/verifies the helper but is not yet mounted as a patrol provider. Next: fixed Bridge routes, owned report/artifact registration and parent projection, plus snapshot replay and judgment UUID receipts/read-only reconciliation. No full parity or final-gate claim.

### G1/P10 explicit trusted tmux socket under helper isolation (2026-09-14)

Wiring audit found that the private `TMUX_TMPDIR` would otherwise point the helper at an empty default server namespace. The fixed script now accepts an explicit `--tmux-socket` for both list and capture; absent this option, existing script behavior is preserved. The Bridge execution wrapper accepts this only as a trusted option, validates the absolute canonical socket, current UID, private parent directory and no world permissions, and passes it as a literal argument. Model capability input does not gain socket/path selection.

TDD: the full snapshot shell suite first reported 384 passed / 2 failed on the new explicit socket case (old script rejected the argument). The focused Bridge tests pass with a real temporary Unix socket (including a space in its path), credential washing, cancellation/cleanup, and rejection of a regular file as a socket. Teamlead build, scoped Biome and shell syntax checks passed. The full shell suite then passed: 385 passed / 0 failed (`/tmp/fly2519-patrol-socket-green.log`). This is transport preparation, not mounted provider/factory or a real tmux/browser acceptance claim.

### G1/P10 durable snapshot registration and read-only replay (2026-09-14)

`registerLeadPatrolSnapshot` now invokes the actual bounded helper under the Bridge-owned operation receipt store. Before execution it prepares and dispatches the request UUID with a digest of the fixed tick/GitHub-facts payload. Success stores only the bounded report basename and SHA-256 in the existing receipt; replay reads that same owned file and checks its path, header, six STEP rows, private file properties and digest. No additional StateStore connection/table or model-selected path is introduced. Report text/path remain an internal Bridge DTO awaiting parent artifact projection.

The shared report reader is also used by initial helper verification. Payload conflicts reject; receipt-only misses, foreign Lead lookups, changed reports, incomplete dispatches, concurrent duplicates and interrupted execution return unknown without rerunning the helper. Read-only replay survives closing and reopening the actual SQLite store. The snapshot's old digest intentionally cannot certify a report subsequently changed by a judgment.

TDD: missing registration module failed first (`/tmp/fly2519-patrol-registration-red.log`). Four focused files / five tests passed, including real helper execution + SQLite close/reopen and a controlled in-flight failure/duplicate probe (`/tmp/fly2519-patrol-registration-final.log`). Teamlead build and scoped Biome/diff checks passed. Still not mounted into the HTTP/provider/factory path; judgment registration and parent artifact projection remain required before P10 is delivered.

### G1/P10 same-report judgment receipts (2026-09-14)

`recordLeadPatrolJudgment` resolves `patrol_<snapshot UUID>` through this project/Lead's successful Bridge snapshot receipt. It accepts only the original report digest or a digest already acknowledged by a successful judgment on the same scoped filename. The added receipt-store query is a bounded, parameterized read of the existing operation table; no judgment table or new authority cache is introduced. Sequential STEP judgments mutate the same owned report; arbitrary changed file bytes fail before another mutation.

Each judgment records its UUID/input digest before dispatch. Its bounded provider reference retains report basename, post-write report SHA, rule SHA and all three gate exit results. Replay returns that historical operation evidence without rewriting the report or pretending that an earlier digest is its current content. It survives SQLite close/reopen, and altered payloads/foreign Lead evidence reject. Source SHA validation now precedes report mutation both in this adapter and in the common judgment writer (a new red test exposed the former write-before-source-check ordering).

Verification: missing adapter red, then source-drift red (`/tmp/fly2519-patrol-judgment-source-red.log`), then six focused files / 29 tests green including shared broker/receipts, actual snapshot helper, sequential judgments, restart replay, file tamper and rule-drift negatives (`/tmp/fly2519-patrol-judgment-registration-final.log`). Teamlead build, scoped Biome and diff checks passed. HTTP/provider mounting and parent artifact projection are still pending; this does not satisfy factory/TUI, native-browser drill, final CI/review or PR gates.

### G1/P10 fixed authenticated Bridge HTTP endpoints (2026-09-14)

Mounted `/api/lead-capabilities/patrol-snapshot`, `patrol-judgment`, and their `-receipt` counterparts through the existing canonical identity/carrier/profile/current-registry checks. The handlers call the actual snapshot registration and judgment services; the snapshot's StateStore path comes from Bridge's existing store, and the project CommDB path remains server-derived. `githubFacts` is accepted only on the fixed snapshot endpoint, not the generic read or write endpoints. Draining denies new patrol operations. The trusted deployment/helper/rule/socket configuration has an explicit `BridgeAppOptions.leadPatrol` forwarding entry; absent that configuration the routes fail closed. Default startup assembly is still pending.

HTTP tests run a real helper against an isolated file-backed StateStore, report directory and SQLite receipt store. They prove snapshot and judgment results, read-only replay, payload conflict, malformed credentials, foreign Lead denial, wrong-endpoint provider parameters and drain rejection. Carrier validation is mocked in this focused HTTP fixture; canonical identity/registry and actual report/DB effects are exercised, but this is not the required complete real carrier/browser drill. An absent canonical Lead resolves to the existing `503/unknown` response rather than `403`; both deny effects, and the test preserves that established distinction.

TDD: missing routes failed first (`/tmp/fly2519-patrol-http-red.log`); three focused files / 19 tests then passed (`/tmp/fly2519-patrol-http-final.log`). Teamlead build and scoped Biome/diff checks passed. Parent artifact projection must still consume the internal report DTO before model exposure, followed by actual default factory/TUI integration and remaining final gates. No production activation or provider write occurred.

### G1/P10 parent transport and artifact projection (2026-09-14)

`createPatrolHandlers` now calls the fixed Bridge snapshot/judgment endpoints, with current parent context checks, bounded response streaming, fixed routes, correlation and cancellation inherited from the existing Bridge transport. A snapshot first queries its receipt; only an unresolved request prefetches the two approved GitHub pages and submits the snapshot. The public request digest is now the catalog input (`tickId`), not the parent-generated GitHub observation. This supersedes the earlier tick/facts digest implementation: changing model input still rejects, while changing live provider observations cannot invalidate replay of the first report.

The parent validates the report SHA, filename/tick, request evidence and ordered STEP DTO before writing it into the real activation-local `LeadArtifactStore`. The public snapshot DTO includes the controlled relative `artifactPath` so the Lead can read the report; the Bridge absolute path is discarded. Judgment calls accept only a current registered local artifact handle and convert it to the Bridge snapshot evidence inside the parent. UUID replay validates the artifact again and reuses its handle. This association is not authorization: every request still checks the current identity and Bridge authority. Judgment response verification checks request/receipt identity, report digest and the persisted three gate exit results.

A red canary test exposed that secret-bearing report text could otherwise pass normal tool-result checks through an artifact. The handler now requires the parent credential list and scans report bytes before artifact creation. The credential values stay in the parent. Tests use a real temporary artifact store and controlled HTTP/SDK responses; the preceding HTTP suite independently uses the actual Bridge/helper/SQLite path. These separate tests are not a claim that the complete real carrier/browser drill passed.

TDD: provider-context replay red, missing parent handler red and credential-artifact red; then five focused files / 35 tests green (`/tmp/fly2519-patrol-parent-final.log`). Teamlead build and scoped Biome/diff checks passed. The parent handler and trusted Bridge configuration still need actual default factory/TUI assembly; native browser drill, full repo gates, review/CI and PR remain required.

### G1 upstream schema inputs, 48 actual tools (2026-09-14)

Factory audit found P15–P17 still lacked actual schemas. Lead ruling `edcfa38d-a793-4f56-b679-7154d337b780` confirmed tools/list from the current configured servers as the authority. Captured 16 Xiaohongshu tools from loopback MCP (2.0.0), 2 Context7 tools from the installed plugin's configured HTTPS endpoint (4.1.0), and 30 gbrain tools (0.9.0). Source/config names, version and exact schema digests are in the three adjacent JSON artifacts; headers/credentials were not persisted. Context7's configured environment-default placeholder was expanded only in collector memory. Only MCP initialize/list operations ran.

The first collector attempt safely failed Context7 on an overly strict query guard (`client` is the configured nonsecret query key) and gbrain because the washed PATH lacked its actual Bun directory. Those were corrected and the exact services re-enumerated after the first collector stopped. Installed gbrain source showed automatic Postgres migrations during connect; its MCP tools are static definitions. The same executable/serve was therefore run with an isolated temporary PGlite config, not the production DB. Collector clients/processes were closed and temporary DB/home removed. This is source/schema identity evidence, not production gbrain business proof.

Added `upstream-baseline.ts` to reject version, identity, duplicate/missing tool or schema digest drift across all captured definitions. Red: missing module; green: focused baseline test exercising all three captured schemas and negative mutations (`/tmp/fly2519-upstream-baseline-green.log`), plus teamlead build and diff check. No default factory or upstream business handlers are claimed complete by this test. The 48-row scope remains intact for the subsequent fixed adapters.

### G1/P17 fixed Context7 catalog handlers (2026-09-14)

Added `docs.library.resolve` and `docs.lookup`, covering both tools in the captured Context7 4.1.0 baseline. The former calls only `resolve-library-id`; the latter calls only `query-docs`. Inputs are typed/bounded and reject additional model URL/tool/header fields. The parent SDK handler verifies current project/Lead/activation and the exact tools/list schema/version before dispatch, applies a 15-second request signal, rejects known credentials in outbound queries and inbound content, and projects bounded text with `untrusted=true`. SDK errors, non-text content and invalid results are not forwarded as success.

The broker now preserves the fixed nonsecret `baseline_drift` code instead of flattening it to a generic provider error. The coverage ledger remains explicit: P15/P16 schemas are captured but handlers pending; P17 has Context7 catalog coverage with other applicable surfaces still pending. No row is removed or automatically admitted by baseline presence.

TDD: missing handler red (`/tmp/fly2519-context7-red.log`), then four focused files / 28 tests green (`/tmp/fly2519-context7-final.log`). Tests cover both fixed calls, no extra model routing fields, stale scope, changed schema preventing calls, input/output credential denial and broker propagation of baseline drift. Teamlead build and scoped Biome/diff checks passed. The SDK client and current-context boundary are controlled fixtures here: fixed real HTTP connection lifecycle, factory wiring and complete live acceptance remain required. No production tool call or upstream write was made in this batch.

### G1/P17 fixed Context7 HTTP lifecycle (2026-09-14)

`startContext7Provider` now owns the real MCP Client/StreamableHTTP transport and creates the two existing documentation handlers after a startup baseline check. It uses only `https://mcp.context7.com/mcp`, refuses redirects, keeps optional API credentials in parent headers, bounds decoded response streams to 256 KiB with a 15-second transport deadline, and rechecks current activation around asynchronous boundaries. No arbitrary endpoint, OAuth flow, subprocess or credential file is exposed to the model. The returned surface is handlers/integration/close only.

The provider's close is idempotent, rejects further requests, aborts active HTTP work and waits for its cleanup. A new close-during-fetch test exposed an unclaimed response-body window before reader acquisition; cleanup now handles both the raw response body and acquired reader, including canceled or unconsumed streams. Startup failure also closes the client/transport and response stream.

TDD: missing provider red; then the real SDK handshake/list/call fixture passed, followed by a failing in-flight response-cancellation assertion and the corresponding fix. Three focused files / four tests passed (`/tmp/fly2519-context7-provider-final2.log`); after cleanup ordering was tightened, the two lifecycle tests passed again (`/tmp/fly2519-context7-provider-close-final.log`). Teamlead build and scoped Biome/diff checks passed. The fixture controls fetch and canonical-context checks while exercising the real SDK, so it proves lifecycle/wire behavior, not a live authorized Lead. Default factory assembly and the full live drill remain required.

### G1/P15–P16 all tool inputs and governed write refusal (2026-09-14)

Applied Lead ruling `3a78eb55-d633-42d6-a5f3-a6b2b70bc2d0`: 46 fixed upstream rows now preserve all captured gbrain/Xiaohongshu tool names, with bounded typed inputs. Model xsec-token fields become parent `resourceHandle` fields; media upload paths become controlled artifact handles. No live schema can add a field or tool automatically. gbrain query is retained as its captured semantic query input; no invented SQL/slug restriction is added.

Nineteen write handlers revalidate the current identity/activation and return explicit denials without any upstream client or I/O. Xiaohongshu publish/comment/like/favorite use `founder_write_gate_absent` (无既有门); unclassified gbrain writes and cookie deletion use `unclassified_write`. The broker preserves these fixed nonsecret codes in durable rejected receipts and replay. No founder authority is fabricated, and no write operation is silently removed from the catalog.

TDD: missing handler red, then three focused files / 27 tests green (`/tmp/fly2519-upstream-denials-final.log`), covering exact schema-row coverage, representative actual broker/SQLite rejection+replay, raw token/path denial and nested raw-data input. Initial build caught the installed Zod record signature requirement; fixed to explicit key/value schemas and reran build successfully. Scoped Biome/diff checks passed. The 27 read operations, parent handles/provider wiring/default factory and full live drill remain required; this batch made no upstream business call.

### G1/P15–P16 fixed read adapters and parent token handles (2026-09-14)

Added all 27 captured read handlers with fixed tool names, strict inputs, exact upstream schema/version checks, current activation checks, 15-second cancellation and bounded untrusted results. Xiaohongshu xsec tokens are replaced by activation-local opaque handles tied to the resource ID; share-URL copies are redacted. Closing the adapter clears the handles. More than 512 handles in one result rejects atomically instead of returning an already evicted handle. Images use controlled artifacts and decoded bytes are checked against known parent credentials before writing.

TDD: missing adapter red, decoded-image credential red and handle-overflow red, then four focused files / four tests passed (upstream-read, xiaohongshu-tokens, upstream-baseline, upstream-write-denials). Teamlead build passed. Initial package-name filter matched no projects and was corrected to the actual package/path; that empty invocation is not test evidence. SDK responses and canonical context remain fixtures here. Actual provider lifecycle, factory/TUI, native browser/drill, full gates/review/CI and PR remain required. No upstream business call occurred.

### G1/P16 fixed Xiaohongshu HTTP lifecycle (2026-09-14)

Added the parent-owned real SDK connection to the captured fixed `http://127.0.0.1:18060/mcp` service. Its nine read adapters become available only after the exact startup schema/version check. Cookie storage stays with the existing MCP service; no browser cookie or upstream client is exposed to the model. Close invalidates resource handles and cancels/awaits the HTTP session. Startup/adapter-construction failure closes partial resources.

Extracted Context7's existing bounded HTTP session for these two fixed upstream coordinates, retaining redirect refusal, 256 KiB decoded response budget, 15-second lifetime, current-activation checks and active stream cancellation. No arbitrary endpoint is introduced. TDD missing provider red, then four focused files / five tests green (`/tmp/fly2519-xhs-provider-green.log`) using the real SDK and controlled fetch; both providers' close-during-response tests and Context7 oversized-startup test pass. Teamlead build passed (`/tmp/fly2519-xhs-provider-build.log`). This is connection lifecycle evidence with fixtures, not a live Xiaohongshu business call or complete factory/drill evidence.

Question `faf43d4f-67fd-4e78-8d78-ea34d41b43ff` asks Lead about the existing gbrain connection mode because its actual serve/connect runs migrations. No production gbrain process was started; independent work continues while the answer is pending.

### G1/P06 Lead scope correction and G3 first native host attempt (2026-09-14)

Applied current Lead rulings e7cc5a18 / 75bd38de (full IDs in design-correction.md): catalog marks GitHub/git A/B/C tiers; broker unconditionally rejects Lead feature push, PR creation and GitHub issue comment before provider hooks or historical successful receipt replay. Codes are `lead_runner_owned_operation` and `lead_github_issue_write_denied`. Existing internal generic handler tests do not authorize using those handlers through the Lead broker. The former 180-second Lead push expectation is superseded by this explicit single-writer ruling; Runner implementation remains untouched. B binding and newly named ready/rerun still require actual Bridge wiring.

TDD: three denial assertions failed, then broker/GitHub/catalog three files / 72 tests passed (`/tmp/fly2519-github-tier-green.log`). Added actual SQLite historical success fixtures and reran broker tests (`/tmp/fly2519-github-tier-replay.log`). Teamlead build passed. No external GitHub mutation occurred.

Added rerunnable `node scripts/qa-fly-2519-browser-canary.mjs` using isolated temporary project/profile/artifacts, synthetic Seatbelt canaries, real pinned MCP, native Chrome list_pages and close invalidation. First host run FAILED at startup with browser_lost; an explicit configuration preflight isolated it to `browser_sandbox_configuration_invalid` (`/tmp/fly2519-browser-host-configuration.log`, Node v25.6.1, exit 1). Actual /Applications and Chrome.app have group-write mode, as does Homebrew Cellar; existing validator rejects these source paths. otool also identifies Homebrew Node dependencies outside the current policy, which is a later compatibility concern, not a proven executed dyld failure. No sandbox relaxation, host chmod, existing profile access or production call occurred. Lead question d090db17-c554-4f8a-8cc8-98c86d4fa80c asks about private immutable executable copies. Host/browser evidence remains FAILED, not accepted.

### G3 host identity pins and exact signature failure (2026-09-14)

Implemented Lead ruling d090db17 in `browser-host-identity.ts`: current host Chrome version 153.0.8010.37, Node v25.6.1 binary SHA256 8b6a6d43e16ddc3cddaf1217fb75dbe7151e342e36317491bf3ef4a1ec5d4202 and dynamic libnode SHA256 eba53ff748dff3e370155b4d6543b66f65419c2751b7bdc8b642ce092aff5e9c. The explicit baseline does not update on drift. The verifier hashes before executable probes, runs strict deep Chrome codesign verification, checks versions and rehashes before accepting. Source/ancestor modes are receipt facts. BrowserWorker verifies before the isolation probe and again before MCP transport startup. Deployment verification now includes these identity/worker/policy modules.

Seatbelt source validation retains package-source mode/symlink restrictions, but host Chrome/Node integrity is delegated to the mandatory identity check. Homebrew read/map is allowed per ruling; no Homebrew writes or extra network/IPC authority is added. Profile/tmp isolation remains. No private executable copies or host chmod/xattr changes were made.

Actual `/usr/bin/codesign --verify --deep --strict /Applications/Google Chrome.app` exited 1 with the exact line: `/Applications/Google Chrome.app: resource fork, Finder information, or similar detritus not allowed`. The resulting native canary exited 1 at `host-identity`, code `browser_host_identity_unverified`, Node v25.6.1, 7244 ms (`/tmp/fly2519-browser-host-identity-canary.log`). This fails before the policy canary/MCP/Chrome IPC stages; those remain UNPROVEN. Report c22ce772-e8b3-434b-8282-d3bf10a1a54d carries the exact denial to Lead. Per ruling, further host/browser widening stopped; unrelated implementation can continue.

TDD missing verifier red, then five focused files / 19 tests passed (`/tmp/fly2519-browser-host-final.log`): fixture byte pins, codesign failure preventing Node execution, mid-check libnode drift, zero worker spawn on identity failure, lifecycle cleanup and bounded policy/deployment behavior. Canonical production codesign is not mocked in the host canary; unit fixtures are not host acceptance. Teamlead build and scoped checks passed. Full factory/TUI, gbrain host provider, GitHub B binding/ready/rerun, complete drill and full gates/review/CI/PR still remain.

Superseding signature ruling c22ce772-e8b3-434b-8282-d3bf10a1a54d was received during this batch: removed --strict, added exact baked Identifier=com.google.Chrome / TeamIdentifier=EQHXZ8M8AV checks from bounded `codesign -dv` stderr, made Chrome version drift an explicit warning while retaining mid-check consistency and all Node/libnode pins. Host identity now passes; unit fixtures additionally verify wrong-team refusal and version-warning behavior. The prior strict failure above is historical, not the current blocker.

The next exact host failure is Seatbelt parsing, before Node or Chrome: `sandbox-exec: host must be * or localhost in network address`, backtrace `<input string>:13:26: (remote tcp "127.0.0.1:4311")`. A fixed synthetic Node-launch subprobe under the same generated policy captures bounded stderr without exposing runtime credentials. Evidence `/tmp/fly2519-browser-host-denial.log`, exit 1, 7466 ms. Per ruling, no policy change followed this denial. Native Node/dylib, full isolation canaries and Chrome IPC remain UNPROVEN; no host success is claimed.

Following explicit grammar ruling 7754b935-b2de-4cb6-96da-ea8ab94cc1f8, changed only the forced-egress host token to `localhost:<exact proxyPort>` and added explicit deny network*. Red-to-green sandbox test: seven tests and teamlead build passed. Actual rerun now fails with the exact line `sandbox-exec: sandbox_apply: Operation not permitted`, stage seatbelt-node-launch, exit 1, 7427 ms (`/tmp/fly2519-browser-host-localhost.log`). No Node/dylib or Chrome IPC success is inferred. Policy work stopped at this new failure; no permission escalation is available under this execution profile.

Lead ruling be489e78-7771-404d-b704-848c88cf35f9 assigns the nested-sandbox host proof to QA outside the Implement sandbox. Updated the argument-free canary with distinct `nested_sandbox_unavailable`, durable per-run JSONL evidence paths, explicit proxy refusal and upstream isError failure handling. Syntax/Biome checks passed; no host canary rerun was attempted after this ruling. The gap checklist explicitly records QA ownership and unproven host acceptance.

### G1/P06 Bridge PR/Lead binding reader (2026-09-14)

Added a bounded parameterized StateStore read of existing session/PR rows and CommDB owner resolution using patrol's precedence: exact execution first, otherwise current running/blocked issue cohort, otherwise latest historical cohort. Missing, blank, mixed, mismatched-issue and foreign-project ownership do not grant access. The Bridge helper requires all matching PR sessions to identify one issue and the same Lead; zero rows or overflow rejects as `pr_not_bound_to_lead`. It creates no table, owner cache or authorization-only remote endpoint. It must still be invoked at each actual B write boundary in the upcoming typed Bridge provider.

TDD missing helper red; the first ownership-change fixture hit the existing immutable receipt-lineage guard, so the test was corrected to create distinct real owner rows instead of rewriting that identity. The final actual StateStore/CommDB SQLite test proves no binding refusal, exact ownership, exact-owner precedence over mixed current cohort, conflicting PR sessions refusal, current fallback, ambiguous fallback refusal, latest fallback and foreign project refusal (`/tmp/fly2519-github-binding-final.log`). Comm and teamlead builds passed. The retention consumer gate passes; this reader uses existing live `sessions` tables, which are outside that gate's targetTables. Retention classification is live authority: missing/pruned PR evidence denies, and no durable lineage/history table is used to restore a PR grant.

This is the binding reader only. Parent A reads, B typed write/ready/rerun routes, default factory/TUI and full acceptance remain unfinished. No production DB or GitHub mutation was performed.

### G1/P06 bound GitHub B effects and actual Bridge HTTP path (2026-09-14)

Added named `github.pr.ready` and `github.run.rerun` B rows plus bounded PR label edits. Ready uses a fixed GraphQL mutation after verifying the existing PR/node ID and current owner binding; it grants no approving review or merge. Rerun requires a completed run, exact canonical repository and linked current PR head. PR edit permits only title/body/labels, and label results must match the requested set. Reviews remain COMMENT only. All B handlers run in Bridge with the live StateStore/CommDB binding rechecked at actual write boundaries.

Mounted fixed `/api/lead-capabilities/github` and `github-receipt` routes through the existing authenticated canonical/carrier envelope. The normal route uses the existing broker/SQLite UUID state machine; the receipt route performs only live binding and receipt reads. Neither returns an authorization grant for a later parent-side mutation. Same UUID never reissues an already recorded write; changed input rejects. `pr_not_bound_to_lead` is preserved by the broker. Actual Bridge assembly accepts a trusted `leadGithub` client/secrets option; production initialization of that option and the parent transport/default factory remain outstanding.

Tests use real StateStore, CommDB, receipt SQLite and mounted HTTP, with controlled SDK business responses. Missing-module and label-evidence assertions failed first; after fixes six focused files / 92 tests passed (`/tmp/fly2519-bound-github-final.log`). Both standalone router and full createBridgeApp paths prove missing binding, one mutation across UUID replay, read-only receipt lookup, changed-payload refusal and revoked-carrier refusal. The full-app fixture initially supplied options in the wrong legacy positional slot; corrected to the existing BridgeAppOptions slot, not a production API redesign. Receipt correlation and deployment entry additions were followed by three files / 21 tests (`/tmp/fly2519-bound-github-receipt-final.log`). Build caught implicit wrapper parameter types, corrected them, and final teamlead build passed (`/tmp/fly2519-bound-github-build-final2.log`). Scoped Biome/diff checks passed. No production GitHub call occurred.

A reads, parent B transport, real default client/factory/TUI assembly, gbrain host lifecycle, full drill and full gates/review/CI/PR remain. Host Chrome acceptance remains QA-owned outside the Implement sandbox per be489e78.

### G1/P06 parent GitHub A adapters and B transport (2026-09-14)

Added a parent A-only handler adapter over the typed GitHub reads. It rereads current canonical projectRepo and activation authority and rejects repository changes across asynchronous provider calls; it adds no PR department grant. The separate parent B transport exposes only comment/edit/COMMENT review/ready/rerun, using fixed Bridge github and github-receipt routes. Fresh results validate request UUID and resource evidence; durable replay accepts a receipt without inventing fresh provider data. C operations remain denied in the broker.

Added explicit pr_not_bound_to_lead propagation through parent outcomes and Bridge receipt lookup. The actual standalone and full Bridge HTTP regression first reproduced read_unavailable for a missing binding; both now preserve the explicit denial without SDK mutation. Five focused files / 54 tests passed (`/tmp/fly2519-github-parent-verification.log`). The A adapter first failed as a missing module (`/tmp/fly2519-github-read-parent-red.log`); build then caught unknown repository input and unchecked split elements, both narrowed explicitly. Final teamlead build passed (`/tmp/fly2519-github-parent-build-final.log`). No production GitHub call occurred.

These are callable adapters, not completed default runtime assembly. Real client initialization, factory/TUI, gbrain host lifecycle, complete drill, repository-wide gates, review, exact-head CI and non-draft PR are still pending. Browser host proof remains QA-owned under be489e78; no canary retry was performed.

### G1/P15 pinned host gbrain provider and real canary (2026-09-14)

Implemented the lifecycle required by Lead ruling `faf43d4f-67fd-4e78-8d78-ea34d41b43ff`: the parent starts the actual host gbrain 0.9.0 CLI with its existing ~/.gbrain/config.json, rather than an isolated replacement service/database. Before spawn, it verifies the Bun binary SHA, global lock SHA, bounded package/src tree SHA and package version. Config changes invalidate the session; database URL overrides, Bun preload environment, .env loading and automatic dependency installation are excluded. Config credentials (including encoded/decoded DB password) remain parent-only and join the existing read adapter's secret filter. Gbrain writes retain the prior explicit denial.

Extracted the existing bounded stdio/process-group lifecycle into a shared internal transport. The browser wrapper still requires the exact Seatbelt launch and its existing environment allowlist; no browser policy or canary was retried. Gbrain uses the same bounded JSON-RPC parsing, exact environment, no restart, and owned child-group cleanup. Diagnostic output is drained into bounded counters/classifications only; raw logs and data are not printed. The provider validates the full version/schema before exposing existing read adapters, checks current activation/code/config around calls, and closes the SDK, transport and adapter on failure or shutdown.

TDD missing host/transport modules failed first. Six focused files / 12 tests now pass, including actual child/SDK calls, config/code drift refusal, decoded-password secrecy, closed-session rejection, existing browser orphan-process cleanup and compiled deployment verification (`/tmp/fly2519-gbrain-suite-final2.log`). Teamlead build passed (`/tmp/fly2519-gbrain-build-final2.log`), as did scoped Biome and script syntax checks.

The argument-free `node scripts/qa-fly-2519-gbrain-canary.mjs` performs actual host pins, MCP initialize/tools-list, exact 30-tool schema verification, read-only get_stats and close. First host runs failed during initialize: Bun interprets the separated `--config /dev/null` as a module path. A credential-free `bun --no-env-file --config /dev/null --version` reproduced `Module not found '/dev/null'`; the equals-form succeeded. Added the failing argv expectation, fixed to `--config=/dev/null`, then passed actual host canary. Final invocation (also disabling auto-install) exited 0 with 30 tools and **zero Migration N applied**, no error classifications, and successful close. Durable receipt: `/private/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/fly2519-gbrain-evidence-UfmZbt/canary.jsonl`; command log `/tmp/fly2519-gbrain-host-canary-final2.log`. Earlier failed receipts remain intact.

Current source inspection also corrects the earlier generalization about connect-time migrations: this pinned Postgres db.connect path performs SELECT 1; serve then starts MCP. initSchema/runMigrations are separate. The initial schema capture used PGlite under unresolved migration concerns; it was not host proof. The current host receipt is real read evidence, not permission for production provider writes or v2 activation.

Default factory/TUI and production client assembly remain unfinished; this provider is callable but not yet installed into the normal startup path. Full issue drill, repository gates, review, exact-head CI and non-draft PR remain pending. Browser host proof remains independently QA-owned.

Additional startup-failure verification uses a real MCP child advertising a changed version: provider initialization rejects baseline_drift, and every spawned fixture PID is gone after cleanup (`/tmp/fly2519-gbrain-partial-start.log`). Final TypeScript no-emit check also passed (`/tmp/fly2519-gbrain-final-types.log`).

### G1/P06 actual GitHub SDK and Bridge startup wiring (2026-09-14)

Added the actual parent Octokit client with fixed https://api.github.com routing, no retry plugin, manual redirect handling, 4 MiB decoded response budget, 15-second request lifetime and cancellation/drain on close. The sole accepted authenticated 302 is the Actions run-log endpoint; the existing separate pinned HTTPS ZIP downloader remains responsible for the signed location. Other redirects and foreign origins reject before any redirected request. SDK diagnostic logging is suppressed. Credentials use existing GH_TOKEN/GITHUB_TOKEN precedence or fixed `/opt/homebrew/bin/gh auth token --hostname github.com`, bounded and with a washed helper environment; values stay in parent memory. No live token or GitHub request was used during this implementation batch.

Actual startBridge now owns a lazy client provider and closes it in the shutdown path. The typed GitHub route invokes this loader only after current canonical/carrier checks. Lazy loading avoids depending on a stale startup-only v2 registry snapshot and performs no credential read at ordinary Bridge boot. Receipt-only requests need neither the loader nor a client and continue to read only binding/receipt state. Actual standalone and full Bridge HTTP fixtures prove no loader call during receipt lookup or after carrier revocation. Scope and PR ownership checks remain in the existing Bridge handlers.

TDD missing client/configuration factory failed first; early startup-only selection was replaced during integration audit with the final lazy lifetime. Three focused files / 66 tests passed before that adjustment; final lazy routing/handler suite passed three files / 23 tests (`/tmp/fly2519-github-lazy-green.log`). Added real SDK checks for no authenticated redirect following, accepted run-log 302, response cap, close cancellation and exact 15-second timeout; these plus compiled deployment tests passed two files / 7 tests (`/tmp/fly2519-github-client-final-tests.log`). Build first caught nonportable inferred Octokit declaration types; explicit public return types corrected them. Final build (`/tmp/fly2519-github-lazy-build.log`), final TypeScript no-emit check (`/tmp/fly2519-github-client-final-types.log`), scoped Biome and diff checks passed.

The normal Codex parent factory/TUI remains unassembled and must consume these clients/providers. Remaining Bridge startup surfaces, full isolated issue drill, full repository gates, review, exact-head CI and non-draft PR remain outstanding. No production activation/restart/provider write or browser canary retry occurred.

### G1 assembly audit and unconditional denials (2026-09-14)

The resolver/parent previously required a concrete handler and credential integration for git.feature.push, github.pr.create and github.issue.comment, despite the binding Lead ruling making those operations unconditional broker denials. Removed that assembly requirement only for catalog entries carrying unconditionalDenial. They remain visible in the manifest and immediately reject through the existing broker, including before historical replay/provider dispatch; ordinary operations still require both handlers and integrations. No denied provider is instantiated just to satisfy inventory.

TDD resolver initially omitted the three denial rows without handlers. Final resolver and real parent UDS test pass (two files / six tests, `/tmp/fly2519-factory-denials-green.log`): a parent with no Git handler serves an exact lead_runner_owned_operation denial. Teamlead build passes (`/tmp/fly2519-factory-denials-build.log`).

The assembly audit found additional concrete prerequisites that the generic remaining-factory note had not named: (1) discord.message.attachments.get/send occur only in catalog/tests, with no concrete handler, although plan section 5 explicitly requires them; (2) six existing runner tools are implemented in runner-actions.ts but are absent from the v2 catalog/façade path, whose manifest only contains catalog operations; (3) production native-skill pins and complete source selection are still not supplied to a default factory. These are implementation gaps, not approved removals or non-blocking advisories. The default factory/TUI must not be enabled by omitting them. Complete attachment transport, preserve all six runner tools with existing scope/idempotency authority, supply explicit source/native pins, then finish the shared factory and remaining Bridge startup surfaces before the full issue drill and gates. Browser host proof remains QA-owned; no production mutation or browser retry occurred.

### G1/P04 actual attachment read path (2026-09-14)

Implemented discord.message.attachments.get across the typed Bridge route and a parent artifact handler. Bridge reuses the current thread/department authorization before and after provider work. It reads the exact fixed Discord message endpoint, verifies message/channel/attachment IDs, restricts the download to the matching Discord CDN attachment path, rejects redirects and mismatched declared/actual bytes, enforces the existing 25 MiB limit and scans known credentials. The bot token is attached only to the Discord API request, never to CDN requests. Parent receives bytes with request UUID, MIME and SHA-256 evidence rather than a CDN URL/authorization grant, validates the complete response, scans its own known secrets and stores an activation-owned artifact handle. Unknown binary content uses application/octet-stream and generated .bin filenames under the existing bounded, inode/hash-checked artifact store.

TDD missing download helper failed first. Parent binary-artifact test then failed until the explicit octet-stream artifact type was added. Final four files / 16 tests passed (`/tmp/fly2519-attachment-get-final.log`), covering exact API/CDN credential separation, foreign hosts/threads, oversized metadata, redirects, revocation, size mismatch, known credentials, parent UUID/content evidence and real mounted Bridge HTTP. SDK/upstream responses are controlled fixtures; no live Discord request occurred. Teamlead build (`/tmp/fly2519-attachment-get-build.log`), compiled deployment tests (`/tmp/fly2519-attachment-deployment.log`), scoped Biome and diff checks passed.

This completes the callable attachment read path only. Attachment sending, six runner tools in v2, explicit native/source pins and default factory/TUI assembly remain required, alongside other remaining Bridge startup surfaces and full issue drill/gates/review/CI/PR. No production activation/restart/write or browser canary retry occurred.

### G1/P04 attachment send transport primitive (2026-09-14)

Added the trusted Bridge multipart sender alongside the existing attachment downloader. It accepts already-validated in-memory bytes, uses generated filenames and a fixed Discord message endpoint, disables mentions and redirects, preserves the supplied bounded nonce with enforce_nonce, and copies bytes into Blob before asynchronous authorization. It caps each file at 25 MiB and the list at ten, rejects known credentials in text/files/results, bounds response JSON to 256 KiB, and enforces a 15-second abortable lifetime. Current scope is checked before dispatch and after response work. It issues exactly one provider request; any ambiguous result remains an opaque error for the durable caller to reconcile. This helper does not itself claim durable request authority and must not be wired without that caller.

TDD six tests first failed because the sender export was missing. Final send/download suite passes two files / 11 tests: multipart contents and credential destination, invalid/empty/oversized inputs, revocation, non-retry on provider errors/redirects/mismatched message ownership, cancellation with an unresponsive fetch and stale success. Teamlead build passed (`/tmp/fly2519-attachment-send-build.log`), scoped Biome passed. All provider responses were controlled fixtures; no live Discord write occurred.

Attachment SEND is still incomplete: parent binary upload, Bridge file-digest/UUID receipt binding, replay/receipt-only handling and HTTP integration remain. The existing GET path is unchanged. The six runner tools, production native/source pins, shared runtime factory/TUI, remaining Bridge wiring, isolated issue drill and full repository/review/CI/PR gates remain open. No production activation or browser retry occurred.

### G1/P04 Bridge attachment upload and durable send receipts (2026-09-14)

Implemented the Bridge-owned attachment send wrapper using the existing operation receipt table in SqliteOutboundDedupStore. Its input digest binds thread, text, ordered artifact handles, MIME, sizes and SHA-256 of copied bytes. Atomic prepare/dispatch/success transitions admit one send; any existing prepared/dispatched/unknown receipt forbids resending. A persisted successful message ID can be returned after SQLite close/reopen and activation movement, but only after fresh canonical authorization. Receipt-only lookup never creates a row or dispatches. Cancellation/ambiguous provider results become unknown; changed payload under the same request UUID rejects. No new authority table was introduced.

Added a bounded internal binary upload frame (64 KiB JSON header, at most ten 25 MiB files), exact lengths and per-file hashes. The typed Bridge /attachments endpoint authenticates before reading the large body, allows one active upload per router, rejects compressed/nonbinary input, and bounds the entire upload lifetime to 15 seconds. It reuses the current canonical thread/department scope checks, binds uploaded handles to catalog input, and calls the durable sender. Actual Bridge startup supplies its existing operationReceipts instance. Parent artifact-handle-to-upload wiring remains absent; this is not yet end-to-end SEND delivery.

TDD: receipt wrapper tests initially failed on the missing export; upload frame tests initially failed on the missing module; actual mounted Bridge route test initially returned 404. Final five files / 23 tests pass (`/tmp/fly2519-attachment-upload-final.log`), including SQLite close/reopen, concurrent and interrupted dispatch, file/text/MIME/handle/order conflicts, receipt-only absence, stale replay, binary truncation/tamper/trailing bytes, HTTP unauthorized request, successful upload/replay and changed-file refusal. Provider responses are controlled fixtures; no live Discord mutation occurred. Teamlead build passed (`/tmp/fly2519-attachment-upload-build.log`); compiled deployment tests passed (`/tmp/fly2519-attachment-upload-deployment.log`), scoped Biome and diff checks passed.

Next: parent artifact upload and result/reconcile handling, then six runner tools in v2, explicit production native/source pins, shared factory/TUI, remaining Bridge startup wiring and the full issue drill/gates/review/CI/non-draft PR. Browser host proof stays QA-owned; no canary retry or production activation/restart occurred.

### G1/P04 composed parent attachment send and receipt lookup (2026-09-14)

The parent attachment handler now exposes SEND as well as GET. SEND resolves activation-owned artifact handles through the inode/hash-checked store, scans text and bytes for parent credentials, encodes the fixed binary upload envelope and dispatches only to the configured Bridge attachment endpoint. It bounds its entire work to 15 seconds, including an unresponsive fetch, and verifies bounded JSON results against request UUID, receipt UUID and the exact Discord message provider reference. It does not return paths, URLs, credentials or authorization-only grants. Its reconcile method uses the same request/input with receiptOnly=true; an absent/unknown receipt stays unknown and cannot trigger a send. If an old activation no longer owns the artifact handles, reconciliation fails closed rather than restoring authority from a path.

TDD the new parent test initially failed because no SEND handler existed. Final six files / 25 tests pass (`/tmp/fly2519-attachment-composed-final.log`). Coverage includes unknown handles, credential-bearing text/files, wrong request UUID and an unresponsive fetch cancelled by the caller. The existing real-registry Bridge fixture now invokes the actual parent handler over real local HTTP, through canonical scope checks and the real SQLite receipt store, proves successful upload plus receipt-only reconciliation without a second provider send, and rejects the same lookup after department membership changes. Carrier process probing and Discord/Linear responses remain controlled fixtures; this is isolated integration evidence, not production activation or live Discord delivery.

Teamlead build passed (`/tmp/fly2519-attachment-parent-build.log`); scoped Biome and diff checks passed. Both attachment operations now have callable parent/Bridge paths. Their selection by the still-missing default runtime factory remains unproved. Next work is the six retained runner tools in v2, explicit production native/source pins, shared factory/TUI and remaining Bridge wiring, followed by full issue drill/repository gates/review/exact-head CI/non-draft PR. No production mutation or browser canary retry occurred.

### G1/P01 retained runner contracts and v2 MCP names (2026-09-14)

Added all six existing runner names as concrete P01 catalog operations, with scoped Bridge credential consumption, typed inputs and bounded outputs. Extracted the original input schemas into a shared module; v1 still passes its current adopted-menu enum and its execution implementation is unchanged. V2 catalog taskCategory is a bounded identifier, with adopted-menu authorization still required at the provider. The v2 MCP facade advertises the original six tool names only when their operations occur in the signed manifest. Each tool takes the original arguments plus an explicit requestId and translates only to a broker envelope; it performs no database, credential or direct provider action. Existing business idempotency keys remain intact.

Resolver now requires all six registered handlers, Bridge integration, current runner capability and adopted menus before projecting the runner group. Missing handlers or menu adoption cannot advertise the old six names from configuration alone. Actual v2 Bridge execution handlers and parent transport are still missing, so this contract/facade work does not yet establish usable runner parity or justify enabling the default factory.

TDD catalog, MCP tool-list/dispatch and resolver tests failed first on missing operations/names and erroneous availability without handlers. Final four files / 51 tests pass (`/tmp/fly2519-runner-manifest-final.log`), including all 30 existing runner action tests and native MCP in-memory transport verification of exact UUID-bound forwarding. Teamlead build passed (`/tmp/fly2519-runner-manifest-build.log`); compiled deployment tests passed (`/tmp/fly2519-runner-manifest-deployment.log`). No runner was dispatched and no production mutation occurred.

Next: typed Bridge runner execution using existing authorization/idempotency, parent handler/reconciliation and isolated integration proof; then native/source pins, shared factory/TUI, remaining Bridge wiring and full issue drill/gates/review/CI/PR. Browser proof remains QA-owned.

### G1/P01 execution-boundary prerequisites (2026-09-14)

The old runner Bridge HTTP client did not accept its caller's cancellation signal and relied on fetch itself honoring the timeout. Added optional trusted caller cancellation, rejection before dispatch for an already-aborted call, bounded races for both fetch and streamed body reads, late-response cancellation and nonblocking cleanup. It retains the existing 15-second/256 KiB budget, request routing, response classification and no-retry behavior; errors still do not expose provider diagnostics.

Extracted the existing scoped-question lookup inside createRunnerActions so both actual respond execution and a new read-only authorize method share recipient, reserved-checkpoint, owner, expiry and disposition checks. The authorize method also reuses runner scope and current adopted-menu/start-key/lease checks. It does not send, respond or start a runner. This is a trusted Bridge primitive for verifying access before receipt replay; it is not a model-visible authorization-only provider protocol. V1 execution remains on the same guarded CommDB and Bridge paths.

Integration auditing also found a real DTO mismatch: a manual start has source='none' and sourceRef=null. The new P01 output schema incorrectly rejected that valid legacy result. Corrected it to allow null, with a test using the actual existing start implementation's output rather than a synthetic DTO.

TDD caller-abort/uncooperative-fetch tests failed first, as did missing authorization and nullable-result tests. Final three files / 56 tests pass (`/tmp/fly2519-runner-authorize-green.log`), including the 30 original action tests, two new action tests and 17 transport tests. Teamlead build passed (`/tmp/fly2519-runner-authorize-build.log`), scoped Biome and diff checks passed. No production call or runner dispatch occurred. Actual v2 typed Bridge routing, durable runner receipts and parent handlers remain next; catalog/MCP availability alone still does not establish runner parity. Factory/native pins/full gates/review/CI/PR remain open.

### G1/P01 actual Bridge runner execution and durable receipts (2026-09-14)

Added executeLeadRunnerOperation over the original six runner actions and the existing Bridge operation receipt store. It requires current v2/canonical identity, runs the shared scope authorization before dispatch/replay and preserves the original guarded Bridge/CommDB effects. The existing broker owns atomic UUID/digest prepare/dispatch/success/unknown transitions. Successful receipts reconstruct only typed execution/instruction/response evidence; start replay rechecks ownership of the recorded execution. Changed input under the same UUID rejects; concurrent, interrupted and unknown starts never redispatch. Receipt-only requests cannot create a missing receipt or invoke a write. Pending legacy starts remain unknown at the result-only broker boundary and must be inspected through runner reads, not restarted.

Added the typed /api/lead-capabilities/runners router and actual Bridge startup wiring using its existing StateStore path, per-project CommDB resolver and shared operationReceipts. The route authenticates the master credential, validates the strict bounded envelope, rechecks canonical registry/carrier identity and builds the original runner context only in Bridge. Request disconnection propagates to the execution wrapper. No database path, raw Bridge URL or credential comes from model arguments.

TDD the execution-wrapper test failed on its missing module. Final six files / 76 tests pass (`/tmp/fly2519-runner-bridge-final.log`), covering all six actual action handlers against isolated SQLite/controlled downstream HTTP, typed outputs, successful and absent receipt-only lookups, UUID/input conflicts, scope movement, concurrent and aborted starts, and a real mounted HTTP route with wrong-token/digest rejection. The HTTP fixture initially lacked carrier evidence. Attempting a real local process-start probe then failed with spawnSync ps EPERM; the final fixture explicitly replaces only carrier validation, as the existing Bridge fixtures do. Registry/HTTP/SQLite remain real; this is not host carrier proof and no production runner was dispatched.

Correction to the prior subsection's build claim: the previous build passed before a final lint edit removed a return expression from the new authorize method. That final code lost TypeScript narrowing. This batch's first build caught TS18048, and an explicit throw restored narrowing. A fresh final build now passes (`/tmp/fly2519-runner-bridge-final-build.log`); do not treat the prior subsection's build as exact-final-head evidence. Deployment checks are included in the 76 tests; scoped Biome/diff checks pass.

Next required step is the parent typed runner handler/reconciliation path. Default factory/TUI selection, production native/source pins, remaining Bridge wiring, full issue drill/repository gates/review/exact-head CI/non-draft PR remain incomplete. No production mutation or browser retry occurred.

### G1/P01 parent runner transport and composed MCP execution (2026-09-14)

Added createRunnerBridgeHandlers using the existing parent Bridge transport. It returns all six handlers, uses only the fixed /api/lead-capabilities/runners route, keeps the original business idempotency fields and request UUID, and sends receiptOnly=true for write reconciliation. Parent checks receipt coordinates before reconciling and correlates successful results with the requested execution, UUID and exact execution/instruction/response provider reference. Known credentials are rejected in runner input and provider output. The parent does not open StateStore/CommDB or invoke runner actions directly.

TDD the new parent test failed on the missing factory export. The final integration now drives an actual native MCP proxy over SDK in-memory transport into a real parent broker, the new parent handler, real local HTTP Bridge and separate parent/Bridge SQLite receipt stores. Repeated MCP calls return the same durable result; explicit receipt-only reconciliation adds no downstream start. Carrier validation remains the explicit fixture described above, and the proxy-to-broker request client is a direct test seam rather than UDS in this test. Existing UDS evidence is separate. Downstream runner start is controlled; no production runner was launched.

Final four files / 59 tests passed (`/tmp/fly2519-runner-parent-final.log`), including existing Bridge transport regressions, 36 runner action/integration tests, nine MCP tests and two compiled deployment tests. Teamlead build passed (`/tmp/fly2519-runner-parent-build.log`); scoped Biome and diff checks passed. P01 now has callable six-tool MCP/parent/Bridge paths, but default runtime assembly remains missing and no live parity acceptance is claimed.

Next: explicit production native/source pins, shared default runtime factory and TUI integration, remaining Bridge provider startup surfaces, full isolated issue drill and repository gates/review/exact-head CI/non-draft PR. Browser host canary remains QA-owned; no retry here.

### G1/G4 explicit native skill baseline and persona transport wording (2026-09-14)

Observed the actual local Codex executable version as 0.153.2 and hashed all six .system SKILL.md files in the current Implement home: imagegen, openai-docs, plugin-creator, review-agent, skill-creator and skill-installer. Committed these exact hashes in native-skill-baseline.ts under the existing six-skill admission ruling. The exported baseline is immutable; runtime content is never used to regenerate expected hashes. Native skill resources/discovery and complete factory selection remain governed by the existing verifier and pending assembly.

Added argument-free, read-only scripts/qa-fly-2519-native-skills-canary.mjs. It runs only the fixed host codex --version command, checks the current CODEX_HOME native skill tree against the committed baseline and emits names/hashes plus status. It does not start a model, bootstrap a home, copy account files or activate production. Actual run passed (`/tmp/fly2519-native-pins-host.json`), confirming this Implement home only. This is not proof of Honey Lemon's activated home or live skills/list discovery.

Changed Honey Lemon's canonical persona tooling paragraph from 'full Claude Code session' to the configured backend's shell/search/read/document editing capabilities, retaining direct PRD authoring and default runner delegation. Agent/NotebookEdit stay outside the workflow; Codex browser work explicitly uses native Chrome DevTools MCP. Other persona responsibilities and governance remain unchanged. Updated stale gap-checklist rows to reflect completed callable attachment/runner paths while preserving the outstanding default-factory/full-acceptance checks.

Teamlead build passed (`/tmp/fly2519-native-pins-build.log`). Three existing native/skill/deployment test files / five tests passed (`/tmp/fly2519-native-pins-tests.log`); canary syntax and diff checks passed. Next: actual source/adapter selection and shared runtime factory/TUI, remaining Bridge startup surfaces, full isolated issue drill and repository/review/CI/PR gates. No production activation, provider write or browser retry occurred.

### G1/G4 installed plugin skill provenance (2026-09-14)

The installed-input inventory previously scanned plugin tool declarations but omitted plugin skills. Added sourceSkills to each plugin entry using the existing bounded SKILL.md reader. Each installation retains its own path/hash; duplicate names across installations are not silently merged. Entries remain explicitly installed_registry_only, and parityVerified remains false. No provider, plugin command or skill is executed and no skill body is exported.

TDD the new two-installation fixture failed on the absent sourceSkills field, then all six inventory tests passed with scoped Biome checks. Read-only host inventory saved to /tmp/fly2519-installed-source-inventory.json confirms the minimalist-entrepreneur plugin has ten child skills, including the five named in Honey Lemon's map. Neither a research skill nor a matching installed plugin command was found. These are installed-source observations, not active session discovery. Asked Lead question 4b1bfb67-e2b3-47ba-a30c-a1a5ce9eee51 about explicit collection mapping and the missing research requirement; the selector currently fails closed on missing required sources. No relaxation implemented. Default factory, source adapters and complete acceptance remain outstanding.

### G1/G4 ruled persona source aliases and visible fallback (2026-09-14)

Acted on Lead question 4b1bfb67-e2b3-47ba-a30c-a1a5ce9eee51: expanded the collection and research aliases, corrected Honey Lemon's canonical wording and pinned twelve actual source paths/digests. The selector preserves absent/changed sources as explicit skillGaps and does not select changed pinned content. Persona skills are non-blocking under this ruling; native deployment verification is unchanged. Pin constants and gap results still require default-factory wiring and startup receipt consumption. No active skill discovery or full parity is claimed.

Alias/fallback tests failed first (two failures); pin drift test then failed first on incorrectly selected changed content. Final three files / fifteen tests pass (rule-sources, native-skills, manifest-skills). Scoped Biome passed. Linear SDK audit found no per-client fetch injection in the locked SDK; no Linear code was changed during this batch. Full factory/provider composition and repository/review/CI/PR gates remain outstanding.

Fresh final Teamlead build passed after the pin-drift change (`/tmp/fly2519-skill-ruling-final-build.log`); diff checks passed. No production activation, provider mutation or browser retry occurred.

### G1/P05 actual Linear SDK transport and operation lifetime (2026-09-14)

Added createLeadLinearClient using the locked SDK's public LinearSdk request injection. It posts only to https://api.linear.app/graphql with parent-held credentials, manual redirects and no retries. Requests require an operation signal, have a fifteen-second transport deadline and bounded one-MiB request/four-MiB decoded response bodies. Cancellation races an uncooperative fetch or stream, cancels late response bodies, and shutdown rejects new work and aborts active requests. Provider errors are reduced to a fixed error code. The existing typed handlers now accept LinearSdk (LinearClient remains structurally compatible).

Added createLinearProviderSession as the actual seven-handler composition entry. It binds metadata authorization and execution to the broker operation signal through AsyncLocalStorage, keeping concurrent request lifetimes separate without replacing global fetch. Canonical project/department metadata checks remain in the existing provider. Direct graphql 15.10.1 dependency reuses the exact transitive version already locked for Linear SDK. Offline addition failed on unrelated missing registry metadata; normal pnpm resolution succeeded with only the one dependency/importer addition. No package version upgrades were introduced.

TDD the client suite failed first on the absent module. Final three Linear files / 28 tests pass (`/tmp/fly2519-linear-client-tests.log`), covering the actual SDK fixed endpoint/query/auth, missing operation lifetime, mutation redirect/no retry, provider error privacy, uncooperative fetch cancellation/late body cleanup, decoded byte budget, shutdown and fifteen-second timeout. A composed provider test proves the actual SDK metadata request is cancelled before any mutation; it retains the existing fixture's mocked carrier context, isolated projects file and controlled fetch. No production Linear call was made. Teamlead build passed (`/tmp/fly2519-linear-client-build.log`), then two compiled deployment tests passed; scoped Biome and diff checks passed. Deployment entries now include this client/provider and the persona source baseline.

Default runtime factory/TUI assembly remains incomplete: it must select these actual providers, source adapters/pins and startup gaps, finish full isolated issue proof and run all repository/review/exact-head CI/non-draft PR gates. No production activation or browser retry occurred.

### G1 shared provider assembly and activation cleanup (2026-09-14)

Added startLeadRuntimeProviders in runtime-factory.ts. It constructs the actual Bridge runner/read/Discord/attachment/GitHub-write/terminal/inbox/patrol/report adapters, parent GitHub and Linear SDK sessions, explicit upstream write denials, pinned gbrain/Xiaohongshu/Context7 sessions and native browser provider. It preserves upstream integration receipts and parent-only credentials for subsequent manifest/broker assembly. It rejects duplicate/unknown/reserved handlers and incomplete non-reserved catalog coverage rather than dropping unsupported rows. No StateStore handle is created in this assembly layer.

Completed child providers are owned by a reverse-order cleanup stack. Child startup exceptions trigger cleanup of all earlier completed providers; child implementations retain responsibility for their own partial-start failures. Shutdown aborts the activation signal, rejects new authorize/execute/reconcile calls, and attempts every cleanup even if one close fails. Tests exposed a missing reconcile lifetime guard after the initial implementation; that guard is now present. The outer factory still must assemble deployment identity, source adapters/pins, native home, manifest and runtime parent and connect both launchers. This is provider composition, not evidence that default v2 startup is complete.

TDD the new factory suite failed first on the missing module; reconciliation shutdown failed separately before its fix. Final four files / 30 tests passed (`/tmp/fly2519-runtime-providers-tests.log`), followed by two compiled deployment tests. Teamlead build passed (`/tmp/fly2519-runtime-providers-build.log`), with scoped Biome and diff checks passing. The factory fixture keeps actual Bridge/Linear/GitHub adapter construction and an actual abortable Bridge fetch path; it explicitly substitutes carrier context and the four external MCP/browser startup boundaries. It proves assembly coverage and cleanup only, not upstream schemas or host browser confinement. No production provider call, activation or browser canary retry occurred.

### G1 provider-to-manifest-to-parent assembly (2026-09-14)

Added startLeadRuntimeParent over the actual provider composition and existing startLeadCapabilityParent. It rechecks current canonical identity and prepared deployment/source state, resolves permitted operations with adopted runner menus, rejects missing capability coverage, builds the public manifest and installs the pinned six-native-skill baseline into that manifest. It wires the actual automatic outbound transport, shared journal, provider handlers, credentials and browser proxy into the existing parent. Parent startup failures close all providers; identity movement after provider startup rejects before parent handoff and also cleans up. Existing parent code continues to own home configuration, skill installation, model isolation and UDS/broker startup.

Integration coordinates distinguish deployed local facades (source revision plus actual catalog input/output schema digest) from upstream MCP receipts. Browser uses the pinned Chrome MCP 1.9.0 and its upstream schema digest, not the local source revision. The new browser-coordinate assertion failed before that correction. Composition fixtures initially omitted explicit codexRunnerActions authorization and correctly failed eligibility; fixtures were corrected, not the policy. The first build caught readonly native baseline versus mutable manifest input typing; copying the fixed baseline into the input fixes that mismatch without recalculating pins.

This test layer explicitly substitutes the runtime parent boundary in addition to the previously documented external MCP/browser and carrier boundaries. It verifies the real manifest, resolution and automatic outbound assembly and failure cleanup; the separate runtime-parent test exercises its real lifecycle. No claim is made that a default launcher can start v2 yet: deployment/source adapters, source receipt gaps, native-home preparation and default runtime/TUI invocation still require wiring. No production activation, provider call or browser canary retry occurred.

Final four files / 20 tests passed (`/tmp/fly2519-runtime-parent-assembly-final-tests.log`), and a fresh Teamlead build passed after the typing fix (`/tmp/fly2519-runtime-parent-assembly-final-build.log`). Scoped Biome and diff checks pass. Full repository gates/review/exact-head CI/non-draft PR remain outstanding.

### G1/G4 verified source consumption and visible skill-gap startup receipts (2026-09-14)

Connected prepareLeadManifestSources to startLeadRuntimeParent. The factory now consumes actual rule-source records rather than accepting already-projected rule/skill arrays. Original and adapter bytes are verified against their recorded digests with the existing bounded Markdown reader and credential scan. Required missing rules or rule drift reject before provider startup. Missing/unverifiable persona skills are omitted from admitted skill instructions and retained as visible gaps under Lead ruling 4b1bfb67. The actual launcher still must supply its complete discovered/selected records and adapters; this does not substitute a preset expected list for actual discovery.

Added bounded, strict skillGaps to the public manifest and MCP validator. Gaps participate in the manifest digest, reject duplicate source IDs, and preserve compatibility when absent. The parent adds the gap receipt and explicit manual-fallback wording to baseInstructions; headless runtime logs the same structured gaps at startup. No unavailable skill is represented as loaded, and the six-native-skill baseline remains separately mandatory. TDD assertions failed first on dropped manifest gaps, missing parent fallback text and the absent source-consumption function.

Final four source/manifest/parent/factory files / 32 tests passed (`/tmp/fly2519-skill-source-consumption-tests.log`); the factory file was rerun successfully after adding an explicit end-to-end source-gap receipt assertion. Three runtime/MCP/deployment files / 152 tests passed (`/tmp/fly2519-skill-gap-runtime-regressions.log`). Teamlead build passed (`/tmp/fly2519-skill-source-consumption-build.log`); scoped Biome and diff checks passed. Actual file fixtures prove source drift handling and source-to-manifest propagation; existing parent fixture uses its real UDS/broker lifecycle with the documented model-isolation seam. No production activation/provider call/browser retry occurred.

Remaining: default launcher discovery and adapter selection, deployment/native-home preparation, default runtime/TUI invocation, full isolated issue proof and repository/review/exact-head CI/non-draft PR gates.

### G1/G4 configured source discovery under explicit admission ruling (2026-09-14)

Added discoverLeadSkillSources/discoverLeadRuleSources. The read-only discovery scans user/workspace skill sources and scoped installed-plugin skill sources, records configured enabled flags separately, expands canonical aliases, applies the twelve fixed source pins and selects only the corrected persona map plus the six explicitly named rule-bundle skills from ruling 34034413. Plugin skill names retain namespaces; later persona edits can admit a namespaced skill without changing code. Methodology sources remain in inventory with not_in_persona_map. Plugin manifests are also inventoried so plugins without SKILL.md are not silently lost. No global settings, plugin processes or account files are modified.

Added strict skillInventory to the hashed public manifest and MCP validator; the runtime parent factory accepts and preserves the inventory alongside actual source records. Admission is not inferred from installed or enabled state. The initial actual host scan found duplicate Discord plugin skill namespaces across two marketplaces. Discovery now retains both inventory entries and records a mapped ambiguous skill as unavailable rather than choosing a source or blocking on an unrelated methodology plugin. Scope remains explicit; no new methodology adapters were created.

TDD the discovery fixture failed first on its missing module. The fixture covers disabled-but-explicit minimalist admission, enabled-but-unmapped methodology inventory, persona-driven admission, duplicate plugin namespaces and no config/skill-body leakage. Final five files / 42 tests pass (`/tmp/fly2519-skill-discovery-final-tests.log`), followed by two compiled deployment tests. Final Teamlead build passed (`/tmp/fly2519-skill-discovery-final-build.log`); scoped Biome and diff checks passed.

Read-only compiled discovery against the current host and this checkout succeeded with 132 inventory entries, 29 selected skill sources, 103 not_in_persona_map entries and no missing source files. Full receipt: /tmp/fly2519-discovered-skill-sources.json. This uses explicit audit selector inputs and proves source presence/configured inventory, not live Claude activation, completed Codex adapters or skills/list discovery. Next: actual adapters for the 29 admitted sources, native-home/deployment preparation and default runtime/TUI invocation, then full issue/repository/review/CI/PR gates. No production activation/provider call/browser retry occurred.

### G4 pinned framework skill adapters (2026-09-14)

Added 23 self-contained Codex adapters for the explicitly admitted ten minimalist frameworks and thirteen PM/research frameworks. Existing framework content is preserved; eleven referenced guest-insight files and thirteen license files are inlined. Two unsupported argument-hint frontmatter fields are moved into the body. The broken synthesize-research connector link is replaced by current-capability discovery and a visible manual research-text fallback. No Claude helper or connector is claimed to be available through this conversion.

A fixed index digest binds every original source digest, final adapter digest and referenced resource digest. Actual discovery attaches only matching adapters; absent or changed adapters remain visible persona skill gaps under the existing warn-and-continue ruling. Six tool-dependent sources (deep-research, last30days, founder-html-delivery, both Xiaohongshu skills and proofshot) remain unavailable pending their explicit tool mappings. These are not silently loaded from their original Claude instructions.

TDD initially failed on the missing adapter module. Five focused files / 20 tests now pass, including changed source, changed adapter bytes and changed pin-index rejection (`/tmp/fly2519-framework-adapter-regressions.log`). All 23 adapters pass the skill-creator quick validator after correcting the two unsupported frontmatter fields. Teamlead build passed (`/tmp/fly2519-framework-adapters-build.log`); scoped Biome passed. Compiled discovery followed by the real installer and assertCurrent in an isolated disposable home installed all 23 adapters and emitted the six expected gaps; receipt `/tmp/fly2519-framework-adapters-host.json`. That receipt explicitly sets parityVerified=false. It proves filesystem installation, not target Honey Lemon home preparation, native skills/list, full runtime or browser acceptance.

Remaining six tool adapters, default launcher/native-home/deployment assembly, full isolated issue proof and full repository/review/exact-head CI/non-draft PR gates are still open. No production activation/provider call/browser canary retry occurred.

### G1/P11 authored text artifact ingress (2026-09-14)

Implemented Lead ruling 371d5706 with artifact.text.create, selected by the shared provider factory. Input is exactly four permitted text MIME types and nonempty text of at most 512 KiB UTF-8. Parent secret scanning, scope/current-activation and cancellation guards run before storing. The activation-owned store now supports text/markdown. Output data contains only artifactHandle; the broker uses that same handle as its durable provider reference. report.publish authorization is unchanged.

The composed test exposed two integration gaps after direct handler tests passed: the existing 64 KiB request cap rejected permitted text, and the initial handler lacked a write provider reference. The shared client, MCP facade, broker and socket now permit a bounded worst-case JSON-escaped frame only for artifact.text.create (6 * 512 KiB + 64 KiB envelope); other operations retain their 64 KiB admission cap. Before parsing a complete frame the socket uses the absolute larger bound, then applies the operation-specific bound. Existing connection timeout remains unchanged. No arbitrary input/path/URL transport was added.

TDD first failed on the absent module; composed UDS test subsequently failed before the reference correction. Final five Teamlead files / 48 tests passed (`/tmp/fly2519-text-integration.log`), including actual UDS/client/broker/SQLite and artifact store with a full 512 KiB NUL payload (worst JSON escaping), same-UUID replay without duplicate file, changed-payload conflict and over-cap rejection. Four Comm client tests passed (`/tmp/fly2519-text-client-tests.log`); fourteen catalog/resolver/compiled deployment tests passed (`/tmp/fly2519-text-catalog-tests.log`). Comm build and final Teamlead build passed (`/tmp/fly2519-text-comm-build.log`, `/tmp/fly2519-text-final-build.log`). Scoped formatting was corrected after a check caught the changed test array layout.

This is local isolated ingress evidence, not hosted report delivery or complete startup/issue parity. Six tool adapters and default/native-home/deployment wiring plus full repository/review/CI/PR gates remain. No production provider call, activation or browser retry occurred. ProofShot limitation ruling is recorded in gap-checklist; its adapter remains to be written.

### G4 report delivery and native ProofShot adapters (2026-09-14)

Added source/index-digest-bound founder-html-delivery and proofshot SKILL.md adapters. Report delivery uses the actual typed authored-text/publish/verify/deliver inputs and outputs, canonical destination authorization, request UUID replay, seven-day expiry and link-only delivery semantics. It distinguishes hosted verification, browser interaction and delivery receipts. ProofShot uses only approved native Chrome operations; its receipt explicitly states unavailable video recording, server start/kill, process takeover and uncaptured server logs. It grants no raw gh upload, helper execution or extra process permission.

Both skill-creator validators passed. Seventeen source/adapter/install tests passed (`/tmp/fly2519-two-tool-adapter-tests.log`), Teamlead build passed (`/tmp/fly2519-two-tool-adapter-build.log`) and scoped Biome/diff checks passed. Compiled actual source discovery plus the real installer/assertCurrent in a disposable home installed 25 skills with four remaining gaps; receipt `/tmp/fly2519-two-tool-adapter-host.json` explicitly keeps parityVerified=false. No live hosted delivery, browser interaction or full skills/list claim follows from installation.

Pending nonblocking Lead question 31ce91bb-927e-40c7-89f8-9ab4cc3d7055 identifies the original Xiaohongshu skills' missing typed xhs-state/xhs-analysis lease/checkpoint/feedback and consented video/scheduling providers. Await a scope ruling rather than silently substituting caption summaries or dropping incremental provenance. Four tool adapters, default/native-home/deployment assembly and full issue/repository/review/CI/non-draft PR remain incomplete.

### G4 explicit Runner skill-gap receipts (2026-09-14)

Applied ruling 31ce91bb in source attachment, manifest gap schema and startup fallback instructions. Both XHS learning sources remain inventoried but unavailable with runner_workflow_not_lead_capability. The model receives an explicit dispatch-Runner fallback, not permission to run their lease/checkpoint/scheduler/video helpers. Lead memory delegation remains a separate pending capability task.

The new source-gap test failed before implementation; final four files / 26 tests passed (`/tmp/fly2519-runner-skill-tests.log`), followed by a passing focused adapter rerun with a source-to-manifest reason propagation assertion (`/tmp/fly2519-runner-skill-propagation.log`). Teamlead build passed (`/tmp/fly2519-runner-skill-build.log`); scoped Biome and diff checks pass. This records scope accurately and does not count the Runner workflows as Lead parity.

### G1/P15 Lead memory delegation (2026-09-14)

Added typed memory.add/memory.search under ruling 31ce91bb. Parent handlers use the existing fixed Bridge transport. Bridge validates canonical v2 identity/carrier and binds the marker project to the current Lead project; shared user bucket and agent identity come from that authority. Add accepts one learning plus collection/note/op/run provenance, rejects secret hits before dispatch and reuses the existing Bridge-owned UUID/digest receipt state machine. Startup passes the actual MemoryService into the provider router. No Lead process opens StateStore or memory credentials.

MemoryService previously discarded all metadata. Added searchLearningMemories to expose text plus only opId/runKey/noteId/collection; existing searchMemories remains a string-array wrapper with the same project-filtered search. The scoped Bridge output enforces bounded DTOs and secret checks. This makes best-effort op/run dedup possible without interpreting text as metadata. The existing mem0 call is not forcibly cancellable: broker cancellation preserves an unknown receipt even if it settles later, and does not redispatch it.

A Codex-specific XHS memory rule replaces raw curl/token/comm commands with the actual typed inputs and existing respond_runner questionId/answer operation. It preserves marker/project validation, per-item provenance, best-effort search skip, failed/unresolved ACK items and founder-only exclusions. Both Runner learning workflows remain unavailable in the Lead.

TDD failed on the absent write helper, then on missing pre-write secret rejection; metadata projection failed first on its absent method. Final five Teamlead files / 58 tests passed (`/tmp/fly2519-memory-final-tests.log`), including scoped HTTP tests both through the router and the actual createBridgeApp wiring with real isolated StateStore/SQLite receipts. Carrier liveness and external MemoryService are explicit fixture seams; no live memory/Linear/Discord operation occurred. Parent transport tests verify fixed endpoints and response identity. Edge MemoryService suite / 28 tests passed (`/tmp/fly2519-memory-details-tests.log`). Existing Runner actions plus catalog/deployment / 45 tests passed (`/tmp/fly2519-memory-response-tests.log`). Two write-helper tests, including in-flight cancellation/late completion/no redispatch, passed (`/tmp/fly2519-memory-cancel-tests.log`). Edge and final Teamlead builds passed (`/tmp/fly2519-memory-edge-build.log`, `/tmp/fly2519-memory-final-build.log`). Scoped Biome and diff checks pass; plugin.ts has only the service injection line.

Full isolated issue acceptance, remaining research adapters, default/native-home/deployment startup, full repository gates, review and non-draft exact-head CI PR remain incomplete. No production activation or browser retry occurred.

### G1 native skill home preparation (2026-09-14)

Added prepareNativeSkillHome for the trusted launcher. It verifies the six pinned source SKILL.md files/version before copying the entire bounded native resource tree into a new .system directory. It rejects existing targets, symlinks, nonregular/multiply-linked files, secret hits and source identity/size changes during bounded reads. Limits are 512 entries, 1 MiB per file and 8 MiB total. User execution bits are preserved; broader source permissions are reduced to owner-only access. assertCurrent verifies pinned instructions plus captured resource bytes and execution bits. Cleanup removes only the newly created directory if its inode identity still matches and leaves unrelated home state intact.

TDD failed first on the missing module. Three focused files / four tests passed (`/tmp/fly2519-native-home-final-tests.log`), including resource copy/drift, secret/symlink rejection and cleanup preservation. Teamlead build and two compiled deployment tests passed (`/tmp/fly2519-native-home-build.log`, `/tmp/fly2519-native-home-deployment.log`). Read-only source inspection found 60 files / 385996 bytes with no symlinks in the current Implement native tree. Compiled preparation copied and assertCurrent-verified all six native skills in a disposable home, then cleaned it; receipt `/tmp/fly2519-native-home-host.json` states defaultStartupVerified=false and executedNativeHelpers=false. The version parameter used the pinned baseline; this copy check is not an independent executable version observation or Honey Lemon skills/list acceptance.

The helper is not yet called by the default runtime factory. Default startup remains fail-closed pending directory/deployment/native-home composition and headless/TUI invocation. Remaining research adapters and full issue/repository/review/CI/PR gates are unchanged; no browser canary retry or production activation occurred.

### G1 immutable native origin and existing-home verification (2026-09-14)

Applied Lead ruling 67ca977b without adding a source override. The fixed origin is the current installed Codex native tree used for the approved six hashes. Recorded its absolute path and all 60 file SHA-256 values in native-resource-baseline.ts; the native baseline and public manifest now retain this origin. These are committed pins, never recomputed as expected values at startup. preparePinnedNativeSkillHome verifies an existing target against the fixed instruction/resource pins without overwriting it; absent targets are copied from the fixed origin through the bounded preparation helper. A new fixture assertion proves changing a resource at the source fails before target creation.

Four focused files / 29 tests passed (`/tmp/fly2519-native-origin-final-tests.log`), Teamlead build passed (`/tmp/fly2519-native-origin-build.log`) and compiled deployment tests passed (`/tmp/fly2519-native-origin-deployment.log`). A compiled read-only-source check copied the actual pinned tree into a disposable home, verified the existing-home path without overwrite, closed the verifier and verified the original copy remained current; `/tmp/fly2519-native-origin-host.json` keeps defaultStartupVerified=false. No auth file or helper process was copied/executed. The source is intentionally host-specific and fails closed if unavailable.

Default launcher composition is still pending. This resolves its source policy prerequisite, not full runtime activation, effective skills/list, browser host acceptance or repository/review/CI/PR gates. Browser public-only/default identity boundary is recorded in design-correction and gap-checklist.

### G1 actual default headless parent factory (2026-09-14)

Added startDefaultLeadCapabilityParent and connected buildCodexLeadRuntime's v2 default to it. Missing injected test dependencies no longer mean capability_parent_not_assembled; v2 invokes the actual default factory before spawning its app-server. v1 behavior is unchanged. Dry-run wording identifies the selected factory without claiming provider/process startup.

The factory resolves its executing deployment root, verifies the updater deployed-sha/artifacts, checks the actual Codex executable version, validates canonical project/carrier identity, obtains actual adopted menus and configured rule/skill sources, prepares the pinned native home and activation-owned artifact/model-temp/short UDS roots, and calls the existing actual provider/manifest/parent assembly. Credentials remain parent inputs. Public-only browser defaults implement ruling 67ca977b: no local QA target or externally minted application identity; existing provider shutdown owns generation/profile invalidation. Deployed/model executables inside the writable project are refused. Current checks compare deployed code hashes, identity, complete source inventory and menus. Cleanup attempts all owned resources even if one cleanup fails.

The initial composition test failed because the verifier's observedAt timestamp changes on each observation. Current comparison uses deployment identity/content, not observation time; source inventory changes still reject. Three complete test files / 154 tests passed (`/tmp/fly2519-default-runtime-final-tests.log`), including all 141 headless runtime tests. The v2 tests now prove the default factory is selected and failure cleanup occurs, while explicit dependency injection still tests the real parent lifecycle. New factory tests use actual isolated filesystem directories and artifact store; deployed identity/version/native-source discovery and provider/parent startup are explicit mocks. They prove composition, policy inputs, drift refusal and cleanup, not host confinement or activation.

Build first failed on frozen-env type inference dropping the environment index signature; explicit ProcessEnv typing fixed it. Final Teamlead build passed (`/tmp/fly2519-default-runtime-fixed-build.log`) and two compiled deployment tests passed (`/tmp/fly2519-default-runtime-deployment.log`). Scoped Biome and diff checks pass. No production activation or browser canary retry occurred.

Remaining: TUI v2 composition, research adapters, full isolated issue/host acceptance and full repository/review/exact-head CI/non-draft PR gates. Headless default code is connected; operational startup remains unproved until those actual prerequisites and QA evidence are exercised.

### G1 TUI readiness and process-owned parent wiring (2026-09-14)

Extracted the headless effective config/skills check into capability-readiness.ts and reused it in TUI generations. A trusted, process-owned capabilitySession supplies the actual parent and shared journal. v2 checks parent identity/current authority/rules before connecting, uses experimental protocol support, validates actual config/read and forced skills/list before outbound preflight and again before thread use, and requires the exact MCP inventory. Outbound goes through parent.outboundPost; router delivery context and washed founder TUI environment use that same parent. A generation does not close its process-owned parent/journal. Partial-start failure closes its own WS and sender, including failures before runtime assignment. The production v2 parser guard remains until the owned transport and top-level lifecycle are connected.

The new readiness tests first failed on the absent helper; the two initial TUI tests failed because the old generation connected without a parent and never queried config/skills. Final three-file suite passes 183 tests (`/tmp/fly2519-tui-readiness-final.log`), covering actual generation glue with a mocked WS/parent and real SQLite journal, rejected config/skills before preflight, and cleanup. An intermediate run failed one source-format-sensitive existing assertion after wrapping startup; preserving the previous body layout fixed it without weakening the assertion. Teamlead build passed (`/tmp/fly2519-tui-readiness-final-build.log`); scoped Biome/diff checks pass. No real TUI/app-server/browser start, provider call or production mutation was performed. These tests do not establish transport or host acceptance.

Lead ruling a2a08b4c-1d81-46b6-bb71-d47bf83a36e2 permits exactly one transport per activation: remote_control_pinned only with live process binary/argv/env proof, otherwise parent-owned app-server Unix socket. The existing remote-control launcher offers no such live proof, so the next implementation selects app_server_socket. Installed Codex 0.153.2 app-server --help explicitly accepts --listen unix://PATH; actual Unix handshake, invocation confinement and lifecycle still require executable isolated verification. No production daemon will be adopted or stopped.

### G2 parent-owned app-server Unix socket and default TUI entry (2026-09-14)

Applied ruling a2a08b4c using only app_server_socket. startCapabilityAppServer spawns the parent-verified Codex path with strict config, the selected permission/MCP overrides and washed environment. It owns a private short Unix socket directory and its child handle, bounds readiness, supports cancellation, records transport/binary/argv/env digests, checks directory/socket identity and reaps only its own child before deleting its directory. It never invokes remote-control start/stop or adopts an existing daemon. The founder client now uses the same verified binary, home, named permissions and explicit socket. A socket change forces its owned window to reconnect even when the thread ID is unchanged.

createCapabilityTuiRuntime owns the actual default parent factory, shared SQLite journal, socket child and connection supervisor. Transient WS generations reuse parent/journal; only a proven exited owned child is replaced. Partial initialization and final shutdown sweep generation, owned window, child, parent and journal. An ownership callback prevents early failure from killing a window this activation never created. The v2 parser/startup guard is removed, v2 cwd must match the canonical project root, and main selects this owner before legacy persona/home/daemon logic. Existing shell launcher already excludes v2 from legacy home/daemon ensure. v1 keeps its original transport.

TDD: the owned-server test first failed because the module was absent; owner cleanup tests exposed premature unowned-window teardown, fixed with explicit ownership. Final eight-file regression passed 210 tests (`/tmp/fly2519-owned-corrected-final.log`); an additional five-test owner run covers stop racing socket startup and verifies the real SQLite journal closes after parent cleanup (`/tmp/fly2519-owned-race-tests.log`). An intermediate combined run hit a test-only 250ms child-start timeout before the capture file existed. Exit/hang budgets and cancellation synchronization were corrected; production readiness remains bounded at 10s. The new child tests run real isolated Node child/socket fixtures, whereas owner provider/generation boundaries are explicit mocks. Teamlead build passed (`/tmp/fly2519-owned-last-build.log`); compiled deployment coverage remains included in the 210 tests.

Real pinned Codex 0.153.2 (SHA-256 195ace4100a634a9df39147f493e730e666b5bd87795f3c9f3251d8542400424) passed an isolated empty-home check: Unix WebSocket initialize, config/read verified against the exact named permission profile, skills/list availability, child shutdown and socket removal. No auth copy, model turn, browser or production provider call occurred. Parent authority is explicitly mocked, so this proves the selected transport and actual config protocol, not full runtime/manifest skill acceptance or Seatbelt isolation. The reproducible argument-free command is `node scripts/fly2519-tui-socket-canary.mjs` after building Teamlead; it refuses binary drift and writes `/tmp/fly2519-native-tui-socket-<pid>.json`. The original receipt is `/tmp/fly2519-native-tui-socket.json`. The official transport description confirms Unix uses the normal WebSocket HTTP Upgrade protocol: https://learn.chatgpt.com/docs/app-server#protocol.

Remaining: complete isolated issue/default-provider/TUI-visible acceptance, research adapters, QA-owned native browser Seatbelt host proof, full repository gates, effective review, exact-head CI and non-draft PR. No production v2 activation, service restart, provider write, QA dispatch, merge or deploy was performed.

### Research gaps and first full repository gates (2026-09-14)

Implemented ruling 69b1e642: deep-research and last30days retain explicit reason codes in source records, hashed skill inventory and manifest startup gaps. Neither receives a loaded adapter. Parent instructions and runtime startup warnings expose the manual Runner/interactive fallback and prohibit claiming public browsing as subscription Deep Research. Two new propagation cases first failed against the old generic gap; the final four-file suite passes 16 tests (`/tmp/fly2519-research-gaps-final.log`), including hash-tampering refusal and actual parent instruction receipt checks.

First exact pnpm lint failed with six import/format errors (`/tmp/fly2519-full-lint.log`, diagnostic detail `/tmp/fly2519-full-lint.json`). Applied only the reported import/format corrections, including the adapter pin index. The pin index JSON is semantically identical before/after; its committed byte digest was updated and adapter binding tests pass. pnpm lint then exited 0 with 16 warnings (`/tmp/fly2519-full-lint-fixed.log`). pnpm -r build exited 0 (`/tmp/fly2519-full-build.log`). These warnings were not converted into scope expansion.

The first pnpm test:packages:run stopped in config with two flag-accounting failures (`/tmp/fly2519-full-packages.log`): existing wrapper/body FLYWHEEL_WRAPPER_ENV_FILE is a path, not a boolean switch. Its actual script consumers already exist in origin/main; added the missing NON_FLAG_ALLOWLIST reason without changing wrapper behavior or creating an enable flag. The focused 14-test drift audit passes (`/tmp/fly2519-flag-accounting.log`). Full package rerun is in progress and must not yet be called green. The only new scripts/__tests__/*.test.sh relative to origin/main is lead-patrol-github-facts.test.sh; it passed (`/tmp/fly2519-new-shell-test.log`).

The second full package run advanced beyond config and observed a kill-path inventory mismatch in claude-runner. Reviewed the exact delta (`/tmp/fly2519-kill-inventory-diff.json`): twelve added entries and two removed entries, comprising owned patrol/TUI child cleanup, QA probes and the browser-to-bounded-stdio transport move. Updated only the mechanical inventory fixture, retaining every classification and runner-affecting choke-point rule. All five focused kill-path tests pass (`/tmp/fly2519-kill-inventory-tests.log`). The second aggregate run is still live and already contains the pre-fix failure; it is not green. Its handle/log must be polled to terminal before any rerun. The six new inventory-script tests also pass (`/tmp/fly2519-inventory-script-tests.log`).

Aggregate r2 subsequently exited 1: exactly one failing test remained, the pre-fix kill-path snapshot. Config and all earlier packages passed; claude-runner had 1267 passed and 2 skipped, with this one failure. Later packages were not reached. Its execution is terminal; the next full run may now begin. Final lint after both audit corrections exited 0 (`/tmp/fly2519-lint-after-audits.log`).


## Aggregate r3 and evidence consistency checker — 2026-09-14

`pnpm test:packages:run` r3 on `9dddee105` terminated exit 1. `/tmp/fly2519-full-packages-r3.log`: teamlead 6 failed files / 7 failed tests, 1109 passed files / 14281 passed tests / 7 skipped, plus `[vitest-worker]: Timeout calling "onTaskUpdate"`. This is a failed aggregate, not full green.

Isolated rerun `/tmp/fly2519-r3-isolated.log` passes StructuredInboxRouter (19), terminal archive (21), and typed Discord route (5). The two real git push tests still failed: they expected Lead broker admission before the later A/B/C ruling reserved push to Runner. Tests now explicitly prove broker rejection (including replay and changed payload) with zero upstream sends, then invoke the retained lower-level handler directly against a private bare repository to retain actual smart HTTP success/lost-reply and hostile-hook coverage. This transport fixture is not Lead authorization or business parity evidence. `/tmp/fly2519-r3-contract-fixes.log`: 15 passed across git transport, attachment send, and automated message inventory.

The raw Discord sender inventory now classifies the typed attachment path as Lead-authored text; the multipart test asserts exact content, not substring presence. The production child-process census records the actual pinned/bounded startup, credential read, patrol, app-server, and shared stdio paths (6 additions, browser transport rename); `/tmp/fly2519-r3-census.log`: 1 passed. No production behavior changed for these gate fixes. The separate kill-path inventory remains frozen per Lead instruction b419ecc8-062d-442e-bcea-9a7f219f2bf1; sync main and regenerate it only immediately before PR, after any running review verdict.

New `scripts/qa-codex-lead-parity-drill.mjs --mode verify --evidence FILE --expected-head SHA` currently implements evidence consistency checking only. The original four node tests fail on the absent module first (`/tmp/fly2519-drill-evidence-red.log`, the original 4-test red batch) and pass after implementation (`/tmp/fly2519-drill-evidence-green.log`, 6 tests). Checks bind all 17 rows and local SHA-256 references to identity/activation/issue/run/thread/head, bound regular-file reads, reject symlinks/path escape/oversize, and require sequential complete tool trace without Claude calls. Self-reported fixture checks are NOT execution attestations. Even consistent fixture input returns `hostVerified=false`, `parityVerified=false`, and CLI exit 2; explicit missing execution/host/business evidence remains visible. This does not close G3: the actual isolated whole-issue parent/UDS/SQLite/default-TUI collector and QA-owned native browser host evidence remain outstanding.

After these changes, full `pnpm lint` exits 0 with 16 existing warnings (`/tmp/fly2519-r3-followup-lint.log`); `pnpm --filter flywheel-teamlead typecheck` exits 0 (`/tmp/fly2519-r3-followup-typecheck.log`). Aggregate r4 is next; r3 remains failed.

## Final local aggregate disposition and first collected issue chain — 2026-09-14

Lead instruction `e97a997d-1dce-4003-9908-8ec2c98e5cd4` makes r4 the last full-package run on this host: no r5; fix owned assertions with focused tests, retain host-contention red plus isolated green, and use exact-head PR CI as authority. r4 is terminal exit 1 (`/tmp/fly2519-full-packages-r4.log`), stopping in flywheel-comm at lead-registry-cli's 5-second backend migration fixture timeout: 1 failed / 2511 passed / 3 skipped. Later packages were not reached. The same file passed 31/31 isolated, with the failing case taking 898ms (`/tmp/fly2519-r4-isolated.log`). No migration production write occurred: this test owns temporary registry files. Instruction acknowledged/reported through receipt `0d35813b-3f46-4734-ba49-2d65826446dd`; no aggregate green claim.

The new parity-drill test composes the actual TUI lifecycle owner, parent, private UDS broker, SQLite journal/operation receipts, typed Discord and Linear handlers for one issue: runner request -> resolve/read thread -> browser fixture -> Linear comment -> Discord reply. It establishes a real dispatching journal delivery context, proves same-request replay does not repeat a runner effect, changed payload and foreign issue rejection, activation revocation before writes, socket removal/journal close, then reopens SQLite and checks the persisted runner receipt. Runner/provider/process/authority boundaries are explicit fixtures; the default factory, actual TUI generation/window and native browser are not proved by this test.

`node scripts/qa-codex-lead-parity-drill.mjs --mode fixture --output /private/tmp/fly2519-parity-collector-4` executed the fixed test in a bounded child with Vitest thread workers and an empty temporary HOME. It wrote `fixture.json`, `test.log`, and SHA-256 `receipt.json`, then removed that HOME. This development receipt records `workingTreeDirty=true` and `fixtureExecutionPassed=true`, while `hostVerified=false`, `parityVerified=false`; CLI exit 2 intentionally means incomplete overall acceptance. Original red test/CLI evidence: `/tmp/fly2519-parity-chain-red.log`, `/tmp/fly2519-collector-red.log`. Actual chain evidence: `/tmp/fly2519-parity-collector-4/`; validator/output-directory guards: 7 node tests passed (`/tmp/fly2519-collector-unit.log`); full lint exits 0 with 16 existing warnings (`/tmp/fly2519-collector-lint.log`).

G3 still requires full P01–P17 evidence collection and default factory/TUI generation execution, plus QA-owned Seatbelt host browser proof. This first cross-component issue chain does not close those gaps. Production activation/provider writes remain prohibited; review and non-draft PR are still pending. Kill-path snapshot remains frozen until the instructed pre-PR main sync/regeneration.

## Real factory-to-parent browser manifest defect — 2026-09-14

The actual factory used the upstream Chrome MCP tools/list digest as the model-facing browser integration digest. `buildCodexLeadMcpArgv` correctly requires the digest of the admitted facade tools, so a fully assembled parent would fail with `invalid v2 browser integration`. The older factory test replaced the parent and checked only browser version, concealing this producer/consumer mismatch. New assertions pass the produced manifest through the actual MCP consumer: 2 red cases / 9 passing (`/tmp/fly2519-factory-facade-red.log`).

`runtime-factory.ts` now computes the facade digest from the resolved browser operation names. Upstream Chrome schema/version checks remain unchanged in the browser provider/worker. The actual-consumer regression, parent, upstream pin and issue-chain tests pass 14/14 (`/tmp/fly2519-factory-facade-green.log`). Teamlead typecheck and build pass (`/tmp/fly2519-factory-facade-typecheck.log`, `/tmp/fly2519-factory-facade-build.log`). No permissions or tool admission broadened.

A further integration test now invokes `startDefaultLeadCapabilityParent` through the real provider assembly and parent, verifies six synthetic pinned native source files and a fixture rule, creates a local report artifact through the actual UDS broker, and checks cleanup. Default factory, runtime factory, native home verification, manifest/skills, parent, SQLite and artifact handler are not mocked. Explicit fixture boundaries are Codex version, deployment receipt, canonical registry authority, source/menu selection, native source pins, upstream/browser providers and model isolation. A global fetch trap proves no external request occurred. This test passes (`/tmp/fly2519-default-parent-integration.log`).

The collector now runs both fixed integration tests and includes the separately labelled default-factory evidence. Development collection `/tmp/fly2519-default-factory-collected/` passes fixture execution with a dirty-worktree flag, exit 2 and parity/host still false; the existing seven checker tests pass (`/tmp/fly2519-factory-collector-unit.log`). G3 remaining work is full P01–P17 collection, actual TUI generation fixture, QA-owned native host browser, and original business acceptance. This resolves the default-factory execution gap only at explicitly isolated fixture scope, not deployment or host acceptance. Per e97a997d, no further local full-package run; exact-head CI remains authoritative.

## Actual TUI generation fixture and typed Bridge chain — 2026-09-14

Extended the real default-parent integration through `buildTuiGeneration`, `CodexLeadProcess`, live effective config/skill validators, MCP inventory, thread start/resume, journal/router/mailbox/inbox wiring and generation shutdown. The actual parent persists across two generations. Both normal generations read effective config and skills twice; first calls thread/start, second calls thread/resume, preserving one window binding and the same managed socket/home. A third generation receives a foreign default permission and rejects before thread resume or provider access. Parent and shared journal remain alive after generation teardown and close under their owner afterward.

The process/host boundaries remain fixtures: WS RPC responses, terminal window, process locks, outbound preflight, native source pins and deployment/registry inputs. The actual Discord gateway performs its bot identity check against a fixed synthetic GET /users/@me response; all other external requests throw. Two normal generations make exactly two such intercepted identity requests. No real external request, terminal pane or production activation occurs. `/tmp/fly2519-tui-generation-red.log` records the initial incomplete response rejection; `/tmp/fly2519-tui-generation-resume.log` records the complete startup/resume/negative path passing.

The primary issue chain now uses the actual typed Bridge runner/read/inbox handlers as well as its prior parent/UDS/SQLite/Discord/Linear components. P01 start_runner validates the fixed runner route and correlated execution receipt; P07 bridge.read, P08 terminal.status and P09 inbox.batch.ack validate fixed routes/DTOs in the same activation and execution. Batch ACK replay makes one effect, and extra path/command/token fields are rejected before the provider seam. Canonical registry and Bridge responses are labelled fixture boundaries. Captured `providerTrace` omits credentials and records public request coordinates only.

The collector runs both updated integrations and requires the TUI start/resume, same-window and wrong-config evidence before recording fixture success. `/tmp/fly2519-tui-bridge-collected/` is the successful development collection with raw trace and hashes (dirty flag true, exit 2, host/parity false). Seven script guard tests remain green (`/tmp/fly2519-tui-collector-unit.log`). G2's implementation fixture is now exercised; remaining G3 work is the full P01–P17 collection and QA-owned host/browser/business layers. No local full-package retry; r4 red plus isolated evidence and exact-head CI policy remain in force.

### Same-issue GitHub and upstream adapter integration (2026-09-14)

The isolated parity chain now invokes actual GitHub, gbrain, Xiaohongshu and Context7 handlers through the same parent UDS broker and SQLite journal. GitHub reads project the fixed PR head; repeated comment UUID produces one SDK write. Foreign PR, extra repo input and expired fixture ownership reject before SDK calls. The business ownership authority and SDK are explicit fixtures, not StateStore/CommDB authority proof.

Captured upstream schemas feed the real adapters. Knowledge search, Xiaohongshu list/detail and Context7 lookup succeed against fixture SDK responses. Detail resolves the parent-held xsec token from the returned handle; a foreign feed rejects without another upstream call. Model trace contains no synthetic credentials or xsec token. Knowledge deletion and Xiaohongshu publishing retain the exact unclassified_write/founder_write_gate_absent refusals, persist rejected SQLite receipts and replay without upstream effects. Each provider schema drift returns unknown/baseline_drift with no further tools/call.

Validation: focused primary integration passes (/tmp/fly2519-upstream-github-chain.log), teamlead typecheck passes (/tmp/fly2519-upstream-github-typecheck.log), and collector executes both integration files successfully (/tmp/fly2519-upstream-github-collected/, development worktree). Collector exit 2 remains deliberate: full P01-P17, native browser host evidence and Honey Lemon business acceptance are incomplete. These representative P06/P15-P17 calls do not assert every operation, actual provider transport, host isolation or production parity.

### Same-issue artifact and report chain (2026-09-14)

The primary isolated drill now creates HTML through the actual artifact.text.create handler and parent artifact store, then invokes actual report.publish, report.verify and report.deliver handlers over UDS. The fixed Bridge response seam checks the uploaded bytes, activation, issue, report id and endpoint; the emitted trace retains only public operation/request references. Publication and delivery each execute once under UUID replay, and the publish-only prefix contains no deliver call. Extra model path/URL/channel fields and non-text MIME inputs reject before transport. The verification service response is a fixture: its cspValid/nonceValid flags do not prove an actual rendered/public page or server ownership checks.

Focused integration first failed because a negative test intentionally supplied a synthetic credential and the collector correctly rejected that credential in its full request trace (/tmp/fly2519-report-chain.log). Replaced that redundant secret-input case with an unsupported MIME rejection; existing artifact secret tests remain unchanged, and the complete trace secret assertion remains strict. Focused integration, teamlead typecheck, Biome and full lint pass (/tmp/fly2519-report-chain-green.log, /tmp/fly2519-report-chain-typecheck.log, /tmp/fly2519-report-chain-lint.log). The two-file collector passes fixture execution (/tmp/fly2519-report-chain-collected/) with deliberate exit 2 for remaining complete P01-P17/native-browser-host/business acceptance. No production publication, Discord send or browser action occurred.

### P01-P17 representative fixture receipts (2026-09-14)

The same issue/activation UDS drill now covers typed attachment get/send and patrol snapshot/judgment. Downloaded bytes are checked and placed in the actual artifact store; send consumes that handle and UUID replay makes one upload. Wrong download receipt returns unknown; foreign handle and extra URL are denied. Patrol consumes bounded GitHub fixture responses, imports the snapshot through the real artifact projection and substitutes the owned provider evidence handle for judgment. A foreign handle rejects, and judgment replay has one transport effect. The Bridge download/upload, patrol helper and its completion-gate responses remain fixtures; this does not execute the actual patrol shell gates or live Discord.

The same parent also loads its actual fixture rule and installs a fixture skill adapter; the test reads the installed bytes back and verifies wrong rule/skill SHA failures and failed-install cleanup. This covers one fixture adapter, not the complete persona or native discovery. The separate default-factory/TUI integration remains the evidence for full default assembly under its explicit fixture boundaries.

Collector now emits coverage.json with P01-P17 request/result JSON pointers, explicit statuses, and Node/platform/architecture receipt fields. Every row has a representative positive and negative reference. Browser is provider_fixture_only; all other rows are representative_fixture_exercised. No row is parityVerified. Trace scope is recorded_broker_requests_only, not an audit of every native tool/process. In particular the primary fake browser cannot prove worker generation denial: that attempted assertion failed, so its negative now proves only actual broker extra-field rejection. Native worker tests and QA-owned host canary retain generation/isolation acceptance.

Validation: /tmp/fly2519-attachment-patrol-chain.log and /tmp/fly2519-source-chain.log focused green; teamlead typecheck /tmp/fly2519-p17-typecheck.log and full lint /tmp/fly2519-p17-lint.log green. Collector guard tests went red for missing row derivation, then green (10 tests, /tmp/fly2519-source-rows-green.log); mismatched request ids, forbidden recorded operations, missing source binding and fake host declarations cannot produce broad acceptance. Executed collector /tmp/fly2519-p17-final-collected/ has all 17 row references and fixtureExecutionPassed=true, exit 2. Its explicit remaining requirements are complete_P01_P17_drill, native_browser_host_evidence and honey_lemon_business_acceptance. Production v2 and provider writes were not used.

### Main synchronization after R1 (2026-09-14)

R1 effective APPROVED at c97dd7be2 was reported with all 19 advisories. Synchronized origin/main 7aa3b7163 and resolved four conflicts preserving report capabilityOwner plus hosting binding/mutable token/async commit behavior, both capability and release-readiness routes, and regenerated mechanical kill inventory. Locked install/full build/typecheck pass. Reports focused 141/141 and kill inventory 5/5 pass after updating the feature tests for required hostingBinding/expectedHostingKey and asynchronous initialization/commit. Lint passes after formatting the regenerated inventory. Logs: /tmp/fly2519-sync-{install,build,typecheck-green,reports-r3,kill-inventory,lint-green}.log. Broad cached diff whitespace warnings originate in incoming main documentation; resolved code paths pass diff --check. No full-package r5.

Lead instruction f7cd32c1 arrived during final sync verification and was pulled in the merge-commit command. Merge 3eb2e63d7 was completed; subsequent work follows the new 19-item bounded fix round in code-review-r1.md, rather than the earlier proceed-with-advisories plan. No production action or PR has occurred.

### Bounded R1 A1: current Codex home overlap

Changed the real default-factory integration home to .codex-fixture under its synthetic HOME. It failed with permission grant overlaps a credential source (/tmp/fly2519-r1-home-red.log). The v2 parent now passes its trusted active home explicitly to the shared credential alias resolver. Historical suffixed homes remain directory-denied; the current home retains explicit auth/config/profile/account/session/log/state file denies and never receives a whole-directory read grant. The unchanged permission profile keeps :root=deny and grants only verified public source paths. Calls without the explicit v2 home retain the old whole-home deny behavior. Both initial aliases and subsequent current checks use the same metadata.

12 tests across credential aliases, permission profile, runtime parent and actual default factory pass (/tmp/fly2519-r1-home-r2.log), including refusal to grant auth.json and native skill/effective-config/start-resume checks using the suffixed home. Teamlead typecheck passes (/tmp/fly2519-r1-home-typecheck.log). The intermediate old runtime-parent expectation was updated to include the newly explicit private metadata. This is isolated startup proof, not host activation or credential access.

### Bounded R1 round and final pre-PR synchronization (2026-09-14)

R1 findings are tracked individually in code-review-r1.md: 17 fixed and two explicit bounded-budget followups (Discord uncertain-dispatch capacity; distinct root/credential and actual app-server-socket canaries). Lead accepted this 17/19 + two-gap disposition in instruction 54833a8c-f613-40de-85b6-1102dc832819. All six mandatory A findings are fixed. Focused red/green logs are /tmp/fly2519-r1-*.log; no package r5 or native browser host retry ran. Full lint and build passed after the bounded fixes.

Final sync incorporates origin/main f31b75af9. Five conflicts preserve both additions: graphql + parse5 dependencies/lock, capability child-process census + ship-judgment child, regenerated mechanical kill inventory, and report capabilityOwner alongside restored-entry/cancellation parameters. Current census 1/1 and kill inventory 5/5 pass. Full lint/build and frozen install pass (/tmp/fly2519-final-sync-{install,lint,build}.log).

Report verification initially had two owned fixture failures from main's asynchronous registry initialization and required expectedHostingKey, plus two unhandled fixture-cleanup errors. Fixed those two fixtures only. Four unchanged report suites passed 139 tests; the two corrected suites passed all 21 on rerun (/tmp/fly2519-final-sync-reports-r4.log). Earlier failing logs remain /tmp/fly2519-final-sync-reports-r2.log and -r3.log, not relabeled green. Incoming main documentation whitespace is retained; resolved source paths pass checks.

Lead instruction 54833a8c-f613-40de-85b6-1102dc832819 identifies main's founder-budget.test.ts:60 5s timeout, introduced by #1163, as owned by FLY-2556. Do not edit it. If exact-head CI fails only there, record and continue to QA; once the hotfix lands, sync main once and rerun CI so the card head is green. Fresh R2, non-draft PR and exact-head CI remain pending at this checkpoint. Native browser/Honey Lemon business acceptance remains unverified.

## R2 HIGH-only startup repair (2026-09-14)

R2 on d6067bcdf returned CHANGES_REQUESTED for patrol configuration aborting Bridge startup, including packaged layouts. The authorized single repair disables patrol with a sanitized reason while preserving Bridge availability. See code-review-r2.md for all six structured findings and preserved advisories. Missing/unsafe configuration red 2/2; corrected configuration + actual Bridge HTTP green 22/22, additional packaged-layout suite green 3/3. Teamlead typecheck, full lint (18 existing warnings), full build and repair diff check passed. No package r5 or production activation. Final R3 pending.


## QA 1161 launcher rework verification (2026-09-15 UTC)

Authority: Lead instruction a5a27b26-1f82-4023-8eca-9afaf6579db6, reconciled by gate 3cd8995a-d906-4dcd-b6b0-70434ba94deb. The approved solution is the fixed mode-0500, digest-pinned sh exec wrapper with literal executable/map permissions for the wrapper, /bin/sh and /usr/bin/arch; it passes arm64 and the exact Chrome path as argv. Existing isolation, credential denies, codesign60s and headed browser configuration remain intact.

Open observation note (Lead answer d7bda646-5c46-494e-8dbc-a809584e3a2a): QA reported ARCHPREFERENCE dotted-path parsing failure on the unsandboxed host. The implementation environment's direct subprocess reproduction succeeded for both dotted echo and the exact pinned Chrome --version. These differing observations are retained without a root-cause conclusion. The approved wrapper removes ARCHPREFERENCE from the launch path entirely, so further reconciliation is outside this rework. Separately, the real Node execve probe lost inherited fd3; the selected sh exec wrapper passed the synthetic fd3 probe. No Node execve shim or forwarding child process was added.

Fresh verification: expected initial policy/wrapper regression red (3 failures/7 passes), then all 13 browser suites passed 99/99, including real dotted/quoted path argv forwarding, inherited fd3 and actual pinned Chrome --version (no GUI). Full pnpm lint exited0 with18 existing warnings; pnpm -r build exited0. Rebuilt registered root scripts:1 fixture pass,1 explicit nested_sandbox_unavailable host skip,0 failures. Logs: /tmp/fly2519-qa1161-{red,green,browser,lint,build,scripts}.log. No host full package aggregate was run.

The real host regression still requires final-policy Node/probes, MCP initialize, pinned tools/list and headed Chrome list_pages. It and scripts/qa-fly-2519-browser-canary.mjs must pass on the unsandboxed QA host; local --version and nested skips are not host acceptance. If WindowServer registration fails there, preserve the crash evidence and obtain a Lead ruling before changing the policy. Fresh effective review and exact-head CI remain required for this new candidate.


### Direct bash correction authorized before QA (2026-09-15 UTC)

Head5fc5f4c7a received effective APPROVED (request73a8fdce-7838-4b97-b0d9-dc80a4ee8bb5, question53a70e9b-32b3-439a-a99a-5245592719ab). Its new MEDIUM finding browser-launcher-sh-variant-exec-denied contained actual host evidence: /bin/sh is a macOS variant shim which attempts to execute /bin/bash, denied by the exact final policy. Unsandboxed --version success therefore did not prove policy compatibility. The reviewer verified that allowing exact /bin/bash process-exec fixes the launch and that a missing final-target permission still rejects the chain. This review approval does not erase the host failure.

Lead answer6081ee75-ccbe-4797-a7af-bcce75679e85 explicitly treats this as a host-functionality blocker regardless of severity and authorizes a focused correction before QA: use #!/bin/bash directly, allow its exact executable path, remove /bin/sh entirely, retain0500/digest/final-target guards, and leave the other13 advisories untouched. The correction changes only that interpreter choice and its literal exec/map entries.

The registered host regression now also runs the generated Chrome wrapper --version inside the exact final Seatbelt policy, after the Node/credential probes and before the existing real MCP/tools-list/list_pages checks. It retains explicit non-macOS/nested skips and no alternate-policy fallback. Focused regression first produced2 expected failures/9 passes (/tmp/fly2519-bash-red.log), then all11 sandbox/launcher tests passed; fresh full verification follows. No WindowServer or other policy widening.

Direct-bash final local verification:13 browser suites99/99 passed; full lint exit0 (18 existing warnings), full build exit0; rebuilt registered root scripts1 fixture pass1 nested-sandbox skip0 failures. Logs:/tmp/fly2519-bash-{browser,lint,build,scripts}.log. Exact-final-policy Chrome version/MCP/list_pages remain unexecuted here after the nested guard, so fresh review/CI and unsandboxed QA remain required.
