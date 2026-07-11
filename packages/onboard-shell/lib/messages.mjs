// FLY-1062 PR2 · onboard-shell honest plain-words messages (黑话红线继承 1023).
//
// Customer-facing text is Chinese, plain, actionable — never engineering
// jargon, never a leaked path/secret. Each maps a failure to "what happened +
// what to do", nothing more.
export const MSG = {
	keyMissing:
		"需要你的授权码才能安装。请在提示后粘贴授权码(粘贴时不会显示出来,这是正常的)。",
	keyPromptHidden: "请粘贴授权码,然后按回车:",
	keyRejectedEnv:
		"检测到通过环境变量传入的授权码,但没有开启对应的开关,已忽略。正常安装请直接运行安装命令,按提示粘贴授权码。",
	keyInvalid:
		"授权码不对,或者已经失效了。请核对后重试;拿不准的话联系我们要一个新的授权码。",
	network: "连不上安装服务器。请检查一下网络,稍后再运行同样的命令重试。",
	generic:
		"安装没能完成(可能是磁盘空间、权限或安装服务返回了异常)。已经清理干净,请重新运行安装命令重试;仍然不行请把这条信息发给我们。",
	unknownCommand:
		"不认识这个命令。可用:直接运行(安装)· license set(换授权码)· update(更新)。",
	checksum:
		"下载的安装包校验没通过(可能下载中断了)。已经清理干净,请重新运行安装命令重试,不会留下半成品。",
	updateNone: "已经是最新版本了,不需要更新。",
	updateRollback:
		"新版本启动检查没通过,已经自动切回上一个能用的版本。请把这条信息发给我们看看。",
	updateRollbackDegraded:
		"新版本启动检查没通过,自动回退时也遇到了问题,这台机器现在可能处于不完整状态。请先不要继续操作,把这条信息发给我们,我们来帮你恢复。",
	packagedRefusal:
		"这台机器上的 Flywheel 是安装包形态,不能用这个方式。请运行你当初安装时用的那条命令。",
	done: "安装完成,正在启动引导……",
	// The download + install succeeded and were kept (re-running resumes at this
	// step); only the guided setup handoff errored. Say so honestly instead of a
	// generic "unexpected error" (Codex R4).
	setupFailed:
		"安装已经完成,但在启动引导时出错了。请重新运行同样的命令继续(已经装好的部分会自动跳过);如果还是不行,请把这条信息发给我们。",
};
