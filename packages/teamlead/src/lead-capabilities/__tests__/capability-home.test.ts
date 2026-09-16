import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { expect, it } from "vitest";
import { ensureLeadCapabilityHome } from "../capability-home.js";
import { assertLeadPermissionProfile } from "../permission-profile.js";

it("writes the actual home and rotates only the managed socket on restart", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cap-home-")));
	try {
		const home = join(root, "home"),
			project = join(root, "project"),
			activationRoot = join(root, "activations");
		for (const path of [home, project, activationRoot])
			mkdirSync(path, { mode: 0o700 });
		const profile = {
			deploymentRoot: "/opt/flywheel",
			projectRoot: project,
			artifactRoot: join(project, "artifacts"),
			readPaths: [],
			credentialPaths: [join(root, "credentials")],
			brokerSocket: join(activationRoot, "run-first/broker.sock"),
			proxyPort: 32189,
		};
		const options = {
			codexHome: home,
			activationRoot,
			permissionProfile: profile,
			assertCurrent: async () => {},
		};
		await ensureLeadCapabilityHome(options);
		const first = readFileSync(join(home, "config.toml"), "utf8");
		assertLeadPermissionProfile(parse(first), profile);
		await ensureLeadCapabilityHome(options);
		expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(first);
		profile.brokerSocket = join(activationRoot, "run-second/broker.sock");
		profile.proxyPort = 32190;
		await ensureLeadCapabilityHome(options);
		assertLeadPermissionProfile(
			parse(readFileSync(join(home, "config.toml"), "utf8")),
			profile,
		);
		writeFileSync(
			join(home, "config.toml"),
			'sandbox_mode="danger-full-access"\n',
		);
		await expect(ensureLeadCapabilityHome(options)).rejects.toThrow();
		expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
			"danger-full-access",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("replaces an authenticated managed config when pinned paths drift", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cap-home-")));
	try {
		const home = join(root, "home"),
			project = join(root, "project"),
			activationRoot = join(root, "activations");
		for (const path of [home, project, activationRoot])
			mkdirSync(path, { mode: 0o700 });
		const profile = {
			deploymentRoot: "/opt/flywheel",
			projectRoot: project,
			artifactRoot: join(project, "artifacts"),
			readPaths: [join(root, "node-v1"), join(root, "codex-v1")],
			credentialPaths: [join(root, "credentials-v1")],
			brokerSocket: join(activationRoot, "run-first/broker.sock"),
			proxyPort: 32189,
		};
		const options = {
			codexHome: home,
			activationRoot,
			permissionProfile: profile,
			assertCurrent: async () => {},
		};
		await ensureLeadCapabilityHome(options);
		unlinkSync(join(home, ".flywheel-capability-config.sha256"));
		profile.readPaths = [join(root, "node-v2"), join(root, "codex-v2")];
		profile.credentialPaths = [
			join(root, "credentials-v1"),
			join(root, "credentials-v2"),
		];
		profile.brokerSocket = join(activationRoot, "run-second/broker.sock");
		profile.proxyPort++;
		await ensureLeadCapabilityHome(options);
		assertLeadPermissionProfile(
			parse(readFileSync(join(home, "config.toml"), "utf8")),
			profile,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.each(["extra-mcp", "symlink", "public-home", "foreign-socket", "revoked"])(
	"preserves existing files when %s is rejected",
	async (failure) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "cap-home-")));
		try {
			const home = join(root, "home"),
				activationRoot = join(root, "a");
			mkdirSync(home, { mode: 0o700 });
			mkdirSync(activationRoot, { mode: 0o700 });
			const profile = {
				deploymentRoot: "/opt/flywheel",
				projectRoot: join(root, "project"),
				artifactRoot: join(root, "project/artifacts"),
				readPaths: [],
				credentialPaths: [join(root, "credentials")],
				brokerSocket: join(activationRoot, "run-one/broker.sock"),
				proxyPort: 32189,
			};
			let calls = 0;
			const options = {
				codexHome: home,
				activationRoot,
				permissionProfile: profile,
				assertCurrent: async () => {
					if (failure === "revoked" && ++calls === 4)
						throw new Error("revoked");
				},
			};
			await ensureLeadCapabilityHome(options);
			const config = join(home, "config.toml");
			if (failure === "extra-mcp")
				writeFileSync(
					config,
					readFileSync(config, "utf8") +
						'\n[mcp_servers.foreign]\ncommand="forbidden"\n',
				);
			if (failure === "symlink") {
				const target = join(root, "untouched");
				writeFileSync(target, "unchanged");
				unlinkSync(config);
				symlinkSync(target, config);
			}
			if (failure === "public-home") chmodSync(home, 0o755);
			profile.brokerSocket =
				failure === "foreign-socket"
					? join(root, "foreign/broker.sock")
					: join(activationRoot, "run-two/broker.sock");
			const before = readFileSync(config, "utf8");
			await expect(ensureLeadCapabilityHome(options)).rejects.toThrow();
			expect(readFileSync(config, "utf8")).toBe(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it.each(["activation", "artifacts", "both"])(
	"restarts a stable home after %s roots rotate and the old roots disappear",
	async (rotation) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "cap-home-")));
		try {
			const home = join(root, "home"),
				project = join(root, "project");
			mkdirSync(home, { mode: 0o700 });
			mkdirSync(project, { mode: 0o700 });
			const activationRoot = mkdtempSync(join(root, "fw-cap-"));
			const artifactRoot = mkdtempSync(join(project, ".flywheel-artifacts-"));
			const profile = {
				deploymentRoot: "/opt/flywheel",
				projectRoot: project,
				artifactRoot,
				readPaths: [],
				credentialPaths: [join(root, "credentials")],
				brokerSocket: join(activationRoot, "run-first/broker.sock"),
				proxyPort: 32189,
			};
			const options = {
				codexHome: home,
				activationRoot,
				permissionProfile: profile,
				assertCurrent: async () => {},
			};
			await ensureLeadCapabilityHome(options);
			if (rotation !== "artifacts") {
				rmSync(activationRoot, { recursive: true });
				options.activationRoot = mkdtempSync(join(root, "fw-cap-"));
			}
			if (rotation !== "activation") {
				rmSync(artifactRoot, { recursive: true });
				profile.artifactRoot = mkdtempSync(
					join(project, ".flywheel-artifacts-"),
				);
			}
			profile.brokerSocket = join(
				options.activationRoot,
				"run-second/broker.sock",
			);
			profile.proxyPort++;
			await ensureLeadCapabilityHome(options);
			assertLeadPermissionProfile(
				parse(readFileSync(join(home, "config.toml"), "utf8")),
				profile,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it.each([
	"extra-grant",
	"extra-read-grant",
	"foreign-artifact",
	"foreign-socket",
	"extra-mcp",
])(
	"refuses %s in a previous activation config without replacing it",
	async (tamper) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "cap-home-")));
		try {
			const home = join(root, "home"),
				project = join(root, "project");
			mkdirSync(home, { mode: 0o700 });
			mkdirSync(project, { mode: 0o700 });
			const activationRoot = mkdtempSync(join(root, "fw-cap-"));
			const artifactRoot = mkdtempSync(join(project, ".flywheel-artifacts-"));
			const profile = {
				deploymentRoot: "/opt/flywheel",
				projectRoot: project,
				artifactRoot,
				readPaths: [],
				credentialPaths: [join(root, "credentials")],
				brokerSocket: join(activationRoot, "run-first/broker.sock"),
				proxyPort: 32189,
			};
			const options = {
				codexHome: home,
				activationRoot,
				permissionProfile: profile,
				assertCurrent: async () => {},
			};
			await ensureLeadCapabilityHome(options);
			const config = join(home, "config.toml");
			unlinkSync(join(home, ".flywheel-capability-config.sha256"));
			let text = readFileSync(config, "utf8");
			if (tamper === "extra-grant")
				text = text.replace('":root" = "deny"', '":root" = "read"');
			if (tamper === "extra-read-grant")
				text = text.replace(
					'":root" = "deny"',
					'":root" = "deny"\n"/foreign/read-grant" = "read"',
				);
			if (tamper === "foreign-artifact")
				text = text.replace(
					artifactRoot,
					join(root, ".flywheel-artifacts-foreign"),
				);
			if (tamper === "foreign-socket")
				text = text.replace(
					profile.brokerSocket,
					join(root, "foreign/run-first/broker.sock"),
				);
			if (tamper === "extra-mcp")
				text += '\n[mcp_servers.foreign]\ncommand="forbidden"\n';
			expect(text).not.toBe(readFileSync(config, "utf8"));
			writeFileSync(config, text);
			options.activationRoot = mkdtempSync(join(root, "fw-cap-"));
			profile.artifactRoot = mkdtempSync(join(project, ".flywheel-artifacts-"));
			profile.brokerSocket = join(
				options.activationRoot,
				"run-second/broker.sock",
			);
			await expect(ensureLeadCapabilityHome(options)).rejects.toThrow();
			expect(readFileSync(config, "utf8")).toBe(text);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
