import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import { startGbrainProvider } from "../gbrain-provider.js";

const fixture = vi.hoisted(() => ({
	script: "",
	current: true,
	pids: [] as number[],
}));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			const child = actual.spawn(...args);
			if (child.pid) fixture.pids.push(child.pid);
			return child;
		},
	};
});
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		assertActivationCurrent: () => {
			if (!fixture.current) throw new Error("stale");
		},
	}),
}));
vi.mock("../gbrain-host.js", () => ({
	pinGbrainHost: () => ({
		launch: {
			command: process.execPath,
			args: ["-e", fixture.script],
			env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
			cwd: "/tmp",
		},
		assertCurrent: () => {},
		secrets: ["PRIVATE_DB_CANARY"],
		evidence: { version: "0.9.0" },
	}),
}));
it("owns a real SDK stdio session, admits pinned reads and invalidates old calls on close", async () => {
	const snapshot = JSON.parse(
		readFileSync(
			resolve(
				"../../engineering/doc/FLY-2519-codex-lead-parity/upstream-gbrain-schema.json",
			),
			"utf8",
		),
	);
	fixture.script = `const tools=${JSON.stringify(snapshot.tools)};let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(!('id'in q))continue;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'gbrain',version:'0.9.0'}}:q.method==='tools/list'?{tools}:{content:[{type:'text',text:'fixture stats'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});`;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gbrain-provider-")));
	mkdirSync(join(root, "artifacts"), { mode: 0o700 });
	const artifacts = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot: join(root, "artifacts"),
		assertCurrent: () => {},
	});
	let provider: Awaited<ReturnType<typeof startGbrainProvider>> | undefined;
	try {
		provider = await startGbrainProvider({
			env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
			activationId: "a1",
			artifacts,
			secrets: [],
		});
		const context = {
			projectName: "demo",
			leadId: "eng",
			activationId: "a1",
			requestId: randomUUID(),
			signal: AbortSignal.timeout(15000),
			assertCurrent: async () => {},
		};
		expect(provider.handlers.has("knowledge.add_link")).toBe(false);
		const handler = provider.handlers.get("knowledge.get_stats")!;
		expect((await handler.execute({}, context)).status).toBe("succeeded");
		fixture.current = false;
		expect((await handler.execute({}, context)).status).toBe("unknown");
		fixture.current = true;
		await provider.close();
		expect((await handler.execute({}, context)).status).toBe("unknown");
		expect(provider.evidence().migrationsApplied).toBe(0);
		fixture.script = fixture.script.replace(
			"version:'0.9.0'",
			"version:'0.9.1'",
		);
		await expect(
			startGbrainProvider({
				env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
				activationId: "a1",
				artifacts,
				secrets: [],
			}),
		).rejects.toThrow("baseline_drift");
		for (const pid of fixture.pids)
			expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		fixture.current = true;
		await provider?.close();
		artifacts.close();
		rmSync(root, { recursive: true, force: true });
	}
});
