import { isAbsolute, join, normalize, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stringify } from "smol-toml";

export const LEAD_PERMISSION_PROFILE = "flywheel-lead-v2";
export interface LeadPermissionProfileSpec {
	/** Updater-owned checkout; only its worktrees subtree can be model-writable. */
	deploymentRoot: string;
	projectRoot: string;
	artifactRoot: string;
	/** Trusted non-secret deployed artifacts; paths and resolved aliases are explicit. */
	readPaths: readonly string[];
	/** Credential resolver metadata, including realpaths. Never credential contents. */
	credentialPaths: readonly string[];
	brokerSocket: string;
	proxyPort: number;
}
function path(value: string): string {
	if (
		!isAbsolute(value) ||
		value === "/" ||
		normalize(value) !== value ||
		[...value].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		) ||
		/[*?[\]{}]/.test(value)
	)
		throw new Error(
			"permission profile requires exact normalized absolute paths",
		);
	return value;
}
const under = (child: string, parent: string) =>
	child === parent || child.startsWith(`${parent}${sep}`);

export function leadModelWritableRoot(
	spec: Pick<LeadPermissionProfileSpec, "projectRoot" | "deploymentRoot">,
): string {
	const project = path(spec.projectRoot);
	const deployment = path(spec.deploymentRoot),
		worktrees = join(deployment, "worktrees");
	if (
		project !== deployment &&
		((under(project, deployment) && !under(project, worktrees)) ||
			under(deployment, project))
	)
		throw new Error("model workspace overlaps updater-owned checkout");
	return project === deployment ? worktrees : project;
}

function profileConfig(spec: LeadPermissionProfileSpec) {
	const project = path(spec.projectRoot),
		artifacts = path(spec.artifactRoot),
		deployment = path(spec.deploymentRoot);
	const writableRoot = leadModelWritableRoot(spec);
	const broker = path(spec.brokerSocket);
	if (
		!Number.isInteger(spec.proxyPort) ||
		spec.proxyPort < 1024 ||
		spec.proxyPort > 65535
	)
		throw new Error("invalid managed proxy port");
	if (spec.credentialPaths.length === 0)
		throw new Error("credential source metadata required");
	const denied = spec.credentialPaths.map(path);
	const readable = spec.readPaths.map(path);
	for (const secret of denied) {
		if (
			under(secret, artifacts) ||
			under(artifacts, secret) ||
			under(project, secret) ||
			under(deployment, secret) ||
			under(broker, secret) ||
			readable.some((source) => under(source, secret))
		)
			throw new Error("permission grant overlaps a credential source");
	}
	const filesystem: Record<string, unknown> = {
		":root": "deny",
		":minimal": "read",
		":tmpdir": "deny",
		":slash_tmp": "deny",
		// Keep :workspace inheritance; replacing "." loses protected metadata.
		":workspace_roots": { ".codex": "read", ".git": "read" },
		[deployment]: "read",
		[artifacts]: "read",
	};
	for (const source of readable) filesystem[source] = "read";
	for (const secret of denied) filesystem[secret] = "deny";
	return {
		default_permissions: LEAD_PERMISSION_PROFILE,
		projects: { [spec.projectRoot]: { trust_level: "trusted" } },
		approval_policy: "never",
		features: { network_proxy: true },
		permissions: {
			[LEAD_PERMISSION_PROFILE]: {
				extends: ":workspace",
				workspace_roots: { [writableRoot]: true },
				filesystem,
				network: {
					enabled: true,
					proxy_url: `http://127.0.0.1:${spec.proxyPort}`,
					enable_socks5: false,
					enable_socks5_udp: false,
					allow_upstream_proxy: false,
					allow_local_binding: false,
					dangerously_allow_non_loopback_proxy: false,
					dangerously_allow_all_unix_sockets: false,
					domains: {
						"*": "allow",
						localhost: "deny",
						"127.0.0.1": "deny",
						"::1": "deny",
					},
					unix_sockets: { [broker]: "allow" },
				},
			},
		},
	};
}

/** Config syntax is not OS confinement proof; deployment still requires canaries. */
export function renderLeadPermissionProfile(
	spec: LeadPermissionProfileSpec,
): string {
	return stringify(profileConfig(spec));
}
function rejectLegacy(value: unknown): void {
	if (!value || typeof value !== "object") return;
	for (const [key, entry] of Object.entries(value)) {
		if (
			entry !== null &&
			(key === "sandbox_mode" ||
				key === "sandbox_workspace_write" ||
				key === "sandboxPolicy")
		)
			throw new Error("legacy sandbox override invalid for bundle v2");
		rejectLegacy(entry);
	}
}
/** config/read serializes these unset optional fields as null (Codex 0.153.2).
 * Keep every other field, including unknown null-valued options, in exact comparison. */
function comparablePermissions(value: unknown): unknown {
	const copy = structuredClone(value);
	if (!copy || typeof copy !== "object") return copy;
	const profile = (copy as Record<string, unknown>)[LEAD_PERMISSION_PROFILE];
	if (!profile || typeof profile !== "object") return copy;
	const row = profile as Record<string, unknown>;
	const omitNull = (object: unknown, keys: string[]) => {
		if (!object || typeof object !== "object") return;
		const fields = object as Record<string, unknown>;
		for (const key of keys) if (fields[key] === null) delete fields[key];
	};
	omitNull(row, ["description"]);
	omitNull(row.filesystem, ["glob_scan_max_depth"]);
	omitNull(row.network, ["socks_url", "mode", "mitm"]);
	return copy;
}

/** Pass the merged effective config, not just the generated home TOML. */
export function assertLeadPermissionProfile(
	config: unknown,
	spec: LeadPermissionProfileSpec,
): void {
	rejectLegacy(config);
	if (!config || typeof config !== "object")
		throw new Error("permission profile config missing");
	const current = config as Record<string, unknown>;
	const expected = profileConfig(spec);
	const features = current.features as Record<string, unknown> | undefined;
	if (
		current.default_permissions !== expected.default_permissions ||
		current.approval_policy !== "never" ||
		features?.network_proxy !== true ||
		!isDeepStrictEqual(
			comparablePermissions(current.permissions),
			expected.permissions,
		)
	)
		throw new Error(
			"effective permission profile differs from managed bundle v2",
		);
}
