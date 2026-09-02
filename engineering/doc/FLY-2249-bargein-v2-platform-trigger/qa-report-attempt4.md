# FLY-2249 barge-in v2 — QA attempt 4(判决:FAIL · 房间被外部依赖阻断)
Issue: FLY-2249
日期: 2026-09-02
基于: qa-report-attempt3.md、Lead 判据 `1e105fe4` / `127d10cf` / `d5d631ba`

## 绑定头

- Raya **`f9506854fa1484464b799dba0613c559da1a72cc`** == `origin/fly-2249-bargein-v2`。
- flywheel **`a76c5d4a4ea003f6fee2f7ba28ed6077e92a0475`** == DAG `baseRevision` == 锚 PR **#1035** head;
  `baseRefName = main`(`__main__`),MERGEABLE / OPEN;CI `CI OK` / `Quick Gate` / `Classify CI scope` 全 success。
- raya 仓仍无 workflow ⇒ 本地全门代替:lint / build / typecheck rc0;
  contracts 62 + brain 125 + **voice 518** + QA 126 = **831 tests 全绿**。

## 判决:FAIL —— 但阻断项是外部依赖,不是代码

qa@4 需要的**全部新证据都在真房**(附和/轻声/犹豫三臂 + 真语音·呼吸回归)。
真房今天**跑不了**:OpenAI 平台 realtime 额度耗尽。详见 §3。

## 1. 变更范围核实(Lead:引用基线须注明未变代码路径)

`f13a2c9..f950685` 只有两个文件:

```
apps/voice/src/config.ts        (+2)
apps/voice/src/config.test.ts   (+22)
```

逐文件核对 blob 哈希,attempt 3 验过的代码路径**全部逐字节未变**:

| 文件 | f13a2c9 vs f950685 |
|---|---|
| `probes/fly2178-bargein-room-run.mjs` | SAME |
| `probes/fly2249-gate-calibrate.mjs` | SAME |
| `apps/voice/src/runtime.ts` | SAME |
| `apps/voice/src/inbox/InboxReader.ts` | SAME |
| `apps/voice/src/inbox/InboxArbitrator.ts` | SAME |
| `apps/voice/src/pipeline/UplinkSpeechGate.ts` | SAME |
| `apps/voice/src/speech/HeardPosition.ts` | SAME |
| `apps/voice/src/codex/RealtimeTransport.ts` | SAME |

⇒ attempt 3 的四条台架修复变异验证、真语音 4/4、呼吸 3/3、离线校准全网格,**在本头继续成立**,无需重跑。

## 2. ⚠️ 第三处更正:我引用的词表内容不准

attempt 3 报告里我写默认词表「本来就含 `okay ok yeah yep uh-huh mm-hmm right sure`」。
**`yep` 与 `sure` 当时并不存在** —— 它们是本轮 `c0db13a` 新加的。按 commit 核实:

| head | 英文条目 |
|---|---|
| `2b5ecd37`(a2) | `okay ok yeah uh-huh mm-hmm right` |
| `f13a2c9`(a3,我当时验的头) | `okay ok yeah uh-huh mm-hmm right` |
| `f950685`(a4) | 上列 + **`yep` `sure`** |

**错因**:我用 `sed` 读的是**工作树文件**,而实现体当时有未提交改动在同一个 worktree 里;
我读到了尚未提交的内容,却把它当成那个 commit 的事实陈述。**该读 commit,不该读工作树** ——
尤其在与实现体共用 worktree 时。

**我的核心更正不受影响**:`yeah` 在 `f13a2c9` **确实已在表里**,
所以「零英文条目」仍然是错的,`"Yeah."` 归一化后本会命中,
唯一阻止它被过滤的仍是 **founder 归属短路**。
但我另一句「词表什么都不需要改」说得过满 —— `yep` / `sure` 确实是新增覆盖,不是多余工作。

## 3. 阻断项:OpenAI 平台 realtime 额度耗尽(外部依赖)

按 Lead `8e86f10b` 回复指的 FLY-1911 签名,直连 ws 取服务端原话
(`wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5`,key 打码 `sk-proj...4ZMA`):

```
handshake: HTTP 101                       ← 升级成功,key 认证正常
{"type":"error","event_id":"event_EJjdTlUQE8Ezs8X7u0VOy",
 "error":{"type":"insufficient_quota","code":"credit_balance_exhausted",
 "message":"You have no credits remaining. Add credits to continue using the API at
            https://platform.openai.com/settings/organization/billing/."}}
close: code 1013  reason "insufficient_quota.credit_balance_exhausted"
```

复现 3 次(含 qa@4 开工时的复查),code / reason 逐字一致。
`codex/realtime` 二进制把它向上报成 `Connection closed normally`,
所以 `voice_exit` 只看得到 `realtime start failed: stream disconnected before completion`。

**这是 OpenAI 平台按量 credit,不是 ChatGPT 订阅额度**;订阅用量页不能当这个余额的证据,本报告也未使用。

**边界**:该签名解释 17:58Z 之后的两次归属座跑与那个从未到达 Live 的对照。
它**不解释**更早的 `last-human-left` 提前拆房 —— 那些会话进过 Live 也跑完了 rep
(附和轮 6/6、ts3 三轮干净真语音 @17:40),当时余额尚在。耗尽发生在约 17:40–17:58 之间。
两者是**不同现象**,我不做倒推合并。

## 4. founder 归属座:代码层确认,运行层未验

`loadRuntimeEnv` 返回 `{ ...fromFile, ...env, RAYA_ENV_FILE }`(`packages/contracts/src/runtime-env.ts:30`)
⇒ **process env 覆盖 raya.env**。在被测实例的 `env -i` 白名单里设
`RAYA_FOUNDER_DISCORD_USER_ID=1516207680836866219` 即得 `founderUserIds={emitter bot}` ⇒ `interposedRole=founder`。
两次运行验证都因 §3 的额度耗尽止步于 Live 之前;去掉座位的对照因探针早失败而**没有判别力**,
既不能证明也不能排除座位 —— 不把它洗成结论。

## 5. 未覆盖(qa@4 要求的全部新证据)

- 附和 ×3(founder 归属)、轻声 ×3、犹豫 ×3 —— **全部未跑**
- 真语音 ×5 + 呼吸 ×3 回归 —— **未在本头跑**(但 §1 证明相关代码路径未变,a3 结果继续成立)
- 我那条可证伪预测(founder 归属下 `"Yeah."` 必须无耳侧停口)—— **仍未测**

## 6. 复跑前置

founder 为 OpenAI 平台账户充值后,qa@5 的 step 0 应是一次两分钟存活探针
(起一个隔离实例 → 确认到达 Live → 拆掉),再决定是否投入矩阵。
探针脚本与原始输出已归档:QA scratchpad `realtime-quota-probe.jsonl` / `fly2249-realtime-probe2.mjs`。

## 7. 隔离与善后

生产 raya 仓判决前复核 `main@bb9656f` clean;`com.xrli.raya.voice` launchd 全程未被我 load;
所有验证实例都在 `qa-20260902-fly2249-*` 隔离轮目录;跑完无残留进程。
