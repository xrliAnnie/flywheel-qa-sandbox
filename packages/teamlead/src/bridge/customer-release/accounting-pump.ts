import {
	GitHubReleaseAccounting,
	LinearReleaseAccounting,
	request as readRemote,
} from "./accounting-transport.js";
import { readReleaseControlRequest } from "./control-trigger.js";
import type { CustomerReleaseStore } from "./store.js";

function valid(v: unknown): asserts v {
	if (!v) throw new Error("release accounting mapping unavailable");
}
function object(v: unknown): Record<string, unknown> {
	valid(v && typeof v === "object" && !Array.isArray(v));
	return v as Record<string, unknown>;
}
function exact(v: Record<string, unknown>, keys: string[]) {
	valid(
		Object.keys(v).length === keys.length &&
			keys.every((k) => Object.hasOwn(v, k)),
	);
}
function positive(v: unknown): asserts v is number {
	valid(Number.isSafeInteger(v) && (v as number) > 0);
}
function uuid(v: unknown): asserts v is string {
	valid(
		typeof v === "string" &&
			/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v),
	);
}
interface Options {
	store: () => CustomerReleaseStore;
	projects: () => { projectName: string; projectRepo?: string }[];
	env: Readonly<Record<string, string | undefined>>;
	fetch?: typeof fetch;
	now?: () => number;
	onError?: (code: string) => void;
	bugLabel?: () => string;
	recordBugSourceHealth?: (input: {
		activationEpoch: number;
		label: string;
		ok: boolean;
		error?: string;
		at: string;
	}) => void;
}
/** Independent audit worker: default configuration performs no network calls.
 * Stopping aborts its original requests and waits before the database closes. */
export class CustomerReleaseAccountingPump {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private flight: Promise<void> | null = null;
	private controller = new AbortController();
	private running = false;
	constructor(private readonly options: Options) {}
	private binding(epoch: number, raw: Record<string, unknown>) {
		exact(raw, [
			"directory",
			"repositoryId",
			"githubWriterId",
			"linearWriterId",
			"githubTokenEnv",
			"linearTokenEnv",
		]);
		valid(typeof raw.directory === "string" && raw.directory.startsWith("/"));
		positive(raw.repositoryId);
		positive(raw.githubWriterId);
		uuid(raw.linearWriterId);
		for (const name of [raw.githubTokenEnv, raw.linearTokenEnv])
			valid(typeof name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(name));
		const githubToken = this.options.env[raw.githubTokenEnv as string],
			linearToken = this.options.env[raw.linearTokenEnv as string];
		valid(
			githubToken && linearToken && !/[\r\n]/.test(githubToken + linearToken),
		);
		const projects = this.options
			.projects()
			.filter((p) => p.projectName === "flywheel");
		valid(projects.length === 1);
		const repository = projects[0]!.projectRepo;
		valid(
			repository &&
				/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(
					repository,
				),
		);
		positive(epoch);
		const activationId = `flywheel:epoch:${epoch}`;
		const file = object(
			readReleaseControlRequest(raw.directory, "accounting.json"),
		);
		exact(file, ["schemaVersion", "activations"]);
		valid(file.schemaVersion === 1);
		const activations = object(file.activations);
		valid(
			Object.keys(activations).length <= 100 &&
				Object.keys(activations).every((k) =>
					/^flywheel:epoch:[1-9][0-9]*$/.test(k),
				),
		);
		const mapping = object(activations[activationId]);
		exact(mapping, [
			"linearIssueId",
			"githubIssueNumber",
			"linearTeamId",
			"linearProjectId",
		]);
		uuid(mapping.linearTeamId);
		uuid(mapping.linearProjectId);
		uuid(mapping.linearIssueId);
		positive(mapping.githubIssueNumber);
		return {
			epoch,
			githubToken,
			linearToken,
			binding: {
				activationId,
				repository,
				repositoryId: raw.repositoryId,
				linearIssueId: mapping.linearIssueId,
				linearTeamId: mapping.linearTeamId,
				linearProjectId: mapping.linearProjectId,
				githubIssueNumber: mapping.githubIssueNumber,
				linearWriterId: raw.linearWriterId,
				githubWriterId: raw.githubWriterId,
			},
		};
	}
	/** The only production Bug-health writer. Arbitrary issue label lookups
	 * cannot feed this activation-bound source signal. */
	private async probeBugSource(
		raw: Record<string, unknown>,
		fetcher: typeof fetch,
	) {
		if (!this.options.recordBugSourceHealth) return;
		const epoch = this.options.store().activation.get()?.epoch;
		if (!epoch) return;
		let config: ReturnType<CustomerReleaseAccountingPump["binding"]>;
		let label: string;
		try {
			config = this.binding(epoch, raw);
			label = this.options.bugLabel?.() ?? "";
			valid(label.length > 0 && label.length <= 128);
			this.options
				.store()
				.accounting.bindActivationTarget(
					epoch,
					config.binding,
					this.options.now?.() ?? Date.now(),
				);
		} catch {
			this.options.onError?.("accounting_pending");
			return;
		}
		let ok = false;
		try {
			const response = await readRemote(
				fetcher,
				"https://api.linear.app/graphql",
				config.linearToken,
				"POST",
				{
					query:
						"query ReleaseBugSourceProbe($id:String!,$filter:IssueLabelFilter!){issue(id:$id){id team{id} project{id}} issueLabels(first:2,filter:$filter){nodes{id name team{id}}}}",
					variables: {
						id: config.binding.linearIssueId,
						filter: {
							name: { eq: label },
							team: { id: { eq: config.binding.linearTeamId } },
						},
					},
				},
			);
			const body = object(response.value);
			valid(!body.errors);
			const data = object(body.data),
				issue = object(data.issue);
			valid(
				issue.id === config.binding.linearIssueId &&
					object(issue.team).id === config.binding.linearTeamId &&
					object(issue.project).id === config.binding.linearProjectId,
			);
			const nodes = object(data.issueLabels).nodes;
			valid(Array.isArray(nodes) && nodes.length === 1);
			const found = object(nodes[0]);
			valid(
				typeof found.id === "string" &&
					found.id.length > 0 &&
					found.name === label &&
					object(found.team).id === config.binding.linearTeamId,
			);
			ok = true;
		} catch {
			// Loss/null from the monitored source remains fail-closed. No raw
			// transport errors or credentials enter the persisted source record.
		}
		this.controller.signal.throwIfAborted();
		if (
			this.options.store().activation.get()?.epoch !== epoch ||
			this.options.bugLabel?.() !== label
		)
			return;
		try {
			const current = this.binding(
				epoch,
				object(
					JSON.parse(
						this.options.env.FW_CUSTOMER_RELEASE_ACCOUNTING_JSON ?? "{}",
					),
				),
			);
			valid(current.linearToken === config.linearToken);
			valid(JSON.stringify(current.binding) === JSON.stringify(config.binding));
		} catch {
			this.options.onError?.("accounting_pending");
			return;
		}
		this.options.recordBugSourceHealth({
			activationEpoch: epoch,
			label,
			ok,
			...(ok ? {} : { error: "canonical Bug source unavailable" }),
			at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
		});
	}

	async tick(): Promise<void> {
		this.controller.signal.throwIfAborted();
		const now = this.options.now?.() ?? Date.now();
		const ledger = this.options.store().accounting;
		ledger.capture(now);
		const text = this.options.env.FW_CUSTOMER_RELEASE_ACCOUNTING_JSON;
		if (!text) {
			if (
				this.options.recordBugSourceHealth &&
				this.options.store().activation.get()
			)
				this.options.onError?.("accounting_pending");
			return;
		}
		valid(text.length <= 16384);
		const raw = object(JSON.parse(text));
		const fetcher: typeof fetch = (url, init) => {
			this.controller.signal.throwIfAborted();
			return (this.options.fetch ?? fetch)(url, {
				...init,
				signal: init?.signal
					? AbortSignal.any([this.controller.signal, init.signal])
					: this.controller.signal,
			});
		};
		if (this.options.recordBugSourceHealth)
			await this.probeBugSource(raw, fetcher);
		await Promise.all(
			(["linear", "github"] as const).map((target) =>
				ledger.project(
					target,
					(event) => {
						this.controller.signal.throwIfAborted();
						const epoch =
							event.origin === "activation"
								? event.facts.epoch
								: event.facts.activationEpoch;
						positive(epoch);
						const config = this.binding(epoch, raw);
						ledger.bindActivationTarget(config.epoch, config.binding, now);
						return target === "linear"
							? new LinearReleaseAccounting({
									issueId: config.binding.linearIssueId,
									writerId: config.binding.linearWriterId,
									token: config.linearToken,
									fetch: fetcher,
								})
							: new GitHubReleaseAccounting({
									repository: config.binding.repository,
									repositoryId: config.binding.repositoryId,
									issueNumber: config.binding.githubIssueNumber,
									writerId: config.binding.githubWriterId,
									token: config.githubToken,
									fetch: fetcher,
								});
					},
					now,
				),
			),
		);
	}
	private schedule(delay: number) {
		if (!this.running) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flight = this.tick()
				.catch(() => this.options.onError?.("accounting_pending"))
				.finally(() => {
					this.flight = null;
					this.schedule(30000);
				});
		}, delay);
		this.timer.unref?.();
	}
	start() {
		if (this.running) return;
		this.running = true;
		this.controller = new AbortController();
		this.schedule(1000);
	}
	async stop() {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.controller.abort();
		await this.flight;
	}
}
