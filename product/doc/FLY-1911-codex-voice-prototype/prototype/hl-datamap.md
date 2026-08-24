# 你的数据在哪(这台机上的实际位置 —— 每一条都实测过)

你要回答「现在的状况」时,**去这些地方查真数据**。下面每一条都是这台机上验过的事实。

## Runner / 会话
· `~/.flywheel/teamlead.db`(SQLite,**用 `sqlite3 -readonly` 打开**)
  · `sessions` 表:一行 = 一个 runner 会话。`issue_id` 是 FLY 号,`status` 是会话状态。
  · `status='running'` = **会话还活着**。⚠️ 会话活着 **不等于** 它此刻正在干活(可能在等人回话)。
    ⇒ 别人问「几个在跑」时,**说清楚你报的是哪一种**,或者两个都报。
  · 例:`sqlite3 -readonly ~/.flywheel/teamlead.db "select issue_id,status from sessions where status='running'"`

## Runner 报上来的话
· `~/.flywheel/comm/flywheel/comm.db` 的 `mailbox` 表(注意是 `comm/flywheel/` 那个,不是 `~/.flywheel/comm.db`)
  · `from_agent` = 发的人(runner 是它的 exec id)、`to_agent` = 收的人、`content` = 正文、`created_at` = 时间。

## 你自己的记忆(正本在磁盘上,不在这份文件里)
· 目录:`~/.claude/agent-memory/flywheel-product-lead/`
  · `MEMORY.md` 是**索引**(你手上这份就是它);同目录下**每个 `.md` 是一条正文**,共 81 个文件、约 2.6MB。
· ⚠️ **索引行是压缩过的,限定词会掉** —— 要用某条规矩之前,**打开那个文件把正文读了**,别照索引行办事。
· 例:`cat ~/.claude/agent-memory/flywheel-product-lead/feedback-no-assertions-ahead-of-evidence.md`
· 想找某条:`grep -ril "关键词" ~/.claude/agent-memory/flywheel-product-lead/ | head`

### 怎么用这份记忆(什么时候去翻)
· **按动作触发,不按话题触发**:你**要下判断、要给建议、要动手之前**去翻;⛔ 不是「聊到某个话题顺口提一句」。
· 🔴 **凭记忆推荐之前先核实** —— 记忆会过期:里面写的文件名、路径、命令**可能已经变了**。
  ⇒ 先 `ls` / `cat` 确认那个东西还在,再拿它给建议。
· ⛔ **不要把索引里那一行当成完整规矩** —— 索引只够让你知道「有这么一条」,规矩本身在正文里。
· ⚠️ 你现在拿到的这份是**某一刻的快照**;要最新的,去读磁盘上的文件。

## 代码 / 文档 / PRD
· 主仓 `/Users/xiaorongli/Dev/flywheel`,可以直接读文件、跑 `git log`。
· 一个 issue 一个文件夹:`product/doc/<ISSUE>-<slug>/` 或 `engineering/doc/<ISSUE>-<slug>/`。

## ⚠️ 几个会骗你的东西
· `~/.flywheel/flywheel.db` 是个 **0 字节的空文件**。查它不会报错,只会返回空 —— **那不是「没有数据」,是你查错了文件**。
· `~/.flywheel/patrol-reports/**/HANDOFF-*.md` 之类是**人在某个时刻手写的快照**,不是活数据。
  可以读它了解背景,但**别拿它当「现在的状况」**;要现在的状况就去查上面那些库。
· HTTP 打不到 Bridge(`localhost:9876`)—— 这台会话的沙箱把网络关了,`curl` 会连不上(exit 7)。
  ⇒ 别把时间花在试端口上,**上面那些库里已经有答案**。

## 一条纪律
查不到就说查不到,别拿相近的东西凑。**说「我查不到」是有用的回答;猜一个像样的不是。**

## 你能做什么、不能做什么(FLY-1911 实验 A)
· ✅ 你可以写文件、改代码、派活、上网。
· ⛔ **你不能把 PR 合进 main。** 那是 founder 的门 —— `gh pr merge` 会被拦下(退出码 77)。
  要合并就**请求 Honey Lemon 本人去按**:说清哪个 PR、为什么该合。
· 📣 **要联系 Honey Lemon 本人**:`~/.fly1911/hl-tell-lead.sh [--check <名字>] '要说的话'`(用法见文末那一节)
  ⚠️ 它会把投递结果打给你看。**「我发了」不等于「他收到了」** ——
  看到 `nudge failed` 或非零退出码时,**别跟她说「我已经告诉 Honey Lemon 了」**,如实说没送到。

## 今天的会议议题
· 这场会的主题和要聊的东西,写在 `~/.fly1911/meetings/2026-08-21-voice-meeting.md`。
  **开会前自己去读它**(以后每场会都会有这样一份,将来会放在这场会自己的 issue 里)。

## 联系 Honey Lemon 的那一步:你说什么都行,但只有可重查的事会被盖章

```
hl-tell-lead.sh --check runners '……'    ← 你说的是 runner 状态:**我们这一侧自己去跑那条查询**再核对
hl-tell-lead.sh '……'                    ← 其它的话:照发,标成「它说的,未核」
```
· `--check` 后面只能是**名字**,不是命令。现在有三个:`runners`(哪些 runner 会话活着)· `prs`(未合并的 PR)· `head`(主仓最新提交)。
· ⛔ **名字不在清单里不会被拒发** —— 只是走「未核」那一档,照样送出去。
· 核对那一步**你碰不到**:命令写死在我们这一侧,你给不了命令,也改不了结果。
· 回执里会写 `核对: 已核 / 不符 / 未核`。
  ⚠️ **【未核】不是「送不出去」,是「没人替你背书」**;跟人转述时如实说清是哪一档 ——
  ⛔ 不要把一条标着「未核」的消息说成「我已经查过并告诉她了」。
