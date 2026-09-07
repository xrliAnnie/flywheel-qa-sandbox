# FLY-2401 Raya 读侧激活 — 生产变更提案
Issue: FLY-2401 (https://linear.app/geoforge3d/issue/FLY-2401/raya读侧-按-fly-2131-激活清单把-raya-codex-leadagentidraya真正激活生产里-summary-6h)
日期: 2026-09-06
基于: plan.md

状态：**NON-EXECUTABLE DRAFT — 等待 Lead 审批，且必须先独立部署再重生成。**

Lead 已裁定执行前置：production 先追平至少 `b63a2d97` 并从新 checkout 重渲染；FLY-2404 的
shared-business-truth helper 必须先实现、合并、部署；17 席 forward/rollback 只搭 updater R4 舰队
班车（目标 `2026-09-08 00:00 PT`，2404 提前落地时可搭 `2026-09-07 12:00 PT`），不得单独
restart；Lead 执行 dry-run 与生产步骤，QA 只验包完整性和 dry-run。

本提案来自 2026-09-07T01:16:16Z 的只读生产审计。实现节点没有修改 `projects.json`、
`~/.flywheel/**`、launchd、Codex home、workspace 或 Discord；renderer 明确返回
`productionWritesPerformed=false`。

## 1. 当前硬阻断与现状

| 检查 | 当前值 | 激活要求 |
|---|---|---|
| `~/.flywheel/deployed-sha` | `b198edcfaf7777643d482222be21c4d6881790b9` | 三 SHA 相等 |
| `~/Dev/flywheel` HEAD | `8126576cf25d06fc9ef38f32d9710cb20135aee6` | 三 SHA 相等 |
| fresh `origin/main` | `b63a2d97dc914a7b19dea17fe6c5bf0587354e3c` | 三 SHA 相等 |
| `deployed..origin/main` | 2 commits | 必须为 0 |
| pending commits | `8126576 FLY-2309… (#1063)`；`b63a2d9 fix(teamlead)… (#1101)` | 独立部署 |
| main checkout status | clean | clean |
| registry | 6 projects / 16 Leads / Raya 0 | 7 / 17 / Raya 恰 1 |
| `~/Dev/raya-lead-workspace` | absent | present，含 memory/state |
| `~/.codex-raya` | absent | FLY-2404 shared truth 投影 + 同版 standalone |
| installed formal plist | absent | present，`.tui` 副本 absent |
| installed Raya wrapper | present，sha 与 deployed source 相同 | 同字节 |
| manifests / Lead plists | 16 / 16 | 17 / 17 |
| summary absorption events | 0 | next 6h slot 恰一 delivered row |
| cadence | `21600000` ms | 保持 6h |

因此现在不能开 activation transaction。先在独立 deployment window 把两项 pending commit 正常
部署，使 `deployed SHA == checkout HEAD == fresh origin/main`；随后从 activation checklist §1
重跑并重生成本提案。禁止 registry transaction 顺带部署这两项。

三份 Raya 权威物料在 deployed、checkout、origin 三代的 sha256 均相同，所以以下 diff 可供 Lead
预审，但不能替代部署后的 fresh render：

| 物料 | sha256 |
|---|---|
| FLY-2259 Raya registry row | `a1e1960fe803170964169f5742d1a3899d67aae1057a7d9f51034a554101c393` |
| Raya launchd plist template | `5126078796bab58de70bdb266ccfd40de013f7a7144a7b848ed48219bd3ad5d2` |
| Raya installed/source wrapper | `209ba9e093df5bd9995498f8597bd0eec106110833a4c93f25f1f11e71c97a8d` |

## 2. Exact registry JSON Patch

Input `projects.json` sha256：
`45988e9d8301081f06af51d36644b135f2cac6e35639ab1bff05efe1dd57f1b5`。

```json
[
  {
    "op": "add",
    "path": "/6",
    "value": {
      "projectName": "raya",
      "projectRoot": "/Users/xiaorongli/Dev/raya-lead-workspace",
      "projectRepo": "xrliAnnie/raya",
      "memoryAllowedUsers": ["annie", "raya"],
      "generalChannel": "1542079099928059987",
      "leads": [
        {
          "agentId": "raya",
          "backend": "codex-app-server",
          "botTokenEnv": "RAYA_BOT_TOKEN",
          "botUserId": "1542068543645024257",
          "canSpawnRunners": false,
          "chatChannel": "1542079099928059987",
          "codexProfile": "full-access",
          "codexResidencyPatrol": true,
          "effort": "xhigh",
          "match": {"labels": ["raya-lead"]},
          "model": "gpt-5.6-sol",
          "modelContextWindow": 1000000,
          "role": "cos",
          "summaryRole": "recipient"
        }
      ]
    }
  }
]
```

Writer：Lead/operator 只通过 FLY-2259 `register-codex-lead.py` + config lock。验证：唯一
`raya/raya`，resolver 精确投影上表，summary registry migrate/verify 同事务完成。不得直接手编 JSON。

## 3. Exact workspace 与 env diff

Input `raya.env` sha256：
`43f61777ce2b50133044d911f8cb50bd18766317cc3b8126c73084fe3bb2a8ac`；target JSON sha256：
`b5f2ff591628387d6badbe22057ed877e9b245efc1daa0dfd8bf7c8e5dda334c`。

```diff
-RAYA_MEMORY_FILE=/Users/xiaorongli/.flywheel/raya/memory/MEMORY.md
+RAYA_MEMORY_FILE=/Users/xiaorongli/Dev/raya-lead-workspace/memory/MEMORY.md

-RAYA_WORKSPACE_ROOTS_JSON=["/Users/xiaorongli/.flywheel/raya/code","/Users/xiaorongli/.flywheel/raya/memory"]
+RAYA_WORKSPACE_ROOTS_JSON=["/Users/xiaorongli/.flywheel/raya/code","/Users/xiaorongli/Dev/raya-lead-workspace/memory"]

-RAYA_VOICE_OPTIONS_JSON is absent
+RAYA_VOICE_OPTIONS_JSON={"startInstructionsFile":"/Users/xiaorongli/.flywheel/raya/code/apps/voice/assets/start-instructions.zh.md"}
```

同一窗口先停 product brain/voice 写入并证明 memory 无 holder，然后整体移动：

```text
/Users/xiaorongli/.flywheel/raya/memory
→ /Users/xiaorongli/Dev/raya-lead-workspace/memory
```

另建 mode 0700 `/Users/xiaorongli/Dev/raya-lead-workspace/state`。env 只能由本单
`transition-raya-env.py apply/verify` 三键原子切换，保留无关字节和 voice object 其它键，env 保持
mode 0600；失败只可由同 helper drift-bound rollback。

## 4. Identity：audit-only、non-blocking、零写

| 文件 | sha256 | 作用 |
|---|---|---|
| `~/.flywheel/raya/code/IDENTITY.md` | `b2c7e5220740122218c4f4fff6be0988b64a9c86627eb65c22a9d78bed4befa1` | Lead authoritative source |
| `~/.flywheel/raya/identity/IDENTITY.md` | `704695abab60405bb83af03c6e2b1d2da6ce3135501ddb39ae29d5a3e35eda65` | product projection，mode 0444 |

两者不同是已知 drift；本单 `operation=audit_only`、`mutationPlanned=false`、
`authoritativeForLead=false`。没有 copy、chmod、同步或 rollback 动作，也不把 projection 纳入 Lead
active-ready 硬门。

## 5. Discord 与 Codex account

2026-09-07T01:13Z 的 production REST GET（零消息）结果：

```json
{"botUserId":"1542068543645024257","channelId":"1542079099928059987","channelType":0,"messagesSent":0,"ok":true,"tokenSelectorCount":1}
```

探针只从 `.env` 提取唯一 `RAYA_BOT_TOKEN` 键，没有 source 全 env、没有输出 token。Codex home
仍 absent；必须等 FLY-2404 的 link-truth helper shipped 后，按它的最终 contract 建立真实的
mode-0700 home 与指向 canonical `~/.codex/auth.json` 的 absolute symlink。canonical truth 必须是
mode-0600 普通文件，business identity healthy，Raya standalone 与 Mufasa/InfraBot 当前版本完全
一致。禁止 founder 再登录、复制任何 `auth.json` 或猜测未部署 helper 的 CLI。

## 6. Manifest、plist 与 runtime delta

- `converge-flywheel-bin.sh` 后 installed wrapper 仍须匹配 sha
  `209ba9e093df5bd9995498f8597bd0eec106110833a4c93f25f1f11e71c97a8d`。
- materializer 的 before/after 集合必须只新增 `~/.flywheel/manifests/raya-raya.json`，五个权威字段
  为 project `raya`、lead `raya`、external workspace、canonical projects file、backend
  `codex-app-server`。
- plist 只从 template sha
  `5126078796bab58de70bdb266ccfd40de013f7a7144a7b848ed48219bd3ad5d2` 创建到
  `~/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist`；不得留下 `.tui.plist`。
- label `com.flywheel.lead.raya-raya`，tmux `flywheel:raya-raya`，Codex home
  `/Users/xiaorongli/.codex-raya`；需要唯一 pid、真 TUI、推进的 online heartbeat、exact probe。
- Bridge 本代日志必须有 `RuntimeRegistry: 17 lead runtime(s) registered` 且无 Raya skip，或有 exact
  `Late-registered runtime for "raya" (project: raya)`；只有 `/health` 200 不算 runtime 注册成功。

## 7. 全局 digest 爆炸半径与 write freeze

Scratch candidate registry + canonical assignments 的只读计算结果：

| 项 | before | after |
|---|---:|---:|
| Leads | 16 | 17 |
| summary assignment rows | 16 | 17 |
| project aggregators | 6 | 6 |
| `summaryAssignmentDigest` | `b4be7ea6a8f4450ac8fe04240d1f11784a3f5ed7e51a34a37f82865af2d2f717` | `643403c61d649326ee20dbe40cd4c8fd6a4658ed22f2cad7f015da8d3fdfc67a` |

该 digest 进入每席 `identityDigest`，所以 registry 增加 Raya 会使 16 个现有 Lead 的两个 running
env digest 全部失效。事务边界必须是：

```text
N=16 pid/digest census green
→ Lead 宣布 write freeze
→ product/env + registry/receipt + manifest/plist
→ 第二次 ls-remote 仍等于 pinned deployed SHA
→ independent host-tmux census（17 plists，codex-raya=1）
→ 获批 updater/bus transaction reload Bridge + restart all Leads（禁止单独 restart）
→ /health 绑定 deployed SHA + restart total=17/failed=0
→ 17 席 running summary/identity digest 逐席等于 fresh resolver
→ Raya runtime/pane/heartbeat/probe/Discord roundtrip 绿
→ 才解除 write freeze
```

`restart-services.sh --dry-run` 必须先跑绿，但它不会实际执行 host-tmux gate/census，不能替代上面的
独立 census。registry 写入前与 full restart 前必须各跑一次 fresh `ls-remote`。registry 写入后
不得跨人工等待或允许旧 Lead `send/respond`。

## 8. 6h 与 read-receipt 验收

激活完成后按 live cadence 算 exact next slot。canonical `~/.flywheel/teamlead.db` 必须出现恰一行：

```text
lead_id=raya
event_id=$ROUND_ID (由 live cadence 计算的 exact UTC slot)
event_type=summary_absorption_round
session_key=summary-absorption
delivered_at IS NOT NULL
```

Raya 必须亲自读懂并通过窄例外命令 merge 至少一张 `xrliAnnie/raya` 的 summaries-only PR。最终运行
`verify-first-round.py`，让它交叉绑定 DB、round merge receipt/verified SHA、GitHub MERGED current
head、relocated memory 的 round+每个 summary path，以及由 Raya bot token 现场 GET 的真实 Discord
message。成功必须为 `evidenceSource=discord_api_v10`、`reviewed>=1`、`absorbed>=1`；operator 自填
message JSON 或 loopback override 不能作为 production success。

## 9. 固定 rollback

失败后保持 write freeze，按以下顺序执行；只撤本次 before/after 集合差：

1. bootout Raya carrier，归档/移除本次 formal plist、Raya runtime state/log/tmux；
2. 归档/移除唯一新增 manifest，不删 converge 管理的 wrapper/helper；
3. `transition-raya-env.py rollback` 精确还原 env，memory 整体移回旧路径，恢复 product brain；
4. 在 config lock 下恢复原字节/mode 的 projects + receipt，验证 6 projects/16 Leads/无 Raya；
5. 再次证明 `ls-remote == checkout HEAD == deployed SHA`，只通过同一获批 updater/bus 窗口的
   rollback leg 启动 old generation；要求 status `reason=updater`、`total=16,failed=0`，Bridge
   old generation 与 16 席旧 digest 全绿后才解除 freeze。

`~/.codex-raya` 的共享 truth 投影只按 FLY-2404 rollback contract 管理；本单不 logout、不删除
canonical truth。identity projection 从未写，无回滚。已发生的合规 summary merge 是 canonical
已读事实，不伪造 revert；保留 receipt/DB/Discord 证据交 Lead处置。

## 10. 审批请求边界

请求 Lead 批准的是上述未来窗口事务，不是让实现节点现在执行。当前明确 pending：

1. 先独立部署 2 commits，且 production 至少追平 `b63a2d97`；
2. FLY-2404 helper 实现、合并、部署，并按 shipped contract 投影 `~/.codex-raya` 与 standalone；
3. 部署后重生成 renderer/pre-state/三 SHA/16-seat census；
4. 预订获批 updater/bus 窗口，只有班车即将触发时才进入 freeze/mutation；
5. Lead 对 fresh input hashes、exact diff、write freeze 与 rollback 明确批准并逐步执行。

实现节点未改生产；在 Lead 明确批准并指定 operator/window 前，所有 mutation 保持禁止。
