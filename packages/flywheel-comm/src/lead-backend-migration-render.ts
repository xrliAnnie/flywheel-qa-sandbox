import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	applyMigrationFields,
	type BackendMigrationPlan,
} from "./lead-backend-migration.js";
import { parseMigrationIntent } from "./lead-backend-migration-io.js";
import { compileLeadIdentityRows } from "./lead-identity.js";

const xml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
/** Single-target canonical shapes used by the existing materializer and generic supervisor. */
export function renderMigrationArtifacts(
	home: string,
	registry: unknown,
	input: BackendMigrationPlan,
): { manifest: string; plist: string } {
	const plan = parseMigrationIntent(input);
	if (!isAbsolute(home) || [...home].some((char) => char.charCodeAt(0) < 32))
		throw new Error("invalid migration home");
	const candidate = applyMigrationFields(registry, plan);
	const row = compileLeadIdentityRows(candidate, { homeDir: home }).find(
		(r) =>
			r.identity.projectName === plan.projectName &&
			r.identity.leadId === plan.leadId,
	);
	const root = row?.project.projectRoot;
	if (
		typeof root !== "string" ||
		!isAbsolute(root) ||
		[...root].some((char) => char.charCodeAt(0) < 32)
	)
		throw new Error("invalid migration project root");
	const canonicalRoot = realpathSync(root);
	const state = join(home, ".flywheel");
	const manifest = `${JSON.stringify({ leadId: plan.leadId, projectDir: canonicalRoot, projectName: plan.projectName, projectsFile: join(state, "projects.json"), subdir: "", workspace: canonicalRoot, mcpExclude: "", model: plan.target.model, leadBackend: { backendId: "codex-app-server" } }, null, 2)}\n`;
	const manifestPath = join(
		state,
		`manifests/${plan.projectName}-${plan.leadId}.json`,
	);
	const log = join(state, `logs/lead-${plan.projectName}-${plan.leadId}.log`);
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.flywheel.lead.${plan.projectName}-${plan.leadId}</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>${xml(join(state, "bin/flywheel-lead.sh"))}</string><string>${xml(manifestPath)}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
	return { manifest, plist };
}
