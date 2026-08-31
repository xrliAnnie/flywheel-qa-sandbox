# FLY-1984 第三版的实测数据出处

Issue: FLY-1984 (https://linear.app/geoforge3d/issue/FLY-1984)
日期: 2026-08-26
基于: Lead 对 aa293a7e 的答复(他给了一批数字,并要求我自己复核)

> 测量时刻:2026-08-26 00:30 前后。**条数一直在变,当数量级看。**

## 一、Claude Code 的两层记忆(memory-v2.html 图一/图二的出处)

### 第一层 · 按身份 `~/.claude/agent-memory/<agent-id>/`

12 个目录,**全部是 Lead,零个节点**:

```
flywheel-eng-lead      462    sub-lead                 124
flywheel-cos-lead      156    joycon-lead               38
flywheel-product-lead   87    ops-lead                  36
tidal-echo-content-lead 35    cos-lead                  33
reflection-lead         20    rafiki-lead               13
product-lead            13    tidal-echo-cos-lead       10
```
命令:`ls ~/.claude/agent-memory/` · 每目录 `find -type f | wc -l`

### 第二层 · 按工作目录 `~/.claude/projects/<slug>/memory/`

- project 目录总数 **330**;其中带 `memory/` 子目录的 **56**;非空(有 .md)的 **19**
- `-Users-xiaorongli-Dev-flywheel` = **445 条**,最近 7 天动过 **97 条**
- 类型分布:feedback 203 · reference 145 · project 7 · user 1
- **92 条**提到近期 FLY-18xx/19xx 单号 ⇒ 明显是 runner 在写,不是只有 Lead 在写

### 节点确实各有 agent file

`.flywheel/agents/*/` 下有 `pm-executor.md` / `qa-executor.md` / `engineer-executor.md` /
`designer-executor.md` / `prototype-executor.md` 等 ⇒ **她那句「DAG 每个节点也有 agent file」成立。**

## 二、🔴 我改了上游两句话(证据在这)

### 改法 1:「一个 qa 节点在 100 个 worktree 里跑 = 100 份互不相干的记忆,worktree 删了就没了」

**实测不成立。**

```
以 worktree 路径命名的 project 目录        242 个
其中 memory 非空                            0 个   ← 全空
我自己(跑在 worktree flywheel-FLY-1984 里)被指向的 memory 目录:
   ~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/   ← 主仓那份,不是我的 worktree
```
⇒ 节点被指向**主仓**那一份,不是自己 worktree 那份。**worktree 删掉不会丢记忆。**
⇒ 这条对 founder 是好消息,已写进页面 ⑤。

### 改法 2:「IC 那一半不存在」

**更准确的说法是「IC 那一半存在,但是按项目分的,不是按角色分的」。**
证据:主仓那 445 条里 92 条提到近期 FLY 单号、7 天内动了 97 条 —— 节点一直在写。
⇒ 不存在的是**按角色汇总**那一格,不是「节点没有记忆」。
⇒ 这个区别对她重要:她想要的是「qa 记得所有 qa」,而那正好就是缺的那一格 ——
   说成「什么都没有」反而会让她低估现有的那 445 条。

## 三、她三个提问的答案出处

| 她问的 | 答案 | 出处 |
|---|---|---|
| 临时的家删了吗 | 没有,**588 个 / 35 GB** | `ls ~/.flywheel/codex-homes \| wc -l` · `du -sh` |
| Honeylemon 为什么在这 | **FLY-1911 语音分身**,沿用同名 | `~/.codex-honeylemon/config.toml` 第 1 行逐字;18 次会话,8/21–8/23 |
| 记忆开关是 Codex 设置吗 | 是,`[features] memories = true` | `~/.codex/config.toml:863-865` |

⚠️ Lead 说语音分身的 session「全在 8-21」,我量到是 **8/21–8/23 三天**。页面按我量的写。
⚠️ FLY-1893 那张单我**没有独立核**(本会话没有 Linear 访问),页面上只写「另有单在跟」,没有背书它的内容。

## 四、我明确没验的

- ⬜ 打开记忆的成本(变慢 / 变贵)—— 174 条平均 4 KB 的注入量级没量过
- ⬜ Codex 能不能按角色分记忆 —— 这正是她说的第三步,本轮按指令没做

---

# 第四版(where-v4.html)的实测数据出处

日期: 2026-08-26 · 测量时刻约 00:45

## `~/.claude` 本身就是一个有远端的 git 仓

```
git remote -v          origin  https://github.com/xrliAnnie/claude-config.git
git log -1             4d8c0bd  2026-06-12  fix(FLY-258): permission auto-learn …
本地 HEAD              4d8c0bde0e99f4df5c9520c1e9dc8143491a229f
远端 main(ls-remote)   4d8c0bde0e99f4df5c9520c1e9dc8143491a229f     ← 完全一致
```
⇒ **不是「没推上去」,是从 6/12 之后就没再提交过任何东西。** 这两件事在页面上要分清。

## 记忆一条都没进 git,而且不是被 ignore

| | 盘上 | 被 git 跟踪 |
|---|---|---|
| `agent-memory/`(Lead 记忆) | **1028 个文件 · 27 MB** | **0** |
| `projects/*/memory/`(节点记忆) | 全机 **761** 个文件 | **16** |
| 其中 `projects/-Users-xiaorongli-Dev-flywheel/memory/` | 446 条 | **0** |

那 16 个被跟踪的 memory 文件**全属于别的项目**:
GeoForge3D 7 · claude-workflow-update 3 · gogcli 2 · Downloads 1 · summarize 1 · openclaw 1 · hammerspoon-voice-loop 1

`git check-ignore -v agent-memory/flywheel-eng-lead/` → **exit=1,无命中** ⇒ **不是被 ignore,是从未 add**。
`.gitignore` 里那一行注释逐字是:`# Per-project ephemeral data (keep memory/ files)`
⇒ 忽略的是 `**/tool-results/` `**/subagents/` `projects/*/*.jsonl` `projects/*/prompts/`,**memory/ 被特意留在外面**。

## ⚠️ 一个容易误读的数,我特意拆开了

`git ls-files 'projects/*' | wc -l` = **545**,乍看像「记忆有备份」。逐个看后缀:

```
524  .jsonl   ← 旧的 subagent transcript,在忽略规则生效之前就被提交了
 16  .md      ← 才是 memory,且全属别的项目
  5  .json
```
⇒ **那 545 里只有 16 个是记忆。** 页面上没有用 545 这个数,免得她读成「有备份」。

## 未进 git 的总量

```
未跟踪文件(含未 ignore 的)   13,806
~/.claude 总占地             8.3 G   (其中 projects/ 7.1 G)
记忆类占地                   agent-memory 27 M + projects 下 memory 3.6 M
```

## 我没验的(第四版)

- ⬜ 打开记忆的成本(变慢/变贵)
- ⬜ Codex 能不能按角色分记忆 —— 她排的第三步,按指令本轮没做
- ⬜ 她第四句「稍微调整一下机制就能记下来」—— **页面上明写「我不表态」**,既不背书也不否定

---

# 第五版(where-v5.html)新增的实测

日期: 2026-08-26 · 测量时刻约 02:25

## agent file 住在项目仓,memory 住在工具的家

| | 位置 | 数量 | 进 git 吗 |
|---|---|---|---|
| IC 的 agent file | `.flywheel/agents/**.md` | **9**(general / engineer / qa / pm / prototype / product-designer / designer×3) | ✅ 9/9 被跟踪 |
| Lead 的 agent file | `.lead/<lead-id>/identity.md` | **6** | ✅ 6/6 被跟踪 |
| IC 的 memory | `~/.claude/projects/<仓>/memory/` | flywheel 446 条 | ❌ 0 |
| Lead 的 memory | `~/.claude/agent-memory/<lead-id>/` | 1028 文件 27 MB | ❌ 0 |

## 🔴 我改了上游第三句:`~/.claude/agents/` 不全是自带模板

Lead 说「那是 Claude Code 自带的通用模板,不是我们的 Lead」。**实测这句只对了一半:**

```
~/.claude/agents/  共 32 份
  12 份  Claude Code 自带通用模板(大写开头:Backend-Developer / Data-Scientist / …)
  16 份  ★ 正是我们自己的 Lead(anna / belle / claude-infra-bot / cos / flywheel-cos /
         flywheel-eng / flywheel-product / joycon / mufasa / ops / product / rafiki /
         reflection / sub / tidal-echo-content / tidal-echo-cos)
   4 份  flywheel-test-1..4
```
而且**那 16 份跟项目仓里的 identity.md 逐字相同**(cmp 验证:flywheel-product-lead 两边都是
17,238 B 且 cmp 无差异;flywheel-eng-lead 两边都是 11,702 B 且无差异)⇒ 是镜像,不是另一份东西。

`git ls-files agents/` = **12**,恰好就是那 12 份通用模板 ⇒ **我们自己那 16 份一份都没进远端。**

⇒ 为什么必须改:如果按「那不是我们的 Lead」写,她哪天打开 `~/.claude/agents/flywheel-product-lead.md`
会发现那明明就是,而且会开始怀疑这页别的地方。

## ⑧ 那个「先筛密钥」前置的量级(粗查,不是安全审计)

```
Lead 记忆   1029 个文件中 282 个  出现 token|api_key|secret|password|bearer 字样
节点记忆     453 个文件中  96 个  同上
```
⚠️ **字样命中 ≠ 真有钥匙** —— 大多数应该是在讨论这些概念本身。页面上是这么写的,没有夸大成
「有 282 个泄漏」。它的作用只是说明「先筛一遍」不是客套话。

## 页面上刻意没写的

- `git ls-files 'projects/*'` = 545 那个易读错的数(524 是旧 transcript,只有 16 是 memory)
- FLY-2067 的具体修法 —— 不是我这一单的范围

---

# 第六轮(2026-08-27)—— 「IC 的 memory 到底在哪」的实测底稿

Issue: FLY-1984 · 日期: 2026-08-27 · 基于: Lead 指令 `ddcb8799`
全部数字测于 2026-08-27 21:30 UTC。口径:文件夹**全部条目**(与页面 ④⑦⑧ 一致)。

## 一、两侧的真实路径

| | Lead(例:Honey Lemon) | IC(例:写这一页的 runner) |
|---|---|---|
| 干活的地方 | `~/.flywheel/lead-workspace/flywheel-product-lead/` | `~/Dev/flywheel-FLY-1984/`(worktree) |
| 会话记录 | — | `~/.claude/projects/-Users-xiaorongli-Dev-flywheel-FLY-1984/*.jsonl` |
| **记忆** | `~/.claude/agent-memory/flywheel-product-lead/` **88 条** | `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/` **466 条** |
| 分家依据 | **按名字** —— 12 个 Lead = 12 个目录,全非空,共 1033 个文件 / 28 MB | **按项目路径** —— 一个项目一个,所有 IC 共用 |

- 12 个目录逐个:eng-lead 481 · cos-lead(flywheel) 149 · sub-lead 118 · product-lead(flywheel) 88 ·
  joycon 38 · ops 36 · tidal-echo-content 35 · cos-lead 33 · reflection 20 · product-lead 13 · rafiki 13 · tidal-echo-cos 10。
- **231 个** `-Users-xiaorongli-Dev-flywheel-FLY-*` worktree 目录,带 `memory/` 的 3 个,**那 3 个都是 0 条**。
- 「所有 IC 共用一格」不是从我一个样本外推:另查了今天同时在跑的 FLY-2071 / FLY-1969 / FLY-2094
  三个 runner 的 transcript,**四个 runner 被喂的都是同一个 `-Dev-flywheel/memory` 路径**(n=4)。

## 二、⚠️ 两条上游说法在实测下不成立,已改

**① 「flywheel 仓里 grep agent-memory 零命中」—— 不是零。**
`packages/` + `apps/`(出货代码)确实是 **0**;但全仓有 **10 处**,都在
`product/doc/FLY-1911-.../prototype/*.mjs` 与若干 `.md` 里。
⇒ 结论(不是 Flywheel 代码在管这套记忆)成立,但**证据要写成「出货代码零命中」**,
不能写成「全仓零命中」——后者可被一条 grep 推翻。

**② 「runner 不持有 Bridge token,所以调不了 memory API」—— 前半句是错的。**
我读了自己的进程 env:runner **持有** `FLYWHEEL_INGEST_TOKEN` / `FLYWHEEL_CALLBACK_TOKEN` /
`FLYWHEEL_BRIDGE_URL`(还有 `DISCORD_BOT_TOKEN`)。它不是无凭据的。
真正的机制是**凭据分级**:
```
/api/memory  的中间件 = tokenAuthMiddleware(apiToken, geminiAgentToken)   ← plugin.ts:3836
runner 手上的 token   = TEAMLEAD_INGEST_TOKEN(哈希逐字相同,已比对)
                        ≠ TEAMLEAD_API_TOKEN(config.ts:67 若两者相等则拒绝启动)
```
现场三格对照(不是读文档):
```
我的 token → GET /api/reports/        403  ← 认得这张票,只是不给这个门(阳性对照)
乱填 token → GET /api/reports/        401  ← 不认得(阴性对照)
我的 token → POST /api/memory/search  401  ← 这个门不认这张票
```
⇒ 正确说法:**runner 有票,但不是这张门的票。**

## 三、第三个记忆位置:它不是空的,是**没开**

`~/.flywheel/memories/{bridge,product,flywheel-test,geoforge3d}/` 四个目录全 0 文件(建于 3 月)。
**但那不是数据该在的地方** —— 那只是 history.db 的位置,真正的向量库在 **Supabase pgvector**。

```
createMemoryService():  三把钥匙缺一把就 return undefined(且不打日志)
~/.flywheel/.env 实测:  SUPABASE_URL ✅ / GOOGLE_API_KEY ❌ / SUPABASE_KEY ❌   ← 三缺二
bridge 启动日志:        [Memory] 相关行 0 条 —— 与「静默 return undefined」一致
plugin.ts:3834          if (memoryService) 才挂载 /api/memory
```
⇒ **服务从未初始化,`/api/memory` 根本没挂载。** 两侧谁都没在用它。

⚠️ 一个不能混的分辨:`/api/memory` 返 401 **不能**用来证明它没挂载 ——
鉴权在路由之前,没挂载的路由和挂载了但没票,**返的都是 401**(我拿一条不存在的路由对照过,同样 401)。
「没挂载」这一格的证据只有上面的 env + 代码路径,不是那个 401。

## 四、这一轮没验的

- `~/.flywheel/.env` 是 wrapper 唯一的 env 来源(已读 `flywheel-bridge-wrapper.sh:32,46-48` 确认),
  但我**没有**直接读运行中 Bridge 进程的实际 env(macOS 限制),所以严格说是「来源里没有」而非「进程里没有」。
- Honey Lemon 那 88 条**确实被注入她的提示词**这一点,我只有盘上证据 + 我自己这侧同机制的类比;
  我没有她的 transcript 作直接证据。
