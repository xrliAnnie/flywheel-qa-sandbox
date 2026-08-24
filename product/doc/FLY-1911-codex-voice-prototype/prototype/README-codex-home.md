# 专属 CODEX_HOME 这条线在测什么(FLY-1911)

**背景**:语音分身要有自己的 codex home,好让它的记忆/记录不跟别人混在一起。
⚠️ 一动手就量到:**它此前一直跑在 `~/.codex-infra-bot` 上** —— 桥没设过 `CODEX_HOME`,
直接继承了起它的那个 shell 的环境变量。**不是公共 home,也不是它自己的。**

## 这两个文件是什么
· `codex-home-probe.mjs` —— **取证仪器**。`snapshot <标签>` 拍一份三个 home 的状态
  (memories 库逐表行数 · sessions/archived_sessions 文件数与新增文件名 · history 大小),
  `diff <A> <B>` 比两份。⛔ memories 库**一律先复制到临时文件再读**,绝不打开原库。
· `codex-home-criteria.md` —— **冻结的判据**(①隔离 / ②a会话记录落位 / ②b记忆管线 / ③不继承),
  以及这次判据拆分的**提出时刻 vs 首次跑出结果的时刻**(用来判断那是修正还是文过饰非)。

## 现在卡在哪
专属 home 没有 `auth.json` ⇒ 会话起不来(401,和 8/18 那次同一堵墙)。
⛔ 凭据是 founder 的东西,不由 runner 决定:复制 / 软链 / 重新登录三条路等她拍。
(软链已被排除:codex 刷新 token 会写回原文件,而那个文件是**别人的生产**在用。)
