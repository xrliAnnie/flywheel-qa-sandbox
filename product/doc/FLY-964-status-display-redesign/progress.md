# FLY-964 三段式状态显示重设计 — 进度

Issue: FLY-964 (https://linear.app/geoforge3d/issue/FLY-964/三段式designimplementqa状态显示重设计-让-annie-一眼看懂现在在哪一步pm-共创)
日期: 2026-07-07
基于: 无(Lead brief 直接派)

## 任务(Lead brief 重定义)
出**第一版 mockup**(Apple 浅色 HTML)给 Annie 看『理想的三段式状态显示』。沟通件 —— **不 PR、不 ship**。出 hosted URL 发 Lead → Lead QA+浅色核对 → Lead 发 Annie。

## Phase: design(mockup)· 1/1 done
- [x] 摸现状:FLY-560 title 徽章(stage-utils.ts 12→9 聚类)/ FLY-892 置顶 pipeline header / FLY-907 三面同源状态机 / FLY-793 handoff(design_done→implement→awaiting_review→QA→ship gate|FAIL 返工)
- [x] 建 mockup.html:5(+1)代表状态,每个画真 Discord thread-title + 置顶消息;title 粗 phase(只 phase 推进改名)+ 置顶细『你在这里』(进度条+当前小步+球在谁+下一步+卡没卡+attach);cohere 图例 + 字形词表;title A/B 给 Annie 选;体现 FLY-962(活跃不归档)+ FLY-959(QA 全过才弹 ship)两修复
- [x] 浅色自查:prefers-color-scheme=0 / data-theme=0 / 外部资源=0 / body 底 #f5f5f7
- [x] 发布(仅 /api/reports/publish,**不投 Discord**)+ claude-in-chrome 视觉 QA(6 状态 + 两修复区全渲染正确)
- [x] 报 Lead URL

## 交付
- hosted URL: https://fw-reports-a53de2.vercel.app/r/c82e81be2ca826ee6c1ea9026dd50a9b/
- 源文件: product/doc/FLY-964-status-display-redesign/mockup.html

## 待定(留给 Annie⟷HL 共创)
- title A/B(单当前 phase 徽章 vs 三 phase 微进度条)
- 字形/措辞;要不要加「预计还剩」
- 单 session(非三段式)路径是否同套原则(本 mockup 聚焦三段式)

## Next
等 Lead QA 反馈迭代。不 PR、不 ship。
