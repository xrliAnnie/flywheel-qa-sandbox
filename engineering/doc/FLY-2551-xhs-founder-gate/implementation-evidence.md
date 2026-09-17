# FLY-2551 小红书逐次批准门 — 实施证据
Issue: FLY-2551 (https://linear.app/geoforge3d/issue/FLY-2551/2441follow-up-小红书-publishcommentlikefavorite-的机器可验-founder-门今天)
日期: 2026-09-14
基于: plan.md

## 当前边界

本阶段按 Lead 排期裁定 02547414-5981-4ffa-95e7-9b336e0021a9 实施源码、测试、文档。未创建专用系统用户、安装服务、读取生产 XHS session 或执行对外写。T1/T6 的 broker 装配等待 FLY-2519 合入 main，遵守 9a5ebd14-c1d2-43cd-bc06-5dbe814f5f70，不合其 feature branch。

## T2 独立账本与消费原语

- `migrations.ts` 初始化独立七表、约束及 append-only 审计。缺失/空库在普通启动时拒绝；未来版本、缺表及数据库检查异常拒绝。
- `store.ts` 仅供 authority 内部使用；新账本要求 exclusive create、0600、普通文件且单链接；数据库 generation 必须匹配部署传入值。Bridge 不接触数据库。
- 每个写事务先回读 WAL/FULL/fullfsync/checkpoint_fullfsync/foreign_keys/busy_timeout；所有业务值用 prepared 参数。prepare+引用、decision+event+notification、claim+attempt 各为 immediate 事务。
- claim 重算冻结 JSON digest，核对 scope、账号、policy/founder config version、期限与状态；消费和唯一 attempt 同时提交。existing 只返回状态，不返回新执行许可；unknown/failed 不重新开放。
- 已消费请求不能撤回或被替代；跨 scope 替代被拒绝；替代请求创建失败整体回滚。

### 可复现检查

- `pnpm --filter flywheel-teamlead exec vitest run src/xiaohongshu-write`：新增 supersession 后 79 tests green（其中 durability 当时5项）。随后新增 outbox 故障回滚，`... vitest run src/xiaohongshu-write/__tests__/durability.test.ts`：6 tests green。
- `pnpm --filter flywheel-teamlead typecheck`：exit 0。
- 红测：恢复 stash 的 store/durability 缺 store 模块；新增 NORMAL 降级测试最初未抛错；新增 supersession 两项最初失败。实现后分别转绿。
- 双独立 Node 进程通过 IPC ready barrier 同时发起 claim，真实 SQLite 得到 claimed/existing；两个进程 exit 0，重开后仍只有一条 attempt。
- 故障注入：attempt INSERT trigger、COMMIT 的 IOERR_FSYNC、notification INSERT trigger。调用者不获得 claimed；reopen 后无半条消费/批准/审计，修复故障后才可继续。

### 尚未证明

这里只证明独立 store 原语。计数器 fixture 尚未贯穿真实 service/transport；完整链路、provider fsync 墓碑、账号 lease、开关最终 admission、OS 身份隔离、受控媒体、Discord 核验、两 runtime 装配和全仓 gates 均待后续任务。COMMIT/fsync 为故障注入，不声称已做真实断电测试。T2 的 Bridge status 客户端装配留至 T6；本节不作为整单验收或生产 parity 证据。

## T3 媒体冻结原语（进行中）

- `artifacts.ts` 只接收 AsyncIterable<Uint8Array>，不收路径/URL；写入私有 root 下随机 UUID 文件，O_EXCL/O_NOFOLLOW、0600、file+directory fsync 后登记真实 SQLite metadata。媒体读取验证 scope、root dev/inode、文件 dev/inode/nlink/mode/size、打开 fd 身份与完整 hash。
- 强制显式可信解码器接口；magic/MIME 检查不被当作完整解码。解码前后重新核对字节。每媒体上限取实际附件限制与10MiB较小值，总预算最多2GiB；并发导入在 await 前保留容量，启动计入残留文件，不能靠重启逃逸预算。
- `artifacts.test.ts`：10项通过，覆盖重开 catalog、跨scope、MIME与decoder失败、链接/字节/inode/root变更、导入失败清理、并发/重启预算及解码等待期间变更。PNG是 synthetic magic fixture，decoder为测试替身，**不证明实际 PNG/视频有效性**。
- 本批全量 XHS focused suite：6 files / 90 tests green；teamlead typecheck exit 0；新改文件 Biome check通过。
- 尚需 T3 的真实受控解码器装配、完整卡片/manifest/Discord交付、GC/引用生命周期与2519受控流来源。目录权限测试不替代专用UID主机隔离证据。
- 2026-09-14 本批核对 FLY-2519 PR #1191 仍 OPEN、mergedAt=null；继续保持独立接口，不合其 feature branch。

## T3 完整审核卡交付（进行中）

- `preview.ts` 生成完整 UTF-8 文本附件，包含原始标题/正文及全部冻结字段；系统批准指令不嵌入用户正文。
- `cards.ts` 校验媒体 hash/size/order，按最多10附件且20MiB分批上传，逐个重取消息作者、频道、内容、附件名/长度及实际字节；全部成功后才发送最终卡。
- 最终卡含材料消息链接、content digest、manifest digest、截止时间、批准一次尝试/超时可能已发出/明确撤回边界。所有 send 显式传禁用 mentions 参数。
- 账本持久化完整 manifest 和最终卡内容，delivered 事务重算并匹配原 proposal digest。同 ID 替换内容红测曾得到错误成功，修复后拒绝并保持 awaiting_delivery。交付失败清理本次消息，清理失败也不会放行批准。
- 本批 focused：此前完整 XHS suite 97 tests green；随后新增长文与18图分批校验，cards suite 9 tests green。18图严格保序，上传批次10/9附件、最终卡0附件，单批均不超过20MiB。
- 这些测试使用真实 SQLite 和内存 transport；不声称已调用 Discord。真实 Discord transport/refetch、可信消息判定仍在 T4，实际媒体 decoder 和 GC仍是T3待办。

## T3 实际媒体解码

- `media-validator.ts` 对四种 MIME 使用固定 demuxer，先 ffprobe 核对 stream/codec/尺寸，再 ffmpeg 完整解码到 null 输出。只允许 file/pipe 协议；MOV 明确关闭 external drefs 与 absolute paths。限制分配块、像素数、线程、输出日志及每进程 deadline；execFile 无 shell，清空继承环境。
- 调用前校验固定绝对二进制路径的 SHA256 与不可组/全局写权限。私有临时目录在成功/失败后删除，返回固定 `artifact_unverified`。root-owned安装路径及动态库边界仍由T6安装器/运行边界负责，本测试所用Homebrew路径不是生产安装证明。
- 实际 PNG/JPEG/WebP/MP4 正向，magic-only PNG、截断MP4、错误binary hash反向与timeout进程退出，共8 tests green。WebP为本地合成蓝色2x2固定fixture；本机ffmpeg无WebP编码器，改由cwebp生成一次后固化，不跳过实际WebP解码。
- timeout fixture最初200ms在probe启动阶段提前结束、无decoder PID；同步probe正向控制通过。改为2秒测试配置、decoder执行`exec sleep 10`后，取得确切PID且结束后不存在。生产默认60秒未改；不把未启动当作退出证明。
- teamlead typecheck exit0。CI installer原不识别ffmpeg的T15红测已转绿（15/15）；unit-tests现有唯一ci-apt-install步骤补充ffmpeg（同时探测ffprobe）。首次新增第二个安装步骤被CI结构门拒绝，合并回现有步骤后结构门通过。
- 尚未完成T3引用GC及生产authority装配；没有生产账号、Discord写或主机安装操作。
- 本批最终完整 XHS focused suite：8 files / 107 tests green，exit0。

## T3 引用保留与回收

- GC 在 immediate 事务内重读媒体的所有 proposal/attempt 引用，每批最多删除100个合格 artifact。文件身份/hash核实、unlink和目录fsync先于metadata提交。
- 未过期pending/approved、claimed/dispatch-admitted/dispatched以及缺attempt的consumed记录禁止回收。普通终态按最后状态时间+7日；unknown按结果时间+30日；多引用必须全部满足。
- 只删媒体文件、artifact metadata与media_ref；frozen_json/hash、decision、attempt及event保留。unknown在媒体删除后重放仍返回existing。
- 6项真实SQLite/文件测试通过：孤立媒体边界、pending/撤回、unknown及永久消费证据、inflight、共享引用与成功终态起算。崩溃可能留下指向缺失文件的metadata，后续读取fail closed，不自动重建内容或批准。

## T4 Founder原始消息判定（进行中）

- 新`founder-message.ts`：CSPRNG challenge、受限NFKC命令规范化、严格snowflake/timestamp核对、type19精确reply、canonical founder配置一致性、guild/thread/card绑定；拒绝bot/webhook/forward/edit/错码/模糊同意/ship文字。
- 空content返回专门错误；批准期限基于原始消息创建时间，不以迟到observedAt延长。T4审计补齐了store原先不允许未来时间与协议30秒容差的差异，红测后同时修正SQL CHECK与writer校验。
- 原始消息判定23项测试、时钟容差store回归测试通过；本批全部XHS focused suite为10 files / 137 tests green。
- 本模块为纯核验器：它不自行获取Discord消息，不声称调用者传入数据是可信源。真正的authority refetch、原卡/附件重验、配置跨await重验、事务入库、分页observer与通知仍须T4后续装配；当前不能当作机器门已交付。
- 本批teamlead typecheck exit0。

## T4 可信重取与writer连接（进行中）

- `XhsFounderObserver.observe`只接收proposal/message ID，从独立source重取thread归属、原卡、材料消息及附件全部字节；与持久化manifest、bot身份和原内容逐项比较。最后才重取founder原始回复，防止附件await期间的编辑沿用旧快照。
- 在异步读取后以及writer事务内再次读policy；scope/account一致性仍由冻结记录与当前policy核对。批准/拒绝和明确撤回走独立authority ledger，重复撤回幂等。
- 发现并红测修复三处：空content专用错误被泛化；原回复先读取导致编辑竞态；稍后重放的observedAt与首次审计冲突。重放现在只以首次观察时间比对原审计，绝不修改原证据或再mint。
- `DiscordXhsSource`实现受控GET：API固定Discord v10与配置thread，bot Authorization仅发API；附件仅允许Discord CDN的本thread/attachment path，无Authorization、无redirect。按实际读取限制API 512KiB与附件声明大小（最多10MiB），10秒deadline，固定错误码，不在单次请求内部重试403/404/429。
- 测试source使用注入fetch，未调用真实Discord。policy回调尚待T6的root-owned loader；不能把测试回调当OS信任根。实际发卡transport、Message Content权限preflight、持久化分页observer、expiry/outbox通知、authority-main装配仍待完成。
- 修复前完整suite为157通过/1失败（重放observedAt），该红结果保留；后续以修复后的完整suite结果为准。
- 修复后最终XHS focused suite：12 files / 158 tests green；teamlead typecheck exit0。
- 本批复核2519 PR1191仍OPEN，当前head为988e7b1549b31721b6803b1820cd36e27535197d，mergedAt=null；未合其feature branch。

## T4 持久化分页与发卡HTTP transport

- 按[Discord Get Channel Messages官方合同](https://docs.discord.com/developers/resources/message#get-channel-messages)，列表按newest-to-oldest返回，before/after/around互斥。使用before向后扫描，先持久化扫描位置、snapshot head及仅ID backlog，扫到原cursor后按正序处理。
- 每poll最多5页×100、最多处理500条；backlog最多10000 IDs。每条处理成功后才CAS推进cursor；分页/handler失败保留原位置；重启接续原扫描，未扫描历史不被跨过。回调必须是幂等observer，不能把cursor当批准证据。
- 600条积压/重启、分页429、handler中断、乱序页4项测试通过。首次600条真实FULL事务耗时超过默认5秒；仅该集成测试配置30秒，保留600条精确顺序和cursor断言，未修改生产deadline。
- `DiscordXhsSource`新增固定thread分页GET和multipart POST：完整文件字节、最多10附件/单附件10MiB/单请求20MiB、强制禁用mentions；ReviewTransport投影不包含signed CDN URL。DELETE只允许当前实例自己刚发送的ID，不提供任意消息删除能力。
- HTTP测试全部注入fetch，不使用真实bot凭证、不发送实际Discord消息。实际application Message Content权限preflight、通知/expiry worker、分页错误disposition与authority-main定时装配尚未完成。
- 已核对[Application flags官方定义](https://docs.discord.com/developers/resources/application#application-flags)：后续preflight须验证MESSAGE_CONTENT能力与实际thread可读性，不能把空列表视为有读取权限的证明。
- 本批teamlead typecheck exit0。
- 本批最终完整XHS focused suite：13 files / 167 tests green，exit0。


## T4 到期与通知持久化（worker尚未装配）

- 初始通知测试5项因缺少接口全部失败；最小实现后5项通过。另加入COMMIT失败整体回滚、ACK不影响到期与已开始操作的过时提示测试。
- 首轮完整XHS suite为174通过/1失败：已消费后仍返回delivery_delayed。修复为读取队列时重验proposal仍approved且原批准仍未ACK，避免把已开始的写提示为未发送。
- expiry事务同时更新proposal、写不可改审计和唯一通知；每批最多100条，已消费attempt不受影响。未批准proposal到期的receiptId为null，不制造批准。
- founder发送状态与Bridge ACK独立持久化，失败计数可重启恢复；ACK不改变决策、有效期或消费状态。过期会抑制未发送的旧批准/延迟提示。
- 仅更新尚未部署的初始v1 schema。本批无既有生产DB迁移、无Discord外发、无provider调用；定时worker、实际通知transport、撤回通知和authority入口仍待接入。
- 修复后完整XHS focused suite：14 files / 175 tests green（exit0）；teamlead `tsc --noEmit` exit0。此为focused验证，非全仓package gate或最终CI。

## T4 通知发送器与只读Message Content预检

- `XhsNotificationWorker`先做expiry/delayed检查，再按当前有效队列发送，每次await后重新检查后续通知的状态；同实例poll不重叠。重试只有notify能力，没有provider/execute接口。失败计数和送达状态使用真实store，重启继续。
- 明确founder撤回事务新增唯一outbox通知，旧批准和延迟提示被队列状态过滤。通知文字含proposal/digest/event，不引入用户正文或mentions。
- Discord通知POST使用固定event的25字符nonce、enforce_nonce和禁用mentions。通知不会进入草稿删除集合。[Discord官方Create Message](https://docs.discord.com/developers/resources/message#create-message)只保证近几分钟的nonce去重：跨长时间HTTP结果不确定可能重复提示，不能声称Discord通知长期恰好一次；外部XHS mutation仍独立由一次性消费控制。
- `preflight`仅GET，校验/users/@me bot身份、/applications/@me的Message Content应用标志(1<<18或1<<19)、thread guild和近期最多100条消息中的founder普通非mention正文。空列表、空正文、bot自发消息均不作为能力证据；没有可用普通文字样本时fail closed，部署runbook须说明初始thread可读性样本要求。
- 标志依据[Application flags](https://docs.discord.com/developers/resources/application#application-flags)；[Gateway文档](https://docs.discord.com/developers/events/gateway)明确Message Content影响跨API读取。预检不是未来永久权限保证，每次批准仍需原消息refetch核验。
- 红测：worker模块缺失、notify方法缺失、10项preflight接口缺失。发送器/通知/source最初27项定向green；完整回归结果下补。
- 所有HTTP测试注入fetch，未调用真实Discord；worker尚未接入authority-main定时生命周期，pending-card discovery、ship classifier隔离、T5/T6/T7仍未完成。
- 本批最终完整XHS focused suite：15 files / 190 tests green，exit0。Biome定向检查仅发现测试import段空行，自动修复；行为测试未变。FLY-2519 PR1191复核仍OPEN，mergedAt=null，head=988e7b1549b31721b6803b1820cd36e27535197d，未合feature branch。

## T4 独立卡片发现与入站disposition

- `XhsFounderInbox.process(messageId)`通过authority自身source重取消息，再以channel/card/project/lead与完整当前identity查找已持久化卡片；不依赖Bridge传proposal ID，不信任其消息正文。多条歧义绑定返回null，不能任取一条批准。
- 重取前后比较canonical policy。候选回复交给已有observer再次完整refetch；原始消息无效/非精确命令/已过期可明确跳过，读取失败、空Message Content、policy变化继续抛错，分页游标不会越过。
- 21项observer定向测试通过，包含重启发现、重复回复、普通意见/错作者/错scope/错card/编辑忽略、失败保留与policy跨await变更。另加入真实ledger+pagination+inbox+observer的失败后重启恢复测试，完整suite结果下补。
- 初始红测为founder-inbox模块缺失；实现后定向green。没有实际Discord读取或写入。
- 集成勘察：当前tree中旧`classifyFounderShipApproval`无生产调用点；实际gate回复处理在`bridge/founder-reply-deliverer.ts`。后续XHS namespace/card隔离必须落到真实入口，不能只修改旧classifier并称已隔离。T6主入口调度、T5 provider守卫和全部交付门仍待完成。
- 本批完整XHS focused suite：15 files / 200 tests green；teamlead `tsc --noEmit` exit0。并非全仓package gate或最终CI。

## T5 fork隔离准备

- remote main/HEAD核对为计划基线`cf707922a748713f86cda729b1108bf98c951640`。新bare clone在`.claude/worktrees/xiaohongshu-repository.git`，独立worktree在`.claude/worktrees/xiaohongshu-mcp`，分支`flywheel-FLY-2551`；路径已由现有gitignore覆盖。现有`/Users/xiaorongli/Dev/xiaohongshu-mcp`未改动。
- 此嵌套路径满足complete的严格子目录/仓库根约束；未来必须用`--declare-pr .claude/worktrees/xiaohongshu-mcp:<PR>`声明，code review使用对应target-repo。尚无fork PR。
- 已检查baseline测试：live发布/search/feed原本就是t.Skip，其他live测试由integration tag或显式env保护，未新增skip。依赖缓存限定在`/private/tmp/flywheel-FLY-2551-go-{mod,build}`；尚未运行任何生产browser/session。

## T5 公共写拒绝与provider持久化墓碑

- fork baseline `go test -count=1 ./...`最终exit0。新增`write_tombstone.go`：显式provision仅新目录；runtime要求既有0700/当前UID目录、0600单链接generation marker及所有既有记录完整。启动遇到损坏/未知/异代记录拒绝打开。每次以已pin目录fd执行openat+O_EXCL+O_NOFOLLOW，先文件fsync和目录fsync再返回唯一admission；任何部分写/同步不确定保留文件、不删除重试。
- 独立句柄并发只有一个赢家；重启、改attempt重放、file/directory fsync故障、目录替换、路径穿越、损坏和symlink/hardlink均有执行测试。新增启动损坏测试先红（错误允许open），再修复全目录校验。墓碑组件还未接私有commit，不能单独证明外部mutation至多一次。
- `public_write_guard.go`已挂到真实`setupRoutes`，公共MCP `/mcp`及通配路径的六写与未知tool别名403 `founder_write_gate_absent`；REST只允许既有非posting路径，未知写别名也拒绝。RPC解析拒绝重复键、大小写alias及含写的batch；固定1MiB读取界限，允许读时还原原始body。测试下游为计数handler，真实route测试使用无provider实例，绝无实际浏览器调用。
- 读CORS预检先红（403误拒），修复保留OPTIONS既有路径。保留原有十个非posting MCP工具，包括login/cookie操作；其账号lease互斥仍属后续工作，不能把本HTTP拒绝层当成私有账号边界完成。
- fork提交`d604454`。最终`go test -count=1 ./...` exit0，`go test -race -count=1 -run 'Test(GuardedWrite|WriteTombstone)' ./...` exit0。命令显式关闭live测试env；未改既有skip、未运行真实账号或生产服务。
- 尚缺签名permit、peer UID、账号识别/独占lease、pipe browser、非导出VerifiedWrite强制业务上下文、私有commit与最终admission回查，以及T6装配/T7故障端到端证据。不能以公共HTTP403代替所有业务入口守卫。

## T5/T6 permit编码与私有peer校验

- `permit.ts` authority-private signer固定purpose/issuer与domain，只输出canonical `permitJson`+HMAC-SHA256 hex签名；有效期=min(approval,lease,now+60s)，key必须32字节。此原语尚未暴露在任何路由，也不代表已完成消费/dispatch-admission。
- Go `internal_permit.go`验证相同canonical wire与签名、固定issuer/purpose、keyId、provider/账号/epoch/generation/lease/contentDigest/proposal绑定以及时间。固定ASCII字段名排序与TS一致；字符串保留Unicode而不HTML-escape。canonical原文相等检查拒绝未知/重复字段、解析器相关数字写法和非法surrogate替换。
- 两仓相同`xhs-permit-v1.json`由独立Python标准库生成，包含中文、emoji、U+2028和<&>；TS签名和Go验证逐字节匹配，cmp确认fixture完全相同。fixture key为公开合成测试值，非账号凭证。
- 私有HTTP helper只创建0700当前UID父目录下的0600 Unix socket；拒绝既有path与symlink parent。Darwin使用LOCAL_PEERCRED、Linux使用SO_PEERCRED，ConnContext只采信内核uid，HTTP UID头不参与判断。关闭时核对父目录/socket inode，不删除替换文件。
- 真实本机Unix socket定向测试通过：当前内核UID正向control、policy设置为不同UID时即使header声明该UID仍403、下游计数0、模式与清理替换检查。这里未创建另一个真实UID，不能宣称跨principal EACCES隔离或Linux运行证据；受控QA仍需做两UID实测。
- fork `d40b041`。最新`go test -race -count=1 -run 'Test(GuardedWrite|WriteTombstone)' ./...` exit0，包含permit与private socket。默认全包命令session44602仍运行，未重复启动、不记为green；该命令启动于private socket代码加入前，结束后仍需最终代码的全包验证。

## 本批解码器超时测试红测与修正

- 首次XHS完整suite为208通过/1失败：timeout测试读取shell PID文件ENOENT，不能证明decoder确已执行。保留失败，未判全套green。
- 仅测试修正`076969901`：该kill用例固定前置probe结果，继续使用真实decoder child和原2000ms execFile超时；直接断言实际ChildProcess PID、SIGKILL、进程不可再探测及scratch清理。其他7项真实ffmpeg/ffprobe验证保留。没有改生产media-validator、放宽超时或skip。
- 修复后完整XHS focused suite：16 files / 209 tests green；teamlead tsc --noEmit exit0。仍非全仓package gate、code review或exact-head CI。
- 下一步仍为同page账号lease/pipe browser、私有commit把permit/admission/tombstone串联、非导出VerifiedWrite业务入口、T4真实gate隔离与authority调度、T6双runtime/OS部署脚本、T7全部故障和交付门。
- 后续terminal更新：session44602最终exit1，`xiaohongshu`包被Go工具以`Test killed with quit: ran too long (11m0s)`终止（659.965s），无断言失败明细。不是pending或green。
- 同一未改动包随后用`go test -v -count=1 -timeout=30s ./xiaohongshu`诊断，0.659s全部普通测试通过、原有live skips保持；这不足以解释原进程卡住的根因，不作flake豁免。现在重跑最终代码的原始全包命令，结果另记。
- 最终代码`d40b041`的原始全包重跑session7998 exit0：各普通测试包通过（xiaohongshu 1.494s），未改timeout或断言。原11分钟失败保留，根因未确定；不是借定向green覆盖aggregate失败。当前Go full与当前race都有独立exit0收据。

## T5 CDP pipe、受控进程与启动封装

- fork `c636f98` 增加 rod CDP WebSocketable 的匿名pipe transport：fd3写请求/fd4读响应，NUL framing，32MiB单帧上限，严格UTF8/JSON，读写并发锁，坏帧/IO失败关闭。真实os.Pipe和rod client测试覆盖多帧、并发发送、阻塞读取关闭、上限/超限和请求响应。
- child使用独立进程组、固定stdio到/dev/null、最大120秒生命周期；清理先kill专属group再唯一Wait，保留未reap leader避免PGID复用。合成子进程测试取得非空root/descendant PID并验证关闭后消失。这不是实际Chromium detached helper完整归属证明。
- 新LaunchPipeBrowser封装校验root拥有且不可被其他用户写入的binary及全部父目录、固定SHA256与文件inode；固定headless remote-debugging-pipe参数、0700独立profile、不继承环境，显式关闭rod默认URL/monitor/trace/log。连接失败清理；group清理不确定时保留profile，避免误报。
- 初始fixture目录在本机Go1.26 t.TempDir实际为0755；仅将fixture显式chmod0700，生产检查不变。随后以/bin/sh作失败CDP进程时收到sandbox group kill EPERM，测试失败且profile被正确保留。保留这一失败收据；没有将其当作真实浏览器清理成功。
- 将连接后的清理流程抽为私有helper，测试通过真实匿名pipe向持续存活的自有测试子进程发CDP请求，子进程回synthetic rejection；现在连接失败后确实reap并删profile。独立测试继续验证binary pin和固定命令；另有清理不确认必须保留profile的负向断言。没有放宽生产EPERM处理。
- 最终Go全包 `go test -count=1 ./...` exit0（browser1.840s）；最终 `go test -race -count=1 ./browser` exit0（6.428s）。显式关闭live integration env，未新增skip、未使用生产账号或浏览器。
- 以上仍为未接入业务的原语：原browser.NewBrowser未切换，真实Chromium无TCP/full-lineage QA仍缺；同page self-account与独占lease、VerifiedWrite强制业务边界、私有commit/admission/tombstone装配尚未完成。FLY-2519 PR1191仍OPEN/head c2de88abb81e7672f84ca3dd16cf947aa8e0985b，未合feature branch。全仓gate、review、PR及handoff未完成。

## T5 账号lease与会话替换互斥

- fork `11478db` 新增非导出accountLeaseManager。prepare在任何browser await之前预占账号；同账号第二prepare立即account_busy且不调用opener。随机256-bit lease ID绑定digest/account/epoch/generation，生命周期最多120s；取消/超时或迟到的factory结果仍归同一个owner清理。
- recheck只调用保存的同一session，不重新open；稳定ID为空/不同、context过期、epoch/generation/当前owner变化均拒绝。Close幂等；session清理失败不释放账号槽位。这里只是可信session接口，真实rod page selfAccount实现尚未接入，不能作为真实sidebar/state交叉验证证据。
- replaceSession先关闭/作废旧lease，阻止并发prepare，再将递增epoch交给可信回调持久化并替换cookie/login状态。回调必须先持久化；失败保持账号closed，不能继续prepare。实际持久化回调及旧login/cookie业务接线尚待完成。
- 红测分别为lease模块缺失、replaceSession方法缺失；实现后6项lease测试通过，包含启动中取消、身份变化、120s界限、deadline、清理失败、epoch替换和回调故障。最终 `go test -race -run TestAccountLease -count=1 .` exit0（4.153s）；最终普通Go全包exit0。测试均为合成session，未操作真实浏览器/账号/服务。
- 下一步须实现真实同page账号证明、epoch持久化及业务接线；仍缺VerifiedWrite、private commit与最终admission/墓碑串联、T4真实gate隔离/authority调度、T6 runtime集成及T7交付门。原full scope没有缩减。

## T5 同page self-account读取路径

- 当前上游main读到 `aad2a3d249a347859975ce3b76d3442c4a027780`；[login.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/aad2a3d249a347859975ce3b76d3442c4a027780/xiaohongshu/login.go)的CurrentUser使用__INITIAL_STATE__.user.userInfo及userId/user_id。只读查源码，没有调用真实账号或合入上游功能。
- fork `7ae37ca` 新增readSelfAccount与rod page adapter：固定XHS origin导航explore，原子读取唯一sidebar链接和有界self-state投影；两者ID一致且非guest才点击“我”，点击后重读同page，要求sidebar/state/实际profile URL仍为同一ID。缺失、冲突alias、foreign origin、URL credentials、encoded ID、登录跳转、他人profile均拒绝。输出只有稳定ID，错误固定，不序列化整个站点state。
- 新测试初始因reader缺失而红；随后修正gson API类型编译错误。最终self/lease focused race exit0（2.450s），普通Go全包exit0。测试是合成page workflow/URL负向矩阵，rod adapter目前仅编译覆盖；实际Chromium DOM fixture和站点稳定性证据未完成。
- reader尚未接入provider会话factory；epoch持久化/login接线、VerifiedWrite、私有commit/admission/墓碑、T4/T6/T7仍未完成。PR1191复核OPEN，head更新为c695ab53df436ea5bec7145a2df9a321f3303945；没有合feature branch、开PR、部署或真实XHS写。

## T5 私有单次执行协调器

- fork `02eb97a` 将permit/lease/journal组合为非导出privateExecution：固定服务端binding校验permit，校验保存的冻结payload，可信authority admission回查，同lease身份重查，最终payload/time检查，再O_EXCL墓碑+file/dir fsync，最后生成verifiedWrite单次能力交给dispatcher。业务capability只能take一次；无take成功的dispatcher不报告succeeded。
- lease操作锁覆盖整条链；结束统一Close。并发同请求返回同一结果；不同请求不能复用缓存。墓碑已存在返回unknown且不dispatch；发出后error/panic均unknown且不自动重试。错误/结果只返回固定状态，不回传原始异常或permit。
- 新红测先为协调器缺失；跨admission await的payload变更测试随后真实失败，修复增加最终冻结bytes重验。真实私有journal与合成session/callback测试覆盖并发12次仅一dispatch、坏签名、payload/admission/身份/fsync拒绝、响应丢失、panic、既有墓碑以及await后账号/时限/载荷变化。dispatcher执行前实际读取到墓碑文件。
- 最终 `go test -race -run 'Test(PrivateExecution|AccountLease|SelfAccount)' -count=1 .` exit0（2.685s），普通Go全包exit0。没有实际provider HTTP/authority socket或XHS动作；admission/payload/dispatch仍为可信adapter接口。
- 未完成边界：六类现有业务方法尚未强制verifiedWrite入参；provider HTTP/prepare/status/cancel、FrozenWrite Go schema/hash/media verifier、真实same-page factory与epoch持久化尚未装配；T4/T6/T7和交付门仍缺。协调器测试不代表业务全入口守卫或端到端通过。
- 前一轮只读本机检查补记：/Applications root:admin 0775，Chrome.app及executable xiaorongli:admin 0775；不能满足root-owned immutable browser安装要求。没有执行Chrome或改变安装；隔离QA的真实DOM/noTCP/完整lineage证据仍待验。

## T5 provider FrozenWrite跨语言验算

- fork `5e79f5d` 新增完整规范化FrozenWrite Go结构/schema verifier；严格未知字段拒绝、结构重编码与canonical原文逐字相等，拒绝重复/缺失默认/数字别名/非法Unicode替换；以相同flywheel:xhs-write:v1域重算SHA256，再验证六动作允许的target/payload/media组合、UTF16长度、title单位、UUID、safe integer、UTC排程1h..14d。不会从请求补默认或放宽动作。
- Python标准库生成六动作的独立canonical/digest向量；两仓frozen-v1.json经cmp逐字节相同。TypeScript用真实freezeWrite/canonical/contentDigest复算全部一致，canonical.test.ts 50 tests green（原49+共享向量1）。Go同向量通过。
- Go红测先为verifier缺失；额外“合法digest但非法schema”矩阵发现UUID版本过宽，按锁定Zod4.3.6的实际regex修复。矩阵包含未知动作、epoch0、publish target、缺original/media、media类型/视频数量、title单位、空content、visibility、过期schedule、nil tags。
- 最终Go frozen/private focused race exit0（2.543s），普通Go全包exit0；Biome仅格式化新增测试/JSON，既有useTemplate advisory未扩scope修改。没有生产或外部操作。
- 当前只验冻结JSON与media描述符；实际媒体字节stream/hash/MIME/decoder、本机binary/schema policy匹配、保存payload不可变闭包与privateExecution.verifyPayload接线仍待完成。旧六业务入口强制verifiedWrite、private HTTP和provider生命周期、T4/T6/T7及交付门仍缺。

## T5 provider受控媒体副本

- fork `7aadc43` 新增providerArtifactStore：只接受Reader字节和冻结descriptor，随机256bit文件名加固定MIME后缀，不接受模型路径/URL。新lease scratch必须为空、绝对clean path、当前UID0700并pin inode；openat O_EXCL/O_NOFOLLOW0600，单文件<=10MiB、最多18个/180MiB，文件及目录fsync后才进入验证。
- recheck在打开的fd验size/hash/magic MIME、0600/当前UID/single link及原inode，读取后重查mtime/目录及path身份。decoder可信回调前后都recheck；失败清理只unlink pinned directory中的随机名字，无法清理则禁止继续import。
- 红测为模块缺失；另一个红测发现随机文件名没有上传所需的类型后缀，修为仅由已验证MIME映射生成.png/.jpg/.webp/.mp4。测试覆盖字节改写、hash/size/MIME不符、decoder失败/改字节、hardlink/symlink、root替换、取消、19th media和超限descriptor。最终focused race exit0（2.747s），Go全包exit0。
- 测试的PNG header fixture并非完整图片，decoder为合成回调；不能宣称真实媒体已解码。实际pinned ffprobe/ffmpeg decoder、HTTP Reader取消/读取deadline、全局provider配额和lease scratch lifecycle尚待装配。现有callback接口不允许成为模型可选配置。
- 下一步仍为把媒体/frozen verifier接privateExecution，provider实际factory/epoch和六业务VerifiedWrite、私有HTTP；T4/T6/T7未完成。PR1191复核仍OPEN/head c695ab53df436ea5bec7145a2df9a321f3303945，未合feature branch/开PR/执行host或XHS外部写。

## T5 固定payload/media接入执行协调器

- fork `31ce61d` 新增preparedPayload：复制canonical原文，保存digest/proposal及trusted account/upstream policy，复制importer生成的media句柄；每次snapshot重新解析/schema/digest验证，逐项对照media descriptor顺序、fd重验并输出私有路径。policy值匹配不代表已测量实际部署binary，真实启动loader仍须执行pin。
- newPayloadExecution将上述真实校验装入privateExecution，绑定lease的账号/epoch/generation/digest和journal generation，复制签名key。dispatcher仅收到存储原文重新解析的payload及受控路径；commit不接替换正文/媒体。发出前再次snapshot，tombstone之后失败仍保持unknown不重试。
- 初始红测为装配模块缺失；两个组合测试使用真实文件/journal，证明caller raw buffer改写不影响副本、错误policy或缺媒体拒绝、已存媒体改写在commit前拒绝且dispatch0、合法存储载荷仅交付一次。
- 最终prepared/private/media focused race exit0（3.199s），Go全包exit0。decoder/self-account/admission/业务dispatcher仍是合成fixture；不是真实browser或authority socket端到端证明。
- 剩余：真实pinned decoder、provider同page session factory/epoch持久化、六业务方法强制VerifiedWrite及private HTTP/main生命周期；T4真实gate/authority、T6双runtime、T7全仓gate/review/PR/CI/handoff均待完成。无生产、host或XHS外部动作。

## T5 真实媒体解码器及fork CI注册

- fork `df6c4e1` 新增pinned ffprobe/ffmpeg decoder，与authority既有受限参数一致：固定demuxer、file/pipe白名单、MP4禁external drefs、固定env/cwd、64KiB stdout/stderr、40M像素、一个video及最多一个audio、严格解码、总deadline<=60s。每次运行核对absolute nonsymlink executable/hash/mode；root-owned安装及ancestor权限仍须startup loader/隔离QA证明，不能拿本机brew binary当部署隔离证明。
- 初始红测为decoder缺失；真实integration在0700临时目录生成PNG和短MP4，实际ffprobe+ffmpeg正向通过；错误MIME、magic-only损坏PNG、已取消context、坏binary pin均拒绝。另用真实PNG将providerArtifactStore.importArtifact与真实decoder联跑通过，无账号/browser/network访问。
- 输出边界测试发现嵌入bytes.Buffer导致io.Copy通过promoted ReadFrom绕过Write上限，真实红测后改为封装字段。最终 `go test -race -tags integration -run TestProviderDecoder -count=1 .` exit0（3.640s）；普通Go全包exit0。未新增skip；其他现有live integration测试未运行。
- 新fork workflow Guarded write tests：Ubuntu安装ffmpeg，普通全包race，再仅显式运行ProviderDecoder合成integration。actionlint最初拒绝旧setup-go@v4 runner，查官方release最新v7.0.0后替换并actionlint exit0。不触及现有release/deploy流程。
- 推送后exact fork head `df6c4e19406e0d1c8c56f2df64ee08655b273a5a` 运行[34919433474](https://github.com/xrliAnnie/xiaohongshu-mcp/actions/runs/34919433474)已创建，初次查询queued；尚未记CI green。没有root PR或nested PR。
- 剩余：provider session factory/epoch、六业务方法强制VerifiedWrite、私有HTTP/main装配、实际authority admission client；T4/T6/T7全部交付门仍待完成。decoder timeout进程精确清理/隔离host proof仍不是本批测试覆盖的事实。

## T5 旧业务入口拒绝与真实交互路径去重试

- 上一fork head df6c4e19406e0d1c8c56f2df64ee08655b273a5a的CI 34919433474已success：Ubuntu普通全包race及真实媒体decoder合成integration均完成。这只证明该head，不覆盖之后的新提交。
- 审计发现like/favorite旧实现状态不明仍点击，首次状态没变化还会第二次点击。fork `d8e3d79` 将真实Like/Unlike/Favorite/Unfavorite执行函数统一接singleToggle：初始状态未知零click、已达目标零click、一次click后读错/不一致/cancel返回interaction_outcome_unknown，绝不补点。state解析用指针拒绝缺失bool，不把缺字段当false；该路径日志移除带xsec_token的完整URL。
- 旧XiaohongshuService八个写方法及两个私有publish helper全部固定founder_write_gate_absent，直接业务调用也不能越过HTTP guard。保留方法签名供原MCP/REST编译，移除其中原始可执行写body；真实可写能力必须由后续私有VerifiedWrite dispatcher提供，未以全面拒绝替代最终目标。
- 红测：singleToggle/parser缺失；直接PublishContent(nil)在旧代码访问请求而panic，测试当场失败且未进入browser，随后统一guard使八方法全部拒绝。最终singleToggle/state focused race exit0（1.963s），legacy/guard focused race exit0（2.499s），最终Go全包exit0（root2.492s）。没有真实站点/账号调用、没有新增skip。
- 后续发布路径审计发现两个必须修正的问题：图文submitPublish在setOriginal失败时warn并继续；PublishVideoContent/submitPublishVideo没有isOriginal字段，不能承诺完整冻结选项一致。private dispatcher接入前须处理并用fake UI证明实际设置，不得无声忽略。现有FLY-2024 timeout/cleanup验证也需在新的受控路径继续提供。
- 剩余：真实同page session factory/epoch、私有六写dispatcher、HTTP/main/admission client，T4/T6/T7全套交付。PR1191仍OPEN/head c695ab53df436ea5bec7145a2df9a321f3303945；无PR/host部署/XHS外部写。

## T5 原创选项显式设置（UI验证进行中）

- fork d8e3d79的CI34919977775已success。新fork `b79d91a` 将图文/视频都接setOriginalState(page, desired)：要求唯一原创card/switch及真实checkbox，true/false均显式满足；点击确认失败或最终读值不符直接返回error，不再warn后继续。视频content及submit函数新增IsOriginal传递。
- 新合成DOM integration测试初始因setOriginalState缺失而红（另修正launcher.Env variadic编译调用）；实现后本机测试在launcher启动阶段失败：Failed to get the debug url，未执行任何DOM断言。Chrome --version可执行，具体启动失败原因未证实。保留此红收据，不能称本机UI green。
- 该fixture使用明确binary、全新临时UserDataDir及HOME/TMPDIR、固定env、about:blank+SetDocumentContent，不调用旧cookie loader或真实站点。它只验证UI，不绕过或证明生产pipe/root-owned/受控UID边界。
- 普通Go全包exit0；actionlint初次SC2155后将export拆为赋值+export，最终exit0。CI新增只运行OriginalSettingSyntheticDOM的独立步骤，使用runner google-chrome；exact b79d91ac11cbd0c5b36af4ea3fb176d55e2e7b12 的[34920371965](https://github.com/xrliAnnie/xiaohongshu-mcp/actions/runs/34920371965)已in_progress，UI verdict尚待其结果。
- 后续发布内容审计新发现：Publish将tags截到10；inputTags去掉开头#并选择联想第一个item，找不到则改输空格。私有写路径必须消除静默截断/选错目标并核对最终UI内容，不能直接复用这些fallback。未实现，不以源码意图替代证据。
- 私有dispatcher/session factory/epoch/HTTP/main、authority/T4/T6/T7仍未完成；没有真实XHS写、部署或新PR。
- 后续权威回执：34920371965最终completed/success，exact b79d91a的普通race、媒体decode及OriginalSettingSyntheticDOM均通过。该CI证明合成UI的true/false/no-op/missing-checkbox/failed-confirmation行为；本机启动失败与生产隔离/真实站点未验证边界保持。

## T5 标签不截断及精确联想选择

- fork `693c1a6` 移除Publish的tags[:10]及inputTags的TrimLeft("#")。固定payload中的标签原文、数量、顺序继续传入；不再选第一个建议或在找不到时改输空格。
- selectExactTopic只看可见item，要求唯一完整label匹配原文或UI单个#装饰；不trim/case-fold，重复匹配、相似词、没有匹配均topic_unbound且零click。新unit red为matcher缺失，最终focused race exit0（2.490s），普通Go全包exit0。
- 新TopicSelectionSyntheticDOM复用独立临时profile helper，覆盖正确项位于第二、近似词、重复匹配、空列表，断言实际click选择；CI步骤扩为OriginalSetting+TopicSelection。actionlint0；本机integration仅编译检查（-run ^$），没有把no-tests-to-run称为UI验证，实际DOM结果待新CI。
- 此批不证明真实站点topic item呈现形态、最终编辑器chip列表或整篇最终UI与冻结载荷一致，未知UI形态会拒绝；这些仍需后续完整发布fixture/QA验证。没有把候选label选择等同于已发出正确内容。
- 私有dispatcher/session factory/epoch/HTTP/main、T4/T6/T7全套仍未完成；没有真实XHS、生产或host操作。

## T5 私有dispatcher与精确评论目标

- fork `179b9db` 新增guardedDispatcher，将journal消费后mint的verifiedWrite连接到同一个lease session的page；只从preparedPayload重新取得冻结正文/选项/媒体路径。再次绑定digest、账号/epoch/generation、lease，解析token后重查时间/context并take一次。token resolver只收冻结account/target，不接commit caller的替换内容。实际session factory及token resolver尚待装配。
- 六operation映射保留title/content/tags/media/schedule/original/visibility及target/comment/user/unlike/unfavorite。旧公开业务入口仍拒绝。图文/视频/comment/reply旧方法没有平台确认回执，dispatcher一律返回write_outcome_unknown，不把click当作成功；like/favorite仍走已验证singleToggle。完整最终UI一致及平台结果证明仍待完成。
- 审计发现reply旧查找按comment ID失败后会退回同作者另一评论。新ReplyToExactComment关闭该fallback，要求comment ID唯一/connected，冻结可选author必须由选中评论自身的唯一.author data-user-id标记匹配，nested reply不能满足；滚动后点击reply前重验。未知真实站点markup会拒绝，不声称synthetic结构已代表当前真实站点。comment/reply移除含token URL日志并保留caller context。
- 初始dispatcher红测为缺模块/字段，exact-comment红测为缺matcher。最终Go全包 `go test -race -count=1 ./...` exit0（root4.453s）；补充绑定拒绝测试后focused race exit0（root4.448s、xiaohongshu2.781s）。覆盖缺cap、五项绑定改写拒绝且resolver/writer0、原page/精确内容交付一次、六schema映射及comment作者匹配。actionlint、diff-check0。
- CI增加ExactCommentSyntheticDOM：exact/wrong/missing/optional author、nested reply、duplicate ID、ambiguous author。未在本机重新跑已知无法启动的Chrome；其实际DOM执行结果待exact-head CI。既有本机launcher失败收据保持，不拿普通Go测试替代UI验证。
- 剩余：同page真实session factory、持久化epoch、private HTTP/main、authority admission/token resolver、最终UI一致与稳定平台结果；T4/T6/T7及两仓PR/review/完整gate仍未完成。无生产安装/UID操作、真实XHS调用、QA派发或PR。

## T5 受控pipe session factory与私有cookie快照

- fork `bdd6761` 新增实际openControlledSession：只调用LaunchPipeBrowser（固定pinned binary、匿名CDP pipe、新private profile），显式SetCookies，再创建唯一page；同page供readSelfAccount及guardedDispatcher使用。cookie来自明确startup policy路径，不使用旧COOKIES_PATH、工作目录或/tmp回退，也不复制旧cookie。
- 新cookie envelope绑定schemaVersion/account/provider instance/epoch/generation；<=1MiB/256cookies，打开0700当前UID目录与O_NOFOLLOW/Openat0600/single-link常规文件，读取前后核对inode/mtime/size/root，拒绝重复JSON key/未知字段、foreign domain/URL/partition cookie。保存原文hash，每次selfAccount先重读并核对快照未变，再核对页面真实self ID。该reader不是epoch持久化writer；启动器仍须验证所有祖先及专用UID，不能把当前UID文件测试当OS隔离证明。
- 发现并修复启动失败ownership缺口：CDP connect失败且child/profile清理未确认时，PipeBrowser返回owner+error，factory继续把owner交回lease manager，使失败Close保留账号槽位；不能返回纯error后释放槽位。正常cookie/page/self初始化失败也返回owner供manager清理。
- 红测为factory/reader缺失及failedPipeStartup缺失。最终focused cookie race exit0（2.312s），最终普通全包race exit0（root3.287s/browser6.089s/xiaohongshu3.034s）。测试覆盖真实临时文件正向、旧epoch、0644、软/硬链接、空/重复/未知JSON、foreign cookie及坏快照在browser启动前拒绝；合成cleanup失败保留owner/profile。
- 本批没有运行独立UID下真实Chromium、真实self页面或扫码，没有生产cookie/账号操作；因此factory源码已连接不等于host/session端到端验收。新head CI待回执。下一步持久化cookie/epoch替换及private service装配；authority/T4/T6/T7及完整最终UI、平台结果、全仓gate/review/PR仍未完成。

## T5 登录变更前持久化epoch及cookie保存

- 上一fork c512282的CI34922061821已completed/success。新fork `b216be2` 增加accountEpochStore：显式provision才创建目录及固定base账号/generation；运行时要求已存在，逐项读取连续epoch记录和对应cookie文件，缺失/损坏/不连续/换generation均拒绝。路径0700/当前UID/nonsymlink/inode绑定，独立handle通过非阻塞目录flock及O_EXCL串行化，不覆盖历史记录；条目数1024封顶，容量不足不删epoch换空间。
- replace接已有accountLeaseManager.replaceSession：先关闭旧lease并占住changing，持久化新epoch文件+目录fsync，之后才调用trusted login owner；返回cookie通过相同strict校验后写入新epoch独有0600文件，再fsync。新epoch未完成cookie时current返回空cookie路径，重开store不会回退旧会话；manager账号/generation不匹配在callback前拒绝。
- 初始红测为模块缺失；补测真实发现空cookie结果写坏文件导致不能重开、错manager可进入login callback。已提取共用decodeControlledCookies在落文件前验证，并提前绑定manager。中途提取函数有err作用域编译失败（focused及一次全包失败），修复后最终完整 `go test -race -count=1 ./...` exit0（root3.361s/browser4.751s）。未skip或放宽断言。
- 用真实临时文件重开验证新epoch先于callback可见、失败登录只留下未登录新epoch、成功cookie绑定新epoch、旧epoch拒绝；文件/目录fsync注入失败均login0，两个独立store/manager并发只有一次login，丢失/partial/gap/wrong-generation拒绝。重开文件句柄是持久化恢复fixture，不是断电/真实进程重启或真实扫码证明。
- 该store不声称独自识别管理员恢复整个旧磁盘快照；部署/恢复时authority与受信policy的generation/epoch对账和rotate仍必做。base为该generation固定起点，当前epoch取完整持久化历史。实际login owner、startup loader与private HTTP/main尚未接上；没有生产cookie、账号、UID或host动作。
- 下一步把epoch/current cookie路径、factory、prepared payload、permit/journal协调器装配为私有provider服务，再接authority admission及token resolver；T4/T6/T7与全仓gate/review/两仓PR/完整UI及平台结果证明仍未完成。

## T5 私有provider服务与Unix路由装配

- fork `d8910dc` 新增guardedService：从epochStore取得当前账号/cookie路径，使用同一manager独占lease，固定upstream policy验证FrozenWrite，流式import受控媒体，再接真实factory、preparedPayload、permit/journal协调器及guardedDispatcher。默认open调用openControlledSession；实际authority admission/token resolver仍由可信startup注入，启动loader/main尚未完成。
- prepare的request取消只覆盖准备过程；成功返回后脱离已结束HTTP request，仍受service context和总120s deadline限制。prepare忙时直接account_busy；不消费回执、不调用writer。terminal Close在确认browser清理后清除精确scratch；失败则保留scratch及账号槽位。缓存最多128个并清理过期项，永久墓碑不删；临时root最多8个scratch，完整全局容量/重启孤儿回收仍须startup装配验收。
- 新POST /v1/prepare（首multipart part为原始canonical frozen，后续仅无filename的media流，digest另带非授权header）、/v1/commit（仅已有lease+permit+signature）、/v1/status。多余/缺失媒体在browser启动前拒绝；不接文件路径、URL、替换正文或模型token。路由自己也要求kernel-derived peer context，误挂旧TCP仍拒绝；无CORS，响应no-store且仅固定code/lease projection/state。
- service commit复用真实签名/账号/payload重验和先落墓碑再执行；status优先返回已知终态，缓存丢失后精确receipt/attempt/digest/generation墓碑只返回unknown，不重发。发布/comment/reply仍无平台回执，保持unknown，不以fake runner的成功代替真实平台结果。
- 初始红测为service/routes缺失。私有socket测试还抓到Go decoder接受ReceiptId大小写别名，已增加顶层精确字段集合检查；重复key/未知key/别名均400。最终完整Go全包race exit0（root3.787s/browser7.648s）；增加媒体改写和清理失败组合测试后focused service/routes race exit0（2.410s），diff-check0。
- 正向测试使用真实Unix listener和kernel peer、真实epoch/cookie文件、permit HMAC及消费墓碑：prepare writer0，request结束后commit可用，重复commit writer1，status可查询，缓存丢失保持unknown。负向证明伪造peer header/extra媒体/歧义JSON/坏签名/未知lease拒绝；实际import后改媒体文件使commit writer0；不确定browser清理保留scratch/account_busy。browser、decoder、admission、token resolver、业务writer在这些组合测试中为明确synthetic adapter，未冒充真实XHS或隔离UID端到端。
- 下一步private startup配置/实际binary和UID pin、main生命周期、authority admission/token socket客户端与login/read服务，再接T4/T6/T7。新fork head CI待回执；无生产、真实账号、host操作、QA派发或PR。

## T5 authority私有客户端及attempt-bound token查询

- 上一fork d8910dc CI34923097086已completed/success。新fork `49f64d2` 新增authorityClient：固定policy path/UID的Unix socket，每次新连接核对0700 parent/0600 socket的inode、属主和kernel peer；禁止代理/TCP替代/重定向，禁keepalive，5s总deadline、8KiB请求/响应header和16KiB响应body边界，全部失败返回固定非秘密error。
- POST `/internal/v1/provider-admission`发送canonical internalPermit；仅接受精确JSON `{admitted:true,permitDigest:sha256(canonicalPermit)}`。POST `/internal/v1/provider-token`发送permit/account/target，响应必须含相同permitDigest/account/target及<=4096-byte token。guardedTokenResolver现在也接验证后的permit，避免只按account/feed查询时丢失proposal/attempt关联；authority服务端仍必须按该proposal/attempt检查已admitted状态及原project/activation资源归属，本批尚未实现该服务端，digest回显本身不是批准证据。
- strict响应解析拒绝重复/未知/大小写别名及缺字段；所有网络/解析错误不返回上游body、socket路径或token。新client函数签名与guardedService的admit/resolve注入点匹配，真实startup/main尚未创建client或启用服务；没有把synthetic authority服务器当完整机器批准门。
- 红测为缺client；增加permit绑定时先观察旧resolve参数不匹配编译红，再更新resolver与对应测试。最终完整Go全包race exit0（root4.735s/browser6.653s）；追加丢响应/权限漂移测试后focused client/dispatcher/service/routes race exit0（2.951s），diff-check0。
- 实际Unix listener fixture验证kernel UID正向及错误owner拒绝、admission digest/denied/redirect/unknown/oversized拒绝、token跨account epoch/attempt拒绝；hijack后关闭连接模拟admission响应丢失，handler计数1且无自动重试；socket变0644后handler0。测试没有真实authority DB端点、模型进程隔离或真实平台调用。
- 下一步startup配置/UID及实际binary/所有ancestor pin/main生命周期，与TS authority私有admission/token端点装配；login/read、T4/T6/T7、全套最终UI/平台结果、完整gate/review/两仓PR仍未完成。无生产、host、真实账号或QA/ship动作。

## T5 实测工具schema与签名隔离回执验证

- 上一fork49f64d2 CI34923518247已completed/success；PR1191仍OPEN/head e585338878de2e4e7a34b1615a86afb557dc913d，未合2519 feature branch。新fork `6fabd4e` 从当前binary实际registerTools建立内存MCP server/client，只执行ListTools，要求16个唯一工具，按name排序后对完整Tool JSON（含schema/annotations/description）加domain `flywheel:xhs-tool-catalog:v1\n`算SHA256。nil AppServer fixture证明未进入业务handler。
- main新增只读 `--guarded-schema-digest`，在旧env/browser/service初始化前输出指纹并退出。实际 `go run . --guarded-schema-digest` exit0，stdout为 `034d49afdfb72e65c2f3e72ed180a0f7396f8d678232565e7898036a1598626a`；stderr仅已有Registered16日志。无cookie、外部MCP/browser或账号调用。安装器后续应运行实际安装binary此命令，不以包version或模型传入schema代替测量。
- 新guardedBoundary verifier使用Ed25519，domain `flywheel:xhs-boundary:v1\n`，字典序canonical statement含schemaVersion/configDigest/providerBinarySha256/toolSchemaDigest/passed。要求passed=true且完整配置hash、实际binary/hash、实际schema一致；严格JSON拒绝缺字段/别名/未知key。public key与configDigest必须由尚待实现的immutable root-owned启动配置取得，不能从ingress传入。
- 红测为schema/proof模块缺失；最终普通Go全包race exit0（root5.729s/browser10.287s）。测试覆盖实际16tool catalog、描述改写改变digest、重复工具拒绝；临时随机签名key验证正向、配置/binary/schema三项独立漂移、签名的failed verdict、改passed未重签及缺回执拒绝。没有签发真实QA acceptance或以测试key作为安装key。
- 尚未把verifier接startup/main服务分支；root-owned配置/所有ancestor/真实UID与binary验证、root QA签发脚本、provider生命周期与孤儿处理仍待实现。配置digest最终须覆盖两仓revision、policy、两个UID和provider generation等冻结字段，不能只hash一个enabled布尔值。TS authority端点、login/read、T4/T6/T7及完整gate/review/两仓PR均未完成；无生产/UID/host/真实账号动作。

## T5 受信启动配置与main生命周期接线

- 上一fork6fabd4e CI34923936265已completed/success。fork `4008416` 新增 `--guarded-config` 分支，在旧ROD/env/TCP service初始化前进入runGuardedProvider；失败仅输出guarded_provider_unavailable并exit1，绝不fallback旧provider。固定配置包含两仓revision、policy version、服务/model UID、服务GID、account base/generation、所有binary/key/state/socket/proof路径与QA公钥；完整配置原文字节hash绑定签名回执。
- loader要求配置root-owned0644且所有ancestor root-owned/nonsymlink/不可group-other写；当前UID/GID必须匹配独立非root服务身份，附加组只能为服务组。provider自身实际os.Executable路径/hash、browser及ffmpeg/ffprobe全部通过immutable root-owned binary+ancestor检查；实际工具catalog重算匹配；root-signed acceptance必须绑定上述配置/binary/schema后才读32-byte私有key。
- state roots要求当前服务UID0700且ancestor只允许root/service、互不嵌套；key/receipt/socket不能落入可清理media/profile root。key为服务UID0600常规single-link文件，O_NOFOLLOW/nonblocking打开并前后比inode/mtime/size。socket parent经同样ancestor检查；实际private listener/client继续核对kernel peer。
- main现在创建真实epoch/journal（只open，不自动provision）、authority client、实际decoder、guardedService和Unix listener，SIGINT/SIGTERM退出时关闭listener/service/owned leases。尚未实现精确孤儿browser恢复：profile root非空则拒绝启动，不扫描/杀全机Chrome；该限制不是最终恢复验收，后续必须补齐。真实authority server端点/login/read也仍未完成。
- 初始红测为startup reader/principal模块缺失；最终完整Go全包race exit0（root7.037s/browser7.848s）。真实 `go run . --guarded-config /private/tmp/flywheel-FLY-2551-absent-startup.json` exit1且仅固定错误，没有启动服务。没有构造root-owned生产配置/真实acceptance或修改UID；完整正向startup/安装与权限隔离仍待可信隔离QA。
- 后续审计补上模型用户实际组归属：loader通过os/user查ModelUID的GroupIds，服务组与其任一组相同或无法确认即拒绝。测试先因guardedSeparateGroup缺失而红，补实现后startup/boundary/schema/service/routes focused race exit0（2.951s）。不以配置里写一个不同GID自行声称组隔离。
- 下一步TS authority provider-admission/token端点（真实store验证）、read/login装配、root安装/QA签发与精确孤儿处理，T4/T6/T7及最终UI/平台结果、全套gate/review/两仓PR仍未完成。无生产、真实账号或host激活动作。

## T4 authority真实账本的dispatch admission

- fork6a6b4b5 CI34924359566已completed/success。本批root `316d4d0b5` 为XhsWriteStore增加持久化dispatch开关和精确attempt admission。authority_metadata通过FULL事务按列迁移write_enabled/gate_updated_at；已有账本缺列时默认关闭，不从历史approved/consumed记录推断启用。claim也要求开关有效；开关修改方法仅供可信authority lifecycle，未暴露ingress。
- admitDispatch在同一个BEGIN IMMEDIATE/FULL事务内检查strict permit、purpose/issuer、key/audience、账号/epoch/generation、proposal原文重算digest、批准用途/config version/有效期/已消费receipt->attempt绑定、project/lead/current activation、lease及started/updated时间；只允许claimed->dispatch-admitted或同一已admitted上下文。dispatchContext仅给已admitted且未terminal的精确请求返回已存FrozenWrite，后续token查询须再用其project/activation/target归属，不能信任provider另给的裸context。
- setDispatchEnabled(false)与admission共用事务顺序点：撤销所有未消费pending提案（含审计/notification），claimed attempt转unknown；即使重新启用也不能恢复它们。已先admitted的attempt保留资格，符合设计的关闭不承诺撤销规则；context仍校验permit时限和gate时间回退。
- 初始12条测试全部因缺方法而红。扩展套件曾219pass/3fail：artifact-retention使用独立fixture未显式开门，claim被新默认关闭正确拒绝，导致预设in-flight不存在；已在该测试fixture显式授权启用，保留所有原保留期断言。常规store fixture也明确enable，另加旧账本迁移关闭测试以防生产默认变on。
- 新16条admission测试覆盖精确正向+重开、8字段独立改写、activation/terminal拒绝、admission前无token context、关闭-重开不复活、旧metadata迁移关闭、SQLite trigger注入写失败回滚、先admitted后关闭可继续/回退时间拒绝、关闭撤销批准。最终 `vitest run src/xiaohongshu-write` 17文件/226测试全部通过（22.68s）；teamlead typecheck exit0；formatter/diff-check0。
- 这不是整仓aggregate/CI或真实provider->authority端到端证明。私有HTTP/kernel-peer封装、真实policy/activation来源、token provenance store、独立authority-main、Bridge入口及login/read仍待装配；T4/T6/T7和全套gate/review/两仓PR/host最终验收未完成。没有生产DB、UID、host或真实账号动作。

## T4 provider私有HTTP与内核peer校验

- root `89f1f0097` 新增实际Node HTTP admission/token handler，与已有Go authorityClient的两个固定internal路径和permitDigest响应形状对应。每次先通过继承accepted socket fd3的原生helper读取内核UID，再读<=8KiB strict JSON；不使用header或请求参数中的peer声明。5s总deadline、no-store和固定错误，不在失败响应泄漏token或上游错误。
- helper源码只接受fd3，验证AF_UNIX/SOCK_STREAM；Darwin LOCAL_PEERCRED与Linux SO_PEERCRED分支。Node读取内部socket fd（缺失即拒绝），每次检查helper路径/文件/pin，1s超时SIGKILL并等close；输出32字节上限。root-owned helper与所有ancestor仍必须由待装配startup验证，本测试的当前用户临时helper不能当root安装证明；Linux分支尚未由本批CI验证。
- admission使用真实store事务，token必须已有精确dispatch-admitted上下文；请求account/target需与已存FrozenWrite一致。异步token查询后再次解析当前activation/scope并核对账本，变化即拒绝返回。scope和frozen均复制，trusted resolver不能改写校验基准。store接受时钟函数，在取得写事务后刷新时间，避免锁等待沿用旧有效期。
- native helper缺模块红测已观察，后续真实socket正向通过；HTTP组合测试是在handler之后补充，不声称其曾先红。最终重新取得 `vitest run src/xiaohongshu-write` 19文件/231测试全部通过（61.24s），teamlead typecheck exit0，diff-check0。前轮会话终态在上下文切换后无法取回，因此本轮重跑取得独立终态，没有把缺输出当green。
- 三项HTTP测试使用真实Unix HTTP/native kernel UID/SQLite账本，证明admission前token resolver0、合法admission及token响应、查询期间activation变化拒绝、伪造UID header不能推进claimed账本；时钟测试证明入事务后过期拒绝。token和scope来源为明确synthetic adapter，未跑Go->Node跨进程组合、真实资源provenance或隔离双UID安装。
- PR1191当前仍OPEN/head5a76d42bd1392b3d5886fc1bcb78d4a09ded535f，未合2519 feature branch。下一步独立authority-main及可信policy/activation/token资源装配、Bridge入口互斥，provider login/read、精确孤儿恢复和root QA脚本；T4/T6/T7、整仓gate/review/两仓PR及最终host/UI/平台结果证明仍未完成。无生产DB/UID/host/真实账号动作。

## T4 Bridge命令命名空间隔离

- root `1108db90d` 在实际founder-reply-deliverer使用固定isXhsProtocolReply：与authority共用NFKC/trim规范化后，三个XHS命令前缀排除ship/review卡匹配及ship learning observer；原文继续既有durable Lead handoff。此判定只缩小路由权限，不写任何XHS批准。
- 六项新增测试先全部红：即使是XHS合法命令、错码、拒绝/撤回、全角字符或前缀转述，回复当前ship卡仍调用ship回调一次。修复后整个founder-reply-deliverer文件52项及founder-message23项共75项通过（24.62s），保留原ship approve/reject正向；真实CommDB fixture的pending ship未被批准，原文handoff一次，ship/learning回调0。teamlead typecheck exit0。Biome初次仅报新增import顺序，修正后check通过；diff-check0。
- 已知XHS卡上无命名空间的“好”仍需可信卡身份查询及authority-client装配，本批未声称完成该分支。专用审核thread/root policy、独立authority lifecycle、真实token provenance、两runtime接线、provider login/read及全套gate/review/host/UI/平台证明均仍未完成；没有生产、host、真实账号或ship动作。

## trusted-files 恢复验证（2026-09-15）

- 接任取得 implement TURN epoch6，fetch 后本地/远端均为 `4b097fca975a7ec99833686e57b6abad8c496ca8`；读取 progress/plan 与保留的两个 trusted-files 文件，没有重做已完成设计或恢复其他分支 stash。
- 首次误用包名 `@flywheel/teamlead` 返回 no projects matched，不计作测试。改用实际包名后 6 项中 1 项失败：特殊模式 fixture 要求 chmod 04600，但实际 lstat 为0600。独立临时 synthetic 文件重现 04600→0600、02600→0600、01600→01600、0640→0640；本环境未建立原 setuid fixture。
- 仅修改测试为实际可保留的01600，并在调用 reader 前断言真实 mode。生产 exact0600 权限校验未改、未skip。该测试证明 sticky 特殊位被拒绝，不声称本环境取得 setuid/setgid 的真实文件拒绝证据。
- 最终 `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/xiaohongshu-write` exit0，20文件/237项通过（36.04s）；teamlead `tsc --noEmit` exit0；两个 trusted-files 文件 Biome check通过，git diff --check通过。不是整仓aggregate、exact-head CI、独立UID隔离或真实账号证据。
- trusted-files 尚待接独立 authority startup。authority lifecycle/真实token provenance、provider login/read、可信XHS卡短回复查询、T4/T6/T7余项、两仓PR及host/UI/platform证据继续未完成；没有生产/host/账号动作。

## T4 authority 可信启动配置与验收签名（2026-09-15）

- 新增 `authority-config.ts`：严格JSON/schema固定独立service UID/GID/model UID、policy/founder版本、两仓revision、程序/peer helper/provider config路径及hash、private state路径和project/lead/account/Discord registry。无enabled默认值；同UID、admin组、founder配置分歧、重复scope、私密文件进入artifact清理root、任意路径/摘要/未知字段等拒绝。
- loader只读取root-owned不可变配置；从进程和固定 `/usr/bin/id -G <modelUid>`（1s/1KiB、有界干净env）核实实际身份/组隔离。验证当前Node和入口路径，以及Node/JS/helper、provider config和provider/browser/media工具实际文件hash。UTF-8使用fatal decoder。启动读取器不创建UID/目录/账本、不读bot/permit秘密、不打开写门；还未接authority-main。
- 精确解析现有Go guardedStartup字段并绑定service/model principal、两仓SHA、policy、账号base、authority私有socket、key路径/id和QA公钥。provider清理root彼此及authority artifact root不重叠，且不能包含账本、秘密、程序或配置。工具schema为已pin provider配置中的期望值，实际provider运行测量/ready握手仍必须完成，不把配置值当实测schema。
- 新增 `boundary-acceptance.ts`，使用与Go相同的 `flywheel:xhs-boundary:v1` 签名域、排序JSON、Ed25519原始公钥/base64格式；只验签、不签发。loader核验root-owned receipt，绑定authority完整原始config digest、实际验证的provider binary hash、期望schema digest。provider自身仍需其原有独立config receipt；本批未做Go->Node跨进程互操作演练。
- 为计划中位于service private state内的root签名文件新增 `readRootReceipt`：root0644 single-link常规文件、有界NOFOLLOW读取、前后inode/stat/ancestor复核；ancestor只允许root/service且不可group/other写。没有放宽可执行文件/配置的root-only ancestry。真实只读 `/etc/hosts`验证文件读取正向，不是验收凭据或隔离证明；model-owned替代文件拒绝。
- 新模块初始红测均因模块缺失；provider绑定/readRootReceipt扩展各有明确缺函数红测后实现。首次tsc报await后可选process UID/GID/group函数类型未收窄，保留先验存在检查并修正类型后通过。focused三个文件31项、teamlead tsc/Biome/diff-check全部通过。
- 缺失正向root-owned安装fixture、独立UID/system launchd运行、实际root QA签发与两端启动；不把parser的synthetic principal测试当host证明。下一步authority-main/lifecycle、真实scope/token provenance、可信卡短回复、provider login/read/孤儿恢复、两runtime装配与完整gates/PR/host/UI/platform证据仍必做。
- 本批最终XHS全模块验证：`VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/xiaohongshu-write` exit0，22文件/262项（21.87s）；不是整仓aggregate或CI结果。

## T4 authority 到 provider 的私有客户端（2026-09-15）

- 新 `provider-client.ts` 对接现有Go `/v1/prepare`、`/v1/commit`、`/v1/status`。只连接固定Unix socket，每次先通过实际native kernel peer helper核对UID再交给HTTP Agent发送任何正文；没有TCP、代理、重定向或重试fallback。startup仍必须提供root验证过的helper/socket配置。
- prepare只接受已经完整冻结的正文：再次schema/schedule验证，但验证结果canonical与输入不完全相同就拒绝，不能在批准后展开默认值。multipart第一个part为精确frozen、随后按清单顺序发送无filename媒体流；逐流size/hash校验、backpressure和120s整体取消信号覆盖传输。lease严格绑定digest、账号ID/epoch/generation及期限；未知响应字段拒绝。
- commit只发送一次，断线/坏响应返回unknown，不自动重发。status只接有界固定state投影；不透传provider错误或任意返回对象。媒体读取器收到同一AbortSignal；客户端在结束时关闭精确连接并通知读取器取消。
- 初始红测为缺模块；正常6项通过前发现发布fixture继承like的unlike=false，不满足既有schema，明确改为null。随后三个额外负例均实际红：provider提前回复时错误接受未校验媒体、提前关闭后取消仍stalled、null unlike被自动扩展后错误接受；各自最小修复后继续全模块验证。没有放宽断言或skip。
- 测试使用真实Unix HTTP与实际C peer helper，wrong-peer证明HTTP handler0；断线commit handler仅1；媒体为明确synthetic字节，真实provider负责完整解码。本批尚未跑Node→Go→fake browser组合，不把同UID测试冒充独立UID隔离、真实schema/账号或host proof。
- 该客户端尚待接authority service/main；真实scope/token provenance、provider login/read/孤儿恢复、可信卡短回复、两runtime装配、整仓gates/两仓PR及host/UI/platform证据仍未完成。
- 最终 `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/xiaohongshu-write` exit0，23文件/268项通过（21.30s）；teamlead tsc、focused Biome、diff-check通过。仅模块验证，不是全仓aggregate或exact-head CI。

## T4 一次性执行协调器与真实账本组合（2026-09-15）

- 新增store私有 `executionRecord`：按root-derived identity与精确digest读取已批准frozen/receipt/expiry；不消费、不把receipt或frozen内部字段投影给ingress。无批准/身份错/摘要错/撤回/过期/关门均拒绝新lease；已有attempt可在重启、过期/关门后查询原状态，不重开批准。
- claim与executionRecord支持在BEGIN IMMEDIATE取得后调用时钟。新真实第二SQLite连接timeout0 fixture在时钟callback内尝试BEGIN IMMEDIATE并要求locked，证明时间采样在写锁内；到期时零消费。保留既有数字now API兼容测试，生产协调器传时钟函数。
- 新 `XhsWriteExecutor` 将可信scope→真实账本批准读取→provider无写prepare→重核scope/批准/lease→原子claim→内部签名→单次commit→finish串起来。已有attempt直接返回原状态，不再prepare；prepare期间activation变更、撤回、过期均0commit。claim之后异常只记unknown，不恢复回执。对外结果只有固定denied code或attempt id/state，不含receipt/key/permit/token。
- store新接口3项缺方法红；锁内时钟新增测试先因claim不接受callback红；executor初始缺模块红。focused18项通过，涵盖并发两个executor同一real store只1commit、实际重开账本后unknown重放只返回原attempt。一次Biome失败为抛错fixture错误写成无yield generator，已改普通抛错函数，没有skip/放宽断言。
- 补充组合测试使用真实native peer/Unix HTTP client、实际HMAC签名和同一真实store的admitDispatch：缺批准prepare0/mutation0，批准后consume先于commit，HMAC正确且admission通过才counter+1，重开DB换executeRequestId后prepare/mutation仍各1。此组合测试在实现之后补充，不声称先红；HTTP provider是明确fixture，未覆盖Go journal/browser/真实账号或独立UID host。
- scope与media仍是明确依赖接口，实际authority service/main、root registry/current activation与真实token资源来源、provider login/read/孤儿恢复、可信卡短回复及全部gates/两仓PR/host/UI/platform证据未完成；没有生产/host/账号动作。
- 最终 `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/xiaohongshu-write` exit0，25文件/280项通过（20.77s）；teamlead tsc、5文件Biome、diff-check通过。未运行本批整仓aggregate/CI/host验收。

## T4/T5 当前账号私有证明与root registry（2026-09-15）

- fork `40be8d6` 新增实际 `guardedService.accountStatus` 与私有POST `/v1/account`（只接受空对象）。使用既有account lease manager独占session，生产factory仍是openControlledSession；实际自有page ID必须匹配provider账号/epoch，确认epoch/cookie路径未变且精确Close成功后才返回loggedIn=true。无cookie仅loggedIn=false，不启动browser；已有prepared写lease时busy，不抢占；关闭失败保留互斥。响应只含account/upstream/loggedIn，不含cookie/token/lease。
- Go初次命令误用嵌套路径且默认Go缓存写权限拒绝，未形成测试；纠正工作目录并使用既有 `/private/tmp/flywheel-FLY-2551-go-build`、`...-go-mod` 后取得缺方法/结构体红测，再实现。focused与最终完整 `go test -race -count=1 ./...` exit0（最终root6.490s/browser6.926s）。覆盖同session身份、错self、cleanup失败、prepared lease竞争、真实私有HTTP、无cookie不构成登录证明。session/browser为明确fixture，未访问真实账号。
- Root provider-client新增严格account投影，从同一kernel-verified Unix连接调用；包含cookies/xsec_token等未知字段、非boolean登录状态均拒绝。新account方法测试先因缺方法红，再通过。
- 新 `XhsAuthorityRegistry.proveAccount` 只接受project/lead选择器和由Unix入口提供的peer UID，先匹配root registry再通过私有client观察账号。founder/canonical/thread/bot/policy版本全部来自root配置；登录态、账号ID/instance/generation、binary/schema分别匹配，epoch不可低于root base或本进程已观察值。epoch长期防回滚仍依赖provider持久化epoch store，未把内存高水位冒充跨重启证明。
- Registry9项先缺模块红后通过；最终XHS26文件/290项全部通过（31.69s），teamlead tsc、4文件Biome、两仓diff-check通过。尚未跑Node→Go→真实fake-browser完整组合，当前registry测试的private client是synthetic adapter；实际`accountStatus`生产factory路径已接，但host/private UID/账号验收未做。
- 下一步准备服务/authority-main实际装配、当前activation归属、真实read资源token provenance、provider登录二维码与其余9读保留、可信XHS卡短回复、孤儿恢复/root QA签发、全仓gates/评审/两仓PR和host/UI/platform证据仍未完成。没有生产/host/账号动作。

## T4 真实准备账本与审核卡协调（2026-09-15）

- 新 `XhsWritePreparation` 将严格草稿输入→registry账号证明→受控resource/artifact解析→freezeWrite→真实store.prepare→完整deliverReview串起来。模型只能提交操作/payload与handle/ID，不接account、approved、founder、任意目的地或媒体路径/hash；服务生成proposal UUID、15分钟expiry与8位challenge。
- 新store私有 `preparedRequest` 从作用域内prepareRequestId恢复原proposal/frozen/expiry/supersedes；服务重试用原ID、期限对规范化内容做一致性核验，内容改变拒绝。已完整送达的原卡重开DB后不再发送；partial delivery保留awaiting_delivery，同一proposal可重试。并发相同请求在单service内合并，不同内容同key拒绝。
- 新请求在与insert相同的BEGIN IMMEDIATE事务中执行固定(peerUid,project)限额：最多3条未过期待处理proposal、滚动10分钟最多3条新请求。失败送达保留配额预留；同prepareRequestId重试不新增配额。限额在媒体读取/Discord发送前执行；取消不重置滚动窗口，重启不重置账本。
- 明确红测：preparedRequest/协调器缺失；初版hex challenge含0/1不符合已有preview alphabet导致随机prepare_invalid，定位既有校验后改为32字符alphabet均匀生成；第4条请求曾错误发卡，加入持久quota后拒绝。未放宽preview校验、未skip。送达持久化使用完成时的当前时钟，不复用发卡开始时间。
- 6项准备测试覆盖完整送达未自动批准、重启/内容冲突、伪造字段/未观察target、partial cleanup后同proposal恢复、并发合并、持久quota与窗口恢复。fixture用真实SQLite与实际deliverReview，registry/resource/Discord为明确synthetic adapters，不是实际Discord或provider资源证明。
- 最终XHS全模块27文件/297项通过（64.09s），teamlead tsc、4文件Biome、diff-check通过。实际authority service/main入口、current activation绑定、真实read/token来源、provider登录/完整9读、可信卡短回复、孤儿恢复/root QA、全仓gates/评审/两仓PR及host/UI/platform仍未完成；没有生产/host/账号动作。

## T6 launchd socket 继承边界（2026-09-15）

- 新 `scripts/xhs/xhs-authority-launcher.c` 接收 launchd 的 Ingress/Authority 两个监听器，各要求恰好1个。专用非root UID下工作，拒绝实际/有效UID或GID分歧；先复制两fd再映射fd3/fd4，支持来源反序，不因dup2覆盖另一入口。固定绝对Node/entry/config argv、清空继承环境、umask0077，不执行shell、不提权、不读取凭据。
- socket所有权应由launchd在降权前配置：本机 `launchd.plist` manpage明确提供 SockPathOwner、SockPathGroup、SockPathMode 与 launch_activate_socket。此实现让服务不必加入模型组，也不必由服务进程chgrp。plist、root安装器及其真实权限验收仍待完成，不能把本批当作已安装。
- 新 `inherited-listeners.ts` 采用固定fd3/fd4，仅在helper核对两条实际内核socket路径后启动HTTP。不bind、不unlink、不修复权限。helper每次执行前校验文件类型/权限与SHA256；完整root不可写祖先检查仍由startup loader承担，launcher pin尚待加入root config装配。
- 红测先证明模块缺失。真实Darwin socket测试随后发现 getsockopt(SO_ACCEPTCONN) 返回 ENOPROTOOPT，改用本进程 proc_pidfdinfo 的内核socket信息；实际Node继承后server.address()返回null，故路径核验由原生getsockname完成，未删除核验或接受未知路径。
- 原生fixture创建两个真实Unix监听器，再exec实际Node/tsx入口。验证反序fd路由、同fd与TCP拒绝、互换路径拒绝、helper摘要错误拒绝、两个HTTP入口分别响应、幂等关闭且原socket文件保留。fixture运行在测试UID，既非真实launchd激活，也非独立UID/生产host证明；没有账号或生产动作。
- 最终XHS全模块28文件/298项通过（44.14s）；teamlead tsc、两文件Biome、C编译（-Wall -Wextra -Werror）通过。完整repo lint/build/package gate、exact-head CI/review、双PR与host/UI/platform验收仍未做；实际authority-main/运行时读写装配仍未完成。

## T6 root policy 与 launchd 配置生成（2026-09-15）

- root policy新增必填launcher pin与ingressGid。launcher与entry/密钥/socket等受保护路径不能别名，也不能落入artifact/provider可变目录；loadAuthorityConfig在读取私有凭据前通过既有readImmutableFile核验launcher root所有权、祖先、执行权限和SHA256。未安装的测试环境未声称通过真实root loader。
- ingressGid必须与serviceGid分离且不能是admin组；实际 `/usr/bin/id -G <modelUid>` 结果必须包含入口组，服务supplementary groups仍只允许专用serviceGid。组内其他成员审计属于未完成的独立安装/主机QA，不由这个成员检查冒充。
- 新纯函数 `renderAuthorityLaunchd` 输出固定com.flywheel.xhs-authority标签、_flywheel_xhs业务身份、固定launcher→Node→entry→policy参数、清洁环境、0077 umask、两个launchd listener及30s启动节流。Ingress root:ingressGid0660，Authority serviceUid:serviceGid0600；不使用登录Aqua环境或TCP监听。参数按XML转义，无shell拼接；生成函数不写系统文件、不安装、不启动服务。
- 测试先证明旧schema拒绝新launcher/ingressGid且缺launcher仍被接受，再实现；生成器测试先缺模块红。Python标准plistlib独立解析生成XML，验证含空格/ampersand路径无损、参数数组、socket所有权/mode/不同组及环境；root业务UID、共享/admin入口组、相同socket与不规范路径拒绝。focused20项通过。初次Biome报控制字符regex/global escape命名，改等价字符码检查与xmlEscape，无忽略规则。
- 实际部署文件写出/root安装器、socket元数据与独占组成员检查、authority-main/当前activation/真实read-token资源/完整9读/双runtime装配及host/UI/platform验收仍待完成；未执行任何主机安装或账号动作。
- 最终XHS29文件/301项通过（53.97s），teamlead tsc及4文件Biome通过。未运行完整repo gate或exact-head CI/review；本批不改变implement尚未完成的状态。

## T6 装配前合同核对：执行必须携带原回执与操作（2026-09-15）

- 对照plan §7.1发现已实现executor的请求只含proposal/digest/requestId；虽然其内部读取真实批准账本，但缺少批准设计要求的调用者receiptId与operationId。没有将此差异裁成新的API设计。
- 新红测在真实已批准SQLite proposal上发送旧三字段请求，实际得到attempt并执行provider，故失败；修复后strict请求必须含UUID receiptId和六写之一operationId。每次executionRecord读取后均核对原receiptId及冻结operationId，包含首次prepare前、prepare后的复核和已有attempt重放。claim使用经核对的调用者receiptId，不默默替模型补上账本回执。
- 负例覆盖缺两字段、单独缺任一、其他有效UUID回执、其他合法写动作，均0prepare/0commit；已有unknown attempt上的错回执/错操作也拒绝，正确请求重开DB后仍只返回原attempt、不会重复写。真实Unix HTTP/原生peer/账本/permit组合fixture同步补完整合法请求，仍成功且只提交一次。provider及Discord仍为此前明确fixture，未执行真实对外写。
- 最终focused executor+execution-record+provider-client共3文件/21项通过（7.30s），teamlead tsc通过。此次未重跑全XHS或全仓aggregate，上一全XHS结果仍仅对应4856cbd96（29文件/301项）。主入口/当前activation/读token/两runtime/完整9读/root安装器/host QA/整仓门禁/review/双PR仍未完成。

## T4/T6 多scope通知路由装配（2026-09-15）

- 新 `createFounderNotificationRouter` 连接既有真实通知账本、审核卡记录和root registry。通知ID只能选当前待发送账本事件；project/lead从该行取得，频道/guild必须同时匹配原已送达审核卡及固定root registry，digest也必须一致。没有默认频道、任意URL、模型指定目的地或缺失scope fallback。
- router对root输入做快照并拒绝重复scope；同频道复用私有transport。目的地变更或卡证据缺失时抛固定route不可用，既有worker保留pending并记失败次数，继续其他scope；不执行provider、不消费写回执。
- 新3项先缺模块红后绿，使用同一真实SQLite账本的两个项目/不同频道，证明正确分流、旧卡不被重定向、失败不阻断其他项目、伪造event拒绝、重复scope拒绝与调用者修改配置不改变快照。审核manifest和发送端为明确synthetic fixtures，此处仅验证路由；不把它计为真实Discord发卡、完整审核或host证明。
- focused notification-router/notification-worker/notifications共3文件15项通过（5.57s）；完整authority-main、共享频道跨scope分页协调、current activation、真实read-token来源、双runtime及完整9读、root安装器/host QA/全仓gates/review/双PR仍未完成。
- teamlead tsc、两文件Biome、diff-check通过。本轮没有全仓aggregate或exact-head CI/review证据，没有生产/host/账号动作。

## T4/T6 共享频道多scope扫描装配（2026-09-15）

- 新 `createChannelFounderObserver` 为同一频道创建一个XhsMessagePagination和各scope独立XhsFounderInbox。每条消息先经过所有符合initialCursor的scope，全部成功/ignored后才让分页器提交游标；同UID/project/lead重复项、混合频道/guild拒绝。初始扫描用最早scope起点，但每个scope仍保留自己的起点。
- 页面读取前后、每个scope处理前后比对policy快照。任何scope失败或policy漂移都不推进当前消息；重启恢复已持久化pending列表，已处理scope可以再走既有幂等observer，不跳过尚未处理scope。
- 新测试先缺模块红再实现。真实SQLite、真实分页器与inbox组合覆盖同消息两scope、第二scope失败时游标不动、重开DB重试同消息且不重新拉页、配置漂移、重复scope及各自initialCursor。消息源是普通消息fixture；此组合不把先前scope重复调用冒充真实Discord批准重放，批准幂等性仍由既有observer测试单独证明。
- 首轮channel-observer/pagination/observer共3文件29项通过（9.43s），teamlead tsc通过；随后只补各scope起点测试，运行共享频道协调器文件4项测试通过（1.47s），两文件Biome/diff-check通过。主入口、周期生命周期、current activation、真实read/token、双runtime、完整9读、root安装器/host QA/整仓gates/review/双PR仍未完成。

## T4/T6 周期任务与关闭排空（2026-09-15）

- 新 `startAuthorityWorkers` 装配15s各频道observer与5s通知poll，首次立即执行。每个任务独立防重入，慢/失败频道不阻断其他频道或通知。没有provider/execute能力；失败保留原组件的持久cursor/outbox，后续轮次重试。
- close发共享AbortSignal、清理所有interval并等待已启动Promise完成，重复close共用同一结果；不自行关闭SQLite，主入口必须在drain后关闭账本。通知worker现接signal，已完成发送仍记账，但不再启动下一条。共享频道observer在page/scope边界检查停止信号，不推进部分处理消息。
- 调度器先缺模块红；两项关闭负例分别实际红（停止后多发第二条通知、scope中途停止却推进游标），最小修复后绿。测试用fake timer配真实SQLite/通知worker，验证15s/5s节奏、单频道阻塞时其他任务前进、失败频道下proposal按时expired且claim拒绝、close等待精确held Promise且之后无新轮次。
- 最终3文件12项通过（4.77s）。测试不启动launchd/provider或真实Discord；异步请求完成上限仍由底层transport负责，本调度器不通过丢弃在途Promise伪造关闭。实际authority-main/HTTP入口/账号与token来源/两runtime/full9reads/root安装器/host QA/整仓gates/review/双PR仍未完成。
- 首轮tsc发现调度callback停止分支缺显式return（TS7030），补return undefined，保持原停止语义；正在复核类型检查，未将首轮失败报绿。
- 修正后teamlead tsc exit0，六文件Biome及diff-check通过。本轮未运行全仓aggregate/exact-head CI或review，无production/host/账号动作。

## T6 authority 公开写入口（2026-09-15）

- 新 `createWriteIngressHandler` 只接受固定 `/v1/write/prepare|execute|status|cancel` POST；先通过真实native peer helper核对允许modelUid，再读取最多256KiB、严格UTF-8/无重复key的JSON。请求只携带project/lead/activation选择器与input，不接caller-supplied authority identity；root/lifecycle scope解析结果必须匹配实际peer和选择器。私有provider-admission/mint等入口不挂载，UID header不参与授权。
- prepare把外层已核对project/lead注入既有preparation，拒绝草稿内scope替换；execute交给绑定当前context的既有executor；status/cancel直接使用真实store的scope检查。响应只投影已有公开字段；错误固定write_ingress_denied，不透出底层secret/error。180s总时限和客户端断开传播AbortSignal；主入口仍须为executor factory提供持续复核current activation的scope实现，不能把此处一次入口核验当作整个执行期的证明。
- 初次缺模块红；真实Unix HTTP与编译C peer helper测试证明status/cancel、错kernel peer即使带真UID header仍拒绝、私有route拒绝、project/activation替换与额外身份字段拒绝、prepare错误不泄漏。补真实executor+SQLite组合：旧缺回执请求0provider prepare，合法请求先consume再commit，重放结果相同且1prepare/1commit。provider与scope/preparation为明确fixture，非实际Go/Discord/独立UID或生产环境。
- 初轮tsc发现当前Zod record需要key/value两schema（TS2554），改显式z.string()/z.unknown()并补非空草稿转发检查；最终ingress4项通过（4.78s），teamlead tsc通过。真实authority-main/认证current activation来源/受控artifact上传与token资源/完整9读/两runtime/root安装器/host QA/整仓gates/review/双PR仍未完成。
- 最终完整XHS模块33文件317项通过（48.65s），teamlead tsc、两文件Biome与diff-check通过。该结果只覆盖XHS模块，不是全仓aggregate、exact-head CI、代码评审或主机/平台验收。

## T6 provider 子进程生命周期（2026-09-15）

- 新 `startGuardedProviderProcess` 在已经通过loadAuthorityConfig的专用UID上下文中工作；本适配器再次核对实际UID/GID与binary/config pin。只spawn固定binary和 `-guarded-config <固定文件>`，无shell、继承secret或任意环境；cwd固定 `/`，stdio忽略，返回精确child pid/退出Promise。
- stop仅向仍运行的该child发送SIGTERM，等待close事件；20s未确认退出或非零/信号退出返回provider_stop_unconfirmed，不升级到扫描/杀Chrome、不谎报清理成功。重复正常stop幂等；失败后可再次等待已观察的实际退出。spawn不是readiness，主入口必须继续做私有provider协议/account校验，并监听意外退出关闭写门。
- 测试先缺模块红后实现。编译本地无业务C探针，验证固定argv、NODE_OPTIONS/HTTP_PROXY/HOME不在child环境、错pin不启动、实际进程正常退出且kill(pid,0)已不存在；另一个精确探针返回7，stop必须拒绝。principal不匹配在spawn前拒绝。3项通过（1.72s），teamlead tsc通过。
- fixture使用当前测试UID与测试目录；完整root所有权/祖先/组/QA验证仍由尚待主入口调用的loader承担，未把此fixture冒充独立UID/真实Go服务/Chromium清理或host proof。20s超时分支本批未单独执行；没有真实账号/生产provider/host安装动作。authority-main/当前activation/真实读token/完整9读/双runtime/root安装器/host QA/整仓gates/review/双PR仍未完成。

## T6 provider 私有协议就绪（2026-09-15）

- 新waitForGuardedProvider连接既有私有client.account投影，启动最多30s、暂未监听按250ms重试；严格匹配root预期账号/instance/generation、epoch下限、binary/schema/guardProtocol。配置使用快照；观察到绑定不符立即拒绝。
- 监听精确child退出及owner取消，Promise race即使某个adapter迟迟不返回也结束等待；结束清理timer/listener。loggedIn=false只表示读/登录通道ready，不替代prepare阶段的真实自有账号证明或批准回执。
- 初次缺模块红，随后就绪与进程共2文件6项通过（3.19s），teamlead tsc、两文件Biome/diff-check通过。就绪测试用明确private-client fixture，未进行真实Go/账号或host测试。
- T6依赖发现：本分支缺少2519的lead-capabilities目录，实时PR1191尚OPEN。问题871fd61b-5a54-4466-bbea-56d5a6cb84b1获Lead裁定：以集成当刻精确head做stacked依赖，禁止复制/重写；plan/PR标depends on FLY-2519 @ SHA；broker相关chunk仅在1191合入后落地，再按届时授权将chunk同步main并移除pin。继续独立工作，不以等待终止goal。

## T6 经Lead裁定的2519依赖集成（2026-09-15）

- 依据答复871fd61b-5a54-4466-bbea-56d5a6cb84b1，fetch当刻FLY-2519精确head e9eb59e422d2440fbe48c625568984fad4e0cc1a，正常merge到本分支，merge commit 34cd51f6571f06a835693dcfc3affad12047bddd，无冲突、无force-push、未复制/改写上游broker。计划已记录 `depends on FLY-2519 @ e9eb59e422d2440fbe48c625568984fad4e0cc1a` 及必须等待1191合入的依赖chunk落地限制。
- 新源 `lead-capabilities/runtime-context.ts` 的assertActivationCurrent会重读registry并调用validateLeadCarrierAuthorization，且在process probing后再读registry；后续父transport装配必须保留这条链，不从authority公开请求推断当前activation。
- pnpm install --frozen-lockfile exit0（24workspace，新增19个锁定包），未修改lockfile。合并后重新执行pnpm -r build；合并前模块测试不代表本次merge head通过。尚未请求代码review/开PR/交付QA或执行host动作。
- 合并head34cd51f6571f06a835693dcfc3affad12047bddd上pnpm -r build exit0。2519 runtime-context/xiaohongshu-provider/xiaohongshu-tokens/upstream-write-denials共4文件15项通过（6.52s）。它们证明依赖基线仍保持现有校验/写拒绝，不代表2551已接通双runtime。
- 最终合并后XHS全模块35文件323项通过（59.47s）。源码未因集成手改；本批新增文档记录pin/裁定/验证结果。未运行全仓lint/package aggregate或exact-head CI/review，尚不能完成implement。

## T6 parent 到 authority 的固定Unix客户端（2026-09-15）

- 新XhsAuthorityClient固定四个action到 `/v1/write/...`，scope在构造时复制且严格限制project/lead/activation；native peer确认serviceUid后才发送任何HTTP正文。无TCP/代理/重定向fallback、无自动重试。调用者必须先验证root-owned socket/helper策略，并传2519真实parent assertActivationCurrent；客户端本身不把env/model文本当批准。
- 在连接前、peer核对后发送前、响应后调用current检查；请求256KiB、响应64KiB、严格UTF-8/JSON与各action固定响应schema，额外token字段拒绝。未知结果统一authority_request_unavailable且不重发；最终handler必须将写入后的不确定结果按unknown/status恢复处理，不能映射成安全重发。
- 测试先缺模块红；真实Unix HTTP+C peer helper3项通过（3.96s），覆盖构造scope被外部修改不改变请求、三次current检查、错peer/发送前失效0HTTP、执行断线只1HTTP及secret-bearing扩展拒绝。current回调与authority响应是明确fixture，尚未接入runtime-factory真实carrier链；不将此称为双runtime parity。
- 剩余包括root客户端策略加载、2519 handler/catalog/factory接线与共享读token迁移、authority-main/账号读9项、Claude facade、host/root安装及全仓gates/review/双PR。FLY-2519 exact pin与1191先合入的约束继续有效。
- teamlead tsc exit0、两文件Biome/diff-check通过。本批未重跑全XHS或全仓aggregate/exact-head CI，无生产/host/账号动作。

## T6 2519 parent 的root策略工厂（2026-09-15）

- 新createParentXhsAuthorityClient只读取root-owned公开authority policy、pinned provider config、native helper和root签名acceptance，不读取bot/permit key/ledger/cookies。实际process UID必须是policy modelUid，入口组必须在其groups中且serviceGid不能共享；scope必须唯一匹配root registry。
- factory核对root创建的ingress socket及所有祖先：root不可写目录、socket root:ingressGid0660、无symlink；验证QA回执绑定configDigest和provider binary/schema。每次client.current重读同digest policy/provider配置、proof和socket元数据，避免安装/策略漂移后继续发请求。
- 已直接调用2519 createLeadCapabilityContext(env).assertActivationCurrent并传入authority client三次current检查链；env复制，activation由parent构造参数提供。本工厂仍待runtime-factory显式注册，未改变现有默认写拒绝或读取路径。
- 新测试先缺模块红；scope/principal/组/flag/伪造字段和不可信策略输入拒绝，与真实client传输及既有runtime-context测试共3文件17项通过（9.12s）。未建立root-owned正向安装fixture，未声称factory完整host正向通过；纯scope测试的principal是明确输入fixture，实际factory使用process.getuid/getgroups。
- 仍需handler/catalog/factory启用路径、authority-main/共享token和完整9读、Claude facade、root安装器/隔离host探针/整仓gates/review/双PR。2519 exact依赖pin和1191合入前不得落地的约束保留。
- teamlead tsc、两文件Biome、diff-check通过。本轮未执行全仓aggregate/exact-head CI或review，没有生产/host/账号动作。

## T6 绑定回执的只读恢复查询（2026-09-15）

- authority ingress status新增严格可选查询形状：proposalId+receiptId+contentDigest+operationId，复用真实store.executionRecord核对原批准和冻结操作。普通proposal status及cancel仍保留原严格形状；绑定查询不消费回执、不调用executor/provider，输出仍是原安全status投影。
- 新测试先得到403而期望200（4绿1红），最小实现后验证正确绑定可查，分别替换receipt/digest/operation均403且0provider调用。随后真实executor+SQLite完成一次写入，再关闭dispatch门，查询仍返回同一成功attempt且总commit=1。provider和scope为明确fixture，Unix HTTP/native peer使用真实本地实现，不冒充host隔离或平台写入证明。
- 最终ingress/client聚焦2文件8项通过（10.38s）。首次tsc发现Zod union结构类型收窄不足，已用boundStatusSchema显式解析修复；最终类型检查结果另记。尚未接线六写handler/catalog/runtime-factory；authority-main/共享token/9读/Claude/host安装及整仓gates/review/双PR仍待完成。没有实际host/账号/生产操作。
- 最终teamlead tsc exit0；两源码文件Biome及git diff --check通过。本批无全仓aggregate/exact-head CI或review结论。

## T6 六写handler与只读reconcile（2026-09-15）

- 新createXhsWriteHandlers只生成六个冻结写operation；新输入严格为proposalId/receiptId/expectedContentDigest。operation从注册key取、executeRequestId沿用broker context.requestId，模型不能覆盖payload、operation或scope。旧有效upstream输入仍founder_write_gate_absent；client=null同样固定拒绝。
- authorize保留2519真实createLeadCapabilityContext与assertActivationCurrent调用链、parent scope/activation/context.assertCurrent及取消校验。client只由parent传入，工厂尚未注册到运行时，不将普通对象当已验证root策略。共享authority响应schema用于拒绝额外字段。
- execute仅一次authority调用；失联/无效响应/未完成状态返回unknown。reconcile只调用上一批的绑定status，核对proposal/digest，映射已存在attempt，绝不execute。成功仅succeeded/succeeded-noop；failed拒绝，其他状态保留unknown。安全输出不含token或payload。
- 新测试先缺模块红；handler4项通过。与现有默认19写拒绝/真实authority-client/ingress回归共4文件13项通过（7.61s），teamlead tsc、3文件Biome通过。handler测试明确mock carrier与authority；其他本地Unix fixture证据不等于端到端双runtime/host证明。
- catalog尚未支持新输入，运行时尚未注册，因此本批不声称真实broker已放行。接线需处理catalog ZodObject接口及Codex proxy对runnerOperations的extend调用，保留旧输入拒绝并加入真实broker/receipt恢复测试。剩余authority-main/共享token/9读/Claude/root安装与host QA/整仓gates/review/双PR不变；2519 exact pin与1191先合入约束继续有效。

## T6 catalog回执输入与真实broker/proxy（2026-09-15）

- 六个现有operation的catalog输入新增严格二选一：receipt形状或原upstream形状，混合内容/残缺回执/坏摘要均拒绝；旧输入的handler拒绝语义未改。receipt schema抽到无运行时依赖的共享文件。catalog接口允许对象输出的ZodType；Codex proxy仅对原runnerOperations做ZodObject检查后extend，其他operation照常嵌入envelope并导出JSON Schema。
- 真实catalog+LeadCapabilityBroker+SqliteJournalStore测试先receipt schema拒绝红，最小修改后通过：第一次authority execute丢响应→unknown；同requestId重放仅一次status→成功；再次重放无调用；改digest拒绝input_digest_conflict。authority/carrier仍明确fixture，不把broker级测试冒充真实服务/Discord证明。
- 新MCP InMemoryTransport测试验证proxy公开expectedContentDigest/anyOf、不公开xsec_token，完整receipt输入原样转发，混入feed_id在dispatch前拒绝。初次误用Discord响应夹具被XHS输出schema拒绝，改为正确XHS安全响应；未放宽生产校验或断言。
- 最终catalog/handler真实broker/default19写拒绝/proxy共4文件24项通过（8.67s）；teamlead tsc、6文件Biome、diff-check通过。本批未改运行时工厂，默认现有provider尚未切换。下一步root策略client与handler装配，及authority-main/共享token/9读/Claude/root安装与host QA/全仓gates/review/双PR。2519 exact pin及1191先合入约束保留。

## T6 默认运行时装配六写authority路径（2026-09-15）

- startLeadRuntimeProviders现在固定尝试 `/Library/Application Support/Flywheel/Xhs/policy.json` 的createParentXhsAuthorityClient，不接收模型/环境指定的替代路径。缺失、关闭或验证失败仅令六写使用client=null的固定拒绝。验证成功的客户端交给六写handler；其余13个upstream写拒绝保留，delete_cookies仍unclassified_write。
- 外层既有current/lifetime AbortSignal包装保留，关闭后execute/reconcile不能继续。没有启动/安装authority，也未给模型读取私密ledger/key/cookie权限。此处的原read provider尚未迁移，不能声称完整9读/共享token/双runtime已完成。
- 装配测试先旧denial handler不认识receipt形状而红，最小装配后通过默认拒绝、固定路径/当前scope传给工厂、启用后写客户端一次调用、delete_cookies拒绝及关闭后0额外调用。工厂与其他provider使用明确替身，root策略完整正向host证明仍缺。
- 最终runtime-factory/handler真实broker/parent-policy/client共4文件22项通过（7.99s）；teamlead tsc、两文件Biome通过。未执行全仓aggregate/exact-head CI/review或任何host/账号写入。
- 下一步补prepare/status/cancel对模型API及其authority映射，之后authority-main/共享token与artifact迁移/9读/Claude/独立UID安装与host QA/整仓gates/review/双PR。保持2519 e9eb59e4精确依赖及1191先合入约束。

## T6 准备请求的显式账号意图（2026-09-15）

- plan7.1的accountSelector确定为稳定accountUserId字符串。authority preparation现在要求此字段，私有registry.proveAccount先建立真实账号，再将selector与证明结果精确匹配；selector不能产生/覆盖账号权威。匹配前不解析目标、不查询媒体、不生成或发送批准卡。
- 缺字段prepare_invalid，错账号write_scope_unavailable；错误账号同时携带无效resource/media的测试仍先返回scope拒绝且0卡，正确账号走原准备流程。输入canonical已含selector，原并发/replay冲突规则保留，冻结数据仍来自provider证明账号。
- 测试先7红（旧schema拒绝新增必需字段），最小实现后7绿（1.97s）；未放宽旧断言。该处registry与Discord transport仍是fixture；实际账号与host证明尚未完成。公开prepare/status/cancel handler及Bridge routes仍待装配，未声称全路径已可用。
- 最终preparation/registry/ingress共3文件21项通过（6.05s），teamlead tsc exit0；两文件Biome/diff-check通过。本批没有全仓aggregate/exact-head CI/review或host操作。剩余范围与2519 e9eb59e4精确依赖/1191先合入约束不变。
- 328bc183f提交前的最终Biome实际报告链式调用格式差异（上一条Biome通过结论提前写入）；随后仅格式化测试并重跑两文件Biome exit0，格式修正单独提交。行为测试/tsc证据不变。

## T6 prepare响应丢失后的只读恢复（2026-09-15）

- 公开prepare装配前发现broker未知回执不能重新调用prepare（会再次涉及卡片交付）。新增store.preparedStatus按原project/lead/prepareRequestId查已有行并核对完整WriteIdentity，只投影proposalId/contentDigest/state/expiresAt/cardRef；cardRef仅完整preview可见，无payload/回执许可/token。
- 既有 `/v1/write/status` 增加严格 `{prepareRequestId}` 查询形状；不存在或混合proposalId等字段拒绝。该分支不调用preparation/executor/provider，不发卡、不消费。parent client在发送前固定选择对应prepare响应schema，其余status响应schema不变，仍拒绝额外secret字段。
- ingress新增测试先403红，client新增测试先严格schema拒绝红；最小实现后真实Unix/native peer/SQLite查询与旧执行路径通过。初次tsc暴露ProposalRow未声明已有preview_manifest_json列，已补齐类型；无数据库迁移或新表/消费者。
- 最终ingress/client/store共3文件29项通过（8.75s），5文件Biome通过。peer实际本地内核查询，authority响应/账号scope为明确fixture；没有端到端Discord/host证明。公开prepare/status/cancel handler/catalog仍待接线；后续authority-main/共享token+artifacts/9读/Claude/Bridge routes/root安装与host QA/全仓gates/review/双PR保持完整范围。
- 最终teamlead tsc exit0、git diff --check通过。2519 e9eb59e4精确依赖/1191先合入约束保留；未运行全仓aggregate/exact-head CI/review或host变更。

## T6 公开prepare/status/cancel能力（2026-09-15）

- catalog新增xiaohongshu.write.prepare/status/cancel；prepare与cancel为write，status为read。共享输入schema拒绝scope注入、任意路径artifact以及payload中的token/products；payload复用冻结协议字段，operation仍只六写，accountSelector稳定ID。broker envelope requestId映射prepareRequestId，不允许body改写。
- 新management handler注册到真实parent runtime，与六写共用root验证后的authority client及activation/lifetime守卫。prepare把不透明artifactHandles/resourceHandle映射authority artifactIds/targetHandle；authority仍按自身store验证，受控媒体导入及read token迁移尚未装配，不能将当前Lead artifact路径直接当作可发布媒体。
- prepare未知回执reconcile只status按原prepareRequestId查；cancel未知回执只查proposal状态，只有已终结/已开始状态返回结果，仍待取消状态保持unknown。status响应核对proposalId；客户端不可用固定拒绝；transport不确定返回unknown。均不生成批准或调用原raw MCP写入口。
- 测试先缺handler模块红，后真实broker未注册catalog红；实现后真实broker+SQLite确认prepare一次、status恢复一次、成功持久化后无第三次调用。注入/陈旧activation/默认拒绝、取消只读恢复通过；authority/carrier为明确fixture，未冒充端到端Discord或host证明。
- 本轮5文件35项通过（6.10s）：management/runtime-factory/upstream原19写拒绝/catalog/Codex proxy；命令中的contracts.test.ts不存在，Vitest未执行该项，实际冻结测试为canonical.test.ts，另行补跑。teamlead tsc、8文件Biome、diff-check通过。
- 原upstream快照测试现在只比较捕获的upstream行，明确排除新增本地xiaohongshu.write.*；runtime fixture也不把本地status伪装成upstream provider工具。原真实read adapter来自UPSTREAM_TOOL_ROWS，无该重复注册问题。
- 剩余authority-main/受控artifact导入与共享token/full9reads/Claude facade/Bridge固定routes/root安装+host QA/整仓gates/review/双PR；2519 e9eb59e4精确依赖及1191先合入约束保持。没有host/账号写入或QA dispatch。
- 补跑canonical.test.ts 50项通过（0.908s）。两次focused运行分别保留收据，不称为全仓aggregate或exact-head CI/review。

## T6 整仓集成检查与authority activation边界（2026-09-15）

- 在552a9d77b功能head运行pnpm -r build，所有workspace构建exit0。pnpm lint初次exit1：本任务较早5个文件格式错误（4个import组空行、permit JSON缩进），已仅格式修正；JSON解析值与git HEAD逐项相等，签名/canonical文字没有变化。随后pnpm lint exit0，保留18条现有warning，不把warning当错误或清空无关代码。
- authority-main装配审计：root registry只有project/account/founder，plan2.2明确leadId/activationId仅归属且登录UID全不可信，现有scope callback却需要current activation。已向Lead登记问题0414d8ee-a17e-4509-a671-039fb53d1948，拟将真实2519 current校验留parent、authority固定请求归属至claim/permit并核对root/账号epoch/generation；不擅自信任登录UID可写teamlead.db或创造自签角色授权。当前问题pending，非blocked；独立整仓验证持续进行。
- 本批没有服务安装/启动、实际账号操作或QA dispatch。provider/authority主入口及真实scope/token/媒体/9读/Claude/Bridge routes/root host QA/aggregate/review/双PR仍待完成。保留2519 exact pin与1191先合入的约束。
- 最新XHS全模块回归37文件332项通过（56.04s），不是teamlead全包或全仓package aggregate；lead-capabilities接线测试沿用前轮各自收据。全仓lint/build和本次XHS回归均非最终PR exact-head CI/review。
- Lead答复0414d8ee-a17e-4509-a671-039fb53d1948确认上述plan2.2解释：ingress activation仅请求归属；真实2519 parent是current activation唯一权威；authority固定归属到claim/permit，consumed scope不能换activation，独立验证account/epoch/generation/root config，连接取消终止每个尚未dispatch操作。明确禁止model-writable文件、登录UID可写teamlead.db或自签authority。后续按此接线，尚未声称已实现该完整装配。

## T6 activation归属传递与消费后不可替换（2026-09-15）

- 按Lead0414d8ee-a17e-4509-a671-039fb53d1948裁定，ingress scope回调新增已解析的activationId归属字段；明确注释kernel UID/root registry建立scope，真实parent建立current activation，authority固定归属至claim/permit。仍验证resolver返回UID/project/lead/activation与请求完全一致，不从body拿批准、账号或current权威。
- 新入口测试先缺activation字段红，最小修改后通过；固定resolver返回归属不匹配仍403且0executor调用。加强既有真实SQLite executor重启测试：消费后跨expiry、跨requestId、跨activation重放仅返回旧unknown结果，账本attempt.activationId仍activation-a，provider prepare/commit各1次。未修改旧消费/重放逻辑。
- ingress/executor/private provider-authority共3文件18项通过（7.75s），teamlead tsc、3文件Biome/diff-check通过。scope resolver仍为fixture；真实authority-main resolver及取消后的完整服务收尾尚待装配，不能声称已完成Lead裁定的全部接线。
- 下一步从root配置与私有账本派生authority scope并装配主入口；其余媒体/token/9读/Claude/Bridge routes/root host QA/aggregate/review/双PR与2519 exact pin/1191先合入约束不变。无host/账号写入或QA dispatch。

## T6 provider回调从真实账本恢复固定scope（2026-09-15）

- 新store.pinnedDispatch只从consumed proposal和claimed/dispatch-admitted/dispatched attempt读取原activation；重算冻结digest，终态/不存在/未消费返回null。无公开路由、无新表或新保留消费者，不能由provider请求传入替代activation。
- createPinnedDispatchScope对loader已验证root配置取快照，调用方必须传root配置/生命周期重验；校验唯一project/lead、modelUid、policyVersion、provider实例/账号/generation、epoch下限、binary/schema/protocol，返回root founderConfigVersion/keyId及原attempt归属。实际当前账号/epoch继续由provider独占lease校验，私有admission回调不重入account()产生lease死锁。
- 新测试先缺模块红；真实SQLite approve→claim→重启后仍返回原scope，未claim不返回；root开关/账号/epoch/schema漂移、current失败及AbortSignal均拒绝。root配置与current回调为明确fixture，尚未接入authority-main的实际root文件重验。
- dispatch-scope/admission/provider-authority/store共4文件41项通过（12.36s）；teamlead tsc、3文件Biome/diff-check通过。下一步主入口连接该resolver与实际listener/provider生命周期、入口root scope、token/media/9读；Claude/Bridge/root host QA/aggregate/review/双PR未完成。2519 pin/1191先合入和Lead0414d8ee裁定保持；无host/账号写或QA dispatch。

## T6 authority持续root配置检查（2026-09-15）

- 新createAuthorityConfigCurrent仅在loadAuthorityConfig成功后使用，复制已验证配置；每次按原digest读取固定root policy和provider配置，重新读取root acceptance并用原public key/configDigest/provider binary/schema校验签名。任何缺失/变化/坏UTF-8/签名失败统一authority_configuration_changed，不接受新的请求pin或current身份来源。
- 新测试先缺模块红，使用真实Ed25519签名证明每次校验及分别替换policy/provider/acceptance失败；文件读取层为明确mock。与既有真实本地trusted-files和boundary-acceptance测试共3文件15项通过（2.57s），teamlead tsc、两文件Biome/diff-check通过。
- 此checker尚待authority-main传给scope/observer/lifecycle；不是启动器、不是root安装正向证明，也不替代provider自己的二进制与账号lease校验。主入口、token/media/9读/Claude/Bridge routes/root host QA/aggregate/review/双PR未完成；2519精确pin/1191先合入与Lead0414d8ee裁定保留。无host/账号写或QA dispatch。

## T6 私有provider断连取消缺口（2026-09-15）

- 服务装配审计发现private provider-authority只监听IncomingMessage.aborted；请求体已完整消费后的peer断连不触发它，仍在等待的scope/token任务收不到取消。新增真实Unix请求测试：在scope屏障处断开客户端，等待服务端socket close，断言signal.aborted；旧实现稳定false（3绿1红）。
- 最小修复监听ServerResponse.close并在finally移除监听，与现有timer/req.aborted共同驱动同一AbortController。不改变permit/approval/账号校验，不发重试。未准入attempt在断连时仍claimed，既有check会拒绝继续准入。
- private provider-authority/ingress/executor共3文件19项通过（11.10s）；两文件Biome/diff-check通过。测试使用真实native peer/Unix/SQLite，scope任务为屏障fixture，不宣称全部provider/browser进程已收尾或host QA通过。
- authority-main及其root scope/配置checker/provider/listener/worker实际装配仍未完成，媒体/token/9读/Claude/Bridge/root安装验收/aggregate/review/双PR范围不变。保留Lead0414d8ee和2519 pin/1191先合入约束，无host/账号写或QA dispatch。
- 最终teamlead tsc exit0；本批未重跑全仓lint/build/aggregate或exact-head CI/review，前轮整仓检查不当作未来PR结论。

## T6 authority请求处理器实际组合（2026-09-15）

- 新createAuthorityHandlers将真实XhsAuthorityRegistry、XhsWritePreparation、XhsWriteExecutor、pinnedDispatch scope、公开ingress和私有provider handler组合。入口以kernel peer/root registry证明账号后只复制WriteIdentity字段；activation仅沿用请求归属。executor scope固定该次证明，后续只重验root/current，不在lease期间再次account()。
- prepare在root enabled关闭时拒绝；媒体从私有artifact store读取冻结hash对应字节，token/媒体/prepare前后重验current和signal。私有provider scope只读原账本attempt，token适配器仍需实际私有read来源，不能由public请求构造。主入口尚未调用此组合，专用bot/媒体导入/账号token读取的实际adapter仍待完成。
- 测试先缺模块红；使用真实registry/executor/SQLite及fake provider，捕获HTTP handler选项，证明一次account证明、一次prepare/commit、私有回调保留原activation且lease内0额外account()。HTTP factory/root current为明确fixture，没有声称真实服务监听或root-host正向证明。
- 组合/registry/pinned scope/executor共4文件20项通过（4.39s），teamlead tsc、两文件Biome/diff-check通过。余下主入口/provider启动收尾、token/media/full9reads/Claude/Bridge routes/root host QA/aggregate/review/双PR不变；2519 pin/1191先合入与Lead0414d8ee裁定保持。无host/账号写或QA dispatch。

## T5 私有feed读取首条完整路径（2026-09-15）

- Go fork `e4e6ca4`新增POST `/v1/read/list_feeds`，仅内核peer认证后的私有socket可达，严格空JSON输入。与写prepare共用账号lease，在同一个controlledSession的pipe page执行上游FeedsListAction；返回account/upstream/data供可信authority后续投影，不向模型开放原始token。
- 读取前后证明self account，复核持久epoch与cookie路径；90s上下文同时绑定请求和service取消，输出data上限196608字节。只有精确会话清理成功才返回成功；清理失败保留账号排他占用。已有写lease返回account_busy，任何失败只返回固定非秘密code。
- 新真实私有Unix HTTP测试先得到404红（exit1）；接线后定向race通过（3.837s），覆盖一次读取/零写、错误或读取后变化的账号、service取消、上游错误、清理失败、写lease保留与非法额外输入。浏览器页面操作为session fixture，此处不是实际平台/专用UID正向证明。
- Go fork全套`go test -race -count=1 ./...` exit0：main6.586s/browser13.275s/downloader2.731s/xhsutil2.697s/xiaohongshu3.403s。尚待TS私有client/result投影、其余读取/QR及共享token来源，完整9读迁移没有完成；authority-main/Claude/Bridge/root host QA/review/双PR继续保留。
- 根仓库`pnpm test:packages:run`于09:15:32Z开始，冻结head `2fa4cb934236312be613ed4e66d922e03f586f91`，回执目录`/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-gP4NB4/summary.json`；递归build于09:16:38Z exit0。最后读取时summary无finishedAt、packages为空，首包日志尚无最终统计：aggregate未获结论，不计green或PACKAGE_GATE_RECEIPT例外。外层日志`/private/tmp/fly-2551-package-aggregate.log`；原执行session handle在压缩中丢失，未因此重复启动。

## T6 私有feed客户端及清单补录（2026-09-15）

- `5d4f7c124`新增XhsProviderClient.readFeeds：固定私有路径、native peer验证、空输入、预先复制expected account/epoch/generation/provider pins；严格响应校验并逐项与expected比较。仅此读取允许较大的有界响应，data仍受196608字节和count一致性限制，account/permit/status等原8192字节上限保留。raw token只返回authority私有调用方，尚未接入公开读API或opaque handle投影。
- 新测试先缺readFeeds红（1红8绿），随后真实Unix/native helper的9项provider-client测试通过（4.64s）。teamlead tsc、两文件Biome和diff-check exit0。浏览器为HTTP fixture，不代表Go真实平台或host边界验收。
- 本次发现target adapter当前仅接收policy/handle，未收到入口activation归属；下一步共享资源映射须明确沿入口作用域传递归属、绑定account/epoch/feed，不能以新Map或模型传token代替真实读取证明。准备/执行的跨activation语义仍遵从Lead0414d8ee：原消费attempt的归属不可替换，parent负责current activation。
- Lead对报告`2679018f-cf6a-4d1e-a72b-5f2f9ca62665`的回复明确限制host容量：当前gP4NB4允许跑完或关闭，此后实施批次仅focused+lint/tsc/build；最终PR exact-head CI为aggregate记录，开PR前host full最多一次。已接受，未重启或额外启动全包测试。
- gP4NB4首包flywheel-claude-runner于09:27:50Z exit1：控制台1项失败（kill-path inventory，718实际vs711登记）、1339通过、2skip、另有onTaskUpdate错误；机器receipt记failed=3，保留两者差异，不使用RPC-only例外。扫描的7个遗漏均属本分支：5个QA测试清理/探针，2个直接owned child调用（native peer helper/provider进程）。核对作用域后按现有生成器补录，未改分类算法或放宽断言；`a55f4c40b`定向5项inventory测试通过（5.83s），Biome/diff0。
- aggregate仍继续后续包，lsof确认原日志writer仍存活，不能由局部修复改写原红回执。由于本轮源代码已前移，此运行也不作为后续PR精确head证据。此前文档push两次GitHub500后第三次普通push成功（8db9dbbf2）；未force-push。余下主入口/full9reads/QR/token/media/Claude/Bridge/root host QA/review/双PR未完成。

## T6 feed资源归属与准备解析（2026-09-15）

- `937435d0a`补齐prepare内部activation归属：ingress从已校验外层context注入，拒绝草稿内activationId覆盖；preparation严格要求非空字段并传给target(policy,handle,activationId)。这只是资源归属，不是authority判断current activation或mint批准；Lead0414d8ee与原consumed attempt不可转移语义不变。
- 新XhsReadResources由authority持有一个固定project/lead/UID/policy/account/epoch/generation/activation范围，调用私有readFeeds后复核provider绑定，复用2519 XiaohongshuTokenHandles投影token和URL副本，仅登记根feed已观测句柄。target和token解析共用此映射；未读取、跨范围、未知评论目标、root/lifetime失效和关闭均拒绝。token解析期间0网络调用，不在写lease里调用account/read，也不从冻结文本恢复token；restart后的重新读取接线仍待实现。
- 初始ingress/prepare两项红证明归属缺口，新resource模块测试先缺模块红。ingress/preparation/authority组合15项通过（5.52s）；resource/client11项通过（6.44s）；新增close/cancel后resource+既有2519 token投影4项通过（1.83s）；最终preparation含缺失归属守卫+resource11项通过（2.07s）。tsc首次发现unknown收窄错误，改为显式return denied后exit0；6文件Biome/diff0。
- resource测试使用fake私有provider响应及真实token投影/SQLitefixture；private-client的Unix/native peer测试单列，未声称这是一条真实browser→模型端到端链。类尚待authority实际读路由/作用域缓存与main生命周期装配，当前只证明feed目标，reply还需comment详情读取绑定。
- gP4NB4仍有活跃日志writer；最新summary保留claude-runner失败，其后comm/config/core/edge-worker/gemini/github/linear/QA/release/slack包已通过，尚无总终态。继续遵守Lead host容量限制，不再启动实施中aggregate。剩余full9reads/QR/media/Claude/Bridge/root host QA/主入口/review/双PR均未完成。

## T6 authority读取入口与父客户端接线（2026-09-15）

- `bef1fa923`让既有kernel peer/root scope ingress接受固定POST `/v1/read/list_feeds`，仅严格空input；读取结果仅返回有界text投影，不调用prepare/execute。createAuthorityHandlers内部创建XhsReadResources缓存，上限64个作用域，读取刷新LRU，淘汰/close销毁token和target记录；prepare target与private token回调使用同一缓存。移除外部target/token注入项，私有token回调再次核对原consumed scope且不联网。
- XhsAuthorityClient新增固定list_feeds动作：发送前拒绝非空input，保持native peer与三次parent current检查；读取响应单独256KiB传输上限和196608字节text约束，旧写/状态响应64KiB上限保留，额外字段仍拒绝。尚未修改实际模型runtime的upstream读handler来调用此动作。
- 初始ingress/组合2项红（403/缺readFeeds），父client新增动作单项红。实现后ingress/authority组合/resources共12项通过（8.58s），client/root policy/写管理11项通过（4.35s）。单独重验组合1项通过（0.775s），配置失效与close用独立条件断言；teamlead tsc及6文件Biome/diff均exit0。
- 组合使用真实registry/executor/store/resources、fake private provider和捕获的HTTP factory；测试证明读取得到的private-token只在同一已消费scope的private回调出现，lease期间无额外account/read，公开投影没有该token。Unix/native peer的入口及client测试单列；不宣称完整真实browser→broker、Discord批准或root-host正向验证。
- 下一步模型读handler接入该父client、其余8类读取/QR/comment proof与authority-main/provider/listener/worker生命周期。媒体、Claude facade、Bridge routes、root安装验收、review与双PR仍待完成。gP4NB4尚无终态，保留已知红回执及后续10包绿；Lead host容量限制和2519 pin/1191-first/0414d8ee裁定不变。

## T6 模型运行时feed读取迁移（2026-09-15）

- `4040aaf4e`新增createXhsAuthorityReadHandlers，只有受信authority client存在时覆盖xiaohongshu.list_feeds。严格作用域/输入与前后current检查，固定list_feeds调用，保留authority resourceHandle原值，不进入旧MCP token映射器；复用既有untrusted/read receipt输出schema和secret检查。authority错误只返回unknown，不回落旧MCP。
- runtime-factory将该handler合入XHS读map再注册，保留缺少authority时的现有读能力。handler测试先缺模块红，运行时接线测试先旧handler返回unknown红；接线后发现测试错误地比较原AbortSignal对象，源码证实运行时使用请求+生命周期的复合signal，改为验证收到AbortSignal且close后确实aborted，不改生产取消行为。
- 最终runtime-factory/专用read handler/既有upstream-read共3文件16项通过（3.70s），teamlead tsc及4文件Biome/diff exit0。既有27读测试覆盖无authority分支；新分支是mock provider/client的运行时装配证明，不是完整专用UID/browser/Discord/broker正向验收。
- 尚未完成的迁移依赖已核实：startLeadRuntimeProviders仍先启动裸MCP会话；其余读取仍用旧provider与旧token映射，不能解析新authority句柄；deriveAuthorityClientScope仍因enabled=false拒绝客户端。最终需完整迁移9读/QR/comment proof，处理迁移后关闭写门时的读能力及旧MCP退休，不能将单个list_feeds覆盖称为完整read parity。
- 主authority入口与生命周期、媒体、Claude facade、Bridge routes、root host QA、review/双PR仍未完成。gP4NB4最后日志仍在teamlead包，先前红回执不改写，不启动新实施aggregate；2519 pin/1191-first与Lead0414d8ee保持。

## T5 六类私有读取与读写开关分离（2026-09-15）

- Go fork `2879318`已推送：新增search_feeds/get_feed_detail/user_profile/list_collections/get_collection_content/list_saved_content六条私有路由，复用list_feeds原账号独占/readInSession生命周期，保持读取前后self/epoch/cookie复核、90s取消、196608字节结果上限及清理失败不释放账号。controlledSession直接在已有pipe page调用对应上游只读action，不创建旧browser或写dispatcher。
- 私有输入采用全部字段展开的规范格式（authority下一步负责默认值），64KiB JSON上限、严格字段、重复键/UTF-8/空值检查、数量范围和枚举校验；token仅限私有请求，输出只限private authority，不能直达模型。新Unix HTTP六路由各先404红；负例又分别抓到筛选枚举子串匹配、Go将nested null解为零值两个缺口，修复后定向race覆盖PrivateReads/PrivateFeedsRead/GuardedAccountStatus/GuardedService通过（4.151s），gofmt/diff-check通过。未运行新full aggregate。
- 这些测试用fake read session核对路由、账号排他、close与写dispatcher计数0；真实action调用由编译绑定，尚非真实平台/专用UID正向证明。TS private client/资源投影/public ingress/模型handler尚未接这六类，QR仍待实现；不把新增Go端点称为完整9读迁移。
- 收到并落实Lead对报告`5cb95089-5cff-44ac-9759-77f604142c25`的RULING：读能力从不受founder write gate限制，enabled=false仅决定write prepare/execute。`bd37971fb`移除parent transport scope的enabled拒绝项，保持所有root配置/签名/UID/组/registry检查。authority写开关逻辑未移除。
- parent-off测试先红；扩展真实authority组合的enabled=true/false两组，false下read projection成功、prepare抛write_gate_closed、execute denied且0lease/0commit。parent policy/authority组合/runtime共18项通过（5.60s），tsc及4文件Biome/diff exit0。原有测试重排仅为双参数覆盖；没有将读取资格变成写授权。
- gP4NB4的82344/82655/82949仍持有日志句柄，summary无终态，保留最初claude-runner red和后续10包green。下一步六类TS接线、QR/未登录读scope、旧MCP退休及authority-main；媒体/Claude/Bridge/root host QA/review/双PR仍未完成，2519pin/1191-first/0414d8ee及host容量限制保持。

## T6 六类私有客户端规范请求（2026-09-15）

- `d95a94358`新增provider-read-contract及XhsProviderClient.read，固定七个已实现的私有读取操作；将搜索filters/limit、详情评论选项和收藏limit展开为Go要求的完整字段，严格拒绝额外参数、非法枚举/数量/路径型ID/控制字符及坏token。raw token仅在authority→private provider请求中使用；没有添加模型传token的入口。
- 原readFeeds改为复用公共私有read通道，同时保持其typed结果。全部读取在连接前复制预期account/epoch/generation/provider pins，逐次验证kernel peer、结果绑定、数据schema/数量一致性与196608字节上限。详情同时核对外层feed_id与note.noteId等于请求目标；其他动作不改变写commit/status/account的原限额。
- 新六操作规范化测试先缺read红；最终provider-client完整10项通过（4.75s），使用真实Unix/native helper与fake HTTP provider验证完整wire字段、所有六条固定路由、无效输入零发送、错note目标拒绝及旧写/状态回归。不是新Go endpoints/真实Chromium的端到端证明。
- teamlead tsc exit0。Biome初次拒绝控制字符范围正则，改为等价字符码guard并补控制字符ID负例，最后3文件Biome/diff exit0。未启动新aggregate；gP4NB4仍由原进程持有日志、summary无终态，原red继续保留。
- 下一步read-resources对六类结果的投影和comment/feed/user句柄绑定、public ingress/client/model handler接线；需处理Go noteId别名及空xsecToken字段，不可直接把这些结果送入仅支持根feeds的当前mapper。QR/未登录scope、旧MCP退休、主服务入口/生命周期、媒体/Claude/Bridge/root host QA/review/双PR仍未完成。Lead读写开关RULING、2519pin/1191-first和0414d8ee保持。

## T6 noteId与空token投影（2026-09-15）

- `032e190b9`扩展现有token mapper识别noteId/note_id，同时将它们纳入同对象唯一ID检查。Go零值空token字段被移除且不生成句柄；混合空/非空token别名、短值/null、冲突ID和预置resourceHandle继续拒绝。
- 新测试先出现2项红：noteId不被识别，且与id冲突时未被拒绝。最小修复后token mapper/read-resources/既有provider共7项通过（2.82s），teamlead tsc、2文件Biome、diff-check均exit0。未启动aggregate。
- 此改动仅解决投影前置条件；六类结果到资源类型及comment/feed/user授权的绑定、公有入口与模型接线仍待实现。没有把空token或noteId本身当作授权来源，未声称完整读取迁移、真实host或端到端验收。

## T6 搜索与收藏资源绑定（2026-09-15）

- `6beb697b5`新增资源层readList固定四操作（search_feeds/list_saved_content/list_collections/get_collection_content），在调用私有provider前严格规范化参数，拒绝模型提供raw token。与readFeeds共用响应投影及账号/provider/取消/current检查，响应schema与count一致性再次验证。
- 仅普通feeds根行的id或集合notes根行的noteId可登记为feed写目标；嵌套用户句柄不能用作feed目标，空token行不获句柄。集合目录本身不登记写目标。token只从私有读取结果提取，写租约中不新增读取。
- 新readList测试先缺方法红。资源层、authority组合、token mapper共14项通过（1.94s）；覆盖四操作、默认参数、raw token/非法ID零provider调用、嵌套类型冒充、空值、关闭、读取后账号/provider变化、坏count、取消/current变化均不获写目标。teamlead tsc及4文件Biome/diff exit0。provider为mock，组合测试为真实store/registry配fake provider；不代表真实浏览器或专用UID正向验收。
- 下一步公有ingress/client及模型handler四操作接线，并完成detail/comment与user来源证明。QR/未登录scope、旧MCP退休、主服务生命周期、媒体、Claude/Bridge、root host QA、review/双PR仍待完成；不启动新的实施aggregate，现有原始红回执与Lead限制保持。

## T6 四类读取公有接线（2026-09-15）

- `7b562f3b2`将search_feeds/list_saved_content/list_collections/get_collection_content接入固定公有read路由、父authority client及模型handler；authority装配委托同scope的readList。读取输入在client/ingress严格规范化，拒绝额外token；结果沿用有界text投影与untrusted receipt，前后current/取消/peer/作用域检查保留。authority失败不回落旧MCP。
- 三层新增测试先红（client未知动作、ingress403、模型仅1项）。修复后Unix/native peer边界与模型handler共18项通过（5.85s），runtime/authority组合15项通过（2.55s）；teamlead tsc、10文件Biome与diff exit0。真实运行时装配证明四操作转发到authority，组合enabled=true/false均可读取，关闭写门仍拒绝prepare/execute且零写lease/commit。
- Unix测试使用fake authority回包，组合使用真实registry/store/resources与fake private provider。仍不构成完整真实Chromium/专用UID/Discord批准的端到端验收，也未移除旧MCP启动依赖。下一步detail/comment、user来源证明及对应公有接线；QR/未登录scope、旧MCP退休、主服务生命周期、媒体、Claude/Bridge、root host QA、review及双PR均未完成。未启动新aggregate，既有red和Lead限制保持。

## T6 详情评论来源绑定（2026-09-15）

- `41a73a031`新增资源层readDetail及不含token的严格输入schema。必须以同scope已观察的feed句柄匹配feed_id，再仅向private provider传token；双重核对响应外层feed_id与note.noteId、账号/provider、current/取消。详情空token时保留原feed句柄，有新token则登记新句柄，模型响应不含raw token。
- 评论及subComments逐层验证noteId属于该feed、comment id与userInfo.userId有效，以私有映射记录完整feed/comment/user目标和对应token句柄；回复token解析只接受完整匹配的既存记录。句柄映射有512上限，递归深度32，输出196608字节；全部校验通过后才提交评论映射，close清空。不从模型请求或冻结内容生成评论授权。
- 初始缺readDetail红；实现时测试抓到Zod复制评论后句柄未写回响应，改为返回并挂回投影树。随后增加新/空token两组，首次新token夹具仍硬编码空字符串造成红，纠正夹具后资源层15项通过（0.705s）。此前资源/provider-client/authority组合26项通过（4.41s），最后源码变化只涉及详情句柄登记；teamlead tsc及最终3文件Biome/diff exit0。
- 负例证明错feed/未知句柄/模型token在private read前拒绝，跨feed评论、畸形评论、账号变化、取消均不登记任何新评论授权，已有feed授权保留。测试使用fake私有provider，不是实际平台评论数据或专用UID端到端验证。下一步详情公有入口/client/model与真实authority组合接线，user来源证明、QR/未登录scope、旧MCP退休、主服务生命周期、媒体/Claude/Bridge/root host QA/review/双PR仍待完成；未启动aggregate。

## T6 详情公有接线（2026-09-15）

- `2934c48f3`将get_feed_detail接入固定公有read路由、父客户端和模型handler。publicReadInputs显式列出六项已迁移读取，详情只接受feed_id/resourceHandle及读取选项，不接受raw token；authority装配必须找到已有scope，不能为未知activation自动创建详情资源授权。
- 三层测试先红（client未知动作、ingress403、handler仍5项）。修复后边界/模型18项通过（3.97s），资源层/runtime/authority组合30项通过（2.14s）；teamlead tsc、10文件Biome/diff exit0。组合在enabled=true/false下均从已有feed句柄读到详情评论句柄，并验证私有provider收到token而不收到resourceHandle；未知activation拒绝，关闭写门时prepare/execute仍拒绝。
- 当前证据由Unix/native peer边界、运行时装配及fake private provider的真实资源组合构成，不代表完整真实平台/专用UID/Discord端到端验收。下一步user_profile来源证明与公有接线，QR/未登录scope、旧MCP退休、主服务生命周期、媒体/Claude/Bridge/root host QA/review/双PR仍未完成。未启动新aggregate，原red、host容量限制及Lead现行裁定保持。

## T6 用户来源调查与URL编码（2026-09-15）

- 当前Go User只保留userId/nickname/avatar，无用户token；UserProfileResponse.basicInfo仅含redId等展示信息，不能证明机器用户ID。仓库定向fixture清单仅有frozen/permit JSON，没有平台profile HTML/JSON证据。未编造页面字段、用户token或捕获成功，也未执行真实账号/浏览器动作。
- Lead对问题`cf4f97e1-97e3-4e7d-950a-faa852013237`裁定：允许受控private profile author-link的userId+token，须绑定结构化观察的用户ID、精确平台origin/path和请求身份；typed用户句柄仅authority内部。不得复用feed token或redId；最多一次有fixture的受控尝试，无确定来源则记录用户目标写的fail-closed缺口，读取不受影响，之后优先QR/未登录scope、旧MCP退休及双PR。当前没有满足该来源条件的fixture，因此尚无可验用户grant；不以合成链接冒充平台来源证明，依裁定转下一优先项。
- 独立修复fork `5caa95a`：user_profile URL从直接拼接改为PathEscape+url.Values，保证user ID与token里的&/#/+/%/Unicode不改写路径或query。初次写测试路径错误导致no tests to run，未当作证据；正确创建后旧实现因未编码路径出现red，修复后定向race通过（1.816s），覆盖两类ID和四类token，gofmt/diff通过并推送。
- 用户资料读取仍未迁移到新authority，无用户目标写授权新增。下一步QR/未登录读取scope及旧MCP退休；主服务生命周期、媒体/Claude/Bridge、root host QA、review/双PR仍未完成。未启动aggregate，原始red与其他Lead限制保留。

## T6 未登录读取作用域（2026-09-15）

- `f746a0c01`将registry.observeAccount与proveAccount分开。前者接受private provider报告loggedIn=false，但保留peer/registry/account/provider指纹及epoch单调检查；后者仍必须loggedIn=true，供prepare和写路由使用。未登录观察不会变成写证明。
- ingress仅按已通过固定路由allowlist的/v1/read路径向内部scope传read用途，其他路由传write；请求envelope不接受purpose字段。authority装配按内部用途选择观察或证明，未改变写开关/receipt/commit守卫。
- 新observe测试先缺方法红；最终registry/ingress/authority/preparation共30项通过（5.09s），teamlead tsc、6文件Biome/diff exit0。覆盖未登录read scope成功而write scope失败、模型purpose注入拒绝、二进制变化及epoch回退拒绝、既有写准备回归。组合使用fake private account观察，不能据此宣称未登录浏览器可读feed或QR登录完成。
- 下一步QR获取/安全输出/登录会话生命周期及旧MCP退休；user_profile迁移与受限来源缺口、主服务生命周期、媒体/Claude/Bridge/root host QA/review/双PR仍未完成。未启动aggregate，Lead cf4f97e1来源裁定及其他限制保持。

## T5 私有QR图片边界（2026-09-15）

- Fork `7fa1813`新增normalizePrivateLoginQR：只接受严格、规范base64的data:image/png，原始与重编码PNG各不超过384KiB、宽高各不超过2048；先读尺寸再完整解码，拒绝尾随字节。重编码移除ancillary metadata；不抓取URL，不接受SVG。
- 缺函数编译red后实现；最终PrivateLoginQR与AccountEpoch定向race通过（2.600s），gofmt/diff通过并推送。QR测试覆盖两处真实像素保留、合法tEXt元数据剥离、非法图片/URL/SVG/base64/超限尺寸/尾随canary拒绝；epoch八项既有测试复核先持久reservation、失败后logged-out和禁止旧cookie回退。没有启动浏览器或真实扫码。
- 已核对现有controlledSession只能载入既有cookie，不支持初始扫码；accountEpoch.replace支持先reserve再obtain/finish。下一步需独立login owner接入QR输出、self身份校验、cookie保存及严格cleanup，再接公有QR/状态与生命周期。当前校验器尚未接入服务路由，不能称QR功能完成。旧MCP退休及其他尚未完成项目、Lead限制保持；未启动aggregate。

## T5 受控登录owner与收尾（2026-09-15）

- Fork `3b08c8c`新增controlledLogin工厂：只启动独立pipe browser、全新page，不接收旧cookie文件，也不实现writePage。部分启动失败仍返回owner交上层清理；Close幂等。obtainPrivateLogin限4分钟，规范化QR后交可信publish回调，等待扫码，再用readSelfAccount核对冻结账号，捕获cookie并复用严格cookie解码，确认Close成功后才能返回给epoch.finish。
- 使用真实epoch store/replace和fake login session的10场景测试先缺函数red；成功路径证明cookie文件在Close后才出现，bad QR/已登录异常/wait失败/错账号/cookie域非法/cleanup失败/publish失败/panic/取消均不持久cookie。panic只给固定错误；关闭失败不会返回cookie。未运行真实browser或扫码。
- 源码核实Rod CookiesToParams会丢弃partitionKey；增加转换前非空/数量/partitionKey/opaque guard，独立缺helper red后验证分区cookie不被降为普通cookie，secure/httpOnly保留。最终ControlledLogin/PrivateLoginQR/AccountEpoch定向race通过（2.904s），gofmt/diff通过并推送。
- 当前owner与收尾逻辑尚未挂到guardedService异步QR路由；下一步须接入epoch.replace、QR会话缓存、cancel/drain及保留cleanup失败owner，再接公开QR/状态。主服务、旧MCP退休、其他未完项及Lead限制保持，未启动aggregate。

## T5 私有QR调度与路由（2026-09-15）

- Fork `7ba7d77`将login owner挂入guardedService，新增仅kernel private peer可用的/v1/read/get_login_qrcode空输入路由。首次无cookie时启动4分钟job，通过epoch.replace持久reserve后开放QR；重复请求复用job。服务锁在worker取得epoch隔离前保持，阻止启动与写prepare竞争；已有active/changing租约不启动新QR。
- job跟踪owner及Close结果，service.Close取消并最多30秒等待，未确认cleanup保留owner且返回失败；QR发布前创建者请求断连会取消job。等待扫码时accountStatus只返回loggedIn=false和新epoch；成功后QR请求重新走实际accountStatus，不复用缓存成功作为登录证明。旧cookie存在则走原accountStatus。失败job保留为fail-closed状态，尚无重试/恢复入口。
- 初始缺字段/方法编译red；GuardedLogin/AccountStatus/GuardedService/ControlledLogin/QR/Epoch定向race通过（3.680s），新增断连测试后GuardedLogin再次通过（2.591s），gofmt/diff通过并推送。真实private Unix HTTP覆盖返回5字段、extra cookie拒绝、prepared write排他；真实epoch+fake login owner覆盖重复请求单次open、扫码前不获登录证明、成功Close后保存cookie、失败owner保留、请求取消。
- 没有真实浏览器/账号动作；目前仅Go私有路由已接入。下一步TS private client处理QR epoch增长及有界图片、公开QR/登录状态和模型接线，随后旧MCP退休；失败登录恢复、主服务及其余未完成项需继续，不把本批作为完整QR或host验收。未启动aggregate，Lead限制保持。

## T6 TS私有QR客户端（2026-09-15）

- `9936a08da`新增provider-client.loginQR，仅POST固定私有/v1/read/get_login_qrcode且body为{}；连接前复制预期绑定，沿用native peer与取消/超时。返回可单调推进accountEpoch，其余账号字段及provider指纹必须精确匹配；禁止有效旧epoch回退。
- loginProjectionSchema区分待扫码与已登录：前者有规范、有界PNG data URI及未来最多4分钟有效期，后者必须image空且expiresAt=0。TS验证base64规范、PNG头/IHDR尺寸/IEND和384KiB限额，私有响应上限540000字节；完整PNG解码/重编码及去元数据仍由固定Go provider执行，不宣称TS重新完整解码图片。
- 新方法缺失red后实现；真实Unix/native helper配fake provider的全部11项测试通过（2.58s），teamlead tsc与最终3文件Biome/diff exit0。新增覆盖QR epoch前进、旧epoch/错账号/错provider拒绝、URL/非PNG/非规范base64/超限尺寸与体积/过期/超长有效期/错误状态组合/秘密扩展拒绝，保留已有写commit与读取回归。
- 尚未挂到authority公有QR/状态或模型handler；下一步处理QR推进epoch后失效旧资源、公开投影及写门关闭下登录读取，再处理旧MCP退休。失败登录恢复与其他未完成项保持；无真实浏览器/扫码，无新aggregate。

## T6 观察到新epoch后的资源失效（2026-09-15）

- `d5ae6332a`新增registry.assertAccountEpoch同步guard，只接受此前通过private观察验证的同provider/account/generation当前epoch；authority资源实例固定身份快照，每次资源current校验同时检查该epoch。新观察即使loggedIn=false也会使旧feed/comment/token grant无法继续解析；不在写租约内增加provider I/O。
- 新guard缺方法red后实现；registry/resources/authority组合28项通过（1.08s）。组合新增epoch观察一度因fake provider成功commit后leased标记未清而红，明确模拟其cleanup完成后再推进epoch；旧read和private token均target_unbound且账号IO计数不增加。最后固定身份快照后组合2项再验通过（0.442s），teamlead tsc及4文件Biome/diff exit0。
- 本批失效由已接受的新账号观察触发；尚未接入公开QR/状态，下一步必须将QR推进后的观察与公开投影接线，不能把私有QR返回自动称为公开登录功能完成。其他未完成项目及Lead限制保持，未启动aggregate。

## T6 authority公开登录投影（2026-09-15）

- `57d955c41`新增readLogin装配与固定公有/v1/read/check_login_status、/v1/read/get_login_qrcode路由，只接受空input，沿用private peer及read scope。状态返回loggedIn；QR仅返回loggedIn/image/expiresAt，不包含account/provider配置。写开关关闭仍可调用这两个读取回调。
- QR调用前验证context epoch，调用后重新通过registry观察私有账号，要求账号四字段、epoch和登录状态与QR结果一致，同时推进registry epoch使旧资源失效。状态每次使用新private观察，不把缓存结果当写证明。
- 测试先因provider mock误放root config导致clone red，纠正夹具后得到readLogin缺方法red；公有路由新增测试另先403红。最后ingress/authority组合13项通过（3.01s），此前registry相关23项通过（4.13s）；teamlead tsc及5文件Biome/diff exit0。真实Unix入口验证凭据输入拒绝和零写调用，fake private provider配真实registry/resources验证enabled=false下QR推进epoch并拒绝旧句柄。
- 父authority client和模型展示handler还未添加这两个动作；这不是完整QR显示或真实扫码验收。下一步这两层接线及旧MCP退休，其他未完成项和Lead限制保持；未启动aggregate。

## T6 父客户端与模型登录展示（2026-09-15）

- `b6f3c1791`将check_login_status/get_login_qrcode加入父authority客户端固定read路由，严格空输入、受限响应与未来最多4分钟QR有效期；沿用native peer/current/cancel检查。模型读取handler从6个扩为8个，QR以MCP image输出，文本只含登录状态与到期时间；输出整体检查可信secret，拒绝URL及响应额外字段，不在authority失败时回退旧MCP。
- 新测试先因客户端未知动作、handler数量及缺QR handler三处红；实现后类型检查发现联合响应不能按image字段可靠收窄，改为固定动作显式解析，未加类型断言。恢复后重新取得最终证据：客户端/模型handler/runtime三个文件25项通过（3.13s），teamlead tsc exit0，5文件Biome与diff exit0。
- 真实Unix/native helper配fake authority及runtime mock验证固定路由、空输入、秘密字段拒绝、过期/超长QR拒绝、状态/图片投影与runtime接线。无真实browser/账号/扫码，无新aggregate。本批不代表完整登录验收。
- 运行时仍先启动旧MCP再覆盖8个handler，user_profile仍走旧路径。下一步旧MCP退休须保留第9个读取能力并遵守cf4f97e1来源限制；主服务、失败登录恢复、媒体/Claude/Bridge/root host QA/review/双PR仍未完成。

## T6 listener 异步请求排空（2026-09-15）

- `b18f08aac`修复 inherited listener close 只等待 socket、未等待异步 handler 的缺口。两入口共享请求跟踪，关闭开始后拒绝新 handler，关闭连接后等待已开始 handler 的 promise 完成；异常销毁响应且仍清理跟踪。生命周期后续才能安全关闭私有账本。
- 真实 C launcher/Unix fd3+fd4/Node 子进程测试先红：响应已结束而 handler 被受控 promise 保持时，close 提前返回，子进程断言退出1。最小修复后同测试与 authority-workers 共3项通过（1.94s）；teamlead tsc、最终2文件Biome/diff exit0。测试确认释放 handler 前close不完成、释放后结束、重复close幂等、两socket文件未被unlink。
- 未启动真实 LaunchDaemon、浏览器或账号，也未运行新aggregate。主入口装配仍缺失，不能把此排空 helper 当作完整生命周期交付。
- 已执行 Lead dfbaf995 来源裁定：acceptance-audit.md 明示 user_profile 暂留旧MCP、保留eager连接、等待独立真实采集；其余八读已有authority handler。无伪造来源fixture，Lead follow-up issue编号尚待提供。

## T6 authority service 生命周期装配（2026-09-15）

- `dc446ae07`新增startAuthorityService，将现有私有provider客户端/固定spawn、readiness、authority handlers、继承listener和后台workers接到同一生命周期。加载后的root config作固定快照；readiness成功后才开放listener。provider意外退出立即使current失效并开始关闭，closed返回固定失败。
- 关闭先撤销handler权限，并行排空listener与worker，再确认provider.stop，最后关闭ledger并清零所持输入key Buffer。排空/停止失败返回authority_cleanup_unconfirmed，保留ledger/key，不冒称清理成功。启动失败亦沿同一清理路径；close幂等。
- 缺模块red后实现。最终service/readiness/workers/真实launcher四文件11项通过（1.86s），teamlead tsc及最终2文件Biome/diff exit0。新service测试使用受控模块替身验证顺序、readiness失败不开放入口、provider意外退出与两个cleanup失败分支；真实Unix listener覆盖仍来自既有launcher测试，不能据此声称service真实运行。
- 主入口仍需加载root配置/私有凭据、打开既有ledger、构造Discord/source/media adapters，再调用本service并接信号退出。媒体导入、Claude/Bridge、失败登录恢复及root host验收/review/两个PR仍未完成；user_profile deferred裁定保持。未启动新aggregate或真实浏览器/账号动作。

## T6 authority 主入口与私有适配器（2026-09-15）

- `1812d709b`新增authority-main固定--config入口和bootstrap：root loader及current先于凭据读取；permit key必须恰32字节，bot token严格UTF-8且无空白/NUL，读取后清零临时token Buffer。只打开已有ledger，应用root enabled，创建artifact validator、固定registry来源及notification worker，再将ledger/key所有权交给service。入口将SIGTERM/SIGINT转为service.close，异常仅输出固定错误。
- 发卡按project/lead及channel/guild/bot/founder精确匹配registry；Discord preflight置于发卡及消息轮询路径，失败不在启动阶段阻断provider读取。每channel轮询先重新观察私有账号，再构造使用持久cursor的observer；通知只用已有root/ledger router。媒体validator使用root pin及私有stateRoot scratch。
- bootstrap缺模块red、main缺文件red后实现；最终bootstrap/main/service/channel-observer/notification-router五文件18项通过（1.61s），teamlead tsc、4文件Biome/diff及包build exit0。bootstrap使用受控模块替身验证配置先于secret/ledger、短key拒绝、root开关传递、固定发卡目标和延迟Discord preflight；main仅子进程验证额外参数退出2且固定错误。未进行真实daemon、Discord请求或账号动作，包build不等于exact-head CI。
- 主入口已调用service，但完整运行/信号主机证据仍缺。媒体导入入口及guild实测附件限额未接；目前仅10MiB硬上限，不能宣称已实现min(10MiB,实测限额)。Claude/Bridge、失败登录恢复、root安装与隔离QA、review/两个PR仍未完成；未启动新aggregate。

## T6 authority 受控媒体流入口（2026-09-15）

- 361fba0b4新增固定/v1/artifact/import二进制路由，使用既有kernel peer证明，严格base64/UTF-8/JSON元数据只含scope、MIME、长度及digest，禁止路径与额外字段。长度最多10MiB；在逐块流上核对声明长度和SHA-256，结束验证通过后才由既有artifact store注册。返回仅FrozenArtifact，无私有路径。
- authority handlers复用原scope解析，导入要求config.enabled、已证明的当前账号epoch；流逐块及返回前校验current/取消/epoch。关闭写能力拒绝导入而既有读取不变。此入口只登记媒体，不执行provider写入。
- 新入口缺模块red，装配测试缺import回调red；最终入口/装配/artifact三文件13项通过（1.40s），teamlead tsc及4文件Biome/diff exit0。真实Unix/native helper+真实artifact store/ledger验证成功回读、digest/长短/额外路径/跨项目/超限/错误UID拒绝和失败文件清理；媒体decoder用受控替身，未宣称完整PNG/视频解码验收。
- parent仍未上传或将model artifact handle映射到authority artifactId；重试/丢响应的稳定映射尚需闭合。guild实测附件限额、Claude/Bridge、登录恢复、root host QA/review/双PR仍未完成。无真实浏览器/账号动作，无新aggregate。

## T6 parent artifact 上传客户端（2026-09-15）

- a1eaa9f8c新增parent importArtifact，复用既有native peer/current/cancel/单次发送路径。仅接受有界非空Buffer与固定MIME；第一次await前复制字节并计算digest。固定binary路由/元数据header，响应最多1024字节，严格核对返回MIME/长度/digest及artifactId，不接收私有路径/扩展字段。
- 新方法缺失red后实现；最终client/真实artifact入口/model读取/runtime四文件27项通过（3.53s），teamlead tsc及最终3文件Biome/diff exit0。测试覆盖调用后修改原Buffer不改实际上传、错误返回digest/超限/空内容/额外path拒绝、错误UID零HTTP；新增真实client->Unix/native helper->artifact store/ledger组合回读相同字节。新媒体decoder仍为替身，非完整媒体/主机验收。
- model prepare尚未调用importArtifact；当前store每次导入随机ID。必须先解决重复上传/丢响应/重启后的稳定ID复用，再把parent controlled artifact handle转换为authority ID，避免prepareRequestId重放因新ID冲突。不得把本批称为完整发布媒体通路。其他验收缺口保持，无新aggregate/真实账号动作。

## T6 保留中的artifact稳定复用（2026-09-15）

- f0bed7b08在既有xhs_frozen_artifact账本内按project/MIME/长度/SHA-256查找候选，无新表或第二套映射。上传仍完整流校验、decoder校验、暂存配额计入；候选私有文件重新校验路径/inode/权限/内容hash后才复用原随机ID，删除本次暂存并释放配额，延长既有7天保留期。lookup到复用/注册之间无await，单authority内首次并发不会登记多个ID。
- 两项测试先红：重复上传ID变化、损坏旧文件被新文件掩盖。最终artifact/retention/真实入口三文件19项通过（1.90s），teamlead tsc与4文件Biome/diff exit0。实际ledger关闭重开、首次并发/重复上传、跨项目/不同内容隔离、损坏候选拒绝、入口两次上传同ID均验证；保留既有全局配额与retention回归。
- 复用仅限仍保留且可验证的artifact；已被合法回收后不能承诺同ID。重复上传依旧需要暂存配额，满额时保留明确容量拒绝，未越过2GiB上限。下一步model prepare读取parent controlled handle并上传转换；其他验收缺口保持，无新aggregate/真实账号动作。

## T6 prepare转换parent受控媒体handle（2026-09-15）

- 41af1bbb1将runtime实际LeadArtifactStore传给write-management。prepare逐个read已登记handle，在当前activation校验后上传有界图片/视频MIME字节，严格比较返回digest/MIME/长度，再按原顺序传authority artifactId；不再把model handle直接作为私有ID。上传前后均验证授权/取消，恢复路径仍只查status、不重复上传。
- 新测试先红（upload调用为空，handle原样传递）；最终management/runtime两文件18项通过（1.21s），teamlead tsc与3文件Biome/diff exit0。真实parent artifact registry配上传替身验证顺序、未知handle/磁盘内容修改/非媒体类型拒绝、错误返回hash及上传后取消均零prepare；既有真实broker恢复测试保持。
- 此层允许video/mp4类型，但实际parent artifact store扩展表还不接受video/mp4，视频受控登记仍未完成。主机完整prepare/publish验收、guild实测附件限额、Claude/Bridge、登录恢复、root QA/review/双PR仍缺；不把本批单元组合当成真实发布证据，无新aggregate/账号动作。

## T6 parent受控视频流登记（2026-09-15）

- cd0bca757新增LeadArtifactStore.putVideo：只接可信parent提供的AsyncIterable字节流，不解释URL/路径；同parent最多一个活跃视频登记，固定10MiB缓冲区防止极小分块放大数组开销，逐块检查current及取消，最长180秒。完成后复用现有put的作用域/摘要/不可变文件登记；video/mp4扩展加入且直接put同样限10MiB，其他既有25MiB上限不变。
- 缺方法两项red后实现。最终parent artifacts/management/runtime三文件26项通过（1.46s），teamlead tsc及3文件Biome/diff exit0。覆盖分块字节保持、跨store拒绝、超限/源异常/空流/URL/预取消/途中close/等待中的取消与并发拒绝均不登记文件。真实parent视频handle进入上传替身并按video/mp4转换为publish_with_video的authority ID。
- 登记接口不证明视频格式有效，完整decoder仍在authority；测试MP4字节仅登记fixture。真实视频生产/输入调用方、完整媒体解码与Discord回显、guild实测限额及root host发布验收仍需继续；其他Claude/Bridge/login/review/双PR缺口保持，无新aggregate/真实账号动作。

## T6 真实媒体两端组合与限额裁定（2026-09-15）

- 本批新增本地真实媒体组合：使用已有实际ffmpeg生成PNG/MP4，先经真实parent artifact登记/read，再由真实authority artifact store调用实际ffprobe/ffmpeg完整解码、入账、回读并重复导入复用ID；截断MP4虽能作为parent字节登记，但authority拒绝且不留新文件。未替换已有单媒体与timeout测试。
- media-validator共9项通过（2.88s），其中真实超时子进程SIGKILL/退出确认仍通过；单文件Biome/diff exit0。此为测试补充，无生产修改，未重复跑类型检查或aggregate。没有Discord、真实账号或独立UID隔离动作，不能视为主机验收。
- Lead cdb6da8d-d754-4c27-9af7-1386a5e9535c要求：authority在root指定的目标guild专用非用户频道upload/readback/delete探针，过期或guild改变重测；缺失/失败/过期回退10MiB且不可更高，激活不因探针失败阻断。本实现仅fake Discord测试，真实探针留QA529。
- 对非root authority无法写root-owned回执的冲突，Lead 42071685-e07d-4b87-8687-13b664c86c30已更正：回执为authority-owned 0600/private stateRoot，绑定root配置guild/probe channel、测量时间和expiry；只能降低限额，独立10MiB上限永不被回执抬高。无privileged writer/helper，缺失/过期/绑定不符回退10MiB。下一步按更正裁定实现探针及缓存，不把裁定当作探针已经执行。

## T6 附件探针与authority私有缓存（2026-09-15）

- 新增measureAttachmentLimit：仅接受不在userChannelIds中的固定探针频道，先后核对所属guild，上传随机10MiB文件，核对回读bot/channel/message/正文/单附件名称长度及SHA-256，删除成功后才返回24小时回执。失败/删除失败无回执；缺失、过期、错绑定、抬高上限或超长有效期回执统一回退10MiB；合法低值只能降低上限。
- 新增XhsAttachmentProbeCache：authority-owned private stateRoot，检查root身份/属主/0700；绑定guild/channel/bot决定固定文件名，使用readPrivateFile读0600单链接回执，临时0600文件fsync/rename/目录fsync写入。并发poll合并，重开复用，过期重测；失败保留保守回退，无提权或root writer。
- 探针和缓存各自缺模块red；最终两文件6项通过（0.456s），teamlead tsc及4文件Biome/diff exit0。使用fake ReviewTransport来源与真实私有文件缓存验证完整探针序列、错误guild/回读内容/delete拒绝、回执边界、并发/重启/expiry和0644回退。没有真实Discord请求，也尚未验证实际DiscordXhsSource的fake HTTP探针组合。
- 当前模块未接入root probe-channel配置、bootstrap后台轮询及有效限额应用；不能声称激活已执行探针。下一步完成这些接线，并继续其他主机/集成/review/双PR缺口；真实探针仍只属QA529，无新aggregate/账号动作。

## T6 探针启动与scope限额接线（2026-09-15）

- ed3c1557e为root registry增加可选probeChannelId；拒绝任何用户频道作为probe，同probe频道不能绑定不同guild/bot。bootstrap按guild/probe/bot合并缓存，独立DiscordXhsSource只用于专用probe；加入已有worker轮询，启动前无probe IO，后续过期由缓存重测。
- AttachmentLimit支持按project/lead解析，bootstrap返回相应缓存限额或10MiB。authority导入流逐块累计并按本次scope限额拒绝，返回前重查；prepare在发卡前解析同scope限额，所有层仍独立封顶10MiB。底层artifact store保留全局硬上限，未知scope拒绝。
- 配置不识别字段red、prepare未解析callback red、bootstrap仍number red后实现。最终config/bootstrap/service/preparation/handlers五文件40项通过（1.43s），teamlead tsc与10文件Biome/diff exit0。验证专用频道约束、后台poll装配、scope低限额零发卡及超限流拒绝；bootstrap probe仍用替身，真实DiscordSource fake HTTP组合与真实QA探针尚待完成。
- 本批接线是source实现，不是实际启动或测量回执；其余Claude/Bridge、登录恢复、root主机QA/review/双PR缺口保持，无新aggregate/真实账号动作。

## T6 Discord探针真实adapter组合（2026-09-15）

- 338bfa633修复真实DiscordXhsSource与探针的两处不兼容：原文件白名单不接受probe.bin，原channelGuild只接受thread。新增仅可信构造器可选的purpose=probe，允许专用文字频道或thread，但只可发送单个恰10MiB的固定探针文件；审核卡默认用途维持原文件/频道约束。bootstrap显式构造probe用途。
- 实际source配fake fetch先两项null red；修复后验证完整GET guild -> POST multipart -> GET message -> 无Authorization的CDN回读 -> GET guild -> DELETE顺序，bot token只到固定Discord API，mentions为空，两用途不能互发文件。
- 审计发现失败缓存每15秒轮询会再次上传，新增失败重试测试先4次而预期3次红；cache加入至少5分钟重试间隔，缓存有效期间仍无额外探针，过期/重启规则不变。
- 最终Discord/source/bootstrap/cache四文件33项通过（0.869s），teamlead tsc与6文件Biome/diff exit0。全程fake HTTP，无真实Discord或账号动作；真实QA529测量回执、独立UID/root主机、Claude/Bridge、登录恢复、review/双PR仍未完成，未启动新aggregate。

## T6 authority 通知投影与投递确认（2026-09-15）

代码 `7e047d317`：新增固定 `/v1/notification/list|ack`，已装入实际 authority handlers 和 parent client。协议仅传 eventId/eventKind/proposalId/receiptId/contentDigest/expiry；不传内容、账号令牌或批准原文。列表最多100条，4KiB请求、64KiB响应、有界超时、严格JSON/字段；Unix native peer 与 root registry 限定范围。通知无需 provider 登录或写门开启；ACK只改投递状态，不消费/延期/创建批准。Bridge 定时拉取与持久邮箱投递尚未装配。

- RED：已有账本通知查询忽略 UID/project/Lead，新增范围测试实际返回外域记录（1 failed / 8 passed）。接口组合测试在新增模块前缺模块红。
- 最小修复：账本查询与ACK加入参数化原始UID/project/Lead过滤；过滤先于LIMIT100。真实 client → authority handlers → Unix native helper → SQLite 测试，写门on/off、provider离线均无需provider调用，重复拉取/ACK、到期、错peer、伪造UID header、未知scope、重复JSON键、额外授权字段和失效policy均覆盖。
- 批量夹具曾两次触发既有按项目/UID刷卡限额；保持生产限额，改为101个独立项目合法提案后验证本scope记录不被外域前100条饿死。
- 最终验证：6文件33项定向测试全部通过，5.05s；teamlead `tsc --noEmit` exit0；Biome8文件无修改/错误；git diff --check exit0。
- 同次范围包含 notification-ingress、notifications、notification-worker、notification-router、authority-client、authority-handlers 测试。临时真实SQLite/Unix socket/native helper；无真实Discord、账号、服务启停、聚合测试或host隔离验收。
- 下一步：Bridge每5s读取非授权通知、幂等入backend-neutral mailbox并在持久收据后ACK，以及Claude固定入口。其余登录恢复、root安装/QA、review和两个PR仍未完成。

## T6 Bridge 持久邮箱通知投递（2026-09-15）

代码 `1952e3bc6`：新增 XhsNotificationPoller，仅持有 notifications/notification_ack 两种调用能力；严格解析整批通知，单实例防重入，先同步持久入队再ACK，失败保留authority outbox下次重放。关闭signal在fetch返回后与每次ACK前检查。未调用provider或execute。统一 LeadInboxRuntime 新增范围校验的 enqueueXhsNotification，复用项目现有 MailboxQueue 及 nudge；无需新StateStore/session-event消费者。

- 队列ID按project/lead/event三元组SHA256确定；实际MailboxQueue去重/墓碑处理。不把通知当作写许可，邮件明确要求查询当前状态；批准已过期或结果未知不可自动重发。
- RED：缺模块；随后真实重启重放失败（ACK未成功），根因默认createdAt每次变化导致mailbox projection冲突。最小修复复用持久记录createdAt，归档记录检查并避免重建；活动记录改内容仍拒绝。Runtime新方法在实现前真实not-a-function红。
- GREEN：两个测试文件44项全部通过，4.54s；teamlead tsc --noEmit exit0；Biome4文件无修改/错误；diff --check exit0。完整lead-inbox-runtime文件40项通过，其既有故障注入stderr不视作现实服务故障。另4项为实际临时CommDB/MailboxQueue、关闭重开、ACK丢失、队列失败、非法响应、取消/重入、跨scope及内容冲突。
- 尚未接入Bridge启动/关闭生命周期及5秒定时器，也尚未建立Bridge专用只读策略client factory；不宣称服务已实际轮询或已通知真实Lead。下一步闭合该装配，然后Claude固定路由和其余运行期/QA/review/两PR门。
- 无真实账户/Discord/浏览器/host变化、无新host aggregate。

## T6 Bridge 通知生命周期装配（2026-09-15）

本批新增 Bridge 专用 notification client factory，复用公共root策略/验收回执/peer helper/socket校验；仅暴露 notifications/notification_ack，运行时拒绝其他action。scope由root registry产生，固定 bridge-xhs-notifications 为投递归属标签，不获取Lead carrier；Lead parent原activation校验仍强制保留。没有私有bot/permit/cookie读取。

实际 plugin 在 leadInboxRuntime.start 后启动服务；每5秒重新加载root策略，无有效安装时保持无连接并下轮重试。单次pass禁止重入，各scope并发隔离，终止signal传至客户端和poller。plugin关闭先await服务close（停timer/abort/等待在途pass），后关闭邮箱。真实Bridge未启动/重启，未做生产通知。

- RED：factory not-a-function；lifecycle缺模块。首次factory夹具不完整mock产生导入失败，修复夹具后取得正确缺factory红。
- GREEN：4文件10项通过，1.02s；teamlead tsc --noEmit exit0；Biome5文件无修改/错误；diff --check exit0。
- 定时器受控测试：缺policy首轮失败、4999ms不重试、5000ms重试、在途不重叠、close取消并等待、不在close后轮询；实际poller组合证明 notifications→enqueue→notification_ack，后续只查空列表。factory mock证明root scopes、通知用途限定和policy失效拒绝；实际Unix/ledger证据见前两批。
- Bridge 通知的源代码装配至此已连接；仍需host/端到端QA证明。下一步Claude固定路由/入口、其余登录恢复和root安装验收，以及完整门、有效review、两个PR。未运行新host aggregate或真实account/Discord/服务动作。

## T6 Claude identity 裁定与请求合同（2026-09-15）

Lead回答 `6fc497dd-c4ad-41cc-ac67-19b15b524eeb`：接受新增窄Claude adapter，不扩大 validateLeadCarrierAuthorization；使用canonical backend=claude-code、identity digest、CURRENT lease generation/holder PID/start liveness及一致history。不读Codex carrier evidence、不伪造bundle、不复用ship，缺证据拒绝写路由且读不受影响。

新增 validateClaudeLeadLeaseAuthorization 在原Codex校验器旁，独立核验canonical摘要、claimed lease key/generation、当前bound row与history的holder tuple/bound时间；活性探针后重读identity和lease。返回仅verified tuple或固定denial，从不采纳off/unprotected/audit_allowed豁免；mode开关本身不能使缺lease通过。不存在lease文件不新建。未改原Codex校验函数或authorizeLeadWrite语义。

新增固定四路径请求parser，复用既有prepare/receipt/proposal schema。只接requestId+input；prepare仅受控handle，execute仅冻结proposal/receipt/digest/operation引用；未知路径/原provider工具/extra授权与scope字段、重复JSON键、超过256KiB拒绝。尚未mount HTTP路由，尚未连接Claude工具入口或媒体；parser不是身份或批准权威。

- RED：adapter不存在两项failed；parser缺模块。随后正向lease测试红因夹具探测writer PID而非其真实fixture holder222/pane-start，修复夹具后通过。
- GREEN：完整lead-lease-enforce43项通过1.40s，包含原Codex/enforce/audit行为；新测试缺lease/错generation/key/digest/死进程/探针异常/探针中registry变化/history tuple不一致及恢复；固定route parser3项通过0.228s。
- comm tsc --noEmit与build exit0；teamlead tsc --noEmit exit0；Biome4文件无修改/错误；diff --check exit0。原文件故障注入stderr与预期一致，不作现实故障证据。
- 下一步 HTTP route identity assembly（Claude用新adapter，Codex保持原parent authority）、共享执行/受控媒体与Claude入口；其余login/root QA/review/两PR仍未完成。无真实lease/账号/Discord/host变化或新aggregate。

## T6 双runtime Bridge write context（2026-09-15）

新增 createXhsWriteContext，供token认证后的Bridge路由调用。严格base64/JSON身份header上限8KiB，仅允许project/Lead/identityDigest及互斥lease或carrier引用。Claude调用新lease validator，绑定digest+lease generation+holder PID/start生成稳定非秘密归属ID；Codex沿用原carrier validator与full-access bundle v2要求，保留parent activation UUID，拒绝processIndeterminate。前后重读完整canonical row，后续assertCurrent比较同一身份/holder；不从header铸造批准，不回传原claim。

新增 createBridgeXhsWriteClient，要求上述server current guard，同时重新核对root policy、acceptance、peer helper、socket及真实UID/groups。scope复制，调用前guard失效就不发送。原parent和notification-only factory语义保留。

- RED：context缺模块；Bridge write factory不存在。GREEN：4文件11项通过0.972s，teamlead tsc --noEmit exit0，Biome4/diff0。
- 本批mock边界覆盖Claude generation drift、Codex activation保留/不确定进程、混合claim/错误digest/额外批准/坏header、root scope快照与current guard。实际lease/Unix/ledger证据在前批，不能把本批mock当真实host证据。
- HTTP handler尚未mount，受控媒体注册与Claude工具入口待接；下一步使用这两个factory及既有固定request parser完成实际请求处理。原六写默认拒绝仍有效；其余login/root QA/review/两PR仍未完成。无真实account/Discord/host/aggregate动作。

## T6 固定 HTTP write handler（2026-09-15）

新增 createXhsWriteRouter，固定四个完整路径，token校验先于raw body解析，严格保留重复JSON键拒绝。调用前创建双runtime context/root-policy client；prepare仅通过调用方提供的当前scope LeadArtifactStore.read读取handle并校验实际bytes/hash/size/MIME，导入authority后再核对descriptor，然后传artifact IDs。execute仅冻结proposal/receipt/digest/operation和requestId；status/cancel仅proposal。每个await后核验current与取消，未知结果只报固定码，不自动重试。

- 本模块必须在全局express.json前挂载。当前已用真实本地HTTP服务器/Express验证，尚未在生产plugin挂载：需要下一批提供Bridge artifact注册/清理生命周期和上传入口，再完成mount。这里的artifacts callback不是已存在的生产registry证明。
- RED：模块缺失；prepare正向断言漏写既有draft默认字段，保留源码规范化并补齐夹具；tsc指出导出Router推断类型不可移植，加入显式Router类型。
- GREEN：routes/request/context三个文件10项通过0.741s；teamlead tsc --noEmit exit0，Biome2/diff0。测试覆盖四动作、受控handle未知拒绝、媒体hash回执不符、身份在RPC后失效、敏感extra响应拒绝、token认证先于坏JSON、duplicate-key与token未配置的零authority调用。
- authority client与identity在HTTP夹具里mock；Unix/SQLite/real media链的前批证据与此分列，尚不能证明真实双runtime端到端/host通过。
- 下一步 Bridge artifact registry/受控上传/lifecycle+plugin mount，再Claude facade；其余login/root安装QA/review/两个PR仍需闭合。无真实account/Discord/host服务变化或新host aggregate。

## T6 Bridge artifact staging registry（2026-09-15）

新增 XhsBridgeArtifactRegistry，复用真实 LeadArtifactStore，按 project/Lead/activation 隔离 handle；媒体只接受字节及四种固定 MIME，单项 10 MiB、全局 256 MiB、最多 64 个 scope。MP4 进入既有 putVideo。输出仅 handle/MIME/size/hash，不返回路径。失败写保留容量预留，直到关闭确认清理；关闭只删除当前实例记录且父目录/目录 inode、设备、UID、权限仍匹配的目录，替换或不确定时保留并报 cleanup_unconfirmed。

createXhsWriteContext 新增 projectRoot()，仅从当前 pinned canonical row 获取绝对真实目录，拒绝符号链接/相对路径/身份变动；后续上传无需接收模型提供的文件路径。

- RED：初始化失败清理测试复现未登记目录导致 close 假成功；将目录 ownership 记录提前到 store 构造前后 GREEN。projectRoot 测试先因方法不存在 RED，再实现。
- GREEN：registry/context/routes 三文件 13 项通过 0.736s，teamlead tsc --noEmit exit0，Biome4/diff0。registry 使用真实临时文件系统与真实 LeadArtifactStore；仅初始化故障通过 mkdtemp 后改权限注入。context 身份来源仍为 mock，不算真实 host/lease 证据。
- 范围：本批只证明进程内注册与正常关闭/失败重试；不能证明进程崩溃后遗留目录回收。生产 binary upload route、共享 registry 的 plugin mount 与 drain/close 仍待接，Claude facade、login recovery、root QA、review、两 PR 仍未闭合。
- 无真实账号、Discord、host 服务或新 host aggregate 操作。

## T6 受控 binary artifact HTTP intake（2026-09-15）

新增 createXhsArtifactRouter，固定 POST /api/lead/xiaohongshu/artifact，鉴权在读 body 前完成；仅四种原始媒体 MIME、无压缩、无 query、非空、最大 10 MiB，最多四个并发流、180 秒超时。无 Content-Length 仍按实际流计数。current identity/root policy/projectRoot 在登记前重新检查，流中身份失效拒绝；registry guard 保持 activation 生命周期，不捕获已结束 HTTP response 的 abort 状态。只返回受控 handle/MIME/size/hash，既不接收路径/URL，也不把上传视为批准。

- RED：缺模块；新增流中身份失效测试发现错误归类为400，改为身份403后 GREEN。二进制图片及 MP4 经真实 registry/LeadArtifactStore 往返；MIME标签不代表解码通过，真实解码仍是 authority 的职责。
- GREEN：artifact routes/registry/write routes/context 四文件18项通过0.989s；teamlead tsc --noEmit exit0、Biome2/diff0。覆盖鉴权、身份、policy、关闭拒绝，空/声明超限/实际chunked超限/压缩/未知MIME/query拒绝，四并发满额拒绝第五个及释放后恢复。使用真实本地HTTP/Express/临时文件系统；身份及root factory为mock，非真实host证据。
- 生产 plugin 尚未挂载。下一步同一 registry 的 write+artifact routers 组合、请求排空/关闭以及 plugin 在全局 express.json 前挂载；之后 Claude facade 与剩余 login/root QA/review/两PR。崩溃 orphan cleanup 尚未证明。
- 无真实账号、Discord、服务重启或新 aggregate。

## T6 Bridge production mount 与异步排空（2026-09-15）

createXhsBridgeWriteService 持有同一 artifact registry 和五个固定路径，上传 handle 直接供 prepare 读取。连接接纳和实际 async handler promise 分别追踪：close 先拒绝新请求、销毁在途连接触发取消，再等真实 handler settle，最后清理自有媒体目录。HTTP close 不等于 handler 完成；清理失败仍保留失败并可重试。raw JSON 解析前的连接也纳入销毁集合。

startBridge 创建服务并通过 BridgeAppOptions 注入，createBridgeApp 在全局 express.json 前挂载；shutdown flag 翻转后首先 await 该服务 close，再走其他关闭步骤。无 apiToken 时传空字符串，保持现有固定拒绝。

- RED：service模块不存在。GREEN：初始五文件20项通过1.43s；随后新增真实 createBridgeApp mount 集成测试，service三项通过8.09s（其中真实stack导入/执行7.676s）。其他四文件18项在本批未变语义的回归中通过。
- 测试证明上传→prepare使用真实registry/临时文件系统；关闭连接后人为保持authority Promise未settle，close必须等待且目录尚在，释放后清理；关闭后新请求503。实际Bridge stack + 内存StateStore验证路由顺序，identity/root/authority仍mock，无真实账号/Discord/host服务操作。
- tsc首次指出config.apiToken可undefined，显式空字符串后teamlead tsc --noEmit exit0；Biome5/diff0。
- 下一步 Claude facade/入口与read cutover；仍需处理login失败与orphan recovery、root安装/QA证据、review/CI/两PR。媒体进程崩溃后的遗留目录回收未证明，本批只证明正常shutdown与在途请求排空。无新host aggregate。

## T6 Claude fixed Bridge client（2026-09-15）

新增 createClaudeXhsBridgeClient，快照启动环境中的 project/Lead/digest/lease key/generation，绑定 canonical lease-key 格式；这些仅为 Bridge 复核的引用。客户端只访问 HTTP loopback 的四个固定 write 路径，拒绝 URL 用户凭证、路径、query/hash、外部host；请求复用严格 parser，不能夹带批准字段。使用现有 TEAMLEAD_API_TOKEN，不读取 authority key、cookie 或 xsec_token。

原生 HTTP 不跟随重定向，无自动重试；请求/响应分别限256KiB/64KiB，180秒超时和可选取消。响应严格 UTF8/JSON（拒绝重复键）及对应 authority action schema；错误仅投影固定状态匹配的拒绝码，其余统一 unknown，内部错误不外泄。

- RED：缺模块。GREEN：客户端4项+固定parser3项，最终7项通过0.450s；teamlead tsc --noEmit exit0，Biome2/diff0。
- 真实本地 HTTP fixture 验证身份快照、固定路径/body、无效目的地/lease/额外批准零发送、secret-bearing/重复键/超限/重定向响应未知且不重试、取消零发送和固定拒绝码。没有调用实际 Bridge、lease 或 authority。
- 入口文件实际位于 packages/teamlead/scripts/claude-lead.sh 与 scripts/lib/mcp-inherit.sh（计划中的路径为该包内相对路径）。下一步 MCP facade + 启动配置，随后受控 artifact producer 与 reads cutover；user_profile 遵守既有 deferred ruling，不伪造 fixture。
- 其余login/orphan recovery、root QA、review/CI/两PR仍未闭合；无真实账号、Discord、host或新aggregate操作。

## T6 Claude MCP facade 与受管启动配置（2026-09-15）

新增 claude-mcp/stdio entry，公开四个 xiaohongshu.write.prepare/execute/status/cancel 工具，使用与 Bridge 同源的 input schemas。MCP 验证请求、固定 action、回执引用与响应，不接受任意方法/额外批准/可变 execute 内容；只转固定错误码。env 快照且 client 延迟创建，缺少 lease 时工具可发现但调用拒绝，不影响协议初始化。

claude-lead.sh 将 flywheel-xhs-write 名称保留，通过 mcp-inherit helper 把构建入口合入受管 MCP 配置；仅 dept/cos 且非 companion/external，缺入口文件不注册。配置只含 Bridge token/身份引用的 Claude 环境占位符，实际 lease generation 在 pane 启动时展开；复用已有 tmux env 传递，不含 authority secret。原始 read MCP 的切换仍单独待完成。

- RED：MCP缺模块；shell helper command not found。GREEN：MCP3+client4+parser3共10项0.634s；新shell角色/缺entry/保留名夹具通过，原mcp-inherit22项通过；shell语法通过。
- teamlead tsc与完整包build exit0（无新全仓aggregate），Biome4/diff0。构建后的真实 stdio child 通过 SDK Client 发现4工具，并在空token/generation下拒绝 cancel 为 founder_write_gate_absent；正常关闭该test-owned child。非真实Claude会话/host激活证明。
- 仍需 controlled media producer、Claude reads切换（user_profile遵守既有deferred ruling），login/orphan recovery、root安装QA、最终review/CI/两PR。原始平台写旁路的真实host关闭证据仍属未完成，不把新增工具当整个安全边界完成。
- 无真实账号、Discord、Lead/Bridge重启或新host aggregate。

## T6 Claude controlled media producer（2026-09-15）

Claude Bridge client 新增 importArtifact，仅四种 MIME/非空/最多10MiB，拷贝调用方bytes后通过固定 binary route 上传，响应严格校验随机handle、MIME/size/hash且拒绝路径extra。与四写请求共用私有有界HTTP实现，仍无redirect/retry，不公开任意URL transport。

新增 claude-media/entry：仅从已打开的 binary stdin 读取，参数只收 MIME，不打开路径/URL。累计上限10MiB、180s timeout与取消，非binary/超限/空/部分被取消内容不上传；成功stdout只有handle descriptor，错误固定码。MCP prepare描述给出受管构建入口的精确位置和stdin使用方式，模型无需把视频塞入MCP JSON。

- RED：client.importArtifact不存在两项失败；stdin module缺失。GREEN：media3+client6+MCP3+parser3，共15项0.822s；teamlead package build（含tsc）exit0，Biome6/diff0。
- 构建后真实test-owned Node child通过stdin输入fixture bytes，向本地fake Bridge发送一次binary请求，返回descriptor后核对hash/size/MIME成功、exit0、stderr空。媒体fixture标签不是有效MP4证明；authority真解码证据沿用前批，不把本批fake响应当真实host批准/外部写证据。
- 下一步 Claude read facade/Bridge read scope切换，保持user_profile既有deferred ruling；随后login/orphan recovery、root QA、最终review/CI/两PR。崩溃遗留媒体回收与真实OS隔离仍待证明。
- 无真实账号、Discord、服务重启或新host aggregate。

## T6 Bridge scoped public read routes（2026-09-15）

新增固定八个 /api/lead/xiaohongshu/read/* POST，复用authority六项public read inputs + 两项login空输入；与prepare共用createXhsWriteContext/current scope，公共root transport scope不检查founder enabled。严格raw JSON、重复键/额外xsec_token拒绝、无压缩、256KiB请求；响应按action schema校验，内容读取256KiB/QR540000字节，QR到期和四分钟上限检查，每次await后重验current。

这些路由加入现有Bridge service的connection/handler追踪并在全局JSON parser前挂载。shutdown读调用返回xhs_read_unavailable，区别于写门拒绝。user_profile依原裁定不注册，execute等任意读action不注册。

- RED：缺read router模块。GREEN：read routes3/service3/parent policy3共9项6.99s；随后真实createBridgeApp fixture新增读请求，service3项4.43s通过。既有policy测试确认enabled=false仍推导合法read scope。
- 真实本地HTTP/Express + 内存StateStore测试验证完整八项映射、scope、token输入/坏JSON/额外响应拒绝、await后current失效，真实stack能upload→prepare→list_feeds；identity/root client/authority仍mock，不能作host证明。
- teamlead tsc --noEmit exit0，Biome5/diff0。无真实账号、Discord、服务重启或新aggregate。
- 下一步 Claude client.read + MCP读投影/QR image与继承切换；user_profile延期边界保持。login/orphan recovery、root QA、review/CI/两PR与crash-orphan证据仍未闭合。

## T6 Claude reads 与 MCP QR projection（2026-09-15）

Claude client.read仅八个固定路径，复用严格read request contract；内容响应256KiB，QR540000 bytes，写类仍64KiB。保留authority resourceHandle，拒绝expired/超过四分钟的QR、任意token输入、未知action；读失败统一availability错误，不作founder授权判断或重试。

MCP现有受管入口新增八个读工具，共12工具。读结果有untrusted/receiptId/observedAt元数据，原始handle不改写；QR以MCP image block输出，文本只含登录状态/到期。user_profile不加入authority facade。

- RED：client.read不存在两项；MCP工具数仍4两项失败。GREEN：MCP4/client8/read routes3共15项0.875s；teamlead package build含tsc exit0，Biome4/diff0。
- 真实构建stdio child可发现12工具，空身份list_feeds固定拒绝xhs_read_unavailable，不暴露user_profile；正常关闭child。native HTTP fixtures与MCP in-memory验证分别成立，无实际authority/账号/host证明。
- Lead ruling3163d0c7-f3f5-4948-b3eb-e6d6b5f44b8f已读并记录acceptance-audit：Claude raw legacy inheritance保持，profile authority cutover/acceptance fail closed，additive facade进两PR，不新增token adapter；旧写工具隔离要求未豁免。此问题已解决，不是pending gate。
- 下一步 login失败与orphan recovery、root安装/QA可执行证据、最终verification/review/CI/两PR；无真实浏览器/账号/Discord/host或新aggregate。

## T5 Explicit login recovery + durable audit（2026-09-15）

Lead ruling ada3c251-b817-4eaf-a094-3f3913d39573允许下一次明确get_login_qrcode请求恢复已失败登录，禁止timer retry，并新增durable audit及三次连续失败上限。本批在fork实现：仅job.done已关闭、tracked owner实际Close完成且无错、当前durable epoch无cookie、account/generation/epoch精确匹配manager且无active lease时解除changing。缺owner、cleanup失败、epoch不符仍拒绝；下一次登录再预约新epoch，旧epoch/墓碑不删除。

每次恢复先以现有私有目录锁/O_EXCL/file+directory fsync写login-retry-N.json（oldEpoch/newEpoch/cause=explicit_login_retry）。readState严格验证该新记录，允许崩溃留下current+1审计但不把它当epoch/cookie完成；坏scope、损坏记录、未确认同步拒绝。连续失败计数按当前service的durable account/generation，第三次失败后第四次QR请求固定429/login_retry_limit；成功登录或真正创建新service清零计数，epoch不回退。

- RED：缺audit方法；第二次明确请求没有打开新login。GREEN：定向race测试2.937s；完整Go根包+browser包race回归分别4.685s/3.934s通过。覆盖审计先于open、重启回读、损坏/sync错误、cleanup/epoch拒绝、第三次上限/私有HTTP固定码、service重建恢复及成功清计数。测试为真实临时文件系统、进程内fake login owner和私有HTTP夹具，无真实平台动作。
- 最初一次测试文件写入用了重复nested路径而失败；随后的go命令显示no tests to run，不计作验证。修正路径后取得上述RED与GREEN。
- fork提交41ff021并推送；root无生产源码变更。gofmt/diff通过，无新host aggregate。
- 审计另发现待处理项：login job对外4分钟期限，但browser/pipe_process.go内部统一2分钟强制生命周期；下一步对齐专用login生命周期并保持write lease界限，再接启动orphan ownership recovery。root安装/QA、最终verification/review/CI/两PR仍待闭合。无真实账号/browser/Discord/host动作。

## T5 Dedicated login browser lifetime（2026-09-15）

修复已发现的期限不一致：普通 LaunchPipeBrowser/startPipeProcess 仍为2分钟；新增固定 LaunchPipeLoginBrowser 仅给受信任的 private login owner 使用4分钟预算。内部预算函数拒绝非正数和超过4分钟值，仍受更早caller context deadline/cancel约束；没有RPC/model配置字段。controlled_login只改到专用入口，write lease逻辑保持。

- RED：bounded-owner timeout方法缺失。GREEN：Go根包/browser完整race回归4.870s/3.997s；gofmt/diff0。新增真实test-owned匿名pipe子进程，在缩短的测试预算到期后被精确owner回收；0/负数/超过4分钟预算均不spawn。源码接线证明login选4分钟、普通入口选2分钟；没有真实Chrome四分钟host证明。
- fork提交d9485d0并推送。无真实browser/account/Discord/host动作，无新aggregate。
- startup orphan仍未完成：parent进程内保留PID/PGID只覆盖正常owner存活，provider crash会失去该保护；现状仍拒绝非空profileRoot。已向Lead登记问题d40b384d-eb00-48f3-88fb-7021cf981703，提出pinned guardian保留未reap child/group、通过anonymous liveness pipe处理parent EOF、durable UID/generation ownership+cleanup receipt；等待架构确认，继续独立installer/acceptance artifacts。不得用PID扫描后kill或全机Chrome扫描替代。
- 最终root QA、verification/review/CI/两PR仍未闭合；本批不是阶段完成。

## 2026-09-15 public launchd listener identity correction

Source ae5a69660 follows Lead c91e5ce1: three public client factories pin listener UID 0 only behind existing immutable root policy/path, registry, provider/helper pins, signed acceptance and current-principal guards. Generic transport permits explicit UID 0 and still requires exact native peer equality. Two factory assertions first failed (450 instead of 0); an actual Unix listener test then failed at the previous constructor UID-zero rejection. After minimal fixes, 16 focused tests across authority-client, parent-client-policy and bridge-client-policy passed (2.68s). A user-owned listener received zero HTTP when expected peer was root; model-owned ingress was refused at construction and recheck. Biome four-file check, teamlead tsc --noEmit and teamlead build exited 0; no new aggregate run. Build ran before commit and is not an exact-head CI receipt.

Local man3 getpeereid and man5 launchd.plist semantics and private-fd4 ruling e6094db9 are recorded in design-correction.md. Private Go/path correction remains next. Guardian approach was approved by d40b384d: fixed child process, unreaped Chromium group, anonymous provider-liveness pipe, hard deadline, exact cleanup receipt; absent/malformed receipts retain nonempty-profile startup denial. Neither guardian nor real host acceptance is implemented by this batch. No real browser/account/Discord/host action.

## 2026-09-15 private launchd fd4 layout correction

Fork ae31eee implements Lead e6094db9: dedicated-group root-owned0750 parent, root0660 socket, full root immutable ancestry, canonical policy path, exact root peer, stable parent/socket identity rechecked around each dial. Provider startup still verifies dedicated principal, signed root policy and pinned artifacts; actual server-side client UID checks are unchanged. TS authority startup now checks the same root-owned private socket layout instead of service-owned0700 ancestry. No self-created private authority listener or UID fallback.

Red evidence: new TS guard import failed before module existed; new Go authoritySocketSnapshot test failed to compile before function existed. An earlier Go invocation wrote a duplicated relative path and printed no tests to run; excluded from evidence. Green: TS private path/config21 tests0.402s plus authority-main1 test0.518s; Go root/browser full race4.436s/4.331s. Directory/socket owner, group, mode, link and ancestor drift cases use explicit metadata fixtures; production factory rejects a real user-owned socket, and a real user listener receives zero HTTP under root-peer pin. Existing native Unix admission/token/response-loss tests remain green with a test-only user-owned fixture factory. Teamlead tsc --noEmit and build exited0, changed TS files Biome and both diff checks clean. Build is precommit, not exact-head CI.

Real launchd fd adoption, outside-serviceGid EACCES and actual root-bound positive connection remain host acceptance work. Provider's own self-created socket must retain a separate service-writable directory in deployment definitions; it cannot share fd4's root-owned directory. Guardian, offline deployment manifests, final aggregate/review/CI/twoPRs remain incomplete. No real host/browser/account/Discord action or new aggregate.

## 2026-09-15 minimal guardian primitive (integration pending)

Implemented the d40b384d-approved fixed C guardian in the provider fork. Contract: inherited CDP3/4, anonymous provider-liveness read pipe5, exclusive empty0600 receipt fd6, startup status pipe7; trusted budget1..240000ms and64hex nonce. It spawns an exact child process group, retains the unreaped leader, waits for EOF/deadline, kills that reserved group, waits, then writes and fsyncs nonce/PID cleanup receipt. No network, process scan, policy selection or host action.

Red: real-process test failed because guardian C source did not yet exist. Green final: cc C11 Wall/Wextra/Werror build through tests; four real-child scenarios EOF, deadline, naturally exited leader retained until group kill, and nonempty receipt refused unchanged before launch. Owned child/descendant disappear; unrelated test process remains. Go root/browser full race4.652s/8.776s, gofmt and diff checks clean. Earlier three-scenario run4.653s/5.928s also green; the final run adds exited-leader coverage. Test cleanup closes the liveness writer and waits for guardian instead of killing its owner prematurely.

This primitive is not yet selected by production: existing direct pipeProcess ownership remains. NEXT add guardian binary pin to both startup schemas, create/fsync durable profile UID/account-generation/inode/nonce identity and receipt, wire provider liveness ownership and CDP handoff, then scoped startup reconciliation only for exact matching completed receipts. Absent/malformed receipts continue nonempty-profile refusal. Guardian death must never lead to a PID scan. No real Chrome/account/Discord/root host launch, no new aggregate. Installation, final verification/review/CI/twoPR handoff remain incomplete.

## 2026-09-15 guardian immutable startup pin

Provider fork7b05617 makes guardian a required startupBinary and verifies it together with provider/browser/ffmpeg/ffprobe before private state access. Root TS provider schema requires the same guardian pin, excludes it from mutable cleanup roots, and loads its immutable root-owned executable bytes against the pinned digest. The provider-config digest already binds this new field into existing signed acceptance. Missing legacy guardian configuration fails closed; no default executable or model-selected path is introduced.

Red: TS strict provider binding rejected the new guardian field; Go test failed to compile because Guardian/verifyStartupBinaries were absent. Green:19 TS configuration tests0.322s; Go focused startup2.271s, then full root/browser race5.693s/10.908s. Go pin test reads an existing immutable /usr/bin/true fixture without executing it and rejects missing guardian, changed digest, and absent non-policy path. TS also rejects missing/malformed pin and guardian under profileRoot. Teamlead tsc/build, changed-file Biome and both diff checks exited0. Build ran before commit; exact-head CI not claimed.

Production browser launch still uses direct pipeProcess: this commit establishes trusted configuration only. NEXT create/fsync per-profile UID/provider-account/generation/inode/nonce identity, wire guardian/CDP/liveness ownership, validate exact completed cleanup receipts and reconcile scoped profiles at startup. Actual guardian use must revalidate its immutable binary before each spawn. No real Chrome/account/Discord/host mutation or new aggregate. Final installation/gates/review/CI/twoPRs remain incomplete.

## 2026-09-15 durable guardian profile identity and startup reconciliation

Added browser guardian_profile lifecycle primitive: create private lease directory, random32-byte nonce, canonical owner record binding actual UID, provider/account/generation, root device/inode and profile device/inode; create exclusive empty0600 cleanup file; fsync records and directories before returning launch ownership. Recovery reads bounded4096-byte regular single-link private records with NOFOLLOW and fstat/path stability checks. Exact canonical JSON rejects duplicates/extra/omitted fields. Cleanup receipt must match nonce and schema, positive bounded PID, cleaned=true. No PID is probed or signalled by recovery.

Provider startup now calls scoped ReconcileGuardianProfiles instead of unconditionally rejecting nonempty roots. It reads at most65 entries (limit64), validates every entry before removing any, revalidates exact identity before cleanup, and never follows profile symlinks outside the directory. Unknown directory, empty/malformed receipt, account/generation/UID/nonce/inode mismatch, duplicate JSON, symlink, altered permission and physically replaced directory all fail closed with profile retained. Existing direct-browser profiles lack this identity and remain refused.

Red: profile tests failed to compile before the new types/functions existed. Green: focused real-filesystem profile suite2.011s; final Go root/browser full race4.789s/9.691s including physical directory replacement. Synthetic completed receipt removes only its matching profile and leaves a symlink target outside untouched. Gofmt/diff checks clean. These are synthetic receipts and filesystem evidence, not a live provider-crash/Chrome acceptance result.

NEXT connect guardian/CDP/liveness process transport and per-spawn pin checks to createGuardianProfile, so production produces these durable identities and actual guardian receipts; make Close require exact cleanup before releasing owner. Guardian primitive, startup pin and recovery consumer now exist, but production launch still uses direct pipeProcess. No real Chrome/account/Discord/host or new aggregate; final installer/gates/review/CI/twoPRs incomplete.

## 2026-09-15 production guardian/CDP integration

Production LaunchPipeBrowser and LaunchPipeLoginBrowser now verify both root-immutable browser and guardian binaries on every launch, create/fsync the scoped identity and empty receipt, and start the fixed guardian with inherited CDP/liveness/receipt/status descriptors. Provider startup supplies verified guardian pin and provider/account/generation scope. The provider owns the sole liveness writer; cancellation/Close closes it, guardian owns child-group kill/reap, and provider waits for guardian plus exact nonce/identity/PID receipt before releasing the profile owner. Missing or unlinked receipt retains profile and returns cleanup failure. Startup/CDP failure after Start retains an owner until cleanup is proved; a proven pre-Start failure can remove only its exact still-empty owned profile. Startup status input is capped64 bytes.

The guardian runs in its own process group so provider-group teardown cannot kill it before EOF cleanup. A new kernel getpgid test first failed (guardian inherited provider PGID1646), then passed after Setpgid. The browser gets its own group inside guardian. No global process scan or externally supplied PID signalling. Legacy direct-process helpers remain only for existing package fixtures; production entry uses guardian.

Red: new process and guarded-browser entry tests failed to compile before implementation; real process-group isolation assertion then exposed the inherited-group defect. Green: normal Close, cancellation, missing receipt, rejected CDP connection and failed guardian exec all tested with a compiled C guardian and synthetic process/CDP peer. Missing guardian pin, digest drift or missing scope refuse before profile creation. Final full Go root/browser race4.745s/9.642s; gofmt/diff clean. Earlier full run4.966s/10.470s preceded the process-group correction and is not the final receipt. No real Chrome, account, Discord, launchd or root host action.

Guardian producer, identity persistence and startup consumer are now connected in source. Actual deployed binary/policy/launchd and provider-crash host acceptance remain unproved. NEXT offline deployment manifests and executable boundary acceptance materials, parent artifact crash cleanup audit, then required final verification/effective review/exact-head CI/twoPR handoff. No new root aggregate run.

## 2026-09-15 offline launchd deployment bundle

Root b86810c76 adds strict offline renderer and deployment-entry CLI. It binds provider raw bytes to policy digest, emits fixed launchd Ingress/Authority sockets (root0660 with respective ingress/service groups), dedicated UID name, Umask63, pinned launcher/Node/entry args, private fd4 root0750 parent and separate service0700 provider parent. Files/directories and immutable entry hashes are reviewable requirements; generated plist itself has root0644/hash requirement. Conflicting directory ownership/modes, unbound JSON and XML path injection are rejected/escaped. The CLI reads bounded regular UTF8 source files and exclusively creates a private bundle; never overwrites an earlier bundle. No installation, chown, credentials, signing or launchctl occurs.

Red: test import failed before renderer existed. Green four tests0.707s including independent Python plistlib decode and actual Node/tsx CLI bundle/no-overwrite invocation. Teamlead tsc/build, three-file Biome and diff checks exited0. Initial Biome regex errors were fixed before final checks. Precommit build is not exact-head CI. deployment.md documents exact usage, requirements versus host evidence, full dependency/bundle closure gap and actual acceptance obligations.

Bootstrap question01e2dc6f-c65a-44b3-9cf2-1e72133a1bbb pending: both production loaders require signed acceptance before service startup, while first boundary probe needs actual service controls. Proposed separate root-pinned fixture-only QA probe entry using synthetic state/keys/fake platform; trusted installer measures and signs, production loaders keep unconditional acceptance. No bypass implemented or host/signing action performed. NEXT resolve this boundary and create executable verifier materials; independent parent artifact crash cleanup audit can proceed. Complete installer/artifact closure, final aggregate/effective review/exact-head CI/twoPRs remain incomplete.

## 2026-09-15 acceptance binds measured probe identity

Lead01e2dc6f approved a distinct fixture-only QA bootstrap entry with enforced root/synthetic/no-real-endpoint checks and installer-only signing. No production loader bypass is permitted. This batch implements the signature prerequisite: both root/provider policies require the same boundaryProbe pin; immutable loading and deployment requirements include it. TS/Go signed statements require probeSha256 and compare it with the root-pinned digest alongside config/provider/schema binding. Missing legacy field or independent probe drift fails closed. The probe itself and trusted installer measuring/signing are not implemented by this batch.

Red: TS signed fixture was rejected before the added field was supported; Go failed compile before new statement/expected field. Green36 focused TS tests1.31s across signature/config/current/client/deployment, Go startup/boundary focused2.290s then full root/browser race5.435s/11.089s, teamlead tsc/build and Biome/diff clean. Fork71693d0. Precommit build is not exact-head CI. No real host launch/signing/account/Discord or new aggregate.

Artifact audit and ruling910aca94 recorded in acceptance-audit.md: next implement fsynced exclusive project marker with PID/start-time/nonce and proven-dead takeover; retain all unowned staging dirs, account leftovers against256MiB and8-dir cap, fixed denial plus Lead-visible paths. No deletion subsystem; separately authorized operator cleanup remains a follow-up. No pending ruling. Full probe/installer closure, final aggregate/effective review/exact-head CI/twoPRs remain incomplete.

## 2026-09-15 retained staging measurement primitive

Root9aa3b04f4 implements the non-deleting measurement prerequisite for ruling910aca94. Only reserved project-root .flywheel-xhs-artifact-* trees are counted; exact known path/dev/inode roots are excluded. It sums actual regular-file logical sizes (including manifest bytes without interpreting contents), refuses symlinks/special files/hardlinks and identity drift, and bounds root enumeration100000 entries, leftover traversal65536 nodes/depth16. At256MiB or8 retained dirs it throws fixed staging_leftovers_exceeded with retained paths for the eventual Lead-visible log. No data is deleted or moved.

Red missing-module import before implementation. Green3 real-filesystem tests0.206s: exact inode exclusions, unknown inode counted, sparse256MiB and8-dir refusal with retained paths, symlink refusal with outside target intact. Teamlead tsc/build and two-file Biome/diff green. Runtime registry admission does not call this primitive yet; do not claim the repeated-crash allocation gap fixed.

Existing flywheel-config processStartTime and mkdir-lock were inspected. Generic age-based malformed-marker fallback must not be used here; the lock supports disabling age fallback via staleMs Infinity, but staging still needs explicit start-time presence, fsync, nonce ownership and persistent lifetime/release integration. NEXT implement that owner marker and integrate this scanner with project reservations and fixed denial/log propagation. No new deletion subsystem, host operation or aggregate. Fixture-only probe/installer closure and final gates/twoPRs remain incomplete.

## 2026-09-15 durable staging owner primitive

Added acquireXhsStagingOwner around existing flywheel-config withMkdirLock, held for registry lifetime with explicit async close. It requires an observed own process start time before creating state, disables age recovery with staleMs Infinity, and uses the existing PID/start-time/token identity logic for proven-dead/PID-reuse takeover. Exact acquired marker/directory inodes are checked before chmod/fsync; marker0600, lock0700 and project parent are synchronized before exposing capability. assertCurrent checks project/root identity and unchanged bounded marker bytes. Changed marker refuses both use and release; successful close waits for lock release and parent fsync. No leftover artifact directory is deleted.

Native processStartTime(process.pid) returned null in this sandbox; no estimated uptime fallback was added. Tests explicitly inject process start observation while exercising real filesystem locks; a real short-lived Node child supplies a confirmed exited PID for takeover. Red missing-module test; green4 owner cases plus3 leftovers cases0.829s. Initial tsc/build exposed an inferred-never callback type; explicit void typing fixed it, and final tsc/build exited0. Biome/diff clean. No host identity proof is claimed from the injected start-time tests.

Registry integration remains NEXT: acquire one owner per canonical project, await pending acquisition/close, recheck owner around reads/writes, combine retained bytes with per-project reservations, propagate staging_leftovers_exceeded and Lead-visible retained paths. Registry.close/service.close/tests must await asynchronous owner release. Do not claim the runtime staging gap fixed before this wiring. Actual fixture-only boundary probe/installer closure and final review/CI/twoPRs remain incomplete; no host/account/Discord/new aggregate.

## 2026-09-15 staging registry integration — resumed execution dd5960a4

Applied the exact inherited stash63021e24510f18cbd677975e5a62ce53fe48c20e after obtaining implement TURN epoch8. Registry now acquires one durable owner per canonical project, rechecks it on handle reads and uploads, scans retained trees before admission, and combines their measured bytes with synchronous per-project reservations. Concurrent activations cannot reserve beyond256MiB. Incoming bytes are copied before asynchronous acquisition. Close waits for acquisition and service drain, removes only identity-confirmed owned trees, then awaits owner release; unconfirmed cleanup remains retryable. HTTP returns fixed staging_leftovers_exceeded while internal warning records retained paths. Existing unowned trees are preserved.

Red verification: temporarily restoring the three production files to inherited HEAD while retaining tests produced three assertion failures: directory-cap upload unexpectedly allowed; second registry unexpectedly acquired staging; concurrent uploads both succeeded with only3 bytes remaining. Restored the exact production diff afterward. Added direct retained-byte/concurrent-activation coverage and marker-tampering read/write guards.

Green: VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/xhs-artifact-registry.test.ts src/bridge/__tests__/xhs-artifact-routes.test.ts src/bridge/__tests__/xhs-write-service.test.ts src/bridge/__tests__/xhs-staging-owner.test.ts src/bridge/__tests__/xhs-staging-leftovers.test.ts —27 tests /5 files passed,10.93s. Expected denial warnings include synthetic retained paths. pnpm --filter flywheel-teamlead typecheck exit0; scoped Biome check formatted the added tests. Sandbox tests retain explicit process-start observation seam; no production identity fallback added.

This closes the source-level staging admission wiring gap, not host cleanup or full acceptance. Fixture-only boundary probe/root installer remain absent; final aggregate gates, effective review, exact-head CI and both PRs remain outstanding. No live account, Discord probe, host install/restart, QA dispatch or ship action occurred.

## 2026-09-15 synthetic file probe and signed classification

Implemented separate boundary-probe-entry and strict fixed-root fixture admission per Lead0671478b-e152-427b-a373-311be247fd01. File-authority performs eight filesystem attempts as the actual model UID; only EACCES/EPERM counts, missing files/unknown errors/success do not. No configurable production paths/accounts/endpoints, no content read/write/truncate, no service startup or signing. Tests mock root metadata/permission errors for positive logic and launch real child processes for missing arguments, production path, user temp root and unsupported-probe rejection. These tests are not host isolation proof.

TS and Go signed statements now require probeKind=fixture_harness. TS red had two assertion failures (valid classified receipt rejected; old unclassified receipt accepted). Go red rejected the valid classified receipt. Initial Go command used a wrong relative test path and unwritable default cache; corrected to existing /private/tmp/flywheel-FLY-2551-go-{build,mod}, then obtained the actual assertion red. Green21 TS tests across5 files1.58s; teamlead typecheck and scoped Biome passed. Go focused startup/boundary race tests passed2.255s. Domain remains the undeployed v1 contract; both consumers reject older missing-kind receipts.

Next: root installer nonempty positive fixture controls, shared production module fixture service launcher, remaining probe matrix and immutable installation closure. Real dedicated UID/peer/fd-adoption and actual Chromium/XHS-origin behavior remain separate founder-run host acceptance items. No signing/host/Discord/account action or new aggregate has run. Effective review/exact-head CI/two PRs remain outstanding.

## 2026-09-15 nonempty synthetic file positive controls

Added file-control to the independent fixture entry. It requires actual serviceUid, reads five fixed known synthetic sentinel files through the existing trusted-file readers, rejects missing/empty/non-synthetic bytes and changed inode/metadata, and requires the exact state inventory plus an empty owned artifact directory. Root/model UID cannot run a positive control. Only file identities/digests are returned. Marker SHA and state dev/inode now bind both positive and negative observations; negative probes reject state replacement between operations.

Initial test import failed because the new module was absent; subsequent positive/negative unit cases use explicit mocked root metadata and process identity. Real child entry tests continue to reject invalid/production/user paths. These checks are source-level evidence and not real dedicated-UID host proof. Teamlead typecheck passed. Installer must execute before/after positive controls itself, compare evidence and supply all remaining probes; no model-supplied output grants authority, no signer was added.

Code audit for next shared fixture launcher: authority-handlers.test.ts currently captures HTTP factory options with mocks; no end-to-end.test.ts exists in the xiaohongshu-write suite. The separate launcher must compose real handlers/store/transport with the pinned fake adapters and cannot count these existing mocked assembly tests as the promised complete path. Actual host UID/fd/peer and Chromium/XHS-origin checks remain separate and pending.

## 2026-09-15 real Unix HTTP founder-gate integration

Added end-to-end.test.ts covering all six write operations plus unlike/unfavorite (8 scenarios). Each uses the actual native peer reader compiled from xhs-peer-credentials.c, Unix HTTP server, createAuthorityHandlers/registry/read projection/preparation/cards, trusted-source founder observer, real SQLite decisions/CAS and executor. No HTTP factory mocks. Reads supply scoped handles without returning the synthetic parent token; replies target the delivered full card, with wrong author refused. No receipt and mismatched digest each produce0 commits; concurrent distinct execute IDs produce1 commit; closing/reopening the real store and recreating handlers preserves1 commit. Image/video use the real frozen artifact store and compare the bytes handed to the fake provider against the imported synthetic bytes.

The initial integration failed at execution with founder_receipt_expired: the fixture observer used clock NOW+3000 while execute still used NOW+2000, correctly rejected by the runtime. Advancing the fixture clock after observation fixed that chronology. Also corrected fake commit to the actual signature(leaseId,signedPermit). No production code or assertions were weakened. Final8 scenarios passed2.06s; Biome/diff clean. Earlier one-scenario green0.547s is superseded.

Evidence limits: same real local UID, synthetic platform/Discord/in-process provider and synthetic decoder adapter; native peer checks are exercised but dedicated-UID isolation is not. The provider adapter checks permit HMAC and consumed state but is not the Go fork. This suite is now an executable full authority flow source fixture; it is not yet exposed through the independent root-pinned fixture launcher. Next extract/reuse bounded synthetic adapters for that launcher, wire the trusted root installer and remaining probe matrix/installation closure. Actual host/Chromium platform proof, full aggregate, effective review, exact-head CI and both PRs remain pending.

## 2026-09-15 independent authority-flow launcher

Extracted the eight established authority integration scenarios into boundary-fixture-flow.ts using Node assertions and production components; no Vitest or test-only ledger fixture dependency. The standalone boundary-probe-entry now accepts authority-flow through a separate root-fixture/service-UID admission wrapper. It reads the fixed immutable native helper, verifies nonempty file controls, reserves/fsyncs a single-use runtime/run-once marker, executes bounded fixed cases and compares positive controls afterward. Existing or failed runs cannot retry; case databases/artifacts remain for installer audit. Production startup and signed acceptance remain untouched.

Tests initially failed for missing modules. A later explicit path assertion failed because the wrapper had not passed the short socket path. Corrected to fixture io/i after identifying the Darwin Unix sockaddr length issue with deeply nested case directories; a real Unix HTTP test now runs with an overlong evidence directory and separate short socket. No path shortening symlinks or external socket directories added. Scenario setup always closes its SQLite store even if setup fails before server start.

Green26 tests across5 files2.52s: ten fixed-flow/negative/helper/path cases, three wrapper admission/one-shot/partial-retention cases, seven positive-control cases, five negative-probe cases and the real child entry rejection case. Typecheck passed; scoped Biome/diff clean. Built entry rejects authority-flow with /var/db/flywheel-xhs as expected (exit1, boundary_probe_unavailable, no stdout). Wrapper root metadata is mocked in unit tests; no real root fixture, dedicated UID transition, launchd, Go provider or Chromium/account/Discord action occurred.

Remaining: trusted root installer executes/comparisons/signing and full immutable artifact closure; other actual host probes and Go-provider linkage. Same-UID synthetic flow must never be counted as dedicated-UID isolation or actual-platform evidence. Full aggregate/effective review/exact-head CI/two PRs remain pending.

## 2026-09-15 root-only fixed-principal execution primitive

Lead53d7cd65 confirmed root-only/non-setuid runner with irreversible setgroups→setgid→setuid and observed-ID/group equality before exec. Implemented xhs-fixture-principal.c with fixed root policy path, strict ordered bounded policy grammar, root immutable ancestry, SHA-256 measured Node/entry pins, fixed fixture-root nonce and role/probe allowlist. No paths or IDs accepted from argv/env. Service lane rejects other groups/login shells; model lane preserves actual account supplementary groups. No arbitrary shell/root command, installer or signer. Inherited fd3+ closed after enumeration; stdout/stderr remain for trusted parent observations.

Red: new C file absent, then local -Werror compilation found closefrom undeclared on this macOS SDK. Replaced it with /dev/fd enumeration followed by close, which is directly tested on a child-owned descriptor. Earlier argv-path draft was changed before commit to comply with Lead fixed-policy ruling. Tests now compile both normal binary and a nonprivileged C harness: actual unprivileged program invocation rejects; strict parsing rejects extra/invalid fields/path traversal/production fixture path; local immutable /usr/bin/true digest accepts exact bytes and rejects drift; inherited test fd is closed. Two tests passed0.878s, -Wall/-Wextra/-Werror; no root identity change executed. Local SDK CommonDigest.h was checked for the native SHA-256 API.

This is the runner primitive only. Root installer policy rendering/provisioning/execution/receipt comparison and signing, immutable closure, remaining host context matrix, Go linkage and final workflow gates still need completion. It is not host privilege-drop success or activation proof.

## 2026-09-15 — Fixture evidence comparison and native policy serialization

- Added `collectFixtureEvidence`: runs service positive control, model denial probe,
  repeated service control and authority flow in fixed order. Strict bounded JSON
  rejects unknown fields, missing/duplicate operations, wrong identity/nonce/helper,
  changed inode/metadata/content, missing scenarios and replay counts above one.
  It returns an evidence digest with `hostAcceptance:false`; it cannot sign or
  enable production. The future root installer must invoke its own pinned children,
  rather than accept uploaded observations.
- Added `renderFixtureRunnerPolicy`: serializes dedicated boundaryProbe and Node
  pins plus root-selected fixture nonce and verified principal ids into the native
  runner's ordered grammar. Rejects invalid uid/gid range, shared principal/group,
  admin service group, bad digests, non-installed paths, traversal, control bytes
  and native path-buffer overflow. Serialization itself grants no authority.
- RED: policy test failed on absent module before implementation. GREEN: 33 tests
  in three files, 1.81s, including compiled native parser consuming actual renderer
  output and nonprivileged native execution rejection. Changed-file Biome and
  teamlead typecheck passed. No root execution or actual principal drop was run.
- Remaining: root provisioning and child orchestration, full immutable dependency
  closure, real host context/UID/fd/peer/Chromium probes and Go-provider linkage;
  aggregate verification, effective review, exact-head CI and both PRs.

## 2026-09-15 — Exclusive root synthetic fixture provisioning

- Added root-only `provisionBoundaryFixture` primitive with immutable ancestor and
  pinned peer-helper admission, fixed policy and QA paths, exclusive reservation,
  fd-based ownership/modes, per-file and directory fsync. Root0700 hides the fixture
  until all contents are persisted, then root0755 admits service/model probes.
  Partial failures retain the reservation and fixture; no overwrite, cleanup or
  automatic retry exists. Only fixed sentinel bytes are created, no real secrets.
- RED: absent provisioning module. GREEN: six provisioning tests using a real
  temporary filesystem with explicit fake ownership/root identity. Mid-write
  failure keeps root0700 and already-written bytes; unprivileged identity, writable
  parent and invalid policy fail before creation. These are source tests, not
  privileged host provisioning or cross-UID evidence.
- Broader validation: all502 tests/65 files in `src/xiaohongshu-write` passed75.74s.
  Teamlead typecheck/build, changed-file Biome and diff whitespace check passed.
- No actual root action, installer entry invocation, production activation or
  acceptance signature occurred. NEXT: bind fixed installer policy/config to this
  primitive and direct native child execution; independently measure complete
  dependency closure and collect the remaining actual host/Go-provider matrix.
  Full repository gates, effective code review, exact-head CI and both PRs remain.

## 2026-09-15 — Bind measured fixture execution to installer reservation

- Found and reproduced a collector gap: internally consistent child observations
  for a different fixture marker/state were accepted. RED regression resolved
  instead of rejecting. The expected fixture marker digest and state dev/inode
  are now required installer inputs; every positive control must match them.
- Added `runInstallerFixture`, a root-only internal composition primitive. It
  validates fixed installed program pins before provisioning once; remeasures
  runner/Node/probe/helper before each direct native child; only role/probe argv,
  clean environment, no shell, bounded output and120s SIGKILL timeout. Nonzero
  child exit, unexpected stderr or pin replacement stops without retry/cleanup.
  Collector expectations come directly from the provisioner's reservation.
- No caller-supplied result JSON/callback or acceptance signer exists in this
  composition API. It still relies on a future authenticated installed caller
  establishing the complete immutable dependency closure; it is not a shipped
  root installer entry and was never run as root.
- GREEN:30 tests/4files7.16s, including native runner parser/execution rejection,
  temporary-fs provisioning, reservation substitution and orchestration failure
  tests. Orchestration tests simulate identity/children; they are not host proof.
  Changed-file Biome, teamlead typecheck and diff whitespace passed.
- NEXT: immutable installed artifact/dependency closure and fixed root-only entry
  loading its policy/config, persistent unsigned observations, remaining actual
  host/Go-provider probes and acceptance signing. Full repo gates/review/CI/PRs
  remain outstanding.

## 2026-09-15 — Exact installed dependency tree measurement

- Added bounded manifest/tree measurement: strict complete inventory including
  empty files/directories, root-only immutable ancestry and entries, per-file
  SHA256 streaming reads with fd/name metadata equality, and final file/directory
  recheck. Rejects links/special files, extra/missing entries, unsafe paths/modes,
  size/hash mismatch and changes while reading later dependencies.
- RED: missing module before implementation. GREEN:13 filesystem tests5.06s;
  tests redirect installed paths and simulate root ownership, while exercising
  actual temp files, hashes, hardlinks/symlinks and a late file mutation. Changed
  Biome and diff whitespace checks passed. This is source measurement evidence.
- The verifier deliberately does not authenticate caller-provided manifest bytes
  or assert a complete runtime import graph. Native/bootstrap authentication,
  symlink-free installed artifact layout, imported dependency coverage and actual
  root execution remain pending before this can participate in acceptance.

## 2026-09-15 — Repository verification and bootstrap decision

- `pnpm lint` exited0 (4155 files,18 warnings; no blanket warning cleanup).
- `pnpm -r build` exited0 for the workspace.
- `ci-structure.test.sh` exited0; `fly1674-residue.test.sh`80 passed0 failed;
  `ci-apt-install.test.sh`15 passed0 failed; `lead-patrol-github-facts.test.sh`
  exited0. Logs: `/private/tmp/fly2551-{lint,build,ci-structure,fly1674-residue,ci-apt,patrol-facts}-20260915.log`.
- Started required `pnpm test:packages:run`, live tool session13788; log
  `/private/tmp/fly2551-packages-20260915.log`. Also patrol snapshot test remains
  live session19952, log `/private/tmp/fly2551-patrol-snapshot-20260915.log`.
  Neither is claimed passing; re-poll these exact sessions before any restart.
- Lead confirmed native pre-Node whole-tree verification in question
  837db97f-6b4d-4a8c-bec5-0ee09cb4f8e9. Recorded constraints in design-correction.
  Follow-up77c07b6c-8f14-449a-8064-ba1ca3d1ffd8 asks how the initial
  no-whitespace grammar should represent verified Chrome framework/helper names
  containing spaces. No architecture/code change was made while that answer is
  pending. Continue independent verification and poll normally; not blocked.

## 2026-09-15 — Native manifest parsing and fixed-tree hashing

- Implemented deterministic JSON-inventory projection to sorted ASCII native rows
  with SHA256, four-digit octal mode, literalroot0:0, and exact relative path.
  Chrome framework/helper single spaces are preserved per77c07b6c; ambiguous
  spaces/control/non-ASCII/traversal/duplicates/oversize input are rejected.
- Added native parser and fixed-tree walker headers. Native walker uses macOS
  CommonCrypto before any JS needs to execute: root-owned immutable ancestry,
  no links/special files, exact regular-file inventory/hash/mode, fd/name metadata
  equality, final file recheck, bounded total nodes/depth/bytes. Directories are
  inferred from file paths; unlisted empty directories are rejected by projection
  and native traversal. Artifact assembly must satisfy this explicit layout.
- REDs: missing projection module, then missing native parser/tree headers in
  compiled harnesses. GREEN:28 tests/3files2.00s, including native builds under
  -Wall -Wextra -Werror, real temporary file hashing/empty file/link/extra/missing/
  mode/spacing negatives. Filesystem ownership is simulated in harnesses; no root
  invocation, native bootstrap execution, policy authentication or host proof.
  Teamlead typecheck, changed Biome and diff checks passed.
- Patrol snapshot402/0 completed. Package aggregate13788 interrupted under explicit
  host-contention instruction c0d866ed-a283-41ef-abab-b8190ecec458, not relied on;
  no host aggregate restart. Exact-head CI will supply aggregate of record.
- NEXT: fixed root-only bootstrap entry authenticates native manifest digest and
  its own installed policy/pins, invokes this native walker before exec Node;
  JS projection binding and installed installer orchestration, remaining actual
  host/Go-provider probes/signing, code review and two PRs remain.

## 2026-09-15 — Fixed root bootstrap and paired manifest pins

- Added no-argument root-only native launcher: fixed policy/manifest paths, root
  immutable bounded reads, both JSON/native digests, full native tree before Node
  execution, required node/installer-entry inventory members, metadata recheck,
  clean environment/cwd/stdin/umask and inherited descriptor closure. Bootstrap
  binary provenance still belongs to the independent trusted installer.
- Added offline policy renderer and paired-manifest comparator. Even two correctly
  pinned byte strings fail if their projection differs. Comparator emits no
  approval/signature and is awaiting installed-entry wiring.
- REDs: missing native launcher and missing comparator module. GREEN:24 tests in
  four focused files3.95s; final descriptor-cleanup addition reran native bootstrap
  two tests2.42s. Native builds use -Wall -Wextra -Werror. Teamlead typecheck,
  changed-file Biome and diff checks passed. No root invocation occurred.
- NEXT: fixed installed JS entry reads/authenticates policy and manifests, verifies
  projection before installer mutation, binds reviewed authority config and native
  principal pins, invokes fixture orchestrator and persists unsigned observations.
  Assembly/signature binding, actual host/Go-provider matrix, review and two PRs
  remain. Host aggregate stays stopped; exact-head CI is aggregate of record.

## 2026-09-15 — Installed entry to one-shot evidence persistence

- Added standalone fixed-path/root guard before runtime import, installed controller
  immutable policy/manifest/projection checks, inventory-pinned installer settings,
  authority digest and Node/peer/probe/principal binding, root nonce, existing
  orchestrator invocation, and post-probe deployment rechecks.
- Added root-only exclusive0600 evidence persistence with fsync. No retry, overwrite
  or signature. Wrong identities/pins, changed projection/config and probe failure
  stop before mutation or prevent a success receipt after the probe.
- REDs: missing persistence export and installed-controller module. GREEN:34 tests
  across5 focused files2.27s; includes actual unprivileged entry process rejection,
  temporary filesystem exclusive persistence, config drift and composition guards.
  Root identity/child execution are simulated in unit tests; no root action or
  real installation was run. Teamlead typecheck and changed Biome/diff passed.
- NEXT: reviewed artifact assembly that preserves the fixed entry/module/dependency
  layout while materializing links inside the tree; bind bootstrap/manifest evidence
  into acceptance signing. Remaining actual host/Go-provider matrix, code review,
  exact-head CI and two PRs remain; host aggregate stays stopped.

## 2026-09-15 — Small isolated JavaScript runtime bundle

- Actual bundling probe: installer558110B, authority753037B, probe698979B, only
  Node builtins and better-sqlite3 external. Implemented fixed offline builder,
  explicit SQLite/bindings/file-uri runtime copy and root entry, no symlinks.
  Added exact dev build dependency esbuild0.25.10 already present in lock graph.
  Initial pnpm offline add lacked unrelated aws4fetch metadata; narrowly updated
  importer for existing locked version, then frozen/offline/ignore-scripts install
  passed with no dependency resolution or lifecycle execution.
- RED: absent builder; first complete artifact test exposed an incorrect expected
  authority exit code (source contract is2 for invalid argv), corrected assertion
  after inspecting source. GREEN: isolated artifact test8.64s including native
  SQLite query42, bundled installer guard, exact authority/probe stderr/status,
  no symlinks and overwrite refusal. Changed Biome/typecheck/diff passed.
- Corrected native-tree test's Ubuntu expectation: unsupported-platform verifier
  must refuse; macOS executes the positive/adversarial matrix. macOS focused rerun
  passed1.22s. Ubuntu branch remains for exact-head CI verification.
- Read-only otool evidence proves host Node has Homebrew dylib paths. Lead ruling
  765b2b22 recorded in acceptance-audit: require pinned official portable Node and
  contained/system-only native dependencies. No native assets were installed.
  NEXT compliant native distribution pins/asset inspection and full assembly,
  acceptance signature binding, actual host/Go matrix, review/CI/two PRs.

## 2026-09-15 — portable Node/SQLite candidate and narrow loader policy

Unprivileged offline evidence only; no host installation or activation.

- Official Node archive: https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz ; verified against https://nodejs.org/dist/v24.21.0/SHASUMS256.txt before extraction/execution.
- Archive SHA256 `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`; extracted Node SHA256 `e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b`. Actual version v24.21.0, ABI137.
- Node load commands reference only `/usr/lib/dyld`, `/usr/lib/libSystem.B.dylib`, `/usr/lib/libc++.1.dylib`, system CoreFoundation and Security frameworks. No rpath/Homebrew dependencies.
- Workspace SQLite ABI141 failed under this Node, as expected. Isolated node-gyp rebuild failed before compilation because pkgutil exposes no CLT package receipt; SDK discovery alone did not resolve it. Log `/private/tmp/fly2551-sqlite-node24-build.log`. No workspace addon rebuild or toolchain mutation.
- Upstream pinned better-sqlite3 v12.8.0 prebuild: https://github.com/WiseLibs/better-sqlite3/releases/download/v12.8.0/better-sqlite3-v12.8.0-node-v137-darwin-arm64.tar.gz . GitHub release asset API digest matched downloaded archive SHA256 `936d5da12edd5cd0cc6ae8fbec2e36b87791ae0efee6df243cfe178e2ed45851`; sole extracted addon SHA256 `7fd5c877dee29bd0cad8850eff93e82589d55f118934d9b333095fe64bb6faca`.
- Actual addon load commands reference only `/usr/lib/libSystem.B.dylib` and `/usr/lib/libc++.1.dylib`. Actual pinned Node + copied SQLite JS + explicit nativeBinding to this addon performed `select 41+1 value`, returned42, then closed DB.
- Added narrow offline `inspectNativeLoadCommands`: bounded otool output, contiguous commands, explicit known inert/load commands, normalized system paths only. Rejects all rpaths, loader-relative names, environment injection, unrecognized loader commands, malformed/duplicate name entries, user/Homebrew paths. The selected two assets need no contained dylibs, so this does not implement a general dependency resolver or relocation.
- TDD: absent module failed collection, then14 tests passed; actual official Node/addon accepted and actual Homebrew Node rejected. Typecheck initially caught unchecked regex-match indexing; fixed with explicit never-returning denial and guarded indexing.
- These are candidate provenance pins, not installed root policy or a complete artifact. Assembly must consume these exact bytes/pins and bind inventory/signature; actual UID/fd/peer/Chromium/Go-provider matrix remains pending. Host package aggregate remains interrupted-under-host-contention/not relied on; exact-head CI is aggregate of record.

## 2026-09-15 — pinned native/JavaScript assembly exercised

- Added `scripts/xhs/build-native-runtime.ts`, consuming the exact three source-pinned Node/SQLite/license digests above. It uses exclusive ordinary-user output, actual generated-file loader inspection, clean-environment generated Node/ABI check and SQLite query, then remeasures Node/addon.
- TDD: measured-addon injection test first demonstrated the old builder copied the workspace ABI141 addon; fixed builder takes measured bytes directly. Unpinned-input refusal first failed due to absent native builder, then passed after implementation. Binary comparison reports a boolean to keep failures bounded.
- Focused native-assets/native-runtime-build/runtime-bundle:17 tests across3 files passed2.22s. Teamlead typecheck passed. Biome changed-file check passed.
- Actual macOS arm64 assembly: `/private/tmp/fly2551-native-runtime-assembled`, receipt `/private/tmp/fly2551-native-runtime-assembled.json`;30 ordinary files,126249871 bytes, Node24.21.0/SQLite12.8.0/ABI137, generated-directory query passed, both loaders system-only. `hostAcceptance:false`.
- No host root/install/sign/restart/platform write occurred. Full C/provider/browser/media/config/inventory/signature and actual host matrix remain outstanding; aggregate stays stopped per Lead.

## 2026-09-15 — native helpers/provider and browser/media source ruling

- Native runtime builder standalone TypeScript check initially lacked root Node types; reran with `--typeRoots packages/teamlead/node_modules/@types --types node` and passed. This is separate from the already-passing teamlead check.
- Added offline `build-native-helpers.mjs`: fixed five C sources, native-tree/manifest header measurements, ordinary-user macOS arm64 only, exclusive output, `/usr/bin/cc -Wall -Wextra -Werror -O2`, source measurements rechecked after compilation. No binaries run or installed. Actual output `/private/tmp/fly2551-native-helpers-script`; all five compiled successfully, overwrite refused. Individually inspected outputs link only system libSystem/dyld. Receipt includes source/header/output digests and hostAcceptance:false.
- Fork HEAD3f6dd3fc11709a70c83822338b2f4bd1e62afe81 clean. Actual `CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -p=1 -trimpath` completed using isolated existing GOCACHE/GOMODCACHE. Provider `/private/tmp/fly2551-native-helpers/xiaohongshu-provider` SHA256 `c3ef9b6529064f59e12cdf6051ab9de6b32afc37c88efe624e8e59e948089bfa`; loader system-only. No provider service started.
- Lead ruling question `fc07d088-ce28-41ea-bc9c-08829c6d1e37`: browser must be rod v0.116.2 exact launcher RevisionDefault, official chromium-browser-snapshots Mac_Arm archive. No Playwright fixture reuse. Media first-choice only exact npm ffmpeg-static/ffprobe-static versions with actual system-only arm64 binaries; no source build/Homebrew. If pair unavailable, stop media assembly, mark slots pending, one exact-gap ask; continue independent assembly. No root/activation.
- Actual module source `lib/launcher/revision.go` pins1321438; `browser.go` forms https://storage.googleapis.com/chromium-browser-snapshots/Mac_Arm/1321438/chrome-mac.zip . Download `/private/tmp/fly2551-chromium-1321438.zip` SHA256 `4a478b542f1f6eaa160e64aab76100501e061d3bba46f6a480897ef1103c70c5`;308 ZIP entries,298469095 unpacked source bytes. Framework128.0.6568.0, largest file202981440 bytes. Five internal framework symlinks need approved materialization; unpacked tree digest still pending.
- ffmpeg-static@5.3.0 npm tarball registry SHA512 verified; SHA256 `0525c908c27618582a6fb5d4cc70452a2f2d4f50cb3d88b19b16a3c1cc8df25d`. Package install source points to release b6.1.1 asset https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz . Download matched GitHub asset SHA256 `8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa`; decompressed binary SHA256 `a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584`, actual Mach-O arm64, system-only loader paths. No npm lifecycle scripts run.
- **Media pair pending:** ffprobe-static@3.1.0 tarball https://registry.npmjs.org/ffprobe-static/-/ffprobe-static-3.1.0.tgz matched registry SHA512; SHA256 `0193bc86ec086edcb7c3198fe8aca944e4a5d748f63d2d1b4603b26892ebb628`. Claimed path `package/bin/darwin/arm64/ffprobe` SHA256 `5b592e56f87ff754d94dadf99f38b4d0fb7d463eb780b50e0ca061d668d0e3f7` is actually **Mach-O x86_64**, verified `/usr/bin/file`. System-only linkage does not fix wrong architecture. Stopped media assembly per ruling; no Rosetta or third source. Exact gap registered once as question `d8543257-50a5-45ef-a9d7-d951202c96ec`; poll it for disposition.

## 2026-09-15 — Chromium materialization and composite inventory

- `materialize-chromium.py` accepts only the pinned official revision1321438 archive, freezes the bounded compressed bytes before parsing, and validates the exact five authenticated internal aliases. It writes only ordinary files, preserving names and executable modes, with no symlinks or empty directories. It never launches Chromium. Output is exclusive and failures retain partial artifacts.
- Actual repeated materialization tree SHA256 `72ef0509da5743313a39ed6933406348f107785f0e04a238fa66949b77edf404` is now fixed in source. Digest is SHA256 of sorted entries encoded with Python JSON sort_keys=True and separators=(',',':').642 entries,892910362 bytes. Independent filesystem pass recomputed all file digests and verified no links/empty dirs. Paths `/private/tmp/fly2551-chromium-materialized-verified` and matching `.json` receipt.
- Added `measure-runtime.ts`: ordinary-user offline inventory, bounded streamed hashes and before/after nanosecond identity/complete-directory checks, no symlinks/hardlinks/writable/special files,2GiB total/256MiB file/20k entry limits. Produces exact JSON/native/bootstrap-policy representations through existing parsers. It does not assert artifact completeness or root/host acceptance.
- TDD: absent materializer/inventory commands failed, then passed. A new nested-output negative reproduced acceptance of `..nested-output` inside the source; corrected exact parent-component boundary, then9 tests across3 files passed3.18s. Standalone inventory TypeScript check passed using teamlead Node typeRoots. Changed-file Biome passed.
- Actual composite `/private/tmp/fly2551-runtime-composite` combines pinned native/JS artifact, browser tree, five C helpers, built provider and explicit pending provenance.693 entries,1041196366 bytes. JSON manifest SHA256 `1df76185aff651976ccbe1bf1a926eecef057916fcc2e452f058c6f345bda37d`; native manifest SHA256 `f591e47df72caa8434d9cd8800d2f9480aba628595a24a52ad6dfcc1b0cad437`; bootstrap-policy SHA256 `acc26de58e74fdf21de2a5ba03bbec65dfcd3f8cacfb6992786af65ceb68470f`. Output `/private/tmp/fly2551-runtime-composite-manifests` plus `.json` receipt.
- Actual native tree verifier compiled against this1.04GB tree accepted its manifest, then rejected a changed provenance byte; bytes restored. Ownership was mapped to root **only in the test harness**, so this proves native byte/shape verification, not actual root ownership or installed-host acceptance.
- Lead d8543257 accepts ffmpeg-static5.3.0 pin; ffprobe may only come from same upstream exact b6.1.1 release, if it publishes matching arm64/system-only binary. Otherwise leave ffprobe pending; no further media asks, no source build/Rosetta/third source.
- Lead6c3201d4 confirms one shared native manifest-policy verifier reused by production authority-launcher before JS imports; mismatches fail closed with exact path in reason. Extend existing TS/Go boundary receipt by exactly manifest/bootstrap digest fields, read root immutable metadata outside runtime. No tables/approval lane/activation; no other launcher refactor. configDigest excludes fixture-installer.json; receipt takes manifest digest as input. Required red-green tampered-tree, tampered-metadata, both-digest receipts and existing8 authority scenarios. Implementation of this confirmed binding is next.

### Same-origin media gap resolved under d8543257

The approved b6.1.1 release also publishes matching ffprobe: https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-darwin-arm64.gz . Download matched GitHub asset SHA256 `d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be`; decompressed executable matched published direct-asset SHA256 `bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64`. Actual file is Mach-O arm64;32 loader paths are system-only. No ffprobe-static mislabeled binary or third source used.

Both b6.1.1 arm64 media assets report **binary version6.0**, recorded separately from the release tag. Exact release LICENSE SHA256 `cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2` and README SHA256 `05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a` verified. Actual offline smoke: ffmpeg generated a black16x16 PNG; ffprobe returned codec png,width16,height16. Clean env, no network or host config change.

`build-native-runtime.ts` now requires fixed ffmpeg/ffprobe/license/readme bytes alongside Node/SQLite inputs; it measures all before output, checks all four native loader closures, executes generated Node/SQLite and media version guards, then remeasures. An executable-pair check first failed on the old Node-only artifact; actual new artifact `/private/tmp/fly2551-native-media-runtime` passed,34 files217353081 bytes. Related17 focused tests passed3.67s and standalone builder/inventory typechecks passed. Media slots are resolved; configuration and trust-chain/signature/host matrix remain pending.

Lead78ceb67c confirms precise receipt field semantics: `bootstrapSha256` is the installed native bootstrap **executable** digest; `manifestSha256` is the native runtime.manifest digest. Root-owned metadata outside runtime supplies expected values; native tree verification must measure actual bootstrap against manifest. `bootstrapPolicySha256` remains a distinct inventory measurement and must not be substituted. No native/receipt binding change has yet been made in this batch.

Final media-inclusive offline composite in this batch:697 entries1132299971 bytes; JSON SHA256 `95e8f89b80f51646024359e2432cddd9e4acaa4ed73bc26e2db1a1875e312112`; native manifest SHA256 `5da7d6101b35085f20281e935f58e99201ee8bb382dac87e71e48a4c10bb8bae`; bootstrap-policy SHA256 `2c1f6641862d061ed4c278d91f476b06b071c5f5a44f9d3825deca6365c93c5d`. `/private/tmp/fly2551-runtime-composite-media-final-manifests` is the current candidate; earlier manifests are superseded by media/provenance/browser-directory-mode changes. Native verifier accepted with fixture-only ownership mapping. No installed-host acceptance or production activation.

## 2026-09-15 — shared native startup verification and installation-bound receipts

Implements Lead6c3201d4 and78ceb67c within the approved scope:

- Extracted the existing native bootstrap policy/read/tree verification into **one** `xhs-installation-verify.h` function used by installer-bootstrap and production authority-launcher. Launcher verifies the fixed runtime tree before socket activation/Node exec and requires fixed Node/authority entry/config paths. The listener adoption and verification flow is unchanged.
- Both entrypoints require fixed root-owned external `installation.metadata`: exact LF grammar `version=1`, `manifest_sha256`, `bootstrap_sha256`. Native manifest digest must equal the root bootstrap policy; bootstrap executable digest must equal the matching measured tree entry. Required native/JS entries must exist. Final metadata/policy/manifest identity checks refuse changes during verification.
- Native tree failures retain the exact failing path; diagnostics escape control/non-ASCII/backslash bytes and remain one line. Red test reproduced a newline filename reporting the prior entry; fixed path capture before name validation, then green. Existing fd3/fd4 socket tests remain green.
- Added strict TS/Go metadata parsers. Existing boundary signature schema gains **exactly** `manifestSha256` and `bootstrapSha256`; no new approval lane/tables or configDigest fields. Both languages reject missing/mismatched installation fields and accept the same committed TS-generated public signature fixture. The bootstrap field measures executable bytes, never bootstrap-policy bytes.
- Authority loader and provider startup read the fixed root-owned metadata. Authority current-config checks and parent-client construction freeze their initial installation binding and reject later metadata replacement, including a valid newly signed replacement receipt. Typecheck found these two additional consumers; both updated and tested.
- Installed fixture controller verifies metadata against measured manifest/bootstrap before probes, rechecks metadata after probes, and persists both fields in unsigned observations. Tests show no persistence after metadata drift. No signing capability was added here.
- Offline inventory emits external installation.metadata when its tree includes an executable bootstrap; arbitrary partial inventories remain non-authoritative. Native helper builder now records the new shared header in source measurements. Earlier assembled binaries/manifests are superseded by these source changes and must be rebuilt before use.
- TDD reds: launcher activated sockets with changed tree; policy corruption also covered by the resulting green native test; external bootstrap digest mutation ignored; new signed TS fields rejected; Go metadata parser absent; unsigned fixture observations omitted bootstrap binding and accepted changed metadata; inventory omitted metadata. Each named behavior reached green after the corresponding fix.
- Final focused verification: **68 tests/12 TS-native files passed5.65s**, including all8 authority fixture scenarios plus guards, actual Unix fd3/fd4 handoff, C compilation and synthetic ownership mapping. Teamlead typecheck passed after consumer fixes; standalone inventory typecheck passed; changed-file Biome passed. Go boundary/installation-metadata/startup focused tests passed0.740s. No host aggregate restarted.
- Fork implementation committed `697bc33` (installation metadata, startup binding, two-field signature extension and shared fixture). No root install/service start, real platform write, acceptance signature or host acceptance occurred. Independent installer/signing/config assembly and actual host matrix/review/CI/two PRs remain pending.

### Rebuilt installation-binding artifact

Rebuilt bundled native/media JS runtime at `/private/tmp/fly2551-runtime-installation-binding`, five native helpers at `/private/tmp/fly2551-native-helpers-installation-binding`, and fork697bc33 provider at `/private/tmp/fly2551-provider-installation-binding`. Provider SHA256 `68e06b8ef729178a4bbdafe5f5af12a5bc5c6b67e1b839a743f5aed351f22df5`. Fresh provider/authority-launcher/bootstrap loader inspections remain system-only. Bundled builder again passed actual Node/SQLite and media guards.

Updated composite `/private/tmp/fly2551-runtime-composite`:697 entries1132305800 bytes. Current manifests `/private/tmp/fly2551-runtime-binding-manifests`: JSON SHA256 `c016ac59ef94ee598aec6b58e888cb6a53888bea8f55a9ddbffcc71b8ebee561`; native manifest SHA256 `79411f3b42bfeaf8a3a3cc59fb345c854c2840b1dfc163b05185deb33f4ff6a9`; bootstrap-policy SHA256 `f2436fddbbda3be758aa71065e6f6676b79c5685b5271087748f4d6bb4da2d75`; external installation-metadata SHA256 `907ee6ee450a19738d0abffa8fd09d3b79daa4e914648ecdd3855c6964be7a69`.

Compiled the actual shared native verifier against this complete candidate byte tree and external metadata, mapping ownership only in the test harness: accepted; then appended a metadata newline and observed rejection with exact metadata path; restored bytes. This is byte/protocol evidence, not installed permissions or root/launchd/Chromium acceptance. Configuration slots remain pending in candidate provenance; earlier composite receipts are superseded.

## 2026-09-15 — fixture activation refusal and negative submission evidence

- Consumed Lead rulings 4af8d085-6e30-4620-935e-7fbcfeefeb18 and
  80bac618-24f8-4101-a7fd-5685c7dff162. Current fixture-only signature cannot
  substitute for the missing separately designed host-activation proof.
- Red test used real Ed25519 signing/verification with mocked host file/principal
  boundaries: enabled:false accepted, enabled:true incorrectly accepted.
  Minimal loader guard now refuses enabled:true after receipt verification with
  host_activation_receipt_absent, before private-root/socket checks or startup.
  A valid disabled policy still loads. No host-proof schema was introduced.
- Each of eight synthetic authority scenarios now captures commit counters
  immediately after missing receipt, forged approved/actor/time/ship fields,
  wrong founder and mismatched digest denial. Strict persisted evidence requires
  all four zero counts, while preserving one approved commit and replay total1.
  No counter is inferred from a final total. Collector rejects absent counters
  and nonzero negative submissions. Added forged ingress uses actual Unix HTTP.
- TDD: negative-counter changes first failed9 cases; activation first failed1
  of2 cases. Focused final47 tests/4 files passed3.02s; Teamlead tsc --noEmit
  and changed-file Biome passed. Host aggregate remains interrupted-under-host-
  contention / not relied on; no aggregate was restarted.
- Signing workflow and explicit signed scope fields still pending. Existing
  composite JS bytes/manifests are superseded by this source change. No root
  installation, actual model/host acceptance or production activation claimed.

### Explicit signed fixture scope

Lead4af8's bounded signature contract is now enforced by TS and Go: signed
hostAcceptance must be explicitly false; signed notCovered must be the exact
ordered list real_claude_context, real_codex_context, real_runner_context,
real_login_context, process_authority, privilege_paths, private_transport,
headless_service, legacy_cutover. Missing/true host acceptance, omitted/shortened
scope and real-platform classifications are refused. Go uses a pointer for the
boolean so omission cannot become false during canonical reconstruction.

The shared public Ed25519 fixture was regenerated in TS and copied identically
to both repositories; the transient test private key was discarded, not retained
as an installer key. TS first refused the new valid statement; Go first refused
the shared new fixture. Both reached green after synchronized parser/canonical
changes. Focused37 tests/5 TS files passed5.12s, Teamlead typecheck and changed-file
Biome passed; Go boundary/metadata/startup tests passed0.814s.
Fork c4e8f84 contains the matching contract. Existing unsigned fixture collector
still does not sign; root-only signer implementation remains next. These local
fixtures do not establish installed-host acceptance or activate writes.

## 2026-09-15 — direct-collector root fixture signer

- runInstalledFixture now requires disabled authority policy, fixed root output
  paths, pinned provider policy binding and measured provider/browser/guardian/
  media/probe entries. It rechecks provider bytes alongside authority policy,
  manifests, metadata and full tree after directly collecting the fixture.
- After exclusive unsigned evidence persistence, the installer reads only the
  fixed root-owned single-link exact0600 Ed25519 PKCS8 key outside runtime.
  Derived public key must equal both pinned policy keys. It creates and verifies
  both fixture-only signature envelopes in memory before any publication.
  There is no uploaded-results/sign-caller-JSON API or service signing endpoint.
- Root0644 receipts are exclusive, fsynced and never overwritten. Failure of
  second publication retains first output and observations, returns generic
  failure and does not retry. Raw key input Buffer is cleared; no whole-process
  memory erasure claim. No private key is generated/provisioned by this runner.
- Reds:7 installer cases failed before signing/provider/key guards existed;
  2 exclusive-persistence tests failed before the primitive existed. Green45
  tests/6 files passed4.26s including actual offline bundle/SQLite smoke,
  root-mode ownership mapping and unprivileged bundled-entry refusal. Added
  evidence-persistence failure guard then passed all20 installer tests1.09s;
  the union is46 distinct passing tests. Changed-file Biome passed.
- These tests execute real Ed25519 signing/verification with transient test keys
  and mocked host boundaries. They do not prove actual root provisioning,
  installed principal isolation, real platform behavior or activation.
- Question e73b0fbc-65f7-42ac-97c9-6a3e61c08049 pending: pin source handoff
  boundary for excluded host probes and production configuration inputs after
  Lead4af8/80 A. Offline configuration builder may accept QA public bindings;
  this runner has no trusted target key/host identities and must not fabricate
  a production-complete configuration. Existing artifact pins are superseded.

### Artifact permission mismatch repaired

Offline audit found builder native executables0755 / imported JS0644 but
rendered deployment requirements forced every pin0555, which would invalidate
the measured mode tree after installation. Also bundled boundary-probe-entry.js
was0644 although TS and Go startup executable-pin checks require execute bits.
Changed only these mismatches: deployment native/probe0755, imported authority
entry0644, bundled probe0755. Red3 tests reproduced the mismatch; green7 tests
in deployment/runtime-bundle passed1.56s, including actual bundle mode stat,
SQLite smoke and unprivileged installed-entry rejection. Typecheck/Biome passed.
No real installation or permission mutation occurred outside test artifacts.

### Rebuilt fixture-signer artifact candidate

Rebuilt official Node24/SQLite137/media JS bundle from root70d611553 at
/private/tmp/fly2551-runtime-fixture-signer; build guards passed actual SQLite
query and media version checks. Built forkc4e8f84 darwin/arm64 provider at
/private/tmp/fly2551-provider-fixture-signer, SHA256
85e50c4889a884d23fc310a06cdcd9ca35f4e3bca5b3afa7299388fa9d7ed436.
Its actual load commands remain system-only. Pinned Node24 imported the bundled
signer and refused the actual unprivileged invocation with the expected generic
error. No key read or root execution occurred.

Updated /private/tmp/fly2551-runtime-composite preserves browser and native helper
bytes while replacing JS/provider and provenance. Probe mode is now0755.
Current inventory /private/tmp/fly2551-runtime-fixture-signer-manifests:
697 entries,1132315347 bytes; JSON SHA256
e8ec1c70e0067526ae4b11f3ed894c7393408c92149904bdeb18d5755b573b2d;
native manifest5e0b920378fac3ec96069ec2e9a76a942a16705782c00d61a7dfa96c3014771b;
bootstrap policy97c021e18c760e03e107ee19ad37c661544a5c089addf980eeef4b0d71da7474;
installation metadataf62fb3026a6903dc59c27b08d07019e970b6d5901ae51d830eac799983a1d90b.
Actual shared native verifier accepted these bytes using fixture-only ownership
mapping. Authority/provider/fixture-installer configs remain explicit pending
slots, so this is not a production-installable or host-accepted package.

### Remaining implementation boundary pinned

Consumed Lead e73b0fbc-65f7-42ac-97c9-6a3e61c08049: fixture signer plus
validated offline artifact/config builder are this phase's source deliverables.
Real host probes and host activation proof share one follow-up design issue;
exact nine exclusion names are now in follow-ups.md. Inspected the actual
boundary-probe-entry mode dispatch: only three implemented fixture modes are
exposed, with unknown modes rejected; no partial host-probe branch retained.
Builder remains to implement; no trusted QA public inputs exist on this runner.

## 2026-09-15 — validated offline artifact/config builder

Implemented Lead e73b0fbc source boundary with an unprivileged assembler taking
only public config and externally supplied immutable root-owned QA bindings.
The strict binding schema has explicit target id, platform/architecture, five
numeric identity fields and public Ed25519 key; missing/untrusted/mismatched or
private-key-bearing inputs cannot finalize a production artifact.

The assembler uses the existing bounded direct runtime measurement as a shared
function, checks fixed layout/pin hashes/modes and required runtime files, copies
bounded regular single-link files, generates the downstream fixture-installer
config, and measures the final runtime. Raw authority/provider and QA bindings
are rechecked before the completion artifact is written last. Partial output is
retained without automatic retry/overwrite. Generated requirements include root
metadata/manifests and an explicitly external root0600 signing-key requirement;
no private key or acceptance signature is generated or copied.

TDD: initial builder suite could not load the absent assembler. Added outside-
runtime pin case then reproduced an accepted invalid package and reached green
after explicit containment validation. Generated root metadata/key requirements
were initially absent and their assertion failed before the requirements fix.
Final15 builder tests passed3.32s; existing inventory test passed with the shared
measurement refactor (16 distinct tests). Cases cover missing trust, key/host
mismatch, secret fields, enabled policy, provider/pin/mode/file gaps, actual CLI
refusal of model-owned QA bindings before output, QA drift, bounded-copy failure,
partial-output retention and no retry. Positive artifact tests use synthetic
runtime bytes and mocked root ownership; no production candidate was finalized.

Builder standalone TypeScript check passed. Full pnpm lint exited0 (4184 files,
18 warnings; no edits); pnpm -r build exited0. Logs are retained at
/private/tmp/fly2551-final-lint.log and /private/tmp/fly2551-final-build.log.
The new shell test currently visible versus main,
scripts/__tests__/lead-patrol-github-facts.test.sh, passed both guard groups.
It belongs to the inherited FLY-2519 dependency. Host package aggregate remains
interrupted-under-host-contention / not relied on; exact-head CI remains required.

PR-base audit6503776f-7a9c-4e72-9140-6b6c25e80e85: after fetching
main, the branch includes unmerged FLY-2519 dependency changes (617 files versus
main;246 files versus the plan-pinned e9eb59e422d2440fbe48c625568984fad4e0cc1a).
Current remote dependency head is9d7b4639054a8487c6d6df129fe46e6571443443.
No rebase/reset/force-push or dependency edits were made. Code review, exact-head
CI and both PRs remain incomplete; these local checks are not host acceptance.

Lead6503776f answered: open root Draft PR against main now for CI; disclose the
FLY-2519 dependency and expected diff shrink. Do not register code review yet.
After PR1191 is MERGED, perform exactly one origin/main merge (no rebase/force),
verify the diff contains only2551, mark ready and register exact-head review.
Poll PR1191 every10 minutes between bounded steps; never mark this wait blocked.
Initial GitHub poll: OPEN, mergedAt:null. No review request or merge performed.

## Draft PRs and provider exact-head CI

Root Draft https://github.com/xrliAnnie/flywheel/pull/1214 was opened against main
at b73cce1b94dc0907ce754cf32cb7fd9a089e6790, with the milestone as literal last
commit. Provider Draft https://github.com/xrliAnnie/xiaohongshu-mcp/pull/9 is linked.
Root GitHub mergeability is CONFLICTING/DIRTY and has no CI run yet. Lead answer
42743bd9 confirms this is expected while built on older2519: retain the draft,
perform no conflict merge now, and do the single main merge after1191 is MERGED.
No formal review has been registered.

Provider CI on c4e8f84 failed because Linux GCC -Werror rejected the ignored
write() result in guardian failed-exec reporting. Fork6cd94d34c2840781f842b47caa70ec55b9b8e491
reuses existing write_all there; local guardian race test passed8.417s.
Both exact-head Guarded write tests runs then passed:
https://github.com/xrliAnnie/xiaohongshu-mcp/actions/runs/35013860277
https://github.com/xrliAnnie/xiaohongshu-mcp/actions/runs/35013867510
The separate automatic GitHub Claude Review workflow failed for absent
Anthropic/OAuth/federation credentials. It is not the injected effective review
verdict; no credential or workflow changes were made. Failure was reported to
Lead separately and must not be represented as an all-checks-green claim.

Rebuilt native helpers and provider with the fix. Provider SHA256 stayed
85e50c4889a884d23fc310a06cdcd9ca35f4e3bca5b3afa7299388fa9d7ed436;
guardian SHA256 is89ca52c20ea9032f2988176756b510059c295db7bf112f8a7a1242259b87d43e.
Refreshed source candidate inventory at
/private/tmp/fly2551-runtime-provider-ci-fix-manifests:697 entries1132315380 bytes,
JSON2155e147c71ef65402d887c646d8af0cf517b0516bfc834385c40bbe363257aa,
native94a44a060cf58a29ac10d934eeea5d819c4ae7a8cfaeefbb54a7ceef631737a2,
bootstrap policye5e03135b86fcb29dd1c955f4733eb77af915b480773ee5346d7146e44fd1ce2,
metadata4c2221a5480c4976a55a8e1d7b1aac04dfe7d64d1f03e2a1f06ed01e2f1fd51b.
This source candidate still has no externally supplied production configuration;
it is distinct from the synthetic fully assembled builder tests and from host
acceptance. No root installation, real private key or activation occurred.

Dependency poll at2026-09-15T19:32:25Z: PR1191 OPEN, mergedAt:null,
head9d7b4639054a8487c6d6df129fe46e6571443443. Next poll no earlier than19:42:25Z.
The mandated one main merge and formal code-review registration have not run.

## 2026-09-16 — dependency merged; one authorized main sync

Lead instruction ba60803f-12c4-4c74-96f3-109e4fdb22d3 released the dependency:
PR1191 merged 2026-09-16T20:26:15Z. This branch merged main
`d1af40c719dcd8c16d4afc24b509c6275c9fc866` once, without rebase/force push.
Git reported58 conflicts because the inherited2519 history predates its final
main integration. Comparing against pinned2519 baseline
`e9eb59e422d2440fbe48c625568984fad4e0cc1a` identified44 conflicts with no2551
change; those retain main, including all2519 documents and milestone.
The other14 used that pinned baseline for a three-way content merge. The only
remaining manual conflict was the Claude reserved MCP names: retain main's
removal of gbrain and add2551's flywheel-xhs-write. No feature redesign.
The complete final diff against main has exactly the same250 path set as2551's
pre-sync diff against the pinned baseline, with no2519 documentation paths.

Fresh verification of the merged tree:
- frozen-lockfile install exit0; lint exit0 (22 warnings, no fixes).
- pnpm -r build exit0.
- ci-structure shell contract, xhs-write-mcp and mcp-inherit shell tests exit0.
- bash syntax and diff --check against main exit0.
- five conflict-relevant Vitest files:35/35 pass in9.77s. The initial attempt
  ran before the updated flywheel-config build completed and failed one test
  with installSqlTiming missing; rebuilding exports and rerunning without any
  source fix passed. Keep that initial failure distinct from the fresh pass.

The prior host-contention instruction still excludes restarting the local
aggregate; final exact-head CI is the aggregate gate. Review and CI remain
pending until bound to the pushed head. Provider PR9 remains at6cd94d3 with its
previous exact-head Guarded tests green; automatic Claude workflow credential
failure is separate from the injected effective review. No host activation,
real platform operation, QA dispatch or ship occurred.

## 2026-09-16 Quick Gate residue repair

Lead instruction 4a558471-4d42-4ae7-95c2-fe41c119c28f authorized only the
Quick Gate failure repair and one push followed by a fresh injected review.
CI run 35147117917 / job 104965912282 and a local main-only residue scan
both failed on the XHS-specific founderReceipt method and its two production
callers. This was a symbol collision with the FLY-1645 retired API denylist;
the method queries xhs_write_decision, not the retired receipt subsystem.
Renamed the method and all callers to receiptForFounderMessage without
changing queries, authorization behavior, or the residue scanner policy.

Fresh verification: residue-gate tests 5/5; main-only scan passed over 2757
files; affected observer, end-to-end, notifications and boundary-fixture-flow
Vitest files 50/50, exit 0 (8.20s). No host aggregate was run. Final exact-head
CI and effective review remain pending; provider PR9 stays at 6cd94d3.

## 2026-09-16 replacement-runner CI portability repair

Execution966274b3 resumed under implement TURN epoch10. Root4fe07d9ae's
review1378e5d5 returned APPROVED with15 MEDIUM/LOW advisories. CI35148695706
failed all four teamlead shards. The reported auto-narrow failures were expected
mutants: baseline green and3/3 killed. Fresh unchanged baseline checks passed
StateStore.auto-narrow-approval30/30 and eligibility6/6. No auto-narrow changes.

Lead scope answer325f2abc authorized one bounded test/fixture batch and one push:
- Use canonical os.tmpdir() instead of macOS-only /private/tmp test roots.
- Match the synthetic XHS provider inventory to production upstream rows;
  management operations remain owned by their real handlers. Other provider
  fixture inventories stay unchanged. No production broker change.
- Supply valid installation.metadata bytes in the immutable-file fixture.
- Bind ingress test proposals to the real process UID, also on Linux.
- Register the three dedicated-authority child-process sites in the census.

Red reproduction: census, default-parent and bridge-client-policy failed5 tests;
CI separately proves Linux ENOENT and requester-UID failures. First repair pass
was51 green/1 red: applying the upstream inventory restriction to all mock
providers omitted context7. Restricting it to XHS yielded the remaining1/1 pass.
All15 affected files now pass52 tests across the bounded runs; Biome and
 diff --check pass. No assertions were relaxed. Production authorization files
are unchanged. Unrelated verdict-cursor4/4 and done-thread-archiver56/56 passed
without edits; the prior aggregate failures remain recorded, not erased.

codex:rescue companion could not initialize a task thread: fs sandbox helper
exit71, sandbox-exec sandbox_apply Operation not permitted. No raw codex exec
or sandbox bypass. The injected formal review remains the effective gate;
new head needs fresh root review, then serial provider review at6cd94d3.
No host aggregate rerun, production activation, QA dispatch or shipping.

## 2026-09-16 XHS namespace fixture ID correction

CI35151184213 at c03058ef0 finished red: shard3 serial had six namespace
fixture failures plus automated-message-inventory timeout; all other work jobs
passed. Local unchanged reproduction: six failures,60 passes across the two
files; inventory passed. Canonical Discord ingress rejects nonnumeric reply IDs
before the namespace handler, while these six cases shared literal ship-card.

Lead answer b79277a6 explicitly authorizes only replacing its two occurrences
(message_reference.message_id and gateMessageId) with existing SHIP_CARD.
Assertions and production semantics remain unchanged. Focused
founder-reply-deliverer64/64 now passes; Biome and diff checks pass.
Lead confirms old review request23e22f9e failed nonzero_exit, so the new head
may be pushed once and receive one fresh formal review without waiting for it.
Provider remains6cd94d3; no host aggregate rerun or activation.
