import { describe, expect, it, vi } from "vitest";
import { deriveLeadSocketPath } from "../../lead-address.js";
import { locateConfiguredLeadWindow } from "../fleet-lead-locator.js";

const HOME = "/home/test";
const STATE = "/state/flywheel";
const KEY = "geo-product-lead";
const PLIST = `${HOME}/Library/LaunchAgents/com.flywheel.lead.${KEY}.plist`;
const MANIFEST = `${STATE}/manifests/${KEY}.json`;

describe("locateConfiguredLeadWindow", () => {
	it("reads current plist authority on every v2 lookup", async () => {
		const socketPath = deriveLeadSocketPath("geo/product-lead", STATE);
		const files: Record<string, string> = {
			[PLIST]: `<plist><string>${STATE}/bin/flywheel-lead-wrapper-v2.sh</string></plist>`,
			[MANIFEST]: JSON.stringify({
				projectName: "geo",
				leadId: "product-lead",
				socketPath,
			}),
		};
		const readFile = vi.fn((path: string) => files[path]!);
		const execFn = vi.fn(async (file: string) => {
			if (file === "ps") {
				return {
					stdout: "/bin/bash /repo/lead-body.sh /manifest\n",
					stderr: "",
				};
			}
			return {
				stdout: "%0\tmain\tbash /repo/lead-body.sh /manifest\tclaude\t0\t42\n",
				stderr: "",
			};
		});

		await expect(
			locateConfiguredLeadWindow("geo", "product-lead", {
				homeDir: HOME,
				stateDir: STATE,
				readFile,
				execFn,
			}),
		).resolves.toMatchObject({ carrier: "v2", socketPath, windowId: "%0" });
		expect(readFile.mock.calls.map(([path]) => path)).toEqual([
			PLIST,
			MANIFEST,
		]);
	});

	it("fails closed for missing or unknown plist authority", async () => {
		const execFn = vi.fn();
		await expect(
			locateConfiguredLeadWindow("geo", "product-lead", {
				homeDir: HOME,
				stateDir: STATE,
				readFile: () => "<plist><string>/bespoke/wrapper.sh</string></plist>",
				execFn,
			}),
		).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});

	it("fails closed for a historical shared-server plist", async () => {
		const execFn = vi.fn();
		await expect(
			locateConfiguredLeadWindow("geo", "product-lead", {
				homeDir: HOME,
				stateDir: STATE,
				readFile: () =>
					`<plist><string>${STATE}/bin/retired-wrapper.sh</string></plist>`,
				execFn,
			}),
		).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});
});

// FLY-2882 QA rework: a 529 room's Bridge has its own launchd authority — the
// room registry test-deploy writes (`launchd-leads.json`), handed to the
// Bridge explicitly. Layout below is byte-shaped after qa-launchd-lead.sh.
describe("locateConfiguredLeadWindow — 529 room launchd authority", () => {
	const ROOM = "/tmp/flywheel-test-slot-2";
	const REGISTRY = `${ROOM}/launchd-leads.json`;
	const PROJECT = "test-slot-2";
	const AGENT = "flywheel-test-3";
	const LABEL = `com.flywheel.qa.lead.slot-3.${AGENT}`;
	const RUNTIME = `${ROOM}/launchd/${AGENT}`;
	const ROOM_PLIST = `${RUNTIME}/lead.plist`;
	const ROOM_MANIFEST = `${RUNTIME}/manifest.json`;
	const LEAD_STATE = `${ROOM}/q/3`;
	const WRAPPER = "/Users/dev/flywheel/scripts/flywheel-lead-wrapper-v2.sh";
	const SOCKET = deriveLeadSocketPath(`${PROJECT}/${AGENT}`, LEAD_STATE);

	function roomPlist(
		over: {
			label?: string;
			wrapper?: string;
			manifest?: string;
			state?: string;
		} = {},
	): string {
		return [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<plist version="1.0"><dict>',
			`<key>Label</key><string>${over.label ?? LABEL}</string>`,
			`<key>ProgramArguments</key><array><string>${over.wrapper ?? WRAPPER}</string><string>${over.manifest ?? ROOM_MANIFEST}</string></array>`,
			"<key>EnvironmentVariables</key><dict>",
			"<key>HOME</key><string>/Users/dev</string>",
			`<key>FLYWHEEL_STATE_DIR</key><string>${over.state ?? LEAD_STATE}</string>`,
			"</dict>",
			"<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>",
			"</dict></plist>",
		].join("\n");
	}

	function roomFiles(
		over: {
			registry?: unknown;
			plist?: string;
			manifest?: Record<string, unknown>;
		} = {},
	): Record<string, string> {
		return {
			[REGISTRY]: JSON.stringify(
				over.registry ?? [
					{
						label: "com.flywheel.qa.lead.slot-2.flywheel-test-2",
						plist: `${ROOM}/launchd/flywheel-test-2/lead.plist`,
						manifest: "",
						carrier: "codex-tui",
						stateDir: `${ROOM}/q/2/c/0123456789abcdef`,
					},
					{ label: LABEL, plist: ROOM_PLIST, manifest: ROOM_MANIFEST },
				],
			),
			[ROOM_PLIST]: over.plist ?? roomPlist(),
			[ROOM_MANIFEST]: JSON.stringify(
				over.manifest ?? {
					projectName: PROJECT,
					leadId: AGENT,
					socketPath: SOCKET,
					pid: 4242,
				},
			),
		};
	}

	function livePane() {
		return vi.fn(async (file: string) => {
			if (file === "ps") {
				return {
					stdout: "/bin/bash /Users/dev/flywheel/scripts/lead-body.sh /m\n",
					stderr: "",
				};
			}
			return {
				stdout:
					"%0\tmain\tbash /Users/dev/flywheel/scripts/lead-body.sh /m\tbash\t0\t42\n",
				stderr: "",
			};
		});
	}

	function locate(
		files: Record<string, string>,
		execFn = livePane(),
		lead = AGENT,
	) {
		const readFile = vi.fn((path: string) => {
			const body = files[path];
			if (body === undefined) throw new Error(`ENOENT ${path}`);
			return body;
		});
		return {
			readFile,
			execFn,
			result: locateConfiguredLeadWindow(PROJECT, lead, {
				homeDir: HOME,
				stateDir: ROOM,
				readFile,
				execFn,
				launchdRegistryPath: REGISTRY,
			}),
		};
	}

	it("finds the room Claude Lead through registry → plist → manifest and never reads production LaunchAgents", async () => {
		const { readFile, execFn, result } = locate(roomFiles());
		await expect(result).resolves.toMatchObject({
			carrier: "v2",
			socketPath: SOCKET,
			bodyPaneTarget: "%0",
		});
		expect(readFile.mock.calls.map(([path]) => path)).toEqual([
			REGISTRY,
			ROOM_PLIST,
			ROOM_MANIFEST,
		]);
		expect(
			readFile.mock.calls.some(([path]) => path.includes("LaunchAgents")),
		).toBe(false);
		// The pane probe addresses the socket derived from the Lead's own state dir.
		expect(execFn.mock.calls[0]?.[1]).toContain(SOCKET);
	});

	it.each([
		["the registry file is missing", {}, [REGISTRY]],
		["the registry is not an array", { registry: { label: LABEL } }, []],
		[
			"no registry row carries this Lead",
			{
				registry: [
					{
						label: "com.flywheel.qa.lead.slot-3.someone-else",
						plist: ROOM_PLIST,
						manifest: ROOM_MANIFEST,
					},
				],
			},
			[],
		],
		[
			"two registry rows claim this Lead",
			{
				registry: [
					{ label: LABEL, plist: ROOM_PLIST, manifest: ROOM_MANIFEST },
					{
						label: `com.flywheel.qa.lead.slot-4.${AGENT}`,
						plist: ROOM_PLIST,
						manifest: ROOM_MANIFEST,
					},
				],
			},
			[],
		],
		[
			"the row is a Codex carrier",
			{
				registry: [
					{
						label: LABEL,
						plist: ROOM_PLIST,
						manifest: ROOM_MANIFEST,
						carrier: "codex-tui",
					},
				],
			},
			[],
		],
		[
			"a production-shaped label stands in for the room label",
			{
				registry: [
					{
						label: `com.flywheel.lead.${PROJECT}-${AGENT}`,
						plist: ROOM_PLIST,
						manifest: ROOM_MANIFEST,
					},
				],
			},
			[],
		],
		[
			"the row points outside the room",
			{
				registry: [
					{
						label: LABEL,
						plist: `${HOME}/Library/LaunchAgents/com.flywheel.lead.x.plist`,
						manifest: ROOM_MANIFEST,
					},
				],
			},
			[],
		],
		[
			"the row escapes the room with ..",
			{
				registry: [
					{
						label: LABEL,
						plist: `${ROOM}/../flywheel-test-slot-9/launchd/${AGENT}/lead.plist`,
						manifest: ROOM_MANIFEST,
					},
				],
			},
			[],
		],
	] as const)("fails closed when %s", async (_why, over, missing) => {
		const files = roomFiles(over as Parameters<typeof roomFiles>[0]);
		for (const path of missing) delete files[path];
		const execFn = livePane();
		const { result } = locate(files, execFn);
		await expect(result).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});

	it.each([
		[
			"the plist Label is another Lead's",
			{ label: "com.flywheel.qa.lead.slot-3.other" },
		],
		["the plist runs a non-v2 wrapper", { wrapper: "/opt/bespoke/wrapper.sh" }],
		[
			"the plist runs the v2 wrapper by a relative path",
			{ wrapper: "scripts/flywheel-lead-wrapper-v2.sh" },
		],
		[
			"the plist binds a different manifest",
			{ manifest: `${ROOM}/launchd/other/manifest.json` },
		],
	] as const)("fails closed when %s", async (_why, plistOver) => {
		const execFn = livePane();
		const { result } = locate(
			roomFiles({ plist: roomPlist(plistOver) }),
			execFn,
		);
		await expect(result).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});

	it("fails closed when the Lead state dir is outside the room, even with a canonical manifest", async () => {
		const outside = `${HOME}/.flywheel`;
		const execFn = livePane();
		const { result } = locate(
			roomFiles({
				plist: roomPlist({ state: outside }),
				manifest: {
					projectName: PROJECT,
					leadId: AGENT,
					socketPath: deriveLeadSocketPath(`${PROJECT}/${AGENT}`, outside),
				},
			}),
			execFn,
		);
		await expect(result).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});

	it("fails closed when the row's plist lives outside the room, even if it is otherwise valid", async () => {
		const outside = "/tmp/elsewhere/lead.plist";
		const files = roomFiles({
			registry: [{ label: LABEL, plist: outside, manifest: ROOM_MANIFEST }],
		});
		files[outside] = roomPlist();
		const execFn = livePane();
		const { result } = locate(files, execFn);
		await expect(result).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});

	it("fails closed when the plist declares the state dir twice", async () => {
		const plist = roomPlist().replace(
			"</dict>\n<key>RunAtLoad",
			`<key>FLYWHEEL_STATE_DIR</key><string>${ROOM}/q/9</string>\n</dict>\n<key>RunAtLoad`,
		);
		const execFn = livePane();
		const { result } = locate(roomFiles({ plist }), execFn);
		await expect(result).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});

	it.each([
		[
			"the manifest names another project",
			{ projectName: "flywheel", leadId: AGENT, socketPath: SOCKET },
		],
		[
			"the manifest names another Lead",
			{ projectName: PROJECT, leadId: "flywheel-test-2", socketPath: SOCKET },
		],
		[
			"the manifest socket is not canonical for the Lead state dir",
			{
				projectName: PROJECT,
				leadId: AGENT,
				socketPath: "/tmp/fly1389-flywheel-test-3.sock",
			},
		],
	] as const)("fails closed when %s", async (_why, manifest) => {
		const execFn = livePane();
		const { result } = locate(roomFiles({ manifest }), execFn);
		await expect(result).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});

	it("asks for the Lead under the registry, not another room Lead", async () => {
		const execFn = livePane();
		const { result } = locate(roomFiles(), execFn, "flywheel-test-2");
		await expect(result).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});

	it("fails closed when the pane on the canonical socket is not a lead body", async () => {
		const execFn = vi.fn(async () => ({
			stdout: "%0\tmain\tzsh\tzsh\t0\t42\n",
			stderr: "",
		}));
		const { result } = locate(roomFiles(), execFn);
		await expect(result).resolves.toBeNull();
	});

	it("rejects a relative registry path without reading anything", async () => {
		const readFile = vi.fn();
		await expect(
			locateConfiguredLeadWindow(PROJECT, AGENT, {
				homeDir: HOME,
				stateDir: ROOM,
				readFile,
				execFn: livePane(),
				launchdRegistryPath: "launchd-leads.json",
			}),
		).resolves.toBeNull();
		expect(readFile).not.toHaveBeenCalled();
	});
});
