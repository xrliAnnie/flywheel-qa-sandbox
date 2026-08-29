# FLY-1984 多个 Codex 身份的「家」 — 调研(本机实测)

Issue: FLY-1984 (https://linear.app/geoforge3d/issue/FLY-1984)
日期: 2026-08-25
基于: exploration.md

> ⚠️ **成色声明**:下面每条都标了是【实测】还是【读代码】。测量时刻 = 2026-08-25 17:00 前后(本机)。
> 会变的量(条数、容量)是那一刻的快照,不是恒定值。

---

## 一、本机现在有几个「家」——【实测】

三条**互不相识**的路径各自在造家:

| # | 形态 | 位置 | 数量 | 谁造的 | 生命周期 |
|---|---|---|---|---|---|
| A | 共用一个家 | `~/.codex` | 1 | 你本人 + 所有 `codex exec` / code-review / design-review 流程 | 永久 |
| B | 每个身份一个长期的家 | `~/.codex-<name>` | 19 | `packages/teamlead/scripts/codex-lead-tui-home.sh`(手工起 Lead 时) | 永久 |
| C | 每次执行一个临时的家 | `~/.flywheel/codex-homes/<executionId>` | **588** | `packages/claude-runner/src/codex-home.ts`(每个 Runner execution) | 号称跑完删,**实际全留着** |

命令:`ls -d ~/.codex*`(20,含一个 0 字节的 `.codex-faketest`) / `ls ~/.flywheel/codex-homes | wc -l`(588)

📌 **所以「现在是一个还是多个」这个问题,答案是「三种都在跑,而且没人统一决定过」。**

## 二、这些家占多少地方 ——【实测】

```
~/.codex                 3.5G   ← 共用的那个,最大
~/.codex-infra-bot       1.9G
~/.codex-mufasa          1.5G
其余 17 个 ~/.codex-*     ~2.0G
────────────────────────────────
~/.codex*  小计           8.9G
~/.flywheel/codex-homes   35G   ← 588 个「临时」家
────────────────────────────────
合计                     ≈ 44G
```

命令:`du -sch ~/.codex*` / `du -sh ~/.flywheel/codex-homes`

大头不是记忆,是**日志**:`.codex-infra-bot/logs_2.sqlite` 单文件 **788MB**,`.codex-mufasa/logs_2.sqlite` **439MB**。

## 三、🔴 最要紧的一条:每一个 per-agent 的家,记忆都是 0 条 ——【实测 + 读代码】

Codex 的记忆存在每个家里的 `memories_1.sqlite`(表 `stage1_outputs`)。逐个数:

| 家 | 记忆条数 | 会话数 |
|---|---|---|
| `~/.codex`(共用) | **174** | 403 |
| `.codex-infra-bot` | **0** | 217 |
| `.codex-mufasa` | **0** | 161 |
| `.codex-honeylemon` | **0** | 18 |
| 其余全部 `~/.codex-*` | **0** | — |
| Runner 临时家(抽样 33 个) | **0**(33/33) | — |

**根因不是「它们还没学到东西」,是开关没打开:**
- `~/.codex/config.toml` 有 `[features] memories = true`(第 863–865 行)。
- Lead 家的 config.toml 由 `codex-lead-tui-home.sh` **从零生成**,`grep -i "memor\|features"` = **零命中** ⇒ 这行从来没被写过。
- Runner 临时家的 config.toml 是**整份拷** `~/.codex` 的,所以**带着** `memories = true`(实测第 867 行有)——但家跑完就该删,学到的东西不留。

⇒ **你现在的每一个 Codex Lead 都是失忆的,而且这不是任何人决定的,是生成脚本少写了一行。**

## 四、共用的那个家里,攒的是什么 ——【实测】

`~/.codex` 的 174 条记忆:

- **时间跨度**:2026-06-21 → **2026-08-25 20:56(就在刚才,还在写)**
- **内容**:清一色是 **Flywheel 工程评审**。标题样本:
  `fly720-crash-runner-reaper-code-review-rounds` · `fly921_three_stage_turn_belt_design_review_rounds` · `flywheel-pr479-fly907-multiround-code-review` · `publish-report-csp-nonce-security-review` …
- **有没有被真的用上**:174 条里 **85 条至少被调用过一次**,最高一条被用了 20 次;89 条从没被用过。
- 后台还有一个 `memory_consolidate_global` 的任务(状态 pending)—— 说明「跨会话合并记忆」这个概念,Codex 自己就有。

⇒ 讽刺的地方:**真正在攒经验的那个家,不属于任何一个 Lead,它属于「代码评审流程」。** 而挂着名字的那几位(Mufasa / InfraBot / Honey Lemon)一条都没有。

## 五、一个「家」现在同时在管三件事 ——【读代码 + 实测配置】

拆开 `.codex-mufasa/config.toml` 和 `.codex-infra-bot/config.toml`,一个家里塞着:

| 它管的事 | 具体是什么 | 现在分得开吗 |
|---|---|---|
| **① 身份接线** | `FLYWHEEL_LEAD_ID` · 说话的 Discord 频道 ID · 归哪个项目 · 用哪个通信库 | 已经在分,且**必须**分 |
| **② 权限边界** | 能写哪个仓(mufasa=`Dev/growth`,infra-bot=`Dev/flywheel`)· 能不能上网 · 哪些目录可信 | 已经在分,且**必须**分 |
| **③ 账号** | `auth.json` 登的是哪个 ChatGPT 账号 | 分了,但**不是 1:1** |
| **④ 记忆 / 历史** | `memories_1.sqlite` · `sessions/` · `history.jsonl` | 分了,但**全是空的**(见第三节) |

📌 **③ 的反例值得单独点出**:`~/.codex` 和 `~/.codex-infra-bot` **登的是同一个账号**(`xrliannie@gmail.com`)。
所以「一个家 = 一个账号」不成立 —— 家和账号本来就不是一回事。规范账号只有 3 个
(`packages/claude-runner/agents/codex-account-registry.json`:school / personal / business),家有 608 个(其中 1 个是空壳)。

## 六、当初为什么要分家 ——【读代码,原文在注释里】

`packages/claude-runner/src/codex-home.ts` 开头写得很清楚(FLY-123):

> "THE root-cause fix for **Codex runner concurrency = 1**: multiple Codex runners sharing the single global `~/.codex` **corrupt each other's auth.json**... Giving each runner its own CODEX_HOME... kills that local file race — **accounts can then be shared safely across concurrent runners**."
>
> "Only the ~10KB account face (auth.json + config.toml) is isolated per runner; everything else codex needs it creates inside the home itself."

⇒ 🔴 **分家的原始动机是「并发写坏文件」,是一个纯粹的技术安全问题 —— 跟「它是不是一个独立的人」毫无关系。**
今天这个多文件夹格局,是那个并发修复的副产品,不是身份设计的产物。

这条对 FLY-1984 是决定性的:**你现在看到的「多个家」,不构成任何关于身份的既有决定。这道题是全新的。**

## 七、由此得到的产品判断(我的,待她评)

**「一人一个家还是共用一个家」不是一个问题,是三个问题被捆在同一个文件夹上:**

1. **身份接线** —— 天然该分,现在也分对了,没有争议。
2. **权限边界** —— 天然该分(mufasa 不该能写 flywheel 仓),现在也分对了,没有争议。
3. **记忆经验** —— **这才是真正待定的那一格**,而且现在的答案是「分了,但全空」= 三个选项里最差的那个:既没享受到隔离的好处(本来就没东西可隔离),也没享受到共享的好处。

⇒ 所以真正要问 Annie 的效果问题,只落在第 3 格上。第 1、2 格不用她花时间。

## 八、我不确定 / 没验的

- ⬜ **Codex 的记忆能不能按「谁能读」分组**(比如 Mufasa 的记忆只有 Mufasa 读得到,但工程侧共享一份)——我只看到 per-home 一个库 + 一个 `memory_consolidate_global` 任务,**没验过有没有更细的作用域**。这决定第 3 格有没有中间档。
- ⬜ **记忆开了之后会不会拖慢 / 变贵**。174 条平均 4.1KB,注入成本没量过。
- ⬜ **588 个临时家为什么没被清**(`scrubOrphanedCodexHomes` 存在但显然没生效)。这是工程侧的独立小单,不该塞进本单主线。
- ⬜ 本次 `flywheel-comm stage set research` **连续两次返回 aborted**(已知的 2s 超时假失败),stage 未记录;不影响本单产物。
