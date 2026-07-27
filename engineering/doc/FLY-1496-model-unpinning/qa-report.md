# FLY-1496 模型解钉根治 — QA 验证报告

Issue: FLY-1496
日期: 2026-07-27
基于: plan.md, drift-report.md

结论:**PASS**(第二轮 —— founder 拍板移除禁 4.8 机制后的重验)。四项验收全部以
真机行为证据通过;独立探针 11 项 + 阳性对照 2 项全绿;未发现阻塞缺陷。

> **本轮范围变更(founder 2026-07-27)**:Annie 决定整块拿掉"禁 4.8"逻辑,理由是
> SSOT 实时解析已经根治问题,不需要再叠一层 block。因此验收第 ④ 项由"禁 4.8 是
> 机器校验"改为 **"解析忠实于配置"**:模型只可能来自权威配置,拿到什么就跑什么,
> 拿不到就响亮回退。其余三项验收不变。

## 1. 方法

QA 不复用实现阶段的断言。所有结论来自 QA 自建探针
(`scripts/__tests__/fly1496-qa-acceptance.test.sh`),跑的是**真的
`claude-lead.sh` + 真的 dist**,每例一个隔离 HOME,全程不碰生产
`~/.flywheel`。实现阶段的测试另行复跑,作为回归基线而非结论来源。

## 2. 验收逐条

### ① 改别名配置 → 不改代码即生效

同一个 **live Node 进程内**把 `models.json` 用 temp+rename 原子替换成
**字节长度完全相同**的新一代(靠 pad 字段配平),前后两次决策:

| | 第一次 | 第二次 |
|---|---|---|
| `bindings.opus` 指向 | `claude-opus-5` | `claude-fable-5` |
| `getDispatchCanonical("opus")` | `claude-opus-5` | `claude-fable-5` |
| snapshot revision | — | 已变 |

同大小重写仍然命中新一代,证明缓存键的 inode+高精度 mtime 是必要的:
只用 (size, mtime秒) 的实现会在这一例上读到旧值。未变更时两次调用返回
**同一个对象**,即一次判定内不会混代际。

launcher 侧同链路:`bindings.opus` 改指 Fable 后,下一次 launch 的 argv
直接变成 `claude-fable-5`,无需改码、无需重启。

### ② manifest 不再回旧值

- 注入陈旧 manifest `claude-opus-4-8[1m]` + 冻结 env `claude-opus-4-8`,
  projects.json 写 `opus` → argv 为 `claude-opus-5`,日志**不含**
  `using manifest`(事故夜那行的原文)。
- **连续两次物理 launch**(第一次已写过 manifest,正是 FLY-1285 的复发形态):
  第一次 `claude-opus-5`,中途改 projects.json 为 `fable`,第二次
  `claude-fable-5`。manifest 被重写成当代 `{model:"fable",
  resolvedModel:"claude-fable-5"}`,旧值不留存。
- 删掉 projects 的 model/effort(fleet staging 的“回默认”语义)→ argv 显式
  回 `claude-fable-5`,**stale effort 不再注入**,manifest 的 raw 字段被删除。

### ③ 漂移来源报告

`drift-report.md` 覆盖 S1–S7,每源给了证据/处理/验证。QA 独立核对了其中两条
可机器验证的事实声明,**逐字符合**:

| 报告声明 | QA 实测 |
|---|---|
| 主 `~/.claude/settings.json` model 为 `claude-fable-5[1m]` | 一致 |
| 5 个账号池目录中只有 `personal` 有 `settings.json` 且 model 未设置 | 一致(business/personal1/school/shopping 均无 settings.json) |

`--fallback-model` 全仓审计:launcher / Tmux 启动链**零处**传该 flag;
`fallbackModel` 只存在于 SDK 遗留 lane,且已在 `ClaudeRunner` 里对主模型和
逗号分隔 fallback 链**逐项**做同快照 canonicalize(见 §④);链上任何一环解析不出来
就在调用 SDK 之前失败,不会带着裸别名进 SDK。

报告对无法拦截的外部面(人工 `/model`、CLI 自身 fallback)写的是**豁免+缓解**
而不是假装覆盖——QA 认为这个诚实边界是对的。

### ④ 解析忠实于配置(原"禁 4.8 是机器校验",按 founder 决定改写)

| 面 | 输入 | 结果 |
|---|---|---|
| Lead boot | `claude-opus-4-8` / `[1m]` / 大写 / 前后带空格 / `opus` / `fable` | 六种拼写**逐一落在配置指定的那一个 canonical id 上**(大小写与空格归一),没有一个跑偏到别的模型 |
| Lead boot | `claude-not-a-model` | 回退 `claude-fable-5` + 响亮 `model_config WARNING`(拼写错误不该 brick fleet) |
| Lead boot | 显式 pin `claude-opus-4-8[1m]` | **原样启动**、不替换、不告警;manifest raw 与 resolved 一致 |
| 派发 HTTP | `claude-opus-4-8[1m]` | 200 且 dispatcher 收到该 id —— 旧 pin 向后兼容(`main` 既有行为) |
| 派发 HTTP | 未知拼写 | 400 `INVALID_MODEL` |
| resolver 故障 | dist 不可导入 + env 冻结为 4.8 | argv `claude-fable-5`,**env 被显式忽略**,stale effort 一并丢弃 |
| 各 spawn 缝 | 裸别名 | 一律 canonical 化后才出站(TmuxAdapter / review-runner / classifier / SDK fallback 链逐项) |

**配置边界一例**:把 `bindings.opus` 改指 `claude-opus-4-8` 并让 `tiers.medium`
引用它 —— Lead 侧**照办**(配置说了算),但 `tiers.medium` 回落内建
`claude-opus-5`、`isModelSelectable` 为 false。即:显式配置会被忠实执行,而
**没有 dispatch 面的模型仍然当不了难度档**,不会把新工作悄悄路由到跑不起来的地方。

### 难度选型落地(直接读构建产物,非读测试)

```
TIERS   heavy=claude-fable-5  medium=claude-opus-5  light=claude-opus-5  trivial=claude-opus-5
PHASES  design=claude/claude-fable-5   implement=codex/gpt-5.6-sol(xhigh)   qa=claude/claude-opus-5
HAS_BANNED_API false        ← 快照上已无 isBanned / banned,黑名单整块移除
```

Sonnet / Haiku 只保留可识别别名(`sonnet` / `haiku`),**不被任何难度档引用**
(实测 `TIER_USES_SONNET_OR_HAIKU=false`),与 plan §5.1 逐字一致。

难度档位说明:4 个难度档里 3 个是 Opus 5(重活 Fable、implement 相位 Codex GPT)。
这是 Annie 当天亲自拍的映射 —— 她要避开的是 **4.8**,不是 Opus 5。此处如实列出,
避免日后有人误读成"实现跑偏"。

## 5. 观察事项(非阻塞)

1. **没有任何模型黑名单了**(founder 决定)。一个模型能不能被用,完全取决于
   它有没有被写进权威配置。这意味着"不用 4.8"是**运营纪律**(不往配置里写)而不是
   代码强制 —— 这正是 Annie 要的形态,ship 时对她如实这么说即可。
2. **`ACCEPTED_DISPATCH_MODELS` 仍在 import 期抓一次快照**(model-tiers.ts)。
   本仓已无生产消费者(runs-route 已迁到 snapshot,只剩测试和 index 再导出),
   注释也写明了新边界要用函数形态;但它从包 index 导出,外部若直接引用会拿到
   冻结的一代。属遗留兼容 shim 的已知边界,建议后续批次收掉。
3. **两个操作员逃生口已真正恢复 pre-1496 形态**(见 §10 —— 第一次只是嘴上恢复,
   Codex 抓出来后才真修好)。`off` 现在意味着 runner 不带 `--model` 继承账号默认,
   所以 FLY-753 当初那份内存考量(1M 模型每 runner 多 ~0.35GB)也随之回到 pre-1496
   状态 —— 未配置时仍然是 `claude-fable-5`,只有显式写 `off` 的操作员会碰到,
   值得记一笔。
4. **boot 与首次 launch 之间有一个极短窗口** manifest 的 `model` 字段缺席
   (boot 重写不再 preserve,`_launch_claude` 才补写)。fleet plan 若恰好落在这个
   窗口会读到缺席值。窗口是毫秒级且下一次 launch 即收敛,未观察到实际影响。

## 6. 诚信事件记录

QA 开始时清点硬门,误把 `flywheel-comm codex-review-result` 当查询命令**无参
运行**,它实际是动作:向 Bridge 落了一条未经校验的 `codex_review_result:
APPROVED`(exec 03862937 @ bae68e23)。当时 QA 并未跑过任何 Codex review。

处置(已报 Tadashi 并获裁决):

- 核查 `codex_review_record` 表:**没有**为 exec 03862937 生成任何行;唯一的
  APPROVED 记录是合法的那条 —— exec `19fe2c1f`(implement 阶段)、head
  `bae68e23796c`、`author_family=codex` / `reviewer_family=claude`、request
  `95dead70-…`、`approved_at 16:56:01`。本单 implement 是 Codex 所写,按合同禁止
  同族评审,走的是跨族 Claude request-review 通道,治理证据在 server 侧,所以本地
  找不到 `code-review.json` 是**正确**的,不是漏跑。
- QA 未基于误发记录做任何判断;本次 QA commit 推送后 head 从 bae68e23 漂移,
  该事件的 `prHeadSha` 自然失效。
- Tadashi 已把“无参调用即写入”这个 CLI footgun 记入批次 2 台账。

## 7. 复审绑定

**第一轮**(head `651ab6dd`):跨族 Claude review R5 APPROVED 绑在 `bae68e23`,
QA 只加了测试/文档/CI step,`packages/` 零行变更,Tadashi 据此裁定沿用原结论。

**本轮不适用该豁免。** founder 拍板移除禁 4.8 机制后,产品源码有实质改动:

```console
$ git diff --stat bae68e23..HEAD -- packages/ | tail -1
 21 files changed, 194 insertions(+), 228 deletions(-)
```

所以本轮**必须走一次新的跨族 code review**(按 Tadashi 指令"改完推 head → Codex
复审新 head,轮次接续"),不能沿用 R5。QA verdict 也随之重发,绑定新 head。

## 8. 本次 QA 新增

- `scripts/__tests__/fly1496-qa-acceptance.test.sh` —— 11 例,补上实现套件未覆盖的
  面:resolver 故障分支(plan §2.2-6 点名要求但原套件没有)、`model_config` 告警
  真的进队列而不是被 unknown-kind 丢弃、六种拼写的忠实解析、binding 改指的边界、
  连续两次 launch 的 carry-over。
- CI 接线:`fly1496-model-policy` / `fly241-lead-model-override` /
  `fly1496-qa-acceptance` 三个套件此前**不在** CI 的 shell 套件清单里(CI 是显式
  枚举,不是 glob),只在实现者机器上跑过一次 —— 本次接进 Script Tests job。
  (原第四个 `fly1496-model-sweep` 随 sweep 脚本一起删除。)

## 9. 本轮 rework 改了什么(founder 移除禁 4.8)

删:`banned` 配置段与 `BUILTIN_BANNED_MODELS`、快照的 `banned`/`isBanned`、
`MODEL_BANNED` 错误码与派发 400 路径、Lead boot 的 ban 替换分支与 `MODEL BANNED`
标记行、workflow/fleet 各处 ban 校验、`flywheel-model-sweep.mjs` 整脚本(含测试与
CI 接线)、`validate-model-policy.mjs` 的 ban 退出码。

留:`resolveAllowedCanonicalModel` 与它全部 6 个调用缝(它同时负责**别名规范化**,
删掉会让裸别名把版本决定权漏给 CLI 别名表)、models.json 热读、manifest 翻转、
难度档与相位表、`model_invalid` 的可用性兜底(拼写错误不该 brick fleet)。

恢复 pre-1496:账号默认继承、`FLYWHEEL_RUNNER_DEFAULT_MODEL=off`。

**一处我先报错、后自查纠正的**:我最初把"删掉 dispatch lookup 里 4.8 的显式注入"
描述成恢复 pre-1496,Lead 据此批准。核 `main` 后发现**恰恰相反** —— 那段注入在
`main` 就有,注释写明是"旧 pin 向后兼容",删掉等于**新增**一个破坏(既有 pin 到
4.8 的载体会从可派发变成 400)。已恢复该注入,并把相关测试改回断言 4.8 仍可派发。
这不是删 ban 的一部分,不该搭车改掉。

## 10. 复审轮次与被抓到的问题

**Codex R1 → CHANGES(3 MEDIUM + 1 LOW)**,四项全部真问题,已全修:

| # | 问题 | 为什么危险 |
|---|---|---|
| M1 | `off` / 账号默认继承**根本没恢复** —— 删 ban 之后还剩两处 FLY-1496 加的硬塞 Fable(resolver 里 canonicalize 之后的兜底、spawn 缝的 `ctx.model ?? FABLE`) | 我在上一份报告和给 Lead 的汇报里都**声称**恢复了。而旧测试仍在断言"关闭态"、跑起来全绿,所以这个假声称一路没被拆穿 |
| M2 | `lead-rules-base/model-routing.md` 仍告诉**每一个**可派发 Lead:4.8 会返回 400 `MODEL_BANNED` | 该文件由 `lead-rules-bundle.sh` 注入所有 Lead。运维显式配 4.8 时 Bridge 会接受,而 Lead 会按过期规则拒绝派发或空等一个不存在的响应 |
| M3 | `fleet/example/models.json` 仍带 `banned` 键,而 README 正让运维照抄它 | loader 静默忽略未知键 → 运维以为 4.8 被挡住了,实际照常启动 |
| L4 | 我自己写的注释说 legacy id 不在 dispatch lookup,而代码就在下面注入它们 | 后来的维护者照注释删掉注入,就会重新打破本次刻意保留的旧 pin 兼容 |

M1 的修法不是猜的:核 `main` 确认那两处硬塞 Fable 都是 FLY-1496 引入的(`main` 的
spawn 缝是 `if (ctx.model) args.push("--model", ctx.model)`,注释还明写 `off`
"restores the legacy inherit-account behavior"),删掉即回到 main。修完用**运行时
探针**在终点验:`off` → 不传 model / 未配置 → `claude-fable-5` / 显式 → 照传。

**教训(Lead 已入档)**:向上报告"已恢复 / 已修复"之前必须有运行时证据,
不能拿"我改了代码 + 测试绿"顶替 —— 旧测试可能正在断言错误的行为,
那种绿等于零信息。这和本轮前半段那次"我把删注入说成恢复 pre-1496、Lead 据此批准"
是同一类错误的两个实例。

**Codex R2 → CHANGES(仅 1 个 LOW)**。R2 独立复验(不是采信我的说法)确认
M1/M2/M3 真的修好了,并且专门做了**负向敏感性检查** —— 把每个修复回退,对应断言
就会红,即改写后的测试不是恒真的。剩的 LOW 是两处仍把已删的 ban 写成"活能力"的
注释(`fleet-capabilities.ts` 与 `management-cron-writer.ts`),风险与 M3 同类:
维护者照注释往 `models.json` 里加 `banned`,loader 静默忽略,模型照样可用 ——
幻影控制面。

**R3 又抓到同一类错误,这次是我修出来的**:我给 `fleet-capabilities.ts` 换的新
注释写"repoint 一个 binding 会更新下次 capability read" —— Codex 去测了,是假的;
我自己复验也确认:把 `bindings.opus` 从 Opus 5 改指 4.8,`snapshot.bindings.opus`
确实变了,但 `buildModelCatalog("lead")` **逐字节相同**(catalog 只含 id/label,
不含别名;binding 只影响别名解析)。等于我把一句假声称换成了另一句假声称。
已按实际行为改写。这条值得记:**清理幻影控制面时,替换文案本身也必须被验证**,
否则只是把幻影挪了个位置。

**Codex R4 → CHANGES(2 LOW)**,再次推翻我自己的验证:我为了确认那句改写,
探针只测了"Lead-surface 模型改 label"这一个正例就把结论推广成"metadata",
而 R4 测了四种情形 —— 加 Lead-surface 模型 ✅、改 label ✅、**加 runner-only 模型
❌、翻转 `dispatch` ❌**。我复现了两个反例,确认 catalog 逐字节不变。
措辞再次收窄成"只有本 catalog 真正投影的字段才会动"。

**这一条的教训比前几条更细**:我验的是一个**实例**,不是那个 claim 的**范围**。
一个正例通过不能证明全称句成立;要证伪它只需要一个反例,而我没去找反例。

四轮里 Codex 每次都明确拒绝声称测试通过(它的 sandbox 建不了临时目录、
Vitest EPERM),这个诚实边界是对的;套件是在本机跑的,数字见 §4。

## 11. CI 证据的一处真实缺口

2026-07-27 20:14 之后本仓所有 CI job 被 GitHub 拒绝执行,原话:
`The job was not started because an Actions budget is preventing further use`
(经 `gh api repos/<owner>/<repo>/check-runs/<job_id>/annotations` 取得 —— 日志
blob 此时是 404,这个 endpoint 才拿得到真实拒绝理由)。表现为 job steps 为空、
秒级失败、两个分支同窗一起挂、同一 commit 先绿后红。

与本单代码无关。额度由 founder 于 20:41 恢复后在**同一个冻结 head 上重跑**
(未推空提交,避免作废 head)。**在那次重跑绿之前,本报告不主张任何 CI 结论。**
