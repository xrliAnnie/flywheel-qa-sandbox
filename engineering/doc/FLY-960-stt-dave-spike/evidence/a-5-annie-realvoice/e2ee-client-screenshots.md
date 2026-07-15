# FLY-960 evidence — A-5 判据⑤ founder 客户端截图说明

日期: 2026-07-07
来源: Annie 于 [FLY-960] Discord thread 发出,Tadashi 转达(lead-instruction 872cd365)

## 截图内容(两张)

- `…1783443235397.png`(频道侧栏图):General 语音频道成员 = **Annie(真人)+「耳朵bot·借用中」
  (pool-04)**。确认真人客户端与耳朵 bot **真实共处同一语音频道**。
- `…1783443235530.png`(通话平铺图):补截时嘴巴 bot 已退出(sender 已停),只剩 Annie + 耳朵 bot。
  截图顶部的「mic Error 3002」= 采集结束后的陈旧提示,与收音结果无关(她的 53 秒语音已成功
  收录并转写,见 `annie-script.txt`)。

> 原图在 Tadashi inbox(bot 无法直接访问 founder 私发的附件);本文件按 Tadashi 转达的内容
> 如实记录。

## 判据⑤ 判定(Tadashi 拍,872cd365)

**以 bot 侧 DAVE 证据收 ⑤,判 PASS**:

1. `dave_protocol_version=1`(session_description,`a-4-stability/a-dave-proof.jsonl`)
2. davey MLS 会话/epoch 全链日志(`a-4-stability/a-debug-extract.log`)
3. **最强证据**:耳朵 bot 成功解密 Annie 真人语音(14/15 关键词,`annie-script.txt`)——
   强制 DAVE 下非加密会话直接 4017 断连、不存在明文流,能解出可懂音频即 E2EE 在场铁证。

**如实标注(非阻塞)**:founder 客户端可见的 E2EE 锁标未定位——Annie 界面里 Discord UI
未显著暴露锁图标。此为 nice-to-have 的视觉佐证,bot 侧 DAVE 在场已由密码学证据 + 成功解密
双重坐实,不影响 GO。
