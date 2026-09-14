# FLY-2546 SIGTERM 测试同步 — 探索
Issue: FLY-2546 (https://linear.app/geoforge3d/issue/FLY-2546/flake-flywheel-log-janitortestsh-sigterm-契约在-ci-shell2-间歇红sent1)
日期: 2026-09-14
基于: 无

## 问题与边界
现有 SIGTERM 用例制造 600 个候选文件，等待 lock.d/pid 后睡眠 50ms，再发信号。锁 PID 先于 TERM trap 安装；文件数量和固定睡眠不能同步被测进程。CI 已报告 sent=1 rc=0。当前基线为 14866f7e5，工作树初始干净，无已有 FLY-2546 文档。
仅修改 scripts/__tests__/flywheel-log-janitor.test.sh 的 SIGTERM 用例及夹具/清理。生产脚本、src、其他测试语义不变；不接受 rc=0，不 skip。需要先红后绿、完整套件连续 20 次、同一精确头 CI shell2 连续两次绿。
