import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
	assertLeadPermissionProfile,
	renderLeadPermissionProfile,
} from "../permission-profile.js";

const spec = {
	deploymentRoot: "/opt/flywheel",
	projectRoot: "/work/project",
	artifactRoot: "/managed/activation/artifacts",
	readPaths: ["/managed/rules", "/managed/proxy"],
	credentialPaths: [
		"/home/lead/.ssh",
		"/work/project/.env",
		"/real/credentials",
	],
	brokerSocket: "/managed/activation/broker.sock",
	proxyPort: 32189,
};
describe("bundle v2 permission profile", () => {
	it("retains inherited workspace writes without overriding metadata protections", () => {
		const config = parse(renderLeadPermissionProfile(spec)) as any;
		expect(
			config.permissions["flywheel-lead-v2"].filesystem[":workspace_roots"],
		).toEqual({ ".codex": "read", ".git": "read" });
	});

	it("uses named permissions, public proxy network and only its own broker socket", () => {
		const config = parse(renderLeadPermissionProfile(spec));
		expect(config.default_permissions).toBe("flywheel-lead-v2");
		expect(config.projects).toEqual({
			[spec.projectRoot]: { trust_level: "trusted" },
		});
		expect(config).not.toHaveProperty("sandbox_mode");
		const profile = (config.permissions as any)["flywheel-lead-v2"];
		expect(profile.extends).toBe(":workspace");
		expect(profile.filesystem[":root"]).toBe("deny");
		expect(profile.filesystem[spec.artifactRoot]).toBe("read");
		expect(profile.filesystem["/work/project/.env"]).toBe("deny");
		expect(profile.network.unix_sockets).toEqual({
			[spec.brokerSocket]: "allow",
		});
		expect(profile.network.allow_local_binding).toBe(false);
		expect(profile.network.allow_upstream_proxy).toBe(false);
		expect(() => assertLeadPermissionProfile(config, spec)).not.toThrow();
	});
	it("accepts config/read null legacy fields while rejecting populated overrides", () => {
		const config = {
			...parse(renderLeadPermissionProfile(spec)),
			sandbox_mode: null,
			sandbox_workspace_write: null,
		};
		expect(() => assertLeadPermissionProfile(config, spec)).not.toThrow();
		for (const value of [false, "", {}, "workspace-write"]) {
			expect(() =>
				assertLeadPermissionProfile({ ...config, sandbox_mode: value }, spec),
			).toThrow();
		}
	});

	it("accepts only the observed unset permission fields in Codex config/read", () => {
		const config = parse(renderLeadPermissionProfile(spec)) as any;
		const profile = config.permissions["flywheel-lead-v2"];
		profile.description = null;
		profile.filesystem.glob_scan_max_depth = null;
		Object.assign(profile.network, { socks_url: null, mode: null, mitm: null });
		expect(() => assertLeadPermissionProfile(config, spec)).not.toThrow();
		profile.network.mode = "full";
		expect(() => assertLeadPermissionProfile(config, spec)).toThrow();
		profile.network.mode = null;
		profile.network.future_unverified_option = null;
		expect(() => assertLeadPermissionProfile(config, spec)).toThrow();
	});

	it("keeps production checkout read-only and limits its writable root to worktrees", () => {
		const production = { ...spec, projectRoot: "/opt/flywheel" };
		const config = parse(renderLeadPermissionProfile(production)) as any;
		const profile = config.permissions["flywheel-lead-v2"];
		expect(profile.workspace_roots).toEqual({
			"/opt/flywheel/worktrees": true,
		});
		expect(profile.filesystem["/opt/flywheel"]).toBe("read");
		expect(() => assertLeadPermissionProfile(config, production)).not.toThrow();
		profile.workspace_roots = { "/opt/flywheel": true };
		expect(() => assertLeadPermissionProfile(config, production)).toThrow();
		for (const projectRoot of [
			"/opt",
			"/opt/flywheel/packages",
			"/opt/flywheel/worktrees-escape",
		])
			expect(() =>
				renderLeadPermissionProfile({ ...spec, projectRoot }),
			).toThrow();
		const worktree = parse(
			renderLeadPermissionProfile({
				...spec,
				projectRoot: "/opt/flywheel/worktrees/lead",
			}),
		) as any;
		expect(worktree.permissions["flywheel-lead-v2"].workspace_roots).toEqual({
			"/opt/flywheel/worktrees/lead": true,
		});
	});

	it("rejects effective profile shadowing, extra roots, local egress and legacy overrides", () => {
		for (const mutate of [
			(c: any) => {
				c.sandbox_mode = "workspace-write";
			},
			(c: any) => {
				c.profiles = { other: { sandbox_mode: "workspace-write" } };
			},
			(c: any) => {
				c.permissions["flywheel-lead-v2"].filesystem["/real/credentials"] =
					"read";
			},
			(c: any) => {
				c.permissions["flywheel-lead-v2"].workspace_roots["/home"] = true;
			},
			(c: any) => {
				c.permissions["flywheel-lead-v2"].network.allow_local_binding = true;
			},
			(c: any) => {
				c.permissions["flywheel-lead-v2"].network.unix_sockets[
					"/foreign.sock"
				] = "allow";
			},
			(c: any) => {
				c.features.network_proxy = false;
			},
		]) {
			const config = parse(renderLeadPermissionProfile(spec));
			mutate(config);
			expect(() => assertLeadPermissionProfile(config, spec)).toThrow();
		}
	});
	it("rejects path traversal, relative paths and credentials inside writable artifact roots", () => {
		for (const invalid of [
			{ projectRoot: "/" },
			{ readPaths: ["relative"] },
			{ brokerSocket: "/tmp/../foreign.sock" },
			{ artifactRoot: "/real" },
			{ readPaths: ["/real/credentials"] },
			{ proxyPort: 0 },
		])
			expect(() =>
				renderLeadPermissionProfile({ ...spec, ...invalid }),
			).toThrow();
	});
});
