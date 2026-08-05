import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveCanonicalLead } from "../canonical-lead.js";
import {
	collectLeadLeaseDiagnostics,
	type LeadLeaseDiagnostics,
	LeadLeaseStore,
	type LeadWriteAuthorizationDeps,
	postCarrierClaim,
	validateLeadCarrierAuthorization,
	writeCarrierReceipt,
} from "../lead-lease.js";
import { type LeadLeaseMode, LeadLeaseModeStore } from "../lead-lease-mode.js";

interface LeadLeaseCommandDeps {
	env?: Readonly<Record<string, string | undefined>>;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	fetchImpl?: typeof fetch;
	now?: () => number;
	leadWriteAuthorizationDeps?: LeadWriteAuthorizationDeps;
	leaseStoreDeps?: ConstructorParameters<typeof LeadLeaseStore>[1];
}

function positiveInteger(value: string | undefined, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function emit(
	value: unknown,
	json: boolean,
	stdout: (line: string) => void,
): void {
	stdout(json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

export async function runLeadLeaseCommand(
	args: string[],
	deps: LeadLeaseCommandDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	const subcommand = args[0];
	const dbPath =
		env.FLYWHEEL_LEAD_LEASE_DB ?? join(homedir(), ".flywheel", "lead-lease.db");
	const modePath =
		env.FLYWHEEL_LEAD_LEASE_MODE_FILE ??
		join(homedir(), ".flywheel", "lead-lease-mode.json");
	const projectsPath =
		env.FLYWHEEL_PROJECTS_FILE ?? join(homedir(), ".flywheel", "projects.json");
	const modes = new LeadLeaseModeStore(modePath, env);

	try {
		switch (subcommand) {
			case "resolve": {
				const { values } = parseArgs({
					args: args.slice(1),
					options: {
						lead: { type: "string" },
						project: { type: "string" },
						json: { type: "boolean", default: false },
					},
					allowPositionals: false,
				});
				const resolution = resolveCanonicalLead({
					leadId: required(values.lead, "--lead"),
					...(values.project ? { projectHint: values.project } : {}),
					projectsPath,
				});
				emit(resolution, values.json, stdout);
				return resolution.status === "source_error" ? 1 : 0;
			}
			case "carrier-self-check": {
				const { values } = parseArgs({
					args: args.slice(1),
					options: {
						lead: { type: "string" },
						project: { type: "string" },
						"bridge-url": { type: "string" },
						json: { type: "boolean", default: false },
					},
					allowPositionals: false,
				});
				const leadId = required(
					values.lead ?? env.FLYWHEEL_LEAD_ID,
					"--lead or FLYWHEEL_LEAD_ID",
				);
				const rawClaim = required(
					env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID,
					"FLYWHEEL_LEAD_CARRIER_INSTANCE_ID",
				);
				const projectName =
					values.project ?? env.FLYWHEEL_PROJECT_NAME ?? undefined;
				const checkEnv = {
					...env,
					...(projectName ? { FLYWHEEL_PROJECT_NAME: projectName } : {}),
				} as NodeJS.ProcessEnv;
				const local = validateLeadCarrierAuthorization(
					{ claimedLeadId: leadId, env: checkEnv },
					deps.leadWriteAuthorizationDeps,
				);
				if (!local.valid) {
					stderr(`lead-lease carrier-self-check: local ${local.reason}`);
					return 1;
				}
				const token = required(env.TEAMLEAD_API_TOKEN, "TEAMLEAD_API_TOKEN");
				const bridgeUrl = required(
					values["bridge-url"] ?? env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL,
					"--bridge-url or FLYWHEEL_BRIDGE_URL",
				);
				const response = await postCarrierClaim({
					url: `${bridgeUrl.replace(/\/+$/, "")}/api/lead-lease/self-check`,
					carrierClaim: rawClaim,
					body: { leadId, projectName },
					headers: { Authorization: `Bearer ${token}` },
					fetchImpl: deps.fetchImpl,
				});
				if (!response.ok) {
					stderr(
						`lead-lease carrier-self-check: Bridge rejected (HTTP ${response.status})`,
					);
					return 1;
				}
				const bridge = (await response.json()) as {
					ok?: unknown;
					disposition?: unknown;
					leadKey?: unknown;
					carrier?: {
						pid?: unknown;
						lstart?: unknown;
						instanceDigest?: unknown;
					};
				};
				if (
					bridge.ok !== true ||
					bridge.disposition !== "carrier_passthrough" ||
					bridge.leadKey !== local.leadKey ||
					bridge.carrier?.pid !== local.carrier.pid ||
					bridge.carrier.lstart !== local.carrier.lstart ||
					bridge.carrier.instanceDigest !== local.carrier.instanceDigest
				) {
					stderr("lead-lease carrier-self-check: Bridge attestation mismatch");
					return 1;
				}
				const checkedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
				const receipt = {
					schemaVersion: 1 as const,
					contractVersion: 1 as const,
					leadKey: local.leadKey,
					instanceDigest: local.carrier.instanceDigest,
					pid: local.carrier.pid,
					lstart: local.carrier.lstart,
					checkedAt,
					cliDisposition: "carrier_passthrough" as const,
					bridgeDisposition: "carrier_passthrough" as const,
				};
				writeCarrierReceipt(
					env.FLYWHEEL_LEAD_RECEIPT_DIR ??
						join(homedir(), ".flywheel", "state", "carrier-receipts"),
					receipt,
				);
				emit({ ok: true, receipt }, values.json, stdout);
				return 0;
			}
			case "readiness": {
				const { values } = parseArgs({
					args: args.slice(1),
					options: {
						"bridge-url": { type: "string" },
						"local-only": { type: "boolean", default: false },
						json: { type: "boolean", default: false },
					},
					allowPositionals: false,
				});
				const local = collectLeadLeaseDiagnostics(
					env as NodeJS.ProcessEnv,
					deps.leadWriteAuthorizationDeps,
				);
				if (values["local-only"]) {
					emit({ ok: local.healthy, local }, values.json, stdout);
					return local.healthy ? 0 : 1;
				}
				const token = required(env.TEAMLEAD_API_TOKEN, "TEAMLEAD_API_TOKEN");
				const bridgeUrl = required(
					values["bridge-url"] ?? env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL,
					"--bridge-url or FLYWHEEL_BRIDGE_URL",
				);
				const response = await (deps.fetchImpl ?? fetch)(
					`${bridgeUrl.replace(/\/+$/, "")}/api/lead-lease/diagnostics`,
					{
						method: "GET",
						headers: { Authorization: `Bearer ${token}` },
						redirect: "error",
					},
				);
				if (!response.ok) {
					stderr(
						`lead-lease readiness: Bridge diagnostics HTTP ${response.status}`,
					);
					emit(
						{ ok: false, parity: false, local, bridgeStatus: response.status },
						values.json,
						stdout,
					);
					return 1;
				}
				const bridge = (await response.json()) as LeadLeaseDiagnostics;
				const comparable = (diagnostics: LeadLeaseDiagnostics) => ({
					paths: diagnostics.paths,
					mode: diagnostics.mode,
					modeOverridePresent: diagnostics.modeOverridePresent,
					resolver: diagnostics.resolver,
					audit: diagnostics.audit,
					episodes: diagnostics.episodes,
					leads: diagnostics.leads,
				});
				const parity =
					JSON.stringify(comparable(local)) ===
					JSON.stringify(comparable(bridge));
				const ok = local.healthy && bridge.healthy && parity;
				emit({ ok, parity, local, bridge }, values.json, stdout);
				return ok ? 0 : 1;
			}
			case "set-mode": {
				const { values, positionals } = parseArgs({
					args: args.slice(1),
					options: {
						"updated-by": { type: "string" },
						json: { type: "boolean", default: false },
					},
					allowPositionals: true,
				});
				const mode = required(positionals[0], "mode") as LeadLeaseMode;
				modes.set(mode, values["updated-by"] ?? String(process.pid));
				emit(modes.read(), values.json, stdout);
				return 0;
			}
			case "status": {
				const { values } = parseArgs({
					args: args.slice(1),
					options: {
						"lead-key": { type: "string" },
						json: { type: "boolean", default: false },
					},
					allowPositionals: false,
				});
				const store = new LeadLeaseStore(dbPath, deps.leaseStoreDeps);
				try {
					emit(
						{
							mode: modes.read(),
							storeInstanceId: store.getStoreInstanceId(),
							lease: values["lead-key"]
								? (store.getLease(values["lead-key"]) ?? null)
								: null,
						},
						values.json,
						stdout,
					);
				} finally {
					store.close();
				}
				return 0;
			}
			case "acquire": {
				const { values } = parseArgs({
					args: args.slice(1),
					options: {
						lead: { type: "string" },
						project: { type: "string" },
						"supervisor-pid": { type: "string" },
						"supervisor-start": { type: "string" },
						"acquired-by": { type: "string" },
						json: { type: "boolean", default: false },
					},
					allowPositionals: false,
				});
				const leadId = required(values.lead, "--lead");
				const project = required(values.project, "--project");
				const resolution = resolveCanonicalLead({
					leadId,
					projectHint: project,
					projectsPath,
				});
				if (
					resolution.status === "source_error" ||
					resolution.status === "ambiguous"
				) {
					stderr(`lead-lease acquire: resolver ${resolution.status}`);
					return 1;
				}
				if (
					resolution.status === "ok" &&
					resolution.canonicalProject !== project
				) {
					stderr(
						`lead-lease acquire: project mismatch (${project} != ${resolution.canonicalProject})`,
					);
					return 1;
				}
				if (resolution.status === "valid_but_lead_absent") {
					stderr(
						`lead-lease acquire: ${leadId} is not configured; using bootstrap key`,
					);
				}
				const leadKey =
					resolution.status === "ok"
						? resolution.leadKey
						: `${project}-${leadId}`;
				const store = new LeadLeaseStore(dbPath, deps.leaseStoreDeps);
				try {
					const result = store.acquire({
						leadKey,
						project,
						leadId,
						supervisorPid: positiveInteger(
							values["supervisor-pid"],
							"--supervisor-pid",
						),
						supervisorStart: required(
							values["supervisor-start"],
							"--supervisor-start",
						),
						acquiredBy: values["acquired-by"] ?? String(process.pid),
					});
					const lease = store.getLease(leadKey);
					emit(
						{
							leadKey,
							holderPid: lease?.holderPid ?? null,
							holderStart: lease?.holderStart ?? null,
							supervisorPid: lease?.supervisorPid ?? null,
							supervisorStart: lease?.supervisorStart ?? null,
							...result,
						},
						values.json,
						stdout,
					);
					return result.status === "denied_holder_alive" ||
						result.status === "denied_sensor_degraded"
						? 3
						: 0;
				} finally {
					store.close();
				}
			}
			case "verify-bound": {
				const { values } = parseArgs({
					args: args.slice(1),
					options: {
						"lead-key": { type: "string" },
						"supervisor-pid": { type: "string" },
						"supervisor-start": { type: "string" },
						"holder-pid": { type: "string" },
						"holder-start": { type: "string" },
						json: { type: "boolean", default: false },
					},
					allowPositionals: false,
				});
				const store = new LeadLeaseStore(dbPath, deps.leaseStoreDeps);
				try {
					const result = store.verifyBound({
						leadKey: required(values["lead-key"], "--lead-key"),
						expectedSupervisorPid: positiveInteger(
							values["supervisor-pid"],
							"--supervisor-pid",
						),
						expectedSupervisorStart: required(
							values["supervisor-start"],
							"--supervisor-start",
						),
						expectedHolderPid: positiveInteger(
							values["holder-pid"],
							"--holder-pid",
						),
						expectedHolderStart: required(
							values["holder-start"],
							"--holder-start",
						),
					});
					emit(result, values.json, stdout);
					return result.status === "verified" ? 0 : 3;
				} finally {
					store.close();
				}
			}
			case "progress-snapshot": {
				const { values } = parseArgs({
					args: args.slice(1),
					options: {
						lead: { type: "string" },
						project: { type: "string" },
						json: { type: "boolean", default: false },
					},
					allowPositionals: false,
				});
				const leadId = required(values.lead, "--lead");
				const project = required(values.project, "--project");
				const resolution = resolveCanonicalLead({
					leadId,
					projectHint: project,
					projectsPath,
				});
				if (
					resolution.status === "source_error" ||
					resolution.status === "ambiguous"
				) {
					stderr(`lead-lease progress-snapshot: resolver ${resolution.status}`);
					return 1;
				}
				if (
					resolution.status === "ok" &&
					resolution.canonicalProject !== project
				) {
					stderr(
						`lead-lease progress-snapshot: project mismatch (${project} != ${resolution.canonicalProject})`,
					);
					return 1;
				}
				const leadKey =
					resolution.status === "ok"
						? resolution.leadKey
						: `${project}-${leadId}`;
				const store = new LeadLeaseStore(dbPath, deps.leaseStoreDeps);
				try {
					emit(store.progressSnapshot(leadKey), values.json, stdout);
					return 0;
				} finally {
					store.close();
				}
			}
			case "bind": {
				const { values } = parseArgs({
					args: args.slice(1),
					options: {
						"lead-key": { type: "string" },
						generation: { type: "string" },
						"supervisor-pid": { type: "string" },
						"supervisor-start": { type: "string" },
						"pane-pid": { type: "string" },
						"pane-start": { type: "string" },
						json: { type: "boolean", default: false },
					},
					allowPositionals: false,
				});
				const store = new LeadLeaseStore(dbPath, deps.leaseStoreDeps);
				try {
					const result = store.bind({
						leadKey: required(values["lead-key"], "--lead-key"),
						generation: positiveInteger(values.generation, "--generation"),
						expectedSupervisorPid: positiveInteger(
							values["supervisor-pid"],
							"--supervisor-pid",
						),
						expectedSupervisorStart: required(
							values["supervisor-start"],
							"--supervisor-start",
						),
						panePid: positiveInteger(values["pane-pid"], "--pane-pid"),
						paneStart: required(values["pane-start"], "--pane-start"),
					});
					emit(result, values.json, stdout);
					return result.status === "bound" ? 0 : 3;
				} finally {
					store.close();
				}
			}
			default:
				stderr(`unknown lead-lease subcommand: ${subcommand ?? "<missing>"}`);
				return 2;
		}
	} catch (error) {
		stderr(
			`lead-lease: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 2;
	}
}
