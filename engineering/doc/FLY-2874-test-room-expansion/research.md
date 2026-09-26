# FLY-2874 测试房扩容到六间 — 调研
Issue: FLY-2874 (https://linear.app/geoforge3d/issue/FLY-2874/529-房扩容-测试房-4-6-间加-slot-56bot文字频道bridge-端口-每间一个语音频道补-voice-test-456)
日期: 2026-09-24
基于: exploration.md

## 1. 当前 slot 运行模型

`scripts/test-deploy.sh` 从 `~/.flywheel/test-slots.json` 读取 `TOTAL_SLOTS`，自动认领循环以该长度为上限；指定 slot 通过 `SLOT_IDX=slot-1` 读取 bot、文字频道和端口。`scripts/test-teardown.sh all` 也按配置长度循环。因此 5/6 的主要运行路径已经是配置驱动，缺口集中在配置完整性、早期范围校验、语音映射和遗留入口文案。

`scripts/lib/qa-multilead.sh` 按 slot `id` 解析 `--extra-lead`，没有四房上限；新增 slot 5/6 后可直接组成一个主 slot + 一个借用 slot 的 N-to-N campaign。锁目录和状态目录都以实际 slot 数字命名，不需要新命名协议。

## 2. 必须修改的固定四房命中

| 文件 | 当前事实 | 处置 |
|---|---|---|
| `scripts/test-slots.example.json` | 只有 slot 1–4，且没有语音字段 | 补 slot 5/6；给 1–6 增加 `voiceChannelId` / `voiceChannelName` |
| `scripts/qa-fly-60-driver.sh` | usage 与正则固定 1–4 | 从 `test-slots.json` 读取容量并验证正整数范围 |
| `scripts/test-teardown.sh` | `all` 在配置读取失败时静默 fallback 到 4 | 改为配置读取失败就 fail closed，不再假设容量 |
| `scripts/test-deploy.sh` | 指定 slot 没有在昂贵 preflight 前做配置范围校验；语音 fixture 与 slot 无绑定 | 增加配置范围校验，读取/校验语音字段，fixture 必须匹配 slot 语音映射，并把映射写入 room-info/stdout |
| `scripts/qa/fly2655-voice-room.mjs` | 只校验 fixture ↔ final projects，不校验 slot 映射 | 增加 room-info ↔ fixture 的频道一致性检查 |
| `scripts/__tests__/test-deploy-multilead.test.sh` | 注释称 slot 27 在真实 4-slot pool 外 | 更新为 6-slot pool，行为不变 |
| `scripts/setup-mirror-channel.sh` | 注释笼统称“四个 test bots” | 改为“参与 mirror 的 bots”；mirror 本身仍固定 slot 1–3 |
| `packages/qa-framework/README.md` | 默认池、端口、bot 数量仍写 4 | 改为 6；明确 mirror 仍只用 1–3 |
| `packages/qa-framework/agents/qa-parallel-executor.md` | 端口、池大小、role map 固定 4 | 改为 6，补 slot 5/6 与语音一一映射说明 |
| `packages/qa-framework/suites/fly-60-hard-gate.md` | 环境和前置写 4 / 1–4 | 改为 6 / 1–6 |
| `packages/qa-framework/suites/fly-161-runner-question.md` | 环境和前置写 4 / 1–4 | 改为 6 / 1–6 |
| `doc/qa/framework/real-runner-e2e-guide.md` | `<N>` 说明固定 1–4 | 改为 1–6 |

## 3. 明确保留的命中

- `test-deploy.sh --mode mirror` 仍固定 slot 1/2/3，因为该拓扑特指 cos/product/ops 三角色共享频道；slot 5/6 是 per-slot 扩容，不自动加入 mirror。只修正错误文案，不扩 mirror 拓扑。
- `qa-fly-153-mirror-smoke.sh` 和 mirror setup 的 1/2/3 循环属于上述专用拓扑，保留。
- FLY-2456 drill 中固定使用 slot 4 的 manifest、报告和测试，是该历史场景的 round 选择，不是池容量上限，保留。
- `scripts/teamlead-ci-shard.mjs` 的 `[1-4]/4` 是 CI 分片数，和测试房无关，保留。
- `scripts/__tests__` 中的四帧、四次重试、UUID、字节阈值及历史 fixture 均不是 slot pool，保留。
- `doc/qa/reports/**` 与归档 exploration/research/plan 是历史证据，不回写旧结论。
- `doc/qa/framework/529-room-playbook.md` 中示例 slot 4 是具体演练示例，不表示上限，保留。

## 4. 语音映射

现有 FLY-2655 路径要求调用者传一个 public fixture，fixture 含 `guildId`、`voiceChannelId`、`qaCategoryId`、Founder user id 和 allowlist。安装后会把 voice room 投影进 slot-private projects registry，并由 `loadSlot()` 校验 final registry。

本次最小闭环是在每个 slot 记录中加入：

```json
{
  "voiceChannelId": "<discord-channel-id>",
  "voiceChannelName": "voice-test-N"
}
```

正式 1–6 slot 配置必须完整、唯一地提供这两个字段；为保持现有纯文字合成夹具兼容，普通部署只在字段存在时投影映射，使用 `--voice-fixture` 时才强制两个字段存在，并要求 fixture 的 `voiceChannelId` 等于显式指定 slot 的映射。generalized `room-info.json` 与 stdout 携带可用映射，语音 room loader 再校验 room-info 与 fixture 一致，形成“配置 → 部署 receipt → 语音 runtime”的三点闭环。

## 5. slot 5/6 形状

| Slot | Bot | Text channel | Port | Role / identity | Backend | Voice |
|---|---|---|---:|---|---|---|
| 5 | `flywheel-test-5` | `product-lead-test-2` | 19875 | `lead` / `product-lead` / `product-test-2` | `codex-app-server`, `full-access` | `voice-test-5` |
| 6 | `flywheel-test-6` | `ops-lead-test-2` | 19876 | `lead` / `ops-lead` / `ops-test-2` | default Claude | `voice-test-6` |

slot 5 复用 slot 2 的 Codex app-server 写法；slot 6 保留 Claude，使 5+6 的 N-to-N 验收覆盖混合 carrier。

## 6. Discord 实时盘点

2026-09-24 通过现有 slot bot 做了只读 API 核对（未输出 token）：

- guild：`1485787271192907816`
- QA Testing category：`1493080958889496760`
- 文字频道 slot 1–4 均在该分类下；专属 bot overwrite 为 View + Send + Read History（`68608`）。
- 语音频道目前只有：
  - `voice-test-1`: `1542708566417211423`
  - `voice-test-2`: `1542708795720081408`
  - `voice-test-3`: `1542709028742893699`
- 现有 bot 可读取各自语音频道，但 guild 权限不含 Manage Channels，无法创建或改频道权限。
- 新 bot 的 guild managed role 继续严格使用现有 `68608`（View + Send + Read History）；Connect、Speak、Use Voice Activity 只通过各自 `voice-test-N` 的频道 overwrite 授予，避免新测试 bot 获得其它语音频道的 guild 级进入能力。

因此已通过 Lead 提交 Founder 清单，question id 为 `85a18e11-26a7-4901-92ab-f53405d83bdb`。分工是 Founder 创建两个应用并自行写 token，Lead 以 Founder 的 Chrome 会话创建两个文字和三个语音频道；只回传 application/channel ID，token 不经过聊天。

## 7. TDD 与验证边界

先新增失败测试覆盖：

1. example config 的 slot 1–6 连续性、端口、token env、bot 名、语音名/ID字段、slot 5/6 carrier 形状。
2. `qa-fly-60-driver.sh` 接受配置内 slot 6、拒绝 slot 7。
3. `test-deploy.sh` 读取语音映射并拒绝 fixture/slot 错配。
4. `fly2655 loadSlot()` 拒绝 room-info/fixture 语音频道错配。
5. teardown all 在 slots 配置不可读时 fail closed。

本地只跑相关 shell/Node 测试、`pnpm lint`、受影响包 build，以及 changed TypeScript 的 owning-package `vitest related`（本次预计无 TypeScript 生产文件）。真实 slot 5/6 deploy/health/teardown 与 5+6 N-to-N 依赖 Founder 提供的新身份/频道，必须在代码绿且 Lead 授权开房后执行。
