# FLY-2873 Codex 测试房附件读取 — 探索
Issue: FLY-2873 (https://linear.app/geoforge3d/issue/FLY-2873/病根529-房-codex-载体-lead-在测试房读不了附件默认-direct-出站没有读取身份transport-unavailable)
日期: 2026-09-24
基于: 无

## 目标

让 529 测试房中的 Codex 载体 Lead 通过自己的 `discord_read_attachment` 工具，沿既有 Bridge `/api/lead-inbound/attachment` 路由读取真实截图与文本附件。实现阶段只修测试房部署与身份投影缺口，不改附件读取产品协议，不改变生产 Lead 的出站或 carrier 行为。

## 已知现场

- Discord 入站、RestPoll、收件信封、逐附件元数据与 Bridge 路由匹配已经在 FLY-2757 QA 现场走通。
- 当前 `scripts/test-deploy.sh` 默认把 Codex slot Lead 的 `FLYWHEEL_CODEX_LEAD_OUTBOUND` 设为 `direct`。附件上下文解析明确只允许 `bridge`，所以读取工具返回 `transport_unavailable`。
- 把测试旋钮切到 `bridge` 时，slot Lead 的部署环境没有携带运行附件工具所需的 Bridge endpoint/token，真 Lead 启动后才 fatal。
- QA 手工替 Lead 调路由时，初始身份与 receipt 校验通过，但 carrier 复核返回 `carrier_expired`；这只能证明路由拒绝了手工拼装的 carrier claim，不能替代 Lead 自己调用工具的证据。
- 测试 bot1 的频道权限由 founder/Lead 管理，本实现不得更改。

## 边界与不变量

- Codex 载体不使用 mirror/roundtable 模式。
- 原始 carrier claim、API token 与 bot token 只通过环境变量名/环境值传递，不写入 TOML、argv、日志、错误或工具结果。
- 生产 launcher、生产默认出站选择与生产 carrier 校验逐字节不变；改动限定在 `scripts/test-deploy.sh` 及其直接回归测试，除非研究证据证明还存在同范围的必要调用点。
- 本地只运行相关脚本测试、相关 Vitest、受影响包构建/类型检查与 `pnpm lint`；不跑本地全包测试。
- 不开、不拆 529 房；真实房间回归由 QA 阶段在 Lead 授权后执行。

## 待证问题

1. direct 的 `transport_unavailable` 与手工路由的 `carrier_expired` 是否来自同一根因，即 test-deploy 没把稳定的 slot carrier 身份上下文投影给 Codex Lead。
2. 测试房应当默认对齐生产 Codex Lead 的哪种出站模式，以及 endpoint/token/carrier claim 的权威来源分别是什么。
3. 部署前置检查应在何处 fail loud，才能在创建 Lead carrier 前拒绝缺失变量且不泄露敏感值。

## 预定测试 seam

公共 seam 是 `scripts/test-deploy.sh` 生成并实际交给 slot Codex Lead 的 launch environment，以及真 Codex runtime 暴露的已脱敏环境证据。回归必须做到：

- 正向：bridge 模式下，Lead 启动环境具备附件读取所需 endpoint、API token 和当前 carrier 身份上下文；
- 负向：去掉任一关键投影时，部署阶段非零退出并给出变量名级错误；
- 生产不变：生产 launcher 文件无 diff，测试房之外的默认行为不变；
- 现场硬红由后续 QA 用 Lead 自己的读取工具完成，不用手工 HTTP 代调。
