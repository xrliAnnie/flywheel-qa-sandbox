import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isSafeVersion } from "./config.mjs";
import { currentPkgRoot } from "./install.mjs";
import { stripKeyFromEnv } from "./key.mjs";
import { previousGood, readLedger } from "./ledger.mjs";
import { LockBusy } from "./lock.mjs";
import { MSG } from "./messages.mjs";
import { messageFor } from "./onboard.mjs";
import { mutatorPreflight } from "./preflight.mjs";
import { nextCheckAt, readSchedule } from "./schedule.mjs";
import { refreshShellCopy } from "./shell-copy.mjs";

function versionAt(root, file, json = false) {
	try {
		const contents = fs.readFileSync(path.join(root, file), "utf8");
		const version = json ? JSON.parse(contents).version : contents.trim();
		return isSafeVersion(version) ? version : null;
	} catch {
		return null;
	}
}

const outcomes = {
	updated: "更新成功",
	up_to_date: "已是最新版本",
	held: "暂不安装",
	deferred: "等待安装时段",
	paused: "发布已暂停",
	rolled_back: "已回滚",
	degraded: "恢复失败",
	unauthorized: "授权失败",
	error: "更新失败",
	settled: "恢复完成",
};

function supervisor(cfg, verb, exec, env) {
	const current = currentPkgRoot(cfg);
	if (!current) throw new Error("payload missing");
	return exec(
		"bash",
		[
			"-c",
			`source "$1"; supervisor_${verb} auto-update timer`,
			"auto-update",
			path.join(current, "scripts/lib/supervisor.sh"),
		],
		{
			stdio: "ignore",
			env: stripKeyFromEnv({ ...env, FLYWHEEL_STATE_DIR: cfg.stateDir }),
		},
	);
}

export async function runAutoUpdate(
	cfg,
	action,
	{
		io,
		exec = execFileSync,
		env = process.env,
		json = false,
		now = new Date(),
	} = {},
) {
	const marker = path.join(cfg.stateDir, "auto-update.off");
	if (action === "status") {
		const stored = readLedger(cfg);
		const ledger = stored.ledger;
		const current = currentPkgRoot(cfg);
		const currentVersion = current
			? versionAt(current, ".flywheel-prebuilt")
			: null;
		let supervisorLoaded = false;
		try {
			supervisor(cfg, "is_loaded", exec, env);
			supervisorLoaded = true;
		} catch {}
		const schedule = readSchedule(cfg);
		const status = {
			enabled: !fs.existsSync(marker),
			supervisorLoaded,
			schedule,
			nextCheckAt: nextCheckAt(schedule, now),
			ledgerState: stored.state,
			currentVersion,
			previousGoodVersion: ledger
				? (previousGood(cfg, ledger, currentVersion)?.ver ?? null)
				: null,
			shellVersion: versionAt(
				path.join(cfg.stateDir, "shell/current"),
				"package.json",
				true,
			),
			lastRun: ledger?.lastRun ?? null,
			pendingVersion: ledger?.pendingVersion ?? null,
			nextApplyAt: ledger?.nextApplyAt ?? null,
			holds: ledger?.holds ?? {},
		};
		if (json) io.out(`${JSON.stringify(status)}\n`);
		else
			io.out(
				`${[
					`自动更新：${status.enabled ? "开" : "关"}`,
					`定时器：${supervisorLoaded ? "已安装" : "未安装"}`,
					`检查安排：每 ${schedule.checkEveryHours} 小时检查，${schedule.applyHour} 点起安装`,
					`下次检查：${status.enabled && supervisorLoaded ? status.nextCheckAt : "未安排"}`,
					`当前版本：${currentVersion ?? "未安装"}`,
					`可回滚版本：${status.previousGoodVersion ?? "无"}`,
					`更新程序版本：${status.shellVersion ?? "未安装"}`,
					`最近检查：${status.lastRun ? `${status.lastRun.at} ${outcomes[status.lastRun.outcome]}` : "暂无记录"}`,
					`等待安装：${status.pendingVersion ?? "无"}`,
					`暂不安装：${Object.keys(status.holds).join("、") || "无"}`,
					...(stored.state === "corrupt" ? [MSG.ledgerCorrupt] : []),
				].join("\n")}\n`,
			);
		return 0;
	}
	if (action === "off") {
		fs.mkdirSync(cfg.stateDir, { recursive: true });
		fs.writeFileSync(marker, "");
		try {
			supervisor(cfg, "stop", exec, env);
		} catch {
			io.err("已关闭自动更新；定时器未能停止，后续检查会跳过更新。");
		}
		io.out("自动更新已关闭。\n");
		return 0;
	}
	if (action === "on") {
		let ctx;
		fs.mkdirSync(cfg.stateDir, { recursive: true });
		fs.writeFileSync(marker, "");
		try {
			ctx = await mutatorPreflight(cfg, { exec, env });
			const copy = refreshShellCopy(cfg);
			fs.accessSync(
				path.join(copy, "bin/flywheel-onboard.js"),
				fs.constants.R_OK,
			);
			const current = currentPkgRoot(cfg);
			const bootstrap =
				current && path.join(current, "scripts/packaged/bootstrap-services.sh");
			if (
				!bootstrap ||
				!fs.readFileSync(bootstrap, "utf8").includes("--only")
			) {
				io.err(
					"当前安装的版本还不支持自动更新，请先运行 flywheel-onboard update。",
				);
				return 1;
			}
			exec(
				"bash",
				[bootstrap, "--only", "auto-update", "--state-dir", cfg.stateDir],
				{ stdio: "ignore", env: stripKeyFromEnv({ ...env }) },
			);
			fs.rmSync(marker);
			// The triggered updater must be able to acquire the mutator lock.
			ctx.lock.release();
			supervisor(cfg, "trigger", exec, env);
			io.out("自动更新已开启。\n");
			return 0;
		} catch (error) {
			fs.writeFileSync(marker, "");
			io.err(messageFor(error));
			return error instanceof LockBusy ? 75 : 1;
		} finally {
			ctx?.lock.release();
		}
	}
	return 2;
}
