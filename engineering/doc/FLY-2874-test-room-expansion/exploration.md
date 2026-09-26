# FLY-2874 测试房扩容到六间 — 探索
Issue: FLY-2874 (https://linear.app/geoforge3d/issue/FLY-2874/529-房扩容-测试房-4-6-间加-slot-56bot文字频道bridge-端口-每间一个语音频道补-voice-test-456)
日期: 2026-09-24
基于: 无

## 目标与锁定范围

Founder 已确认把 529 测试房从 4 间扩到 6 间。本实施只扩容现有 slot 模型，不重做测试房架构：

- 增加 slot 5、6，各自拥有独立 bot、文字频道、Bridge 端口、锁、状态目录和 CommDB。
- 让 slot 1–6 各自绑定一个唯一语音频道；现有 `voice-test-1/2/3` 保留，新增 `voice-test-4/5/6`。
- 让部署、拆房、认领、端口和 529 操作入口都能处理 1–6。
- 不改动正在运行的 slot 1–4；真实开房、拆房必须先取得 Lead 授权。
- 不读取、打印、转发或代填新 bot token。Founder 只在本机 `~/.flywheel/.env` 写入 `TEST_BOT_TOKEN_5/6`。

## 当前事实

- `scripts/test-deploy.sh` 和 `scripts/test-teardown.sh all` 已主要按 `test-slots.json` 的长度工作，主路径不是固定四房。
- `scripts/qa-fly-60-driver.sh` 仍把 slot 限定为正则 `[1-4]`。
- QA runner 说明和两份 529 suite 仍写死“4 个 slot / 19871–19874 / 1–4”。
- 当前 `~/.flywheel/test-slots.json` 只有 slot 1–4；端口依次为 19871–19874。
- 当前 Discord `QA Testing` 分类下只有 `voice-test-1/2/3`，没有 `voice-test-4/5/6`。
- 现有测试 bot 的实时 guild 权限不含 Manage Channels，无法通过 bot API 创建频道；Discord 侧必须由 Founder 创建。
- 语音部署现在依赖显式 `--voice-fixture <json>`，slot 配置自身没有文字频道到语音频道的一一映射。

## 假设

1. slot 5 复用 slot 2 的 product Lead/Codex 形状；slot 6 复用 slot 3 的 ops Lead/Claude 形状。
2. `botAppId` 继续等于单 bot 应用的 bot user ID，与现有配置和 Discord allowlist 逻辑一致。
3. 新文字频道分别命名为 `product-lead-test-2`、`ops-lead-test-2`；语音频道严格命名为 `voice-test-N`。
4. slot 配置是容量、端口和频道映射的唯一真源；脚本不另建第二份 1–6 常量表。

## 方案比较

### A. 推荐：扩展现有 slot 记录

给每个 slot 增加 `voiceChannelId`、`voiceChannelName`，slot 5/6 继续使用同一 `slots[]` 数组。部署读取并校验文字与语音坐标，语音 fixture 必须与该 slot 的映射一致。

优点：单一真源；认领/端口/拆房继续沿用动态容量；改动最小。缺点：需要迁移本机配置并补映射验证。

### B. 新增独立 `voiceSlots` 表

文字 slot 与语音 slot 分开配置，再按 id join。

优点：语音配置看起来独立。缺点：两个表会漂移，部署时必须处理缺项、重复 id 和跨表错配，不符合本次小范围扩容。

### C. 在语音脚本内硬编码 1–6 频道 ID

优点：实现最快。缺点：把机器特定 Discord ID 写进仓库，且与 `~/.flywheel/test-slots.json` 形成第二真源；不采用。

## 载体选择

slot 5 按 slot 2 设置 `backend: codex-app-server`、`codexProfile: full-access`；slot 6 保持默认 Claude carrier。这样 slot 5+6 的一次 N-to-N 验收天然覆盖 Codex ↔ Claude 的混合载体，同时只增加一个 Codex app-server 房，保持现有测试池的形状多样性。

## 成功判据

- 静态配置中恰有 6 个唯一 slot，端口为 19871–19876，文字/语音频道均一一对应。
- slot 5、6 分别完成部署、`/health` 200、拆房，且锁、launchd、端口全部释放。
- slot 5+6 完成一次 N-to-N 部署。
- slot 1–4 的配置值保持不变，只补各自语音映射；实施期间不对其做开房或拆房操作。
