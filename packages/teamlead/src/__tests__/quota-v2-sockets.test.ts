import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	discoverPrivateLeadSockets,
	isManagedClaudePane,
	makeTmuxFleetReviveDeps,
	makeTmuxReviveDeps,
	scanQuotaPanes,
} from "../account-heal/quota-revive-scan.js";
import { deriveLeadSocketPath } from "../lead-address.js";

const CAPTURE = readFileSync(
	join(import.meta.dirname, "fixtures", "lead-panes", "usage-limit-real.txt"),
	"utf8",
);

describe("FLY-1663 quota observer private Lead sockets", () => {
	it("uses absolute -S addressing instead of treating a private socket as a -L name", async () => {
		const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const deps = makeTmuxReviveDeps({
			socket: "/tmp/fw-lead.sock",
			execFile,
		});
		await deps.listPanes();
		expect(execFile).toHaveBeenCalledWith(
			"tmux",
			expect.arrayContaining(["-S", "/tmp/fw-lead.sock", "list-panes"]),
			expect.anything(),
		);
	});

	it("accepts main/main only when it is carried by an absolute private socket", () => {
		const pane = {
			paneId: "%0",
			panePid: 41,
			sessionName: "main",
			windowName: "main",
			currentCommand: "claude",
			dead: false,
			qaInjection: false,
		};
		expect(
			isManagedClaudePane(
				{ ...pane, socket: "/tmp/fw-a.sock" },
				CAPTURE,
				false,
			),
		).toBe(true);
		expect(isManagedClaudePane(pane, CAPTURE, false)).toBe(false);
	});

	it("keeps identical %0/pid identities distinct across private sockets", async () => {
		const capturePane = vi.fn(
			async (_paneId: string, _socket?: string) => CAPTURE,
		);
		const snapshot = await scanQuotaPanes({
			nowMs: 1,
			socket: "default",
			qaInjectionEnabled: false,
			listPanes: async () =>
				["/tmp/fw-a.sock", "/tmp/fw-b.sock"].map((socket) => ({
					socket,
					paneId: "%0",
					panePid: 41,
					sessionName: "main",
					windowName: "main",
					currentCommand: "claude",
					dead: false,
					qaInjection: false,
				})),
			capturePane,
		});
		expect(snapshot.listedCount).toBe(2);
		expect(capturePane.mock.calls.map((call) => call[1]).sort()).toEqual([
			"/tmp/fw-a.sock",
			"/tmp/fw-b.sock",
		]);
	});

	it("routes capture and continue back through the pane's exact socket", async () => {
		const execFile = vi.fn(async (_file: string, args: string[]) => {
			if (args.includes("list-panes")) {
				return {
					stdout: "%0\t41\tmain\tmain\tclaude\t0\t\n",
					stderr: "",
				};
			}
			return { stdout: CAPTURE, stderr: "" };
		});
		const deps = makeTmuxFleetReviveDeps({
			runnerSocket: "default",
			leadSockets: ["/tmp/fw-a.sock"],
			execFile,
		});
		const panes = await deps.listPanes();
		const privatePane = panes.find((pane) => pane.socket === "/tmp/fw-a.sock");
		expect(privatePane).toBeDefined();
		await deps.capturePane(privatePane?.paneId ?? "", privatePane?.socket);
		await deps.sendContinue(privatePane?.paneId ?? "", privatePane?.socket);
		const privateCalls = execFile.mock.calls
			.map((call) => call[1])
			.filter((args) => args[0] === "-S");
		expect(privateCalls).toHaveLength(4);
		expect(privateCalls.every((args) => args[1] === "/tmp/fw-a.sock")).toBe(
			true,
		);
	});

	it("discovers only canonical v2 manifest sockets from the launchd roster", () => {
		const root = mkdtempSync("/tmp/fly1663-quota-");
		const stateDir = join(root, ".flywheel");
		const launchAgentsDir = join(root, "LaunchAgents");
		mkdirSync(join(stateDir, "manifests"), { recursive: true });
		mkdirSync(launchAgentsDir, { recursive: true });
		const key = "demo-ops-lead";
		const socketPath = deriveLeadSocketPath(key, stateDir);
		writeFileSync(
			join(stateDir, "manifests", `${key}.json`),
			JSON.stringify({ projectName: "demo", leadId: "ops-lead", socketPath }),
		);
		writeFileSync(
			join(launchAgentsDir, `com.flywheel.lead.${key}.plist`),
			`<plist><string>com.flywheel.lead.${key}</string><string>${stateDir}/bin/flywheel-lead-wrapper-v2.sh</string></plist>`,
		);
		expect(discoverPrivateLeadSockets({ stateDir, launchAgentsDir })).toEqual([
			socketPath,
		]);
	});
});
