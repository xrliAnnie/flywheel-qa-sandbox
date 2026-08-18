# FLY-1846 全项目总管 — 调研(A2 材料:状态今天记录在哪)

Issue: FLY-1846 (https://linear.app/geoforge3d/issue/FLY-1846)
日期: 2026-08-17
基于: exploration.md

> **这份文件只给事实,不给结论。** Honey Lemon 派单时写明:「为下一块准备材料(**不是结论**)」。
> 所有数字都附**可重跑的命令**;所有会过期的结论都进 §7 的过期表。
> 读者要的是「这一格该怎么问她」,不是「我们应该怎么做」。

---

## 1. 为什么要查这些

A2 = 「**它知道什么、多新**」。而 Annie 在 A1 里自己抛了一个她没答的问题:

> 「这里可能会值得斟酌一下的是说,**我们的那些 status 本来就是记录在我们的 repository 里面去的,只是说还需不需要对这个总管来说需不需要有个 summary 给他**。」

⇒ 要跟她聊这一格,先得知道**今天状态到底记录在哪、有多全、有多新、有没有现成的汇总面**。
下面是实测。**测的是 2026-08-17 的机器现状。**

---

## 2. 今天「项目状态」实际记录在哪 —— 六个面

### 面 ①:Bridge 的 StateStore(`~/.flywheel/teamlead.db` 的 `sessions` 表)

**这是唯一一个天然跨项目、机器可读的执行台账。**

- 每行 = 一次 Runner 执行,带 `project_name` / `issue_identifier` / `issue_title` / `status` / `session_stage` / `pr_number` / `summary` / `branch` / `started_at` / `last_activity_at`。
- 覆盖全部项目,历史累计约 2,240 行。

```
sqlite3 "file:$HOME/.flywheel/teamlead.db?mode=ro" \
  "select project_name,status,count(*) from sessions group by 1,2 order by 1,3 desc;"
```

实测(2026-08-17):

| project | completed | terminated | failed | blocked | running | 其他 |
|---|---|---|---|---|---|---|
| flywheel | 1175 | 382 | 154 | 98 | 10 | ship_parked 2 / rejected 1 |
| geoforge3d | 50 | 72 | 16 | 52 | 0 | shelved 3 / rejected 1 |
| sub | 48 | 72 | 4 | 4 | 0 | |
| joycon-typeless | 28 | 9 | 3 | 1 | 0 | |
| tidal-echo | 16 | 13 | 0 | 0 | 0 | |
| growth | 10 | 10 | 3 | 2 | 0 | |
| test-slot-4 | 0 | 0 | 1 | 0 | 0 | |

**三个必须一起说的边界**:

1. **粒度是 issue 级执行,不是「项目进展」。** 它能回答「FLY-1830 跑到 pr_created 了」,
   **不能**回答「flywheel 现在整体推到哪一步了」。而 Annie 要的恰恰是后者(「on the high level」)。
2. **历史项目名会漂。** `sub` 在库里有 128 行,但 `~/.flywheel/projects.json` 里今天已经没有这个项目(改叫 `tidal-echo`)。
   任何按 `project_name` 聚合的东西都得处理这种改名。
3. **`blocked` 是累积残留,不是「今天有 157 件事卡着」。** 全库 `blocked` 共 157 行,
   其中 geoforge3d 52 行、flywheel 98 行 —— 大部分是历史沉淀。

### 面 ②:Linear

- **4 个 team**:Flywheel(FLY)· GeoForge3D(GEO)· Personal(LEARN)· Tidal Echo(TIDE)。
- **11 个 project**(跨 3 个 team;Tidal Echo team **没有任何 project**)。
- 6 个被 Flywheel 管的仓 ↔ Linear 的映射**不齐**:`growth` / `tidal-echo` / `personal-assistant` **在 Linear 里没有对应的 project**。

**两个实测的空洞:**

- **Linear 的 project「状态更新」功能:一条都没有过。**
  ```
  linear: get_status_updates(type=project)  →  []
  ```
- **project 自身的 `status` 字段基本不动**:11 个 project 里只有 3 个是 In Progress,
  `updatedAt` 最新的是 2026-07-06,最老的 2026-02-05。

**issue 层「In Progress」不能当新鲜度信号**:实测 60 个 started 状态的 issue,
最老的 `GEO-65` 停在 2026-03-08,`GEO-101` 停在 2026-03-08,`LEARN-68` 停在 2026-06-18 —— 都还挂在 In Progress。

### 面 ③:各仓的 CLAUDE.md(她说的「status 本来就记录在 repository 里」)

这句话**对 flywheel 成立,对其余五个基本不成立**:

| 项目 | CLAUDE.md | 最后一次改动 |
|---|---|---|
| flywheel | **126,390 字节 / 143 行里程碑表** | 2026-08-16 |
| GeoForge3D | 20,738 字节 | 2026-05-31 |
| joycon-typeless | 5,562 字节 | 2026-04-13 |
| growth | 1,945 字节 | 2026-06-18 |
| personal-assistant | 1,491 字节 | (不是 git 仓) |
| tidal-echo | **没有 CLAUDE.md** | — |

```
for p in GeoForge3D joycon-typeless personal-assistant growth flywheel tidal-echo; do
  f=$HOME/Dev/$p/CLAUDE.md
  [ -f "$f" ] && echo "$p $(wc -c <$f) $(cd $HOME/Dev/$p && git log -1 --format=%ad --date=short -- CLAUDE.md)"
done
```

#### ⚠️ 这一条不是补充信息,是**对她前提的更正**(Honey Lemon 2026-08-17 独立复核确认)

Honey Lemon 按注册表逐仓独立复核了一遍(方法与我不同 —— 他数的是**status 类文档份数 + 最后一次提交**,我数的是 commit 数 + CLAUDE.md 体量/mtime),结论同向:

```
flywheel             2026-08-17    397 份   ← 唯一活着的
joycon-typeless      2026-07-04      6 份
geoforge3d           2026-07-02      3 份
tidal-echo           2026-07-05      1 份
growth               2026-07-05      0 份
personal-assistant   无仓库          0 份
```

⇒ 她那句「status 本来就记录在 repository 里」**只对 flywheel 成立,其余五个停在 7 月初**。

**为什么这个定性很重要**:她正是**基于那个前提**在犹豫「还需不需要一个 summary」。
前提被证伪,问题本身就变了 —— 不再是「要不要额外做个 summary」,
而是「**五个仓库根本没有可读的状态,你要它从哪儿知道**」。
⇒ 这直接决定了 A2 那一轮的形态(见 `plan.md` §3)。

**边界**:flywheel 那份的 143 行是**逐 issue 的实现纪要**(每行一个 FLY 号 + 技术细节),
**不是**「项目推进到哪一步」。要它回答 A2 的「on the high level」,需要的是**它没有的那一层**。

### 面 ④:doc-flow 的每-issue 文件夹

`<部门>/doc/<ISSUE>-<slug>/` —— exploration / research / plan / progress。

实测**只有 3 个项目开了**:`flywheel`(engineering + product)· `joycon-typeless`(product)· `tidal-echo`(content)。
`GeoForge3D` / `growth` 有 `.flywheel/config.yaml` 但没有 `doc_flow` 块;`personal-assistant` 连 config.yaml 都没有。

```
for p in GeoForge3D joycon-typeless personal-assistant growth flywheel tidal-echo; do
  echo "$p: $(grep -c '^doc_flow:' $HOME/Dev/$p/.flywheel/config.yaml 2>/dev/null || echo 'n/a')"
done
```

**边界**:同样是 issue 级,而且是**过程档案**(为什么这么做),不是状态。

### 面 ⑤:每个项目的 MEMORY.md(agent 记忆)

全 6 个项目都有,但那是 **agent 的工作记忆**(决定、教训、坑),不是项目状态;而且**新鲜度差得很远**:

| 项目 | 大小 | 最后修改 |
|---|---|---|
| flywheel | 25,317 | 2026-08-17 |
| GeoForge3D | 20,362 | 2026-07-09 |
| tidal-echo | 1,758 | 2026-06-26 |
| personal-assistant | 1,721 | 2026-06-21 |
| joycon-typeless | 1,439 | 2026-06-17 |
| growth | 3,471 | 2026-05-07 |

### 面 ⑥:Discord(每 issue 一条 thread)+ Runner 的 progress.md

- 每个 issue 在 Lead 频道有一条 thread,Runner 的进展经 Lead relay 进去。
- 每个 Runner 在自己的 doc 文件夹维护 `progress.md`(phase + cursor + next)。

⚠️ **这两面对「总管」目前是不可读的**:
Runner **物理上发不了 Discord**;而 Discord 的历史消息**现有工具读不到**
(FLY-1827 里已经栽过一次:她让去看「我们的聊天记录」,那部分没有工具能读)。
⇒ **如果讨论只发生在 Discord 而没落单,对任何 agent 就等于不存在。**

---

## 3. 有没有现成的「汇总面」—— 有端点,但今天几乎全是熄火的

Bridge 已挂载的读接口(`packages/teamlead/src/bridge/plugin.ts`):
`/api/sessions` · `/api/standup` · `/api/digest` · `/api/fleet/snapshot` · `/api/leads` · `/api/triage/data` · `/api/linear/issues` · `/api/memory`。

实测状态:

| 面 | 现状 | 证据 |
|---|---|---|
| **每日 standup** | **代码在,但 launchd job 没被 bootstrap 进去,从没跑过**;而且它**写死单项目** | `launchctl list com.flywheel.daily-standup` → 不存在;`/tmp/flywheel-standup.log` 从未生成;`STANDUP_PROJECT_NAME=geoforge3d` |
| **每日 digest** | 端点挂着(env 已设),但**没有任何 launchd job 或 cron 去调用它** | `ls ~/Library/LaunchAgents \| grep digest` → 空;`crontab -l \| grep digest` → 空 |
| `/api/fleet/snapshot` | 活的,但内容是**舰队运维**(每个 Lead 的 model/backend/进程),不是项目进展 | FLY-247 inc2a |
| `/api/triage/data` | 活的,是 **issue 分诊**,单项目视角 | |
| `#leads-roundtable` | 活的,但那是**一个让 Lead 互相说话的房间,不是一个掌握全局的角色** | FLY-1827 §4.3 |

⇒ **事实陈述**:今天没有任何一个在跑的东西,会把六个项目的状态定期合成一份东西给任何人看。
唯一天然跨项目的数据在 `sessions` 表里,但它的粒度是 issue 级执行,且**没有任何消费者**。

---

## 4. 一个跨项目的活跃度切片(**只给数字,不给建议**)

⚠️ **这一节和她说的痛点直接相关,所以更要克制**:下面只是**测量**,
**不构成「所以该去推进哪个项目」的建议** —— 那一格是 A4,而且是她拍。

**近 30 天(2026-07-18 起)**:

| 项目 | git commits(30d) | commits(7d) | Runner sessions(30d) | 仓库最后一次提交 |
|---|---|---|---|---|
| **flywheel** | **206** | **82** | **775** | 2026-08-17 |
| tidal-echo | 0 | 0 | 1 | 2026-07-05 |
| GeoForge3D | 0 | 0 | 0 | 2026-07-02 |
| joycon-typeless | 0 | 0 | 0 | 2026-07-04 |
| growth | 0 | 0 | 0 | 2026-07-05 |
| personal-assistant | 0 | 0 | 0 | (不是 git 仓) |

```
for p in GeoForge3D joycon-typeless personal-assistant growth flywheel tidal-echo; do
  echo "$p $(cd $HOME/Dev/$p 2>/dev/null && git log --since='30 days ago' --oneline | wc -l)"
done
sqlite3 "file:$HOME/.flywheel/teamlead.db?mode=ro" \
  "select project_name,count(*) from sessions where started_at>'2026-07-18' group by 1 order by 2 desc;"
```

**必须同时说的三条边界**(否则这张表会被读成比它更强的断言):

1. **commit 数不等于工作量。** 内容型项目(tidal-echo / growth)的产出可能是发布出去的内容,不落 git;
   `personal-assistant` 根本不是 git 仓,**它的 0 是「测不到」不是「没干活」**。
2. **这是「机器上留下的痕迹」,不是「她的注意力」。** 她可能在别处推进了某个项目。
3. **这张表不解释原因。** 它不说明是因为兴趣、因为优先级正确、还是因为其他项目在等外部输入。

---

## 5. 由事实引出的**问题**(给 A2 那一轮用,不是答案)

| # | 要问她的 | 为什么这一格必须她拍 |
|---|---|---|
| 1 | 她说的「status 记录在 repository 里」—— 实测只有 flywheel 那份是活的(126KB/143 行,昨天还在更新),另外五个停在 4~6 月。**那这个总管的「知道」,是知道六个项目,还是主要知道在动的那个?** | 决定它是「全项目」还是「活跃项目」的总管,直接改数据面工作量 |
| 2 | **「每小时读一遍」读的是什么?** 今天唯一天然跨项目的机器可读面是 issue 级执行台账;她要的粒度是「大方向」。**中间那层(把 issue 级合成大方向)今天不存在 —— 是让 lead 每小时写一句,还是让总管自己去合成?** | 这就是她自己抛出的「还需不需要一个 summary」那一格 |
| 3 | **「新」到什么程度算够?** 她说不要实时。每小时?每天?还是「聊之前现查一遍」? | 决定是常驻管线还是按需拉取 —— 两种实现成本差一个量级 |
| 4 | **Discord 里聊的算不算它该知道的?** 很多方向性的话只发生在 Discord 且没落单;而 agent 今天读不到 Discord 历史。 | 若算,就多一条数据面;若不算,得接受它会漏掉方向变化 |

---

## 6. 我没查的 / 查不到的(**明说,不糊**)

- **没查** 每个项目「当前推进到哪一步」的真实答案 —— 那需要人的判断,不是机器能读出来的,而且那是 A2 之后的事。
- **读不到** Discord 历史消息(无工具)。任何「她之前在 Discord 说过 X」我都无法自行核实。
- **没测** 让一个 agent 每小时读一遍这些面的实际成本(token / 时延)—— 等 A2 的粒度定了再测才有意义。
- **没碰** 项目级 COS 存废的任何量表 —— 那是组织决定,`exploration.md` §6.1 已标为未决。

---

## 7. 会过期的结论(**引用前先按命令重核**)

| 结论 | as-of | 会怎么过期 | 重核命令 |
|---|---|---|---|
| standup job 没被 bootstrap,从没跑过 | 2026-08-17 | 任何人 bootstrap 一次就变 | `launchctl list com.flywheel.daily-standup; ls -la /tmp/flywheel-standup.log` |
| digest 端点在但无调度 | 2026-08-17 | 加个 launchd/cron 就变 | `ls ~/Library/LaunchAgents \| grep -i digest; crontab -l \| grep -i digest` |
| Linear project status update 一条都没有 | 2026-08-17 | 她或任何人发一条就变 | linear `get_status_updates(type=project)` |
| 近 30 天只有 flywheel 在动 | 2026-08-17 | **随时会变,这是最短命的一条** | §4 的两条命令 |
| 6 项目 / 16 Lead;3 个项目开了 doc-flow | 2026-08-17 | 加项目、加 Lead、开 doc-flow 都会变 | `python3 -c "import json;d=json.load(open('$HOME/.flywheel/projects.json'));print(len(d),sum(len(x['leads']) for x in d))"` |
| Linear 4 team / 11 project;growth·tidal-echo·personal-assistant 无对应 project | 2026-08-17 | 建 project 就变 | linear `list_teams` / `list_projects` |
| flywheel CLAUDE.md 126KB / 143 行里程碑 | 2026-08-17 | 每次 ship 都在长 | §2 面③ 的命令 |
| HL 独立复核的 status 文档份数 397/6/3/1/0/0 | 2026-08-17 | 任一仓恢复活动就变 | 按 HL 的方法逐仓数 status 类文档 + `git log -1 --format=%ad` |

**行号一律不写** —— 引用代码位置时用 `git log -S` 重新定位,不要照抄行号。
