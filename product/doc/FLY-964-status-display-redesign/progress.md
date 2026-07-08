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
- [x] Lead QA 通过 v1(a0ca86ac)→ 转 Annie。
- [x] Annie 第一波反馈(lead-instruction 2c3c9b91):要**高保真真实 Discord 卡片**,含置顶文字在 Discord 里怎么显示。
- [x] **v2 建好**:6 卡全改高保真 Discord chrome(真 thread 头部栏 # parent › 🧵 + 📌;置顶消息=头像+用户名+APP标+时间戳+真 markdown 渲染<粗体/inline code/emoji 相位行>——因真 Discord 消息只能显 markdown 文字,正是 Annie 要看的)。核心内容全保留。
  - 主题待定(Annie 用深/浅?Lead 在问)→ 内建**双主题 + 纯 CSS 切换钮(无 JS,过托管 CSP,已在发布 URL 实测可切)**,默认深色(Discord 默认/最可能)。她答复后锁定默认。
  - v2 URL: https://fw-reports-a53de2.vercel.app/r/8535263d03570f2a7b13369b3fac627b/
  - claude-in-chrome 双主题都实测渲染正确(含受阻红/可ship绿/A/B/两修复)。
  - commit 092696bd(未 push)。已报 Lead(42166bd6)。
- [x] Annie 主题答复(lead-instruction ed93d601):她 Discord 用 **Dark Mode** → 锁定真实 Discord 深色、去掉浅色切换、加彩色用户名。
- [x] **锁定深色版建好**:移除 dark/light 切换、单一真 Discord 深色主题;精确配色(消息区 #313338 / 侧栏 #2b2d31 / 白浅灰字 / 蓝 #5865f2 / 时间戳灰);彩色用户名 role-color 青 #4fc0ff;其余高保真 chrome 全保留。
  - 最终 URL: https://fw-reports-a53de2.vercel.app/r/dfcd63d3bc3444b505614df15d3deda9/
  - claude-in-chrome 全页实测:6 状态 + 受阻红 + 可ship绿 + 彩色用户名 + A/B + 两修复全渲染正确,真 Discord 深色质感。
  - commit 0a7d1ce9(未 push)。已报 Lead(ed93d601 DONE)。
- [x] Lead QA 通过深色版 + Annie 逐块反馈回来。
- [x] **v3 建好**(Annie 逐块决策定稿方向):
  - 标题=方案A:只当前段徽章 🎨设计/🔨实现/🧪QA(无「未开始」态)。
  - 置顶=大幅简化回每段一行:[段·模型] 状态·exec + 下面 env -u TMUX tmux attach;砍掉球在谁/下一步。
  - 图标 4 个:✅完成 ▶进行中 🔁返工(新增)◻还没到(路线图)。
  - **核心正确性**:画了真实返工例子(实现完→QA→打回实现):实现 🔁返工中、QA ◻待返工回验、标题回 🔨实现 = 返工可见、状态诚实。
  - 保留:真 markdown、深色默认+浅色切换钮、彩色用户名;加正确性区。
  - 自查 div 81/81 平衡;自己 QA 时抓修了 .read flex 碎块 bug。
  - v3 URL: https://fw-reports-a53de2.vercel.app/r/5888845247db9f0decac7888d577e060/
  - claude-in-chrome 双主题实测:返工态/全绿/正确性/切换全对。
  - commit 18bca78f(未 push)。已报 Lead。
  - 我主动 surface 的两个读法(待 Annie 确认):① 返工时标题仍显当前段 🔨实现(方案A),「又返工」细节在置顶 🔁;② QA 返工时用 ◻待返工回验(复用她的 ◻ 图标表「等待」)。
- [x] **v4 完整版建好**(Annie 完整版轮,不再等 Tadashi 两段式确认):
  - 状态锁 4 态:◻未开始 / ▶进行中(含正在返工那段)/ ✅已完成 / 🔁等待中;v3 的『待返工回验』→ 统一『🔁等待中』。返工模型翻转:返工段=▶进行中,被打回等待的 QA 段=🔁等待中。
  - 加 Discord 侧边栏 mock(4 条 thread 各带段徽章,一眼看每个 issue 在哪段)。
  - 加两模式对比:三段式(3 行)vs 两段式(设计+实现合一/QA,标『结构待定义·FLY-830』)。
  - 移除 attach 命令(改 cmux 内置 ⌘P,每段一行更简)。保留真 Discord 深色+真 markdown+浅色切换。
  - 主动 surface:返工要不要进侧边栏徽章(当前按方案A显 🔨实现=和首次实现同,请 Annie 拍)。
  - 自查 div 98/98 平衡、深色默认、0 attach 残留;claude-in-chrome 全页实测(4态/侧边栏/返工/两模式/正确性全对)。
  - v4 URL: https://fw-reports-a53de2.vercel.app/r/c2a9f0142493b6eb7c94c57d9cfd0ec0/
  - commit 56b0e7d6(未 push)。已报 Lead。
- [x] **v5 小修**(Annie:CMux attach 加回置顶 —— v4 删过度了,那条是每段 session 引用):
  - 每段状态行下加回 env -u TMUX tmux attach -t '=cmux-fly-964-<段>'(有 session 的段才有;◻未开始段无)。⌘P footer 保留作快速跳转。其余 v4 全不动。
  - 自查 div 118/118 + p 52/52 平衡、15 处 attach、深色默认、v4 内容全在。
  - v5 URL: https://fw-reports-a53de2.vercel.app/r/fdeec5dde207639ab1a2fbca7d9fe896/
  - 注:最终 live 截图因 Chrome 扩展断连没跑成;v5=v4(已全截图验证)+ v3 已验证的 attach 模式,结构自查绿 → 已如实告知 Lead 让其 QA 时留意 attach 间距。
  - commit 7e150373(未 push)。已报 Lead。
- [x] mockup 交付链完成(v1-v5 全 Lead QA 过 → Annie);设计基本齐。
- [x] **收口 PRD**(Lead 指令:v5 设计收成正式 PRD + 拆 build):
  - prd.md 写好(§0 一句话 / §1 背景 / §2 设计锁定 v5[标题方案A·置顶每段一行 4态+exec+cmux attach·侧边栏当前段徽章(返工不进侧边栏 = Annie 拍板)·真 markdown 深色·三段+两段(两段结构 FLY-830)] / §3 CMux ⌘P 零开发 / §4 正确性头号硬指标[显示永远反映真实+自愈·FLY-907 已修一半根·归档约束喂 FLY-962·根治→FLY-978·edge case ①-⑤ 标 owner] / §5 拆 build 提议 a/b/c + owner 表[显示层+正确性=Tadashi,根治=978,两段=830] / §6 非目标)。
  - review.html(Apple 浅色 PRD 审阅件):自查 0 prefers-color-scheme、body #f5f5f7、div 24/24、0 外部/JS、v5 URL 已链接。
  - review URL: https://fw-reports-a53de2.vercel.app/r/b1ad0181b906062a4d18efb258e3b85f/
  - 技术论断基于已读代码(issue-display.ts PhaseDisplayState=pending/active/done/blocked、FLY-907 全生命周期触发+sweep 自愈、DisplayWriteResult deferred→sweep 补回)。
  - 未触发 codex design_review gate:Lead 明确『product PRD,验收=Annie+我、无 QA』→ Lead 是 reviewer(已在报告注明,Lead 要可再叫)。
  - 注:review.html live 截图因 Chrome 扩展断连没跑成;已 grep 自查浅色达标。
  - commit 待提交(未 push)。已报 Lead。
- [x] Lead QA PRD 过 + Annie approve 964;codex design-review 过(方向 sound)挑出 5 buildability gap。
- [x] **补齐 5 个 buildability gap**(照 issue-display.ts 状态机如实,lead-instruction c163f664):
  - §6.1 状态行 face C 规格化(renderPhaseStatusLine 紧凑行、4 态图标同套、同源刷新);§6.2 964 验收边界独立于 978/962;§6.3 两段式明确划出本次 scope(待 FLY-830);§6.4 4 态完整转移表(现状机基线 + 新增 🔁 规则[某段 parked 但更早段 active→🔁,修 parked-QA 错显已过 bug] + 10 场景事件表含多轮返工/QA重开/设计打回/kill取消归档);§6.5 exec/attach 行最小生命周期。
  - prd.md 加 §6、非目标 renumber §7;review.html 同步加「⑤ 落地补充」含转移表(自查 0 prefers-color-scheme、div 30/30 浅色)。
  - **commit + push flywheel-FLY-964 → PR #499 自动更新**(Lead 要 codex 再过一遍 → 过了 Lead merge)。
  - 更新 review URL: https://fw-reports-a53de2.vercel.app/r/9164f2ae623ee2e2ababe659157497c6/
- [x] codex R2:4/5 gap 过,剩 1 处**两段式 scope 文本矛盾**(§2.6「同一套显示规则」+ §5a build 列了两段式渲染,和 §6.3 打架)。
- [x] **统一两段式 scope**(lead-instruction 075576ff):§2.6 改『本次锁三段式、两段式仅方向说明不进 build、待 FLY-830』;§5a 去掉两段式 build 项改『本次不含两段式渲染 deferred FLY-830』;review.html ①卡 + ④(a) 同步。自查:旧矛盾措辞 prd/review 均 0,三处 scope 一致,review.html 0 prefers-color-scheme + div 30/30。
  - 更新 review URL: https://fw-reports-a53de2.vercel.app/r/05d74f3352c4c41bcf2a195580b99ed2/
  - commit + push → PR #499 更新;Lead grep 核(不再全跑 codex)→ 过了 Lead merge + 建 Ship-964 交 Tadashi + 归档 thread。
- **PARK 待命**:等 Lead grep 核 + merge #499(别 ship / 别自 merge / 别清 / 别归档,等 Lead)。要改 Lead relay。
