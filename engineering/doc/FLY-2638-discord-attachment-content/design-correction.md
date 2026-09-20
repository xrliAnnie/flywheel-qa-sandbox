# FLY-2638 Discord 附件内容可达 — 设计修正
Issue: FLY-2638 (https://linear.app/geoforge3d/issue/FLY-2638/raya附件收件-discord-图片文本仅到达yuan数据lead-无法读取内容)
日期: 2026-09-18
基于: plan.md

## Lead post-review disposition (authoritative implementation appendix)
来源：Lead 对 report 52d04f0b-a0c4-463e-8825-c3dba8ee612c 的回复，设计 TURN epoch=1 期间收到并落实。

> MED corrupt-image-thread-poisoning 在实现阶段做一个最小结构守卫：检查 magic bytes，并按 header 解出宽高；不合格就不塞进 thread，返回文字错误。只做这一层，不做 next-turn health。其余两条（TXT 截断 live test、过期收据措辞）留在 review-followups.md，不开单。

本附录优先于 plan §4.3.6 与 review-followups.md 对此 advisory 的建议：
- 在 lead-actions/attachment-read.ts 输出 image block 前检查真实字节签名与 MIME一致，并从PNG IHDR、JPEG SOF、WebP VP8/VP8L/VP8X头读取宽高；使用有界解析，头部截断/非法结构/缺宽高/零尺寸/尺寸溢出均拒绝，返回 isError + invalid_content 的文字结果。
- 实施可采用明确保守像素预算（最大单边16384，最大像素40,000,000），超预算 too_large；不重编码、不引入图像解释、不能把不合格字节塞进模型线程。
- 不声称该轻量guard等于完整解码，也不能声称child观察到了下游model API拒图。
- 不实施新的下一回合健康巡检/恢复系统；E4的失败输入验收仍保留，R2 reviewer 的next-turn-health提议明确不纳入本单。
- TXT截断边界与回执过期措辞保留非阻塞Follow-ups，不自动开新单。

只改Flywheel、v1 carrier、mailbox receipt绑定、不碰Raya仓/persona等所有边界不变。本附录是已批准方案的Lead窄化裁定，不是新review gate或v2迁移授权。

## 实施期 v1 字段裁定

实施问题 `74629160-2238-493b-b38d-4f45f08bd316` 经 Lead 裁定：本单中的 v1 只按 `codexCapabilityBundleVersion` 字段缺省处理。保持全局 schema 仅接受显式 v2 值 `2`，不新增字面量 `1`，也不改变 canonical identity 或 v2 capability 准入。plan §4.2 的“bundle absent/1”不得解释成扩大全局 capability schema；本附录的边界裁定优先。
