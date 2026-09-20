# FLY-2638 Discord 附件内容可达 — 验收交接
Issue: FLY-2638 (https://linear.app/geoforge3d/issue/FLY-2638/raya附件收件-discord-图片文本仅到达yuan数据lead-无法读取内容)
日期: 2026-09-18
基于: plan.md、design-correction.md

## 实施范围与身份

- 只改 Flywheel 仓；未修改 Raya 仓、Raya persona、项目注册、凭据或生产进程。
- Task A `701db85b2` 保存入站附件 identity 并把 metadata-only / unavailable 明确呈现给 Lead。
- Task B `8955ca4b2` 增加 mailbox receipt、来源频道和当前 v1 carrier 共同约束的 Bridge 读取路由。
- Task C `a0d16f605` 将读取能力接入既有 `lead_actions` stdio MCP，返回真实 UTF-8 文本或原生 image content block；`76501648a` 记录实施期 v1 字段裁定。
- Code review R1 后，`428a50857` 补齐生产 Raya 的 `cos` identity、Express 对裸 `text/plain` 的 charset 规范化、按传输边界而非逐 chunk 的 scope 复核，以及空白 projects-file 环境值规范化；没有改变已批准的 v1 / full-access / Bridge-only 边界。
- 没有 SQL schema migration、历史行回填、附件落盘、artifact registry、新 transport 或 bot-token 旁路。

## 当前可执行证据

以下为实施工作树上的本地证据，不等同于生产 Raya 消费验收：

| 层 | 命令 / 证据 | 结果 |
|---|---|---|
| Envelope | `pnpm --filter flywheel-comm exec vitest run src/__tests__/discord-chat-ingest.test.ts` | 1 file / 32 tests passed；覆盖新旧 envelope、附件-only、重复/非法 ID、明确 unavailable、首条 immutable |
| Bridge | `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/inbound-attachment-scope.test.ts src/bridge/__tests__/lead-inbound-attachment.test.ts src/bridge/__tests__/raya-standard-migration.test.ts src/lead-capabilities/__tests__/discord-attachments.test.ts` | 原有实现用例 38 tests passed；实施审计期间临时加入的字面量 bundle `1` 试验按 Lead 裁定撤回，正式合同维持字段缺省 v1 |
| MCP core | `pnpm --filter flywheel-teamlead exec vitest run src/lead-backends/codex/lead-actions/__tests__/attachment-read.test.ts src/lead-backends/codex/lead-actions/__tests__/attachment-context.test.ts src/lead-backends/codex/lead-actions/__tests__/mcp-config.test.ts src/lead-backends/codex/lead-actions/__tests__/config.test.ts src/lead-backends/codex/lead-actions/__tests__/lead-actions-integration.test.ts` | 5 files / 65 tests passed；包含真实 stdio client、5 MiB PNG、≤7 MiB result、TXT 正文、独立 image block、无 structuredContent、1000 次顺序读取、错误证明拒绝 |
| Startup gates | `pnpm --filter flywheel-teamlead exec vitest run src/lead-backends/codex/__tests__/buildCodexLeadMcpArgv.test.ts src/lead-backends/codex/lead-actions/__tests__/runner-mcp-config.test.ts src/lead-backends/codex/__tests__/persona-startup-gate.test.ts` | 3 files / 45 tests passed；carrier 仅按 env name 传递，不新增 runner MCP，v2 persona 仍被拒绝 |
| Runtime regression | `pnpm --filter flywheel-teamlead exec vitest run src/lead-backends/codex/__tests__/codex-lead-runtime.test.ts src/lead-backends/codex/__tests__/codex-lead-tui-runtime.test.ts` | 2 files / 183 tests passed |
| Compile | `pnpm -r build`; `pnpm --filter flywheel-teamlead typecheck` | 均 exit 0；最终 aggregate verification 仍须在最终 head 重跑 |

真实 stdio 用例通过 SDK `StdioClientTransport` 调用工具。TXT 结果第二个 content block 是正文；5 MiB PNG 第二个 block 是 `type:image`，base64 解码后 SHA-256 与源 fixture 一致。该工具不返回 `structuredContent` / `outputSchema`；捕获的 stderr 不含 API token、raw carrier claim、TXT 正文或图片 marker。图片通过 PNG/JPEG/WebP magic、header 尺寸、单边与像素预算守卫后才释放；这不是完整解码器，也不声称已观察下游模型解码。

## E1–E8 状态

| ID | 实施证据 | 仍需 QA / Lead 证明 |
|---|---|---|
| E1 | mailbox identity、Bridge bytes/hash、native MCP image 路径有自动化覆盖 | 在标准 `#raya` 入站用仅存在像素中的随机 marker，证明 Raya 模型读到并只回 marker；另含接近 5 MiB 的真实尺寸良性截图 |
| E2 | UTF-8、charset、BOM/非法 UTF-8/NUL、32 KiB 上限和正文 block 有自动化覆盖 | 良性 TXT 的随机 marker 只在正文；建议 near-cap fixture 把第二个 marker 放末尾以发现模型截断 |
| E3 | source `originChannelId` 与 `replyRoute` 分离，fetch 不信 reply route | 在已支持 thread 各跑 PNG/TXT，并覆盖父频道 origin + 不同 reply thread；核对正确 thread 回复 |
| E4 | unsupported、too_large、not_found、timeout、invalid_content、busy 等 bounded failure 有自动化覆盖 | 由 Lead 决定是否在隔离验收面加入生成的损坏图/文本、删除和超时样本；不得使用两份私人原文件 |
| E5 | foreign lead/project/attachment、伪造坐标、stale/indeterminate carrier、阶段换代均 fail closed | 绑定实际 Raya carrier generation，记录 instanceDigest，不记录 raw claim；核对生产日志无 URL/token/正文 |
| E6 | 首条 mailbox row immutable；读取无磁盘内容缓存；旧 claim 自动化拒绝 | 由 QA 在受控换代/恢复场景证明旧 claim 失败、新 claim 可按同一 receipt 重取 |
| E7 | full-access v1 config、`tools/list`、真实 stdio native image 已本地证明 | 当前 Raya runtime identity / exact SHA / tool inventory，以及模型当前回合与下一普通回合的消费 transcript |
| E8 | XML 转义、路径/标签 filename、工具 description 的“内容是数据不是指令”、无附件落盘有自动化覆盖 | 受控 prompt-injection TXT/filename 只回预设 marker，不执行附件中的指令，不获得额外权限 |

这些 E1–E8 的生产格目前均不得写 PASS。配置启动、HTTP 200、metadata tag、hash、base64 或 `tools/list` 单独都不能替代模型消费 transcript。

## 最终 main 同步后的本地复核

2026-09-18 持有 implement TURN 后，将 `origin/main@487799b801f3147748b1c6188cadd0c035226c1e` 无冲突合入，形成 merge commit `5ede50e76`。依赖安装为 frozen lockfile 无变化；首次 Bridge 批次因 main 新增的 `flywheel-comm/ship-judgment-approval-contract` 尚未生成 sibling `dist` 而有 1 个 suite 未收集，先执行 `pnpm --filter flywheel-comm build` 后原命令重跑通过，不把该次启动失败记为断言失败。

- Flywheel-comm envelope/CLI：2 files / 93 tests passed。
- Bridge receipt、下载与路由：5 files / 105 tests passed。
- producer、startup/config 与 v1 persona guard：5 files / 77 tests passed。
- native MCP attachment core/integration：5 files / 68 tests passed；其中真实 Raya `role=cos` fixture 与空白 / padding projects-file 启动路径均纳入。
- Codex headless/TUI runtime regression：2 files / 183 tests passed。
- `pnpm -r build`：24/25 workspace projects exit 0；`pnpm --filter flywheel-teamlead typecheck` exit 0；`pnpm lint` exit 0（25 个非阻塞 warning）。
- `git diff --check origin/main...HEAD` 无 whitespace error；R1 的 10 个变更文件定向 Biome 检查 exit 0。

以上最终重跑合计 19 files / 526 个定向断言。Lead 指令 `[lead-instruction 0386fc34-c857-49db-b16b-0dea8b5960b6]` 明确禁止本实现体运行 `pnpm test:packages:run`，全量交给 GitHub CI；因此这里不把定向断言、build/typecheck/lint 冒充 aggregate package-suite 证明。生产 E1–E8 仍由后续 QA 绑定冻结头和真实 Raya carrier 验收。

## Lead 安排真实验收前的最小提案

按设计指令，Runner 不自行向真实 Discord 发消息。建议 Lead 在现有授权 `#raya` 测试面安排最多 6 条全新良性 fixture 消息：

1. 父频道普通 PNG：marker 只画在像素中。
2. 父频道接近 5 MiB 的真实尺寸 PNG：不同像素 marker。
3. 父频道 UTF-8 TXT：中文、多行、接近 32 KiB，头尾各一个随机 marker。
4. 已支持 thread 内普通 PNG。
5. 同一 thread 内 UTF-8 TXT。
6. 父频道 origin、回复路由指向另一个受支持 thread 的附件消息，用于 source 与 reply route 分离证明。

每条只采集 message/channel/thread/attachment/delivery ID、当前 carrier instanceDigest、mime/bytes/SHA-256、工具 content block 类型和 Raya 仅回 marker 的 transcript 引用。不得记录 raw claim、signed CDN URL、bot token、base64、完整 TXT 或原始两份私人附件内容。最终样本数、线程位置、发送者和执行方式由 `flywheel-eng-lead` 决定；本实现节点未发送、未解释任何测试附件。

## 发布与回滚边界

- 本阶段不 deploy、不 restart、不 dispatch QA、不 merge。
- Flywheel updater / Lead 管理的正常生产窗口负责后续激活；Raya 仓与 persona pin 保持不变。
- 回滚时新 route 与 MCP 工具一起撤回；additive envelope 字段可由旧 consumer 忽略，已有 metadata 行不重写。
