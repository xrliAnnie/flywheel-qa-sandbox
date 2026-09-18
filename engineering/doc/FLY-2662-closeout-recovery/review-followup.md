# FLY-2662 旧目录缺失补证 — 调研
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662)
日期: 2026-09-17
基于: plan.md

首轮 review gate a2993708-bbd4-4036-bffc-9e90138c7ad2 登记之后，继续只读核对发现：FLY-2598、2616 的工作目录 lstat=ENOENT、Git inventory 不再登记；StateStore仍有明确 worktree_binding_path/branch/generation。没有独立 worktree-binding 表，getWorktreeBinding 读的是sessions专用绑定列；不能从普通worktree_path或session_params猜。

已纳入 plan revision 2/3，和首轮3个HIGH修订一起重新送审：
- v2 verified_absent_worktree 增加 evidenceMode=legacy_absence_observation。证明“持久精确绑定指向的路径现在没有目录”，不伪称“历史父目录inode始终未变”。
- 仅已merged/current op、完整归属、所有体gone且issue launch reservation有效时允许；精确binding优先来自sessions专用绑定列，若row已被清则必须有持久dispatch/binding receipt。无来源仍拒绝。
- 当前 projectRoot 是配置中的可信repo（核对git common-dir/root identity），目标是它同一canonical parent下的既有绑定path；父目录可访问且与repo root的parent dev/ino一致，禁止symlink/path traversal/未挂载/不同父目录。重复lstat精确ENOENT，git完整枚举无该目标；permission/IO/部分枚举未知。
- 只记录 absent receipt，禁止由这种补证执行 rm、git worktree prune、local/remote branch delete。当Git仍残留registration且无历史parent identity时，不授权prune；可记录physical absent与registration残留followup，不能伪称registration已清。主验收已观测两路径均无registration。
- 提交前及后续记录关闭/归档前，重新核验binding/attribution/parent/current op/reservation与目标仍ENOENT。路径复建即失效；重新转正常bound_worktree验证，不复用absence receipt删除新目录。
- 纯fresh observation是新的reclose时期证据，不标成intent-time快照。保留source/observedAt/parent identity，格式版本与历史target revision一起审计。

这一修正消除计划“必须有历史parent inode”会使点名旧作业再次永久held的缺口。仅记录design proposal；当前未实现/未清理生产目录。
