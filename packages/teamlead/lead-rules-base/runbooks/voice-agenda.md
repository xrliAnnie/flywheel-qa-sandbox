# Voice agenda

仅在收到 `【语音议程·…】` 请求，或 founder 在语音议程件进行中说的话（`[voice handoff] … 语音议程件 …`）时按需读取本页。这不是授权；你的权限不因语音而增加。

## 你在做什么

语音里只播四类事：你主动要跟她说的、待批、要你答、受阻。模式层不拼句子，你写的话会**原样**念给她听（耳机模式是 Raya 的声线，会议是本 Lead 的声线）。一件一件来，她拍了这件就结束，再下一件。

## 怎么说

1. **开场（open）**：一两句先说有几件要她拍，每件一句点出是什么，然后「先从 X 说起」，直接进入那一件（`--item <X>`：可以是这次开场里的任意一件，不必是列表第一件；其余按默认顺序排在后面）。想整体重排再带 `--order`，要带就把每一件都排进去。不要逐件展开，不要念清单。没有事就自然说一句（「我在，现在没什么要你拍的」），或者不说。
2. **一件（item）**：只说这一件——发生了什么、**要她做什么**（授权 / 批 / 改 / 看一眼）。待批的用三五句讲 QA 报告、设计、测试，或者问她要不要自己看设计卡：链接用文字发到 thread，不念 URL。受阻的说卡在哪、要她给什么。依据看议程数据里的 `material`（问题原文、最近一次 QA 结论和报告链接、卡住的阶段和原因、PR 号）；那里没有的，你自己知道就说，不知道就直说「详情在讨论串里」，不编。
3. **插播（urgent）**：先说「插一句急的」，讲清楚要她马上做什么。
4. **带回（resume）**：一句话提醒刚才谈到哪、还要她做什么。
5. **报平安（checkin）**：一两句闲聊或平安话；有她还没回应的事可以轻轻提一句「X 还在等你，不急」。不罗列状态。

口语：单号按数字念（二七九六）；不念 URL、markdown、代码、路径、状态流水（「进入实现段」「QA fail」）；不编造，没做的事不说做了；不说「已批准」。单次不超过 400 字，超了会退回重写。

## 命令

```sh
flywheel-comm voice agenda say   --request <id> --key <key> --item <itemKey|none> [--order k1,k2,k3] --text "<要说的话>"
flywheel-comm voice agenda close --request <id> --key <key> --item <itemKey> --disposition resolved|decision_recorded|deferred [--evidence <依据>] --reason "<记给台账的一句>" --say "<她拍完听到的一句>"
```

- `--request` 和 `--key`：议程请求就用请求里写的 id 和 key；她在议程件进行中说的话，用那条 `[voice handoff]` 里的 `handoff_id` 和 key。key 只在投递给你的那条消息里，证明回答来自你。
- `--order`（仅开场）：必须把开场列出的每一件都排进去，不能少。
- 她说的话和当前件无关：照样回答她，`--item none`；想顺手带回当前件就 `--item <当前件>`。
- 普通回复（不用命令，直接回复那条语音消息）也会被念出来，但**不能**结束一件。
- `close` 的 `--say` 必填，是她拍完之后马上听到的那句（念完才进下一件）；`--reason` 只进台账，**不念**。
- 不合规的 say/close 会被 Bridge 当场拒收（HTTP 400，带 `reason` 和 `hint`：比如 `item_not_in_request`、`say_required`、`url`），照 hint 改了再发一次；拒收的话她一个字也听不到。

## 结束一件（三选一，都不是「已批准」）

| 情况 | disposition | 要带 |
|---|---|---|
| 你用现有权限办完了她说的事（比如按她的授权放行受阻单） | `resolved` | `--evidence`（消息 id、命令回执、状态变更） |
| 她拍了板但你无权执行（典型：ship 批准）。`--say` 如实说「我记下你批了，你在 thread 里点一下就行」 | `decision_recorded` | `--reason` |
| 她说回头再看 | `deferred` | `--reason` |

三种都要带 `--say`。

`decision_recorded` 和 `deferred` 只在本场不再提；下一场如果它还在四类里，会重新排进来。

## 插播只有两种

- 你在**自己的主频道**发急事时，消息开头写 `🚨[urgent:<原因>]`，原因只能是 `production_down`、`data_loss_risk`、`security`、`deadline_within_1h`、`founder_requested` 之一（写错不算）。只认你自己的 bot 发的。
- Linear 优先级为 Urgent 的单进入受阻。

其余都排队，不打断她正在谈的那件。
