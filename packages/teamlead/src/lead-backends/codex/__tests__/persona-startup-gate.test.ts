import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonaActivationView } from "flywheel-comm/persona-activation-client";
import { canonicalSubmissionDigest, type PersonaPin } from "flywheel-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertPersonaNotHeadless,
	verifyPersonaStartup,
	writePersonaObservationReceipt,
} from "../persona-startup-gate.js";

const sha = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
const approval = {
	channelId: "12345678901234567",
	messageId: "22345678901234567",
	contentSha256: "c".repeat(64),
};

describe("persona startup gate", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function fixture(content = "---\nmodel: opus\n---\nRaya persona\n") {
		const home = realpathSync.native(
			mkdtempSync(join(tmpdir(), "fly2696-gate-")),
		);
		dirs.push(home);
		const workspace = join(home, "workspace");
		const personaPath = join(workspace, ".lead", "raya", "identity.md");
		mkdirSync(join(workspace, ".lead", "raya"), { recursive: true });
		writeFileSync(personaPath, content, { mode: 0o600 });
		chmodSync(personaPath, 0o600);
		const pin: PersonaPin = {
			commit: "a".repeat(40),
			personaBlobDigest: sha(content),
			approval,
		};
		const projection = {
			schemaVersion: 1 as const,
			enabled: true as const,
			leadId: "raya" as const,
			repo: "xrliAnnie/raya" as const,
			path: ".lead/raya/identity.md" as const,
			pin,
			lastKnownGood: pin,
		};
		const stateRoot = join(home, "persona-state");
		const projectsPath = join(home, "projects.json");
		const registry = [
			{
				projectName: "raya",
				projectRoot: workspace,
				stateRoot,
				projectRepo: "xrliAnnie/raya",
				personaProjection: projection,
				leads: [
					{
						agentId: "raya",
						summaryRole: "recipient",
						chatChannel: "32345678901234567",
						match: { labels: ["raya"] },
						backend: "codex-app-server",
						codexProfile: "full-access",
						canSpawnRunners: false,
					},
				],
			},
		];
		const raw = Buffer.from(JSON.stringify(registry));
		writeFileSync(projectsPath, raw);
		const input = {
			projectName: "raya",
			leadId: "raya",
			projectsPath,
			expectedProjectsDigest: sha(raw),
			projectRoot: workspace,
			stateRoot,
			systemPromptFiles: [personaPath],
			bridgeUrl: "http://bridge.local",
			bridgeToken: "master",
		};
		return { content, input, personaPath, pin, projection };
	}

	function unrelatedProject(projectRoot: string, stateRoot: string) {
		return {
			projectName: "unrelated",
			projectRoot: join(projectRoot, "unrelated"),
			stateRoot: join(stateRoot, "unrelated"),
			leads: [
				{
					agentId: "other",
					summaryRole: "recipient",
					chatChannel: "42345678901234567",
					match: { labels: ["unrelated"] },
					backend: "codex-app-server",
					codexProfile: "full-access",
					canSpawnRunners: false,
				},
			],
		};
	}

	it("single-reads verified A0 bytes and derives effective instructions before transport", async () => {
		const f = fixture();
		const activation: PersonaActivationView = {
			kind: "pre-m0",
			contractDigest: canonicalSubmissionDigest(f.projection),
			a0Digest: f.pin.personaBlobDigest,
			revision: "3",
		};
		const readActivation = vi.fn(async () => activation);
		await expect(
			verifyPersonaStartup(f.input, { readActivation }),
		).resolves.toEqual({
			personaBlobDigest: sha(f.content),
			baseInstructionsDigest: sha("Raya persona"),
			baseInstructions: "Raya persona",
			contractDigest: canonicalSubmissionDigest(f.projection),
			activationRevision: "3",
			source: "pre-m0-lkg",
		});
		expect(readActivation).toHaveBeenCalledTimes(2);
	});

	it("fails before transport on changed bytes, authority drift, and capability v2", async () => {
		const f = fixture();
		const activation: PersonaActivationView = {
			kind: "pre-m0",
			contractDigest: canonicalSubmissionDigest(f.projection),
			a0Digest: f.pin.personaBlobDigest,
			revision: "1",
		};
		writeFileSync(f.personaPath, "tampered", { mode: 0o600 });
		await expect(
			verifyPersonaStartup(f.input, { readActivation: async () => activation }),
		).rejects.toThrow("persona_pre_m0_digest_mismatch");
		writeFileSync(f.personaPath, f.content, { mode: 0o600 });
		let call = 0;
		await expect(
			verifyPersonaStartup(f.input, {
				readActivation: async () =>
					call++ === 0 ? activation : { ...activation, revision: "2" },
			}),
		).rejects.toThrow("persona_authority_changed");
		await expect(
			verifyPersonaStartup(
				{ ...f.input, capabilityBundleVersion: 2 },
				{
					readActivation: async () => activation,
				},
			),
		).rejects.toThrow("persona_capability_v2_refused");
	});

	it("does not contact Bridge or read persona bytes when exact Raya has no opt-in", async () => {
		const f = fixture();
		const raw = JSON.parse(readFileSync(f.input.projectsPath, "utf8")) as Array<
			Record<string, unknown>
		>;
		delete raw[0]!.personaProjection;
		const encoded = Buffer.from(JSON.stringify(raw));
		writeFileSync(f.input.projectsPath, encoded);
		const readActivation = vi.fn();
		await expect(
			verifyPersonaStartup(
				{ ...f.input, expectedProjectsDigest: sha(encoded) },
				{ readActivation },
			),
		).resolves.toBeNull();
		expect(readActivation).not.toHaveBeenCalled();
	});

	it("keeps dormant Raya rebuilds independent of unrelated registry digest drift", async () => {
		const f = fixture();
		const registry = JSON.parse(
			readFileSync(f.input.projectsPath, "utf8"),
		) as Array<Record<string, unknown>>;
		delete registry[0]!.personaProjection;
		const dormantRegistry = Buffer.from(JSON.stringify(registry));
		writeFileSync(f.input.projectsPath, dormantRegistry);

		registry.push(unrelatedProject(f.input.projectRoot, f.input.stateRoot));
		writeFileSync(f.input.projectsPath, JSON.stringify(registry));
		const readActivation = vi.fn();

		await expect(
			verifyPersonaStartup(
				{
					...f.input,
					expectedProjectsDigest: sha(dormantRegistry),
				},
				{ readActivation },
			),
		).resolves.toBeNull();
		expect(readActivation).not.toHaveBeenCalled();
	});

	it("keeps the registry digest latch strict after Raya opts in", async () => {
		const f = fixture();
		const registry = JSON.parse(
			readFileSync(f.input.projectsPath, "utf8"),
		) as Array<Record<string, unknown>>;
		registry.push(unrelatedProject(f.input.projectRoot, f.input.stateRoot));
		writeFileSync(f.input.projectsPath, JSON.stringify(registry));
		const readActivation = vi.fn();

		await expect(
			verifyPersonaStartup(f.input, { readActivation }),
		).rejects.toThrow("persona_projects_digest_changed");
		expect(readActivation).not.toHaveBeenCalled();
	});

	it("latches a missing contract closed once enrollment markers exist", async () => {
		const f = fixture();
		const raw = JSON.parse(readFileSync(f.input.projectsPath, "utf8")) as Array<
			Record<string, unknown>
		>;
		delete raw[0]!.personaProjection;
		const encoded = Buffer.from(JSON.stringify(raw));
		writeFileSync(f.input.projectsPath, encoded);
		mkdirSync(f.input.stateRoot, { recursive: true });
		writeFileSync(join(f.input.stateRoot, "enrollment.json"), "{}", {
			mode: 0o600,
		});
		await expect(
			verifyPersonaStartup({
				...f.input,
				expectedProjectsDigest: sha(encoded),
			}),
		).rejects.toThrow("enrolled_contract_missing");
	});

	it("atomically records the verified then ready observation without granting authority", () => {
		const f = fixture();
		mkdirSync(f.input.stateRoot, { recursive: true });
		const base = {
			schemaVersion: 1 as const,
			generationId: "d".repeat(32),
			pid: 4242,
			processStartTime: "Wed Sep 17 12:00:00 2026",
			leadKey: "raya-raya",
			threadId: "01999999-9999-7999-8999-999999999999",
			threadRpcAckAt: "2026-09-17T20:00:00.000Z",
			personaBlobDigest: f.pin.personaBlobDigest,
			baseInstructionsDigest: sha("Raya persona"),
			baseInstructions: "Raya persona",
			contractDigest: canonicalSubmissionDigest(f.projection),
			activationRevision: "7",
			source: "pre-m0-lkg" as const,
		};
		writePersonaObservationReceipt(f.input.stateRoot, {
			...base,
			stage: "verified",
		});
		writePersonaObservationReceipt(f.input.stateRoot, {
			...base,
			stage: "ready",
		});
		const path = join(f.input.stateRoot, "observation.json");
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			stage: "ready",
			generationId: base.generationId,
			personaBlobDigest: f.pin.personaBlobDigest,
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("refuses opt-in and enrolled exact Raya on the headless entrypoint", async () => {
		const f = fixture();
		const headless = {
			projectName: "raya",
			leadId: "raya",
			projectsPath: f.input.projectsPath,
			expectedProjectsDigest: f.input.expectedProjectsDigest,
			projectRoot: f.input.projectRoot,
			stateRoot: f.input.stateRoot,
		};
		await expect(assertPersonaNotHeadless(headless)).rejects.toThrow(
			"persona_headless_runtime_refused",
		);
		const registry = JSON.parse(
			readFileSync(f.input.projectsPath, "utf8"),
		) as Array<Record<string, unknown>>;
		delete registry[0]!.personaProjection;
		const encoded = Buffer.from(JSON.stringify(registry));
		writeFileSync(f.input.projectsPath, encoded);
		await expect(
			assertPersonaNotHeadless({
				...headless,
				expectedProjectsDigest: sha(encoded),
			}),
		).resolves.toBeUndefined();
		mkdirSync(f.input.stateRoot, { recursive: true });
		writeFileSync(join(f.input.stateRoot, "activation.json"), "{}", {
			mode: 0o600,
		});
		await expect(
			assertPersonaNotHeadless({
				...headless,
				expectedProjectsDigest: sha(encoded),
			}),
		).rejects.toThrow("enrolled_contract_missing");
	});
});
