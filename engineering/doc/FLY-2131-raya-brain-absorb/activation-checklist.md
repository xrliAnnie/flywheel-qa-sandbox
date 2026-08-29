# FLY-2131 Raya 大脑激活检查单 — 部署检查单
Issue: FLY-2131 (https://linear.app/geoforge3d/issue/FLY-2131/rayav2-m2-大脑summary-吸收-追问-可见汇报承接-fly-2030-m1)
日期: 2026-08-28
基于: plan.md

这是一张 **fail-closed operator 检查单**，不是本 PR 的部署授权。正常部署只走
00:00/12:00 updater 班车；没有 founder 单次明确授权时，不投紧急重启票。

## A. 激活前置

- Flywheel 本单构建已经由 updater 安装；安装产物同时包含
  `flywheel-comm/dist/summary-pr-merge.js`、Raya TUI launcher、context usage
  recorder 与 absorption rider。
- Raya PR-C 已 merge 且对应 brain/voice 构建已经部署。
- summary granularity 已选择，summary registry migration receipt 仍与当前
  `projects.json` 匹配。`summary_registry_activation_preflight` 源文件缺失或
  verify 失败均必须阻断整次 deploy。
- 选一张已知合规的 `xrliAnnie/raya` summary fixture PR（open 或 merged）。
  preflight 只跑 `--dry-run`，不会 merge、不会写回执。

## B. 唯一 registry 行

在 canonical `projects.json` 增加且只增加一个 Raya project / Lead。路径必须替换为
本机最终绝对路径；Discord 与 bot identity 值不得漂移：

```json
{
  "projectName": "raya",
  "projectRoot": "/Users/xiaorongli/Dev/raya-lead-workspace",
  "projectRepo": "xrliAnnie/raya",
  "memoryAllowedUsers": ["annie", "raya"],
  "generalChannel": "1542079099928059987",
  "leads": [
    {
      "agentId": "raya",
      "chatChannel": "1542079099928059987",
      "botTokenEnv": "RAYA_BOT_TOKEN",
      "botUserId": "1542068543645024257",
      "canSpawnRunners": false,
      "backend": "codex-app-server",
      "codexProfile": "full-access",
      "role": "cos",
      "model": "gpt-5.6-sol",
      "effort": "xhigh",
      "modelContextWindow": 1000000,
      "summaryRole": "recipient"
    }
  ]
}
```

注册后先跑 canonical registry validator，不允许用 launcher env 覆盖任何 identity
坐标。`raya/raya` 必须是唯一命中；`summaryRole=recipient` 且
`canSpawnRunners=false`。

## C. workspace 与 memory 一次性迁移

1. 停 Raya brain / voice；确认没有进程持有 memory checkout。
2. 把现有 `raya-memory` canonical checkout **整体移动**到
   `/Users/xiaorongli/Dev/raya-lead-workspace/memory/`；不要创建第二个 clone。
3. 建 `/Users/xiaorongli/Dev/raya-lead-workspace/state/`。workspace 必须在
   `~/.flywheel`、Codex state 与 CODEX_HOME 之外；memory worktree 必须 clean。
4. 同一个 operator transaction 内更新 `raya.env` 两处：
   - `RAYA_MEMORY_FILE=/Users/xiaorongli/Dev/raya-lead-workspace/memory/MEMORY.md`
   - `RAYA_WORKSPACE_ROOTS_JSON` 保留 code root，并把旧 memory root 替换为新
     `.../raya-lead-workspace/memory`。
5. `RAYA_VOICE_OPTIONS_JSON.startInstructionsFile` 指向已部署 checkout 的
   `apps/voice/assets/start-instructions.zh.md`。
6. 先跑 brain / voice config preflight；任何 path、总长或 prompt 通道证据缺失都
   不启动服务。

## D. 机械激活 preflight

从 updater 已安装的 Flywheel checkout 执行：

```bash
RAYA_SUMMARY_FIXTURE_PR=<compliant-pr-number> \
RAYA_LEAD_WORKSPACE=/Users/xiaorongli/Dev/raya-lead-workspace \
packages/teamlead/scripts/raya-activation-preflight.sh
```

它必须同时证明：installed `summary merge --dry-run` 完成当前 head 的完整验证、
canonical identity 精确为 `gpt-5.6-sol / xhigh / 1,000,000`、memory/state
拓扑可读、full-access TUI launcher 到达 side-effect-free dry-run。任一格失败就不
注册、不启动 Raya。

## E. 班车后真机验收

- 吸收：触发一轮真实 `roundId`，核对 unread PR snapshot、所有 merge 回执均含
  verified head、`MEMORY.md` commit provenance 含 summary path + roundId，且
  `#raya` 出现时间/数量/动作可见汇报。
- 追问：用 Judgment 缺失 fixture 验证 PR 保持 open、roundtable 问题含
  `{roundId, pr}`；纯追问轮也必须在 `#raya` 汇报。
- 恢复：分别注入 question posted 前后、merge 后 memory 前、report send 后 ledger
  前的崩溃；第二轮对账必须收敛，不重 merge、不漏吸收、不漏汇报，逻辑问题只计
  一次（Discord 允许一条标明“补记”的重复）。
- 记忆：TUI sandbox 内写并 commit `MEMORY.md`，generation rebuild/resume 后询问只
  存在于该文件的事实，Raya 必须答得出。
- 语音：先证部署字节走 realtime `prompt` 通道、组合 instructions ≤8192、asset
  路径正确；再开新 session，Raya 第一轮自然自称 Raya 并称呼 Annie。
- 指标：确认 active Raya thread 的 `context-usage.jsonl` 行含
  `modelContextWindow=1000000`；若上游不发 notification，只接受显式
  unavailable 证据，不能拿 voice token 行冒充。
