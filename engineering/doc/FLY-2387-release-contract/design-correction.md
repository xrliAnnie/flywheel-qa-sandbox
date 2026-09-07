# FLY-2387 先锁合同:版本/channel/manifest — 设计更正附录

Issue: FLY-2387 (https://linear.app/geoforge3d/issue/FLY-2387/1143b0-先锁合同版本channelmanifestprd-1098-6-规范化版本-72-通道单一真相-73-发布不变量)
日期: 2026-09-06
基于: plan.md(Codex 4 轮 APPROVED,Bridge design gate 已过,blob 9a234f61)

> 本附录记录 plan 过门之后收到的 Lead 裁决,**不改 plan.md**(改了会让已过门的 blob 失配)。implement 节点读 plan 时一并读本附录。

## Lead 裁决(question 34577c85,2026-09-06)

两个默认都批:

1. **Q1 合同包**:新建零依赖包 `packages/release-contract/`(grammar + identity 派生 + JSON Schema + 跨语言向量),`payload-endpoint` / `scripts/release` 改 import,bash 打包脚本由共享向量测试锁一致。= plan §2 / §3 原样。
2. **Q2 C-1b**:不变量 1 放宽为「无 `status=active` entry 才允许 `latest=null`」,`schemaVersion` 仍 1,withdraw-without-fallback 原语归 B5。= plan §1.3 C-1b 原样。

Lead 附加要求:**plan 里写清这是 B0 对 PRD §8.2 updates-paused 的合同层承接,并给 B5 留接口说明。** 以下补齐(implement 节点把本节原样并入 `CONTRACT.md` 的 C-1b 小节)。

## C-1b 的定位与给 B5 的接口说明

**定位**:PRD §8.2 第 2 条要求「若没有可用 previous-good → 进入显式 `updates-paused / no-release-available` 状态:现有安装保持原版本、新安装收到诚实可重试错误,绝不 dangling」。B0 只做**合同层承接**:让 manifest 能合法表达这个状态、让校验器与视图层认识它、锁定它的 wire 形状。**进入 / 离开该状态的操作原语与客户端话术全部归 B5。**

**B5 依赖的接口(本单交付,B5 不得再改形状)**:

| 接口 | 形状 | 说明 |
|---|---|---|
| 进入 paused 的 manifest diff | 同一次 `POST /admin/manifest` CAS 内:`versions[v].status: active→quarantined` + `channels[customer-release].latest: v→null` | 能力 = `customer-release`(`POINTER_CAPABILITY`);transitions 归类为 `quarantine` + `pointer(to:null)`;服务端盖 `quarantinedAt`。B5 的 `payload-promote.mjs withdraw --withdraw <v>`(无 `--fallback`)就是发这个 diff |
| 离开 paused | `channels[customer-release].latest: null→v'`,`v'` 为新 committed 的 release entry(或仍 active 的旧 release) | 走现有 commit / re-pin 路径,C-1 / C-5 照常 |
| 静态判定 | `validateManifest`:`latest=null` ⇔ 该 channel 无 active entry(有 active 却 null → `C-1b` 错误;null 且存在 active → 拒) | 合同包导出;B5 测试直接引用 |
| 视图层 | `manifestView(m, entitlement) → {empty:true, reason:'never-activated'\|'paused'}`(per-channel 判定) | 合同包不含视图;此函数在端点 `views.mjs`,签名由本单锁定 |
| 客户 wire | `GET /manifest` → 503,body 逐字 `{"error":"no-release-available"}`(paused)/ `{"error":"not activated"}`(never-activated);`GET /payload/<v>` 对 quarantined 版本逐字节同形 404 | 客户端现行为不变(非 2xx = 网络类错误);把 `no-release-available` 映射成客户可见话术 = B5,且只能改客户端不能改 wire |
| key 签发 | `license-key issue --entitlement customer` 在 paused 期间被现有前置检查拒绝 | B5 若要「paused 期间仍可签 key 但装不上」需另开合同讨论,本单不承诺 |
| 客户端记忆 | 合同**不**在 manifest 里记「哪个客户装过哪个坏版」;客户端本地记录 quarantined 版本、不重装 = B5(PRD §8.2 第 3 条) | 明确不进 manifest,避免第二本账 |

**B5 验收三情况对应的合同态**:有 previous-good → 现有 `withdraw --fallback`(re-pin,C-5 清零 `retentionSince`);previous-good 已过期(expired)→ 同 paused(expired 不可 re-pin);首个 release 就坏 → paused。三者都在 `examples/`(`withdraw-fallback.json`、`paused.json`)有合法样本。
