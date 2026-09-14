import fs from "node:fs";
import path from "node:path";

export class LockBusy extends Error {
	constructor(message = "另一个更新正在进行,请稍后重试。") {
		super(message);
		this.exitCode = 75;
	}
}

function busy(cfg, message) {
	const error = new LockBusy(message);
	const logs = path.join(cfg.stateDir, "logs");
	fs.mkdirSync(logs, { recursive: true });
	fs.appendFileSync(
		path.join(logs, "auto-update.log"),
		`${new Date().toISOString()} ${error.message}\n`,
	);
	throw error;
}

export function acquireLock(
	cfg,
	{ platform = process.platform, fsImpl = fs } = {},
) {
	fsImpl.mkdirSync(cfg.stateDir, { recursive: true });
	if (platform === "darwin") {
		const file = path.join(cfg.stateDir, "update.lock");
		const { O_RDWR, O_CREAT, O_NONBLOCK } = fs.constants;
		// Darwin O_EXLOCK is not exported by Node. Never unlink this inode.
		for (let attempt = 0; attempt < 2; attempt++) {
			let fd;
			try {
				fd = fsImpl.openSync(file, O_RDWR | O_CREAT | O_NONBLOCK | 0x20, 0o644);
			} catch (error) {
				if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
					return busy(cfg);
				throw error;
			}
			try {
				const held = fsImpl.fstatSync(fd);
				const named = fsImpl.statSync(file);
				if (held.ino !== named.ino || held.dev !== named.dev) {
					fsImpl.closeSync(fd);
					continue;
				}
			} catch (error) {
				fsImpl.closeSync(fd);
				if (error.code === "ENOENT") continue;
				throw error;
			}
			let released = false;
			return {
				release() {
					if (!released) {
						released = true;
						fsImpl.closeSync(fd);
					}
				},
			};
		}
		return busy(cfg);
	}
	const directory = path.join(cfg.stateDir, "update.lock.d");
	try {
		fsImpl.mkdirSync(directory);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		let owner;
		try {
			owner = JSON.parse(
				fsImpl.readFileSync(path.join(directory, "owner.json"), "utf8"),
			);
		} catch {
			return busy(cfg);
		}
		if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
			try {
				process.kill(owner.pid, 0);
			} catch (error) {
				if (error.code === "ESRCH")
					return busy(cfg, "上次更新异常退出,请删除 update.lock.d 后重试。");
			}
		}
		return busy(cfg);
	}
	try {
		fsImpl.writeFileSync(
			path.join(directory, "owner.json"),
			JSON.stringify({ pid: process.pid, created: new Date().toISOString() }),
		);
	} catch (error) {
		fsImpl.rmdirSync(directory);
		throw error;
	}
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			fsImpl.unlinkSync(path.join(directory, "owner.json"));
			fsImpl.rmdirSync(directory);
		},
	};
}
