# FLY-2519 Codex Lead 能力对等 — 调研
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-13
基于: exploration.md

## 证据等级

以下源码基线为 `26ebc4931`。配置、源码和真机完成是不同证据；“已存在”仅表示已有入口，所有验收复选框均留给实现/QA。本轮只读提取 live 配置的 server/credential 名称、非秘密身份字段，未输出 credential 值。对其他项目历史工作树没有执行脚本。

## 能力差集与逐项验收目录

`Pxx` 是本单稳定行号，不是生产权限标识。实施 PR 必须原样带入逐项勾选并链接实际证据；新增审计发现必须加行，不能悄悄归为 out-of-scope。

| ID | Claude 部门 Lead 实际入口 | Codex 当前源码/配置 | 差集处置与通过证据 |
|---|---|---|---|
| P01 | Bridge 派单、runner 管理 | #1162 六工具已存在 | 保留；同身份成功 start/list/status/read/send/respond，未知 start 结果按原 key 对账 |
| P02 | Discord inbound + reply | runtime 收取/自动回复，proactive send 仅 alias | 保留持久收信/ACK；新 issue-thread 解析、读取/回复/创建补齐；不同线程不串写 |
| P03 | Discord fork `fetch_messages` | 无模型主动历史读取工具 | 有序分页读取，messageId/cursor 可对账 |
| P04 | Discord fork `react/edit_message/download_attachment/reply files` | 无对应受管工具 | 同 bot 编辑、reaction、附件下载/发送全部补齐；凭证/路径不外泄 |
| P05 | `linear-api` HTTP MCP | 不在 full-access 精确 server 清单 | 读/search/create/update/assign/relations/comments，保留项目/团队/部门门禁；真实 comment URL |
| P06 | gh/git shell | network/project write 已有，auth 来自 host/env | 保留 diff/status/log/feature branch；认证操作 broker 化；PR/read/checks/comment/create/edit/diff/review evidence |
| P07 | Bridge API 与 comm CLI | full-access 有 API env；六 runner tools 仅一部分 | 目录覆盖实际 Lead read/write routes；治理/恢复门禁不变；每条分类及契约测试 |
| P08 | terminal MCP capture/list/search/status/input/close | 六工具覆盖前三者部分；search/input/lifecycle 非完整 | 共用 terminal 业务核心；输入前 waiting+精确 execution；close 由原 founder 专属流程执行，broker 直接拒绝（见 plan.md §2） |
| P09 | inbox ACK batch/event 与持久通知 | ack_batch + runtime mailbox | 保留 batch；补 event ACK 对等；token 留在可信侧，模型仅引用 event handle |
| P10 | `lead-patrol-snapshot.sh` + dwell judgment receipt | 脚本存在，但写 ~/.flywheel/ 和 tmux 访问不能由 project roots 推定可用 | 可信 adapter 执行既有快照脚本；read 与 judgment 写分开；完整六步结果及 unknown 保留 |
| P11 | publish-report/verify-report/founder-html-delivery | comm 实现 vendor neutral，但认证 env | 复用报告管道；publish-only 与 deliver 分开；HTTP/CSP/nonce 与真浏览器评论验证 |
| P12 | Chrome/Playwright/Claude-in-Chrome 类浏览器 | full-access 配置闸只允许 lead_actions | 独立 Chrome DevTools MCP；可见浏览器、截图/DOM/交互/网络证据；Claude-in-Chrome 调用零次 |
| P13 | R1–R5/部门规则/回复协议/default-enable | base resolver 有治理；漏 default-enable、Discord 合同 | 共用有序规则选择器；vendor 文案适配；实际输入文件双向比较 |
| P14 | persona/项目 shared/PM/HTML/screenshot skills | identity 自称 Claude；Codex 没有完整 skills provision | 后端中性 persona；相同适用源、明确 adapter；真实会话可见并成功使用 |
| P15 | gbrain/project knowledge | Claude launch 挂载 gbrain；Codex 未挂载 | 共用配置服务的 read/search/write 语义；凭证 broker；项目隔离与读写 receipt |
| P16 | Xiaohongshu MCP/学习 skills | live Claude MCP 配置存在；Codex Lead 未挂载 | Codex native MCP 适配同服务，保留账号/收藏访问与授权写操作；不能当无关项跳过 |
| P17 | Context7/其他启用插件工具、搜索/文件写作 | native shell/web 能力与 skill availability 尚未逐项验 | 部署前完整 tools/skills inventory；Context7 docs 查询等价，应用无 Claude 运行时依赖；新适用项逐项补齐 |

上表不是宣称 Tadashi 调用过每个已配置工具；它覆盖当前实际安装入口及角色要求，真实调用证据由逐项验收补上。`~/.flywheel/lead-workspace/flywheel-eng-lead/.mcp.json` 当前 server 名称为 linear-api、xiaohongshu-mcp、flywheel-terminal、flywheel-inbox、gbrain。product 同名配置可能是旧 Claude 残留，不是 Codex 在线能力。

## 源码锚点与消费者

| 锚点 | 当前事实与设计影响 |
|---|---|
| `packages/teamlead/src/lead-backends/codex/lead-actions/mcp-config.ts:18,109,152,258` | 两个基础工具、无 broker、env_vars 凭证、只允许一个 server。新增 browser 必须同时改生成与解析，不是手改 home |
| `.../runner-action-names.ts:2`、`runner-action-context.ts:39` | 六工具单一名单；调用时重读 registry 与 identity。扩展沿用 shared handler，不复制身份/菜单解析 |
| `.../lead-actions/lead-actions-main.ts:148,235` | proactive alias send，持久 batch ACK；没有 thread/history/Linear |
| `.../codex-lead-runtime.ts:379,396,459,1004` | full-access network on、项目唯一 write root；正向 env 表含 secret，MCP options 共用入口 |
| `.../codex-lead-tui-runtime.ts:175,211,574,693,1105` | daemon 继承 bot/master token；MCP 每轮临时拉起；不准恢复已删除的 startup live-ready watcher |
| `.../secret-broker.ts:5,94` | 旧 broker 把全部秘密返回 socket client；依赖 network-off 沙箱 connect 拒绝，不能直接移植到 network-on |
| `.../confinement.ts:1,108` | 旧 profile 验证 network=false，仅能借测试方式，不能复用其结果证明 full-access |
| `packages/teamlead/scripts/codex-lead-tui-home.sh:582,712,789` | 重建 managed TOML；外部追加 browser 配置下次会消失；配置/技能必须由受管生成器产生 |
| `packages/teamlead/scripts/claude-lead.sh:2305,2402,2420,2552` | terminal/inbox/gbrain、本机 MCP 合并、plugin/browser 条件加载；不能只比较 .mcp.json |
| `packages/terminal-mcp/src/index.ts:114,156,247,321,376,445` | 六个终端工具；close 具有真实生命周期副作用。复用内部 handler，不能盲目全量启用 server |
| `packages/inbox-mcp/src/index.ts:83,110` | batch/event ACK 是两种 receipt，不可互换；Codex event handle 到 token 的转换在可信内存中完成 |
| `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.5/server.ts:1058` | 已安装 fork 暴露 reply/react/edit_message/download_attachment/fetch_messages；仅审计，Codex 不运行该插件 |
| `packages/teamlead/scripts/lead-rules-bundle.sh:16,337` | base 选择器故意不含项目层；需要新的共享完整 source selector，不能假设已有完整对等 |
| `packages/teamlead/scripts/claude-lead.sh:2788,2904,2919,2964` | default-enable、Discord、项目 shared、可选截图规则为遗漏来源 |
| `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts:384` | 当前检查 resolver 是 Claude 子集，漏了反向集合差集 |
| `.lead/flywheel-product-lead/identity.md:12,51,209` | Honey Lemon 保留写作/13 PM skills；自称 Claude 的文案需要 vendor adapter；Agent 禁用不因对等取消 |
| `scripts/lead-patrol-snapshot.sh:110,145,1826` | 默认写报告目录；dwell 模式额外写 receipt，必须独立动作 |
| `packages/flywheel-comm/src/commands/publish-report.ts:135,194,263` | env 凭证，publish-only 与 deliver 分离；reuse handler 保留报告 hosting 合同 |
| `packages/teamlead/src/bridge/reports-route.ts:249,430` | publish/deliver 分开，master/ingest tier；不走旧 `/api/publish-html` 别路 |
| `packages/flywheel-comm/src/lead-lease.ts:2790` | `authorizeLeadWrite` 的 canonical identity/lease 是共同写门禁，不由工具参数发明另一身份 |
| `packages/teamlead/lead-rules-base/founder-only-authority.md:72,271,415,461,507,584` | R1 merge、R2 lifecycle、R3 infra-bot-only、R4 updater、R5 空 registry、AUTH-CANON；不复制授权语言 |

`.../` 表示 `packages/teamlead/src/lead-backends/codex/`。实现前每个修改文件都重新读取当前版本，若同步 main 改动语义则补设计 appendix。

## 外部一手资料（2026-09-13 核验）

- [OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)：支持 stdio/HTTP server，config.toml 可配置 env_vars 与 enabled_tools。env_vars 是转发已有环境，不是 secret 隔离机制。
- [Chrome DevTools MCP 官方配置](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)：支持可见 Chrome、独立 userDataDir、关闭 usage statistics/CrUX；版本相关参数必须与锁定包的 help/schema 对照。
- [Chrome DevTools MCP 并发与 profile 说明](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md)：默认 profile 会复用且并发冲突；不同 Lead 应用独立 profile/实例。现有 authenticated session 会带入登录态。

推论：本项目选择每 Lead/activation 独立的 QA Chrome，使用仓库锁定版本和本地路径启动；不用 `@latest`、autoConnect 或公共调试端口。官方配置能力不证明本机启动/沙箱/会话恢复可用。

## 测试形态

优先沿用 teamlead Vitest、comm 单测、launcher shell fixtures；broker/provisioning/schema 属于需要 TDD 的行为改动。实时生产写入仅在后续已授权 issue 验收内进行；本设计不执行。macOS 不运行可能关闭真实 terminal 的 root `pnpm test`；Node runner 与 Vitest flags 分开。
