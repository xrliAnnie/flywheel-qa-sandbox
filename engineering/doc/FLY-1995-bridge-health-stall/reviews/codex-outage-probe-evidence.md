## Codex 全机限流取证(design-review R2 替补缘由,Tadashi 裁定条件①)

- 时间:2026-08-22 ~19:0x UTC。R1(xhigh,thread 01a02ac7-6ea5-78a0-bd6c-868113eedc65)正常完成后,R2 resume 触发 usage limit。
- 探针:`codex-profile use <p>` 逐个切 school/personal/business/personal1/personal2 后各跑 `codex exec "Reply with exactly: OK"`。
- 结果:5/5 profile 全部报 `You've hit your usage limit ... try again at Aug 26th, 2026 11:26 PM.` —— **五个独立账号逐字相同的 reset 时间戳**,疑似机器级限流而非逐号额度。
- 尺子自检:切换后 `~/.codex/auth.json` 的 id_token email claim 确实随 profile 变(school=xiaorongli2011@u.northwestern.edu / personal=xrliannie@gmail.com),排除「profile 没真切」。
- Gemini CLI 替补尝试:0.56.0 报 `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals`(个人 tier 已停,指向 Antigravity)→ 不可用。
- 实际替补:**Antigravity(agy 1.1.15,真 auth 探针通过)**。[R2=agy substitute;Codex 5 profiles usage-limit,identical reset Aug 26 11:26 PM]。R2 抓 1 项(VACUUM INTO 快照)已折入;R3 delta APPROVED。评审链全文:reviews/design-review-r{1,2,3}-*.md。
- 待办(裁定条件③):8/26 后本单未 ship 则机会性补跑真 Codex 轮留档。
