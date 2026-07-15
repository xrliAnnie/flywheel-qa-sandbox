import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCronTargetId,
	buildTargetId,
	fileSourceRevision,
	type ManagementCronView,
} from "../bridge/management-console-contract.js";
import type { CronSourceTarget } from "../bridge/management-cron-source.js";
import { ManagementCronWriter } from "../bridge/management-cron-writer.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const path of cleanups.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

class LaunchctlHarness {
	commands: string[][] = [];
	failCommand?: string;
	loaded: boolean;
	enabled: boolean;

	constructor(state: { loaded: boolean; enabled: boolean }) {
		this.loaded = state.loaded;
		this.enabled = state.enabled;
	}

	execFile = (file: string, args: readonly string[]): string => {
		if (file === "plutil") {
			if (args.includes("json") && args.includes("-")) {
				return readFileSync(String(args.at(-1)), "utf8");
			}
			return "";
		}
		const command = [...args];
		this.commands.push(command);
		const action = command[0]!;
		if (this.failCommand === action) {
			this.failCommand = undefined;
			throw new Error(`${action} failed`);
		}
		if (action === "print-disabled") {
			return this.enabled ? "{}" : `\"example.job\" => true`;
		}
		if (action === "print") {
			if (!this.loaded) throw new Error("not loaded");
			return "service = { state = running }";
		}
		if (action === "bootout") {
			this.loaded = false;
			return "";
		}
		if (action === "enable") {
			this.enabled = true;
			return "";
		}
		if (action === "disable") {
			this.enabled = false;
			return "";
		}
		if (action === "bootstrap") {
			if (!this.enabled) throw new Error("disabled");
			this.loaded = true;
			return "";
		}
		throw new Error(`unexpected command ${command.join(" ")}`);
	};
}

function setupTarget(
	options: {
		loaded?: boolean;
		enabled?: boolean;
		advanced?: boolean;
		modelCarrier?: boolean;
		labelInFile?: string;
		pathOutside?: boolean;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "cron-writer-"));
	cleanups.push(root);
	const launchAgentsDir = join(root, "LaunchAgents");
	const actualDir = options.pathOutside ? root : launchAgentsDir;
	writeFileSync(join(root, ".keep"), "");
	mkdirSync(launchAgentsDir);
	const path = join(actualDir, "example.job.plist");
	const plist: Record<string, unknown> = {
		Label: options.labelInFile ?? "example.job",
		ProgramArguments: [
			"/projects/alpha/job.sh",
			...(options.modelCarrier ? ["--model", "claude-fable-5"] : []),
		],
		StartCalendarInterval: options.advanced
			? { Month: 7, Day: 14, Hour: 9, Minute: 0 }
			: { Weekday: 1, Hour: 9, Minute: 0 },
		KeepAlive: false,
	};
	const bytes = Buffer.from(JSON.stringify(plist));
	writeFileSync(path, bytes);
	const canonicalPath = realpathSync(path);
	const revision = fileSourceRevision(bytes);
	const scheduleTargetId = buildCronTargetId(
		canonicalPath,
		"example.job",
		"schedule",
	);
	const enabledTargetId = buildCronTargetId(
		canonicalPath,
		"example.job",
		"enabled",
	);
	const modelTargetId = buildCronTargetId(
		canonicalPath,
		"example.job",
		"model",
	);
	const writable = {
		writable: true,
		consequence: "reload-launchd" as const,
		requiresAcknowledgement: true,
	};
	const readonly = {
		writable: false,
		reason: options.advanced ? "advanced" : "未声明模型载体",
		consequence: "governance-readonly" as const,
		requiresAcknowledgement: true,
	};
	const view: ManagementCronView = {
		id: buildTargetId("cron", [canonicalPath, "example.job"]),
		label: "example.job",
		projectName: "alpha",
		sourceHint: "example.job.plist",
		schedule: {
			targetId: scheduleTargetId,
			current: options.advanced
				? null
				: {
						days: [1],
						times: [{ hour: 9, minute: 0 }],
						label: "自定义",
					},
			source: { kind: "launchd_plist", revision },
			writeCapability: options.advanced ? readonly : writable,
		},
		enabled: {
			targetId: enabledTargetId,
			current: options.enabled ?? true,
			source: {
				kind: "launchctl",
				revision: `launchctl:${options.enabled === false ? "disabled" : "enabled"}`,
			},
			writeCapability: writable,
		},
		loaded: options.loaded ?? true,
		model: {
			targetId: modelTargetId,
			current: options.modelCarrier
				? { provider: "anthropic", model: "claude-fable-5", effort: null }
				: null,
			source: { kind: "launchd_plist", revision },
			writeCapability: options.modelCarrier ? writable : readonly,
		},
		warnings: [],
	};
	const target: CronSourceTarget = {
		path,
		canonicalPath,
		label: "example.job",
		plist,
		bytes,
		fileSha: revision.slice("file:".length),
		view,
		modelArgumentIndex: options.modelCarrier ? 1 : null,
	};
	const launchctl = new LaunchctlHarness({
		loaded: options.loaded ?? true,
		enabled: options.enabled ?? true,
	});
	const writer = new ManagementCronWriter({
		launchAgentsDir,
		uid: process.getuid!(),
		targets: () => [target],
		deps: { execFile: launchctl.execFile },
	});
	return { root, path, bytes, target, view, writer, launchctl };
}

describe("management cron writer staging", () => {
	it("does not disable the whole console when LaunchAgents is absent", () => {
		expect(
			() =>
				new ManagementCronWriter({
					launchAgentsDir: "/missing/Library/LaunchAgents",
					uid: 501,
					targets: () => [],
					deps: {
						realpath: () => {
							throw new Error("ENOENT: LaunchAgents");
						},
					},
				}),
		).not.toThrow();
	});

	it("returns canonical old/new/SHA/runtime state with zero mutation", () => {
		const { path, bytes, view, writer, launchctl } = setupTarget();
		const staged = writer.stage({
			targetId: view.schedule.targetId,
			desiredValue: {
				days: [1, 3, 5],
				times: [
					{ hour: 9, minute: 0 },
					{ hour: 17, minute: 30 },
				],
				label: "自定义",
			},
			observedRevision: view.schedule.source.revision,
		});
		expect(staged).toMatchObject({
			status: "staged",
			change: {
				field: "schedule",
				oldValue: view.schedule.current,
				newValue: {
					days: [1, 3, 5],
					times: [
						{ hour: 9, minute: 0 },
						{ hour: 17, minute: 30 },
					],
				},
				fileSha: expect.stringMatching(/^[a-f0-9]{64}$/),
				priorRuntime: { enabled: true, loaded: true },
			},
		});
		expect(readFileSync(path)).toEqual(bytes);
		expect(launchctl.commands).toEqual([]);
	});

	it("rejects forged keys, stale revision, unsafe files, uid drift, label drift, and escape", () => {
		const normal = setupTarget();
		expect(
			normal.writer.stage({
				targetId: normal.view.enabled.targetId,
				desiredValue: false,
				observedRevision: normal.view.enabled.source.revision,
				path: "/tmp/forged",
			} as never),
		).toMatchObject({ status: "rejected" });
		expect(
			normal.writer.stage({
				targetId: normal.view.schedule.targetId,
				desiredValue: normal.view.schedule.current,
				observedRevision: "file:stale",
			}),
		).toMatchObject({ status: "rejected" });

		const escaped = setupTarget({ pathOutside: true });
		expect(
			escaped.writer.stage({
				targetId: escaped.view.enabled.targetId,
				desiredValue: false,
				observedRevision: escaped.view.enabled.source.revision,
			}),
		).toMatchObject({ status: "rejected" });

		const label = setupTarget({ labelInFile: "other.job" });
		expect(
			label.writer.stage({
				targetId: label.view.enabled.targetId,
				desiredValue: false,
				observedRevision: label.view.enabled.source.revision,
			}),
		).toMatchObject({ status: "rejected" });

		const uid = setupTarget();
		const uidWriter = new ManagementCronWriter({
			launchAgentsDir: join(uid.root, "LaunchAgents"),
			uid: process.getuid!(),
			targets: () => [uid.target],
			deps: {
				execFile: uid.launchctl.execFile,
				lstat: (path) => {
					const stat = lstatSync(path);
					return {
						isFile: () => stat.isFile(),
						isSymbolicLink: () => stat.isSymbolicLink(),
						uid: process.getuid!() + 1,
						gid: stat.gid,
						mode: stat.mode,
					};
				},
			},
		});
		expect(
			uidWriter.stage({
				targetId: uid.view.enabled.targetId,
				desiredValue: false,
				observedRevision: uid.view.enabled.source.revision,
			}),
		).toMatchObject({ status: "rejected" });

		const symlink = setupTarget();
		const real = `${symlink.path}.real`;
		writeFileSync(real, symlink.bytes);
		rmSync(symlink.path);
		symlinkSync(real, symlink.path);
		expect(
			symlink.writer.stage({
				targetId: symlink.view.enabled.targetId,
				desiredValue: false,
				observedRevision: symlink.view.enabled.source.revision,
			}),
		).toMatchObject({ status: "rejected" });
	});

	it("canonicalizes valid schedules and rejects empty/range-invalid values", () => {
		const { writer, view } = setupTarget();
		const duplicate = writer.stage({
			targetId: view.schedule.targetId,
			desiredValue: {
				days: [3, 1, 3],
				times: [
					{ hour: 9, minute: 0 },
					{ hour: 9, minute: 0 },
				],
				label: "每日",
			},
			observedRevision: view.schedule.source.revision,
		});
		expect(duplicate).toMatchObject({
			status: "staged",
			change: {
				newValue: { days: [1, 3], times: [{ hour: 9, minute: 0 }] },
			},
		});
		for (const desiredValue of [
			{ days: [], times: [{ hour: 9, minute: 0 }], label: "自定义" },
			{ days: [1], times: [], label: "自定义" },
			{ days: [8], times: [{ hour: 9, minute: 0 }], label: "自定义" },
			{ days: [1], times: [{ hour: 24, minute: 0 }], label: "自定义" },
			{ days: ["1"], times: [{ hour: 9, minute: 0 }], label: "自定义" },
			{ days: [1], times: [{ hour: "9", minute: 0 }], label: "自定义" },
		]) {
			expect(
				writer.stage({
					targetId: view.schedule.targetId,
					desiredValue,
					observedRevision: view.schedule.source.revision,
				}),
			).toMatchObject({ status: "rejected" });
		}
	});

	it("keeps advanced schedules read-only while allowing enable, and refuses unbound model edits", () => {
		const { writer, view } = setupTarget({ advanced: true });
		expect(
			writer.stage({
				targetId: view.schedule.targetId,
				desiredValue: {
					days: [1],
					times: [{ hour: 9, minute: 0 }],
					label: "自定义",
				},
				observedRevision: view.schedule.source.revision,
			}),
		).toMatchObject({ status: "rejected" });
		expect(
			writer.stage({
				targetId: view.enabled.targetId,
				desiredValue: false,
				observedRevision: view.enabled.source.revision,
			}),
		).toMatchObject({ status: "staged" });
		expect(
			writer.stage({
				targetId: view.model!.targetId,
				desiredValue: {
					provider: "openai",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
				observedRevision: view.model!.source.revision,
			}),
		).toMatchObject({ status: "rejected" });
	});

	it("rejects cron effort values that have no persisted launchd carrier", () => {
		const { writer, view } = setupTarget({ modelCarrier: true });
		expect(
			writer.stage({
				targetId: view.model!.targetId,
				desiredValue: {
					provider: "anthropic",
					model: "claude-fable-5",
					effort: "xhigh",
				},
				observedRevision: view.model!.source.revision,
			}),
		).toMatchObject({ status: "rejected" });
	});
});

describe("management cron writer apply/verify/rollback", () => {
	it("reloads a loaded schedule in exact order and verifies registered state", () => {
		const { writer, view, launchctl, path } = setupTarget();
		const staged = writer.stage({
			targetId: view.schedule.targetId,
			desiredValue: {
				days: [1, 2],
				times: [{ hour: 10, minute: 15 }],
				label: "自定义",
			},
			observedRevision: view.schedule.source.revision,
		});
		if (staged.status !== "staged") throw new Error("expected staged");
		expect(writer.apply(staged.change)).toMatchObject({ status: "applied" });
		expect(launchctl.commands.map((command) => command[0])).toEqual([
			"bootout",
			"enable",
			"bootstrap",
			"print-disabled",
			"print",
		]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			KeepAlive: false,
			StartCalendarInterval: [
				{ Weekday: 1, Hour: 10, Minute: 15 },
				{ Weekday: 2, Hour: 10, Minute: 15 },
			],
		});
	});

	it("bootstraps an enabled-but-unloaded job; disable and enable use launchctl state, not a plist key", () => {
		const unloaded = setupTarget({ loaded: false, enabled: true });
		const schedule = unloaded.writer.stage({
			targetId: unloaded.view.schedule.targetId,
			desiredValue: {
				days: [1],
				times: [{ hour: 11, minute: 0 }],
				label: "自定义",
			},
			observedRevision: unloaded.view.schedule.source.revision,
		});
		if (schedule.status !== "staged") throw new Error("expected staged");
		expect(unloaded.writer.apply(schedule.change).status).toBe("applied");
		expect(
			unloaded.launchctl.commands.map((command) => command[0]),
		).not.toContain("bootout");
		expect(unloaded.launchctl.loaded).toBe(true);

		const disable = setupTarget({ loaded: true, enabled: true });
		const disableStage = disable.writer.stage({
			targetId: disable.view.enabled.targetId,
			desiredValue: false,
			observedRevision: disable.view.enabled.source.revision,
		});
		if (disableStage.status !== "staged") throw new Error("expected staged");
		expect(disable.writer.apply(disableStage.change).status).toBe("applied");
		expect(disable.launchctl.commands.map((command) => command[0])).toEqual([
			"bootout",
			"disable",
			"print-disabled",
			"print",
		]);
		expect(JSON.parse(readFileSync(disable.path, "utf8"))).not.toHaveProperty(
			"Disabled",
		);

		const enable = setupTarget({ loaded: false, enabled: false });
		const enableStage = enable.writer.stage({
			targetId: enable.view.enabled.targetId,
			desiredValue: true,
			observedRevision: enable.view.enabled.source.revision,
		});
		if (enableStage.status !== "staged") throw new Error("expected staged");
		expect(enable.writer.apply(enableStage.change).status).toBe("applied");
		expect(enable.launchctl.commands.map((command) => command[0])).toEqual([
			"enable",
			"bootstrap",
			"print-disabled",
			"print",
		]);
	});

	it("fails before mutation on render, SHA drift, or bootout failure", () => {
		const render = setupTarget();
		const renderWriter = new ManagementCronWriter({
			launchAgentsDir: join(render.root, "LaunchAgents"),
			uid: process.getuid!(),
			targets: () => [render.target],
			deps: {
				execFile: (file, args) => {
					if (file === "plutil" && args[1] === "xml1")
						throw new Error("render failed");
					return render.launchctl.execFile(file, args);
				},
			},
		});
		const renderStage = renderWriter.stage({
			targetId: render.view.schedule.targetId,
			desiredValue: {
				days: [2],
				times: [{ hour: 10, minute: 0 }],
				label: "自定义",
			},
			observedRevision: render.view.schedule.source.revision,
		});
		if (renderStage.status !== "staged") throw new Error("expected staged");
		expect(renderWriter.apply(renderStage.change).status).toBe("rejected");
		expect(readFileSync(render.path)).toEqual(render.bytes);
		expect(render.launchctl.commands).toEqual([]);

		const drift = setupTarget();
		const driftStage = drift.writer.stage({
			targetId: drift.view.schedule.targetId,
			desiredValue: {
				days: [2],
				times: [{ hour: 10, minute: 0 }],
				label: "自定义",
			},
			observedRevision: drift.view.schedule.source.revision,
		});
		if (driftStage.status !== "staged") throw new Error("expected staged");
		writeFileSync(drift.path, "manual drift");
		expect(drift.writer.apply(driftStage.change).status).toBe("rejected");
		expect(drift.launchctl.commands).toEqual([]);

		const bootout = setupTarget();
		bootout.launchctl.failCommand = "bootout";
		const bootoutStage = bootout.writer.stage({
			targetId: bootout.view.schedule.targetId,
			desiredValue: {
				days: [2],
				times: [{ hour: 10, minute: 0 }],
				label: "自定义",
			},
			observedRevision: bootout.view.schedule.source.revision,
		});
		if (bootoutStage.status !== "staged") throw new Error("expected staged");
		expect(bootout.writer.apply(bootoutStage.change).status).toBe("rejected");
		expect(readFileSync(bootout.path)).toEqual(bootout.bytes);
	});

	it("restores exact bytes and prior runtime after post-rename failure; reports partial if rollback fails", () => {
		const rollback = setupTarget();
		rollback.launchctl.failCommand = "bootstrap";
		const staged = rollback.writer.stage({
			targetId: rollback.view.schedule.targetId,
			desiredValue: {
				days: [2],
				times: [{ hour: 10, minute: 0 }],
				label: "自定义",
			},
			observedRevision: rollback.view.schedule.source.revision,
		});
		if (staged.status !== "staged") throw new Error("expected staged");
		expect(rollback.writer.apply(staged.change).status).toBe("rolled_back");
		expect(readFileSync(rollback.path)).toEqual(rollback.bytes);
		expect(rollback.launchctl.commands.map((command) => command[0])).toContain(
			"bootout",
		);

		const partial = setupTarget();
		partial.launchctl.failCommand = "bootstrap";
		let renames = 0;
		const partialWriter = new ManagementCronWriter({
			launchAgentsDir: join(partial.root, "LaunchAgents"),
			uid: process.getuid!(),
			targets: () => [partial.target],
			deps: {
				execFile: partial.launchctl.execFile,
				rename: (from, to) => {
					renames++;
					if (renames > 1) throw new Error("restore rename failed");
					renameSync(from, to);
				},
			},
		});
		const partialStage = partialWriter.stage({
			targetId: partial.view.schedule.targetId,
			desiredValue: {
				days: [2],
				times: [{ hour: 10, minute: 0 }],
				label: "自定义",
			},
			observedRevision: partial.view.schedule.source.revision,
		});
		if (partialStage.status !== "staged") throw new Error("expected staged");
		expect(partialWriter.apply(partialStage.change)).toMatchObject({
			status: "partial",
			rollbackError: expect.stringContaining("restore rename failed"),
		});
	});

	it("restores a loaded job when candidate rename fails after bootout", () => {
		const renameFailure = setupTarget();
		const writer = new ManagementCronWriter({
			launchAgentsDir: join(renameFailure.root, "LaunchAgents"),
			uid: process.getuid!(),
			targets: () => [renameFailure.target],
			deps: {
				execFile: renameFailure.launchctl.execFile,
				rename: (from, to) => {
					if (from.includes(".candidate.")) throw new Error("rename failed");
					renameSync(from, to);
				},
			},
		});
		const staged = writer.stage({
			targetId: renameFailure.view.schedule.targetId,
			desiredValue: {
				days: [2],
				times: [{ hour: 10, minute: 0 }],
				label: "自定义",
			},
			observedRevision: renameFailure.view.schedule.source.revision,
		});
		if (staged.status !== "staged") throw new Error("expected staged");
		expect(writer.apply(staged.change)).toMatchObject({
			status: "rolled_back",
			error: expect.stringContaining("rename failed"),
		});
		expect(renameFailure.launchctl.loaded).toBe(true);
		expect(readFileSync(renameFailure.path)).toEqual(renameFailure.bytes);
	});

	it("reclaims a stale lock and always unlinks the lock even when close throws", () => {
		const stale = setupTarget();
		const request = {
			targetId: stale.view.schedule.targetId,
			desiredValue: {
				days: [2],
				times: [{ hour: 10, minute: 0 }],
				label: "自定义" as const,
			},
			observedRevision: stale.view.schedule.source.revision,
		};
		const staged = stale.writer.stage(request);
		if (staged.status !== "staged") throw new Error("expected staged");
		const lock = `${stale.path}.flywheel.lock`;
		writeFileSync(lock, "999999\n");
		const old = new Date(Date.now() - 10 * 60_000);
		utimesSync(lock, old, old);

		let lockFd: number | undefined;
		const writer = new ManagementCronWriter({
			launchAgentsDir: join(stale.root, "LaunchAgents"),
			uid: process.getuid!(),
			targets: () => [stale.target],
			deps: {
				execFile: stale.launchctl.execFile,
				open: (path, flags, mode) => {
					const fd = openSync(path, flags, mode);
					if (path === lock) lockFd = fd;
					return fd;
				},
				close: (fd) => {
					closeSync(fd);
					if (fd === lockFd) throw new Error("close interrupted");
				},
				processAlive: () => false,
				now: () => Date.now(),
			} as never,
		});
		expect(writer.apply(staged.change)).toMatchObject({ status: "applied" });
		expect(existsSync(lock)).toBe(false);
	});

	it("no-op has zero side effects and a second staged writer conflicts after the first applies", () => {
		const noOp = setupTarget();
		expect(
			noOp.writer.stage({
				targetId: noOp.view.enabled.targetId,
				desiredValue: true,
				observedRevision: noOp.view.enabled.source.revision,
			}),
		).toEqual({ status: "no_op" });
		expect(noOp.launchctl.commands).toEqual([]);

		const race = setupTarget();
		const request = {
			targetId: race.view.schedule.targetId,
			desiredValue: {
				days: [2],
				times: [{ hour: 10, minute: 0 }],
				label: "自定义",
			},
			observedRevision: race.view.schedule.source.revision,
		};
		const first = race.writer.stage(request);
		const second = race.writer.stage(request);
		if (first.status !== "staged" || second.status !== "staged")
			throw new Error("expected staged");
		expect(race.writer.apply(first.change).status).toBe("applied");
		expect(race.writer.apply(second.change).status).toBe("rejected");
	});
});
