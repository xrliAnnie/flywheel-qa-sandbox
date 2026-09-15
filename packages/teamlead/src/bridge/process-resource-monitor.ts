import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";

export interface ResourceLimits {
	soft: unknown;
	kernel: unknown;
	systemFiles: unknown;
	systemMaxFiles?: unknown;
}
export interface FdHealth {
	used: number | null;
	limit: number | null;
	rlimit_soft: number | null;
	kernel_per_process_limit: number | null;
	rlimit_unlimited: boolean | null;
	limit_source: "darwin-effective" | "process-rlimit" | "unavailable";
	unlimited: boolean;
	usage_ratio: number | null;
	sampled_at: string | null;
	limits_sampled_at: string | null;
	system_files: number | null;
	system_maxfiles: number | null;
	status: "fresh" | "stale" | "unavailable";
	reason: "sample_failed" | "sample_timeout" | "limit_unavailable" | null;
}
interface Dependencies {
	platform?: string;
	now?: () => number;
	readFds?: () => Promise<string[]>;
	readLimits?: () => Promise<ResourceLimits>;
	warn?: (snapshot: FdHealth) => void;
	alert?: (snapshot: FdHealth) => Promise<boolean>;
	resolve?: () => Promise<boolean>;
}
function limitValue(raw: unknown): number | null {
	if (raw === "unlimited") return Number.POSITIVE_INFINITY;
	if (typeof raw === "string" && !/^\d+$/.test(raw.trim())) return null;
	const n =
		typeof raw === "number"
			? raw
			: typeof raw === "string"
				? Number(raw.trim())
				: NaN;
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function sysctl(name: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"/usr/sbin/sysctl",
			["-n", name],
			{ timeout: 2000, maxBuffer: 65536, encoding: "utf8" },
			(error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
		);
	});
}
export async function readProcessLimits(
	platform = process.platform,
): Promise<ResourceLimits> {
	let soft: unknown = null;
	try {
		const report = process.report.getReport() as {
			userLimits?: { open_files?: { soft?: unknown } };
		};
		soft = report.userLimits?.open_files?.soft ?? null;
	} catch {
		/* Unknown is explicit; never infer the shell's limit. */
	}
	if (platform !== "darwin") return { soft, kernel: null, systemFiles: null };
	const [kernel, files, maxFiles] = await Promise.allSettled([
		sysctl("kern.maxfilesperproc"),
		sysctl("kern.num_files"),
		sysctl("kern.maxfiles"),
	]);
	return {
		soft,
		kernel: kernel.status === "fulfilled" ? kernel.value : null,
		systemFiles: files.status === "fulfilled" ? files.value : null,
		systemMaxFiles: maxFiles.status === "fulfilled" ? maxFiles.value : null,
	};
}

/** One process singleton. All health reads are cache-only, including staleness. */
export class ProcessResourceMonitor {
	private readonly platform: string;
	private readonly now: () => number;
	private readonly readFds: () => Promise<string[]>;
	private readonly readLimits: () => Promise<ResourceLimits>;
	private limits: ResourceLimits = {
		soft: null,
		kernel: null,
		systemFiles: null,
	};
	private limitsAt: number | null = null;
	private used: number | null = null;
	private sampledAt: number | null = null;
	private failure: FdHealth["reason"] = null;
	private flight: Promise<void> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	private notified = false;
	private pressure = false;
	private lowSamples = 0;
	constructor(private readonly deps: Dependencies = {}) {
		this.platform = deps.platform ?? process.platform;
		this.now = deps.now ?? Date.now;
		this.readFds =
			deps.readFds ??
			(() => readdir(this.platform === "darwin" ? "/dev/fd" : "/proc/self/fd"));
		this.readLimits =
			deps.readLimits ??
			(() => readProcessLimits(this.platform as NodeJS.Platform));
	}
	start(): void {
		if (this.timer || this.stopped) return;
		void this.sample();
		this.timer = setInterval(() => {
			void this.sample();
		}, 30000);
		this.timer.unref?.();
	}
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.flight;
	}
	snapshot(): FdHealth {
		const now = this.now();
		const limitsFresh = this.limitsAt !== null && now - this.limitsAt <= 600000;
		const soft = limitsFresh ? limitValue(this.limits.soft) : null;
		const kernel = limitsFresh ? limitValue(this.limits.kernel) : null;
		const effective =
			soft === null || (this.platform === "darwin" && kernel === null)
				? null
				: this.platform === "darwin"
					? Math.min(soft, kernel!)
					: soft;
		const limit =
			effective !== null && Number.isFinite(effective) ? effective : null;
		const stale =
			(this.sampledAt !== null && now - this.sampledAt > 60000) ||
			(this.limitsAt !== null && !limitsFresh);
		const unavailable =
			this.failure !== null || this.used === null || effective === null;
		const files = limitValue(this.limits.systemFiles);
		const maxFiles = limitValue(this.limits.systemMaxFiles);
		return {
			used: this.used,
			limit,
			rlimit_soft: soft !== null && Number.isFinite(soft) ? soft : null,
			kernel_per_process_limit:
				kernel !== null && Number.isFinite(kernel) ? kernel : null,
			rlimit_unlimited: soft === null ? null : soft === Infinity,
			limit_source:
				effective === null
					? "unavailable"
					: this.platform === "darwin"
						? "darwin-effective"
						: "process-rlimit",
			unlimited: effective === Infinity,
			usage_ratio:
				limit !== null && this.used !== null ? this.used / limit : null,
			sampled_at:
				this.sampledAt === null ? null : new Date(this.sampledAt).toISOString(),
			limits_sampled_at:
				this.limitsAt === null ? null : new Date(this.limitsAt).toISOString(),
			system_files:
				limitsFresh && files !== null && Number.isFinite(files) ? files : null,
			system_maxfiles:
				limitsFresh && maxFiles !== null && Number.isFinite(maxFiles)
					? maxFiles
					: null,
			status: this.failure
				? "unavailable"
				: stale
					? "stale"
					: unavailable
						? "unavailable"
						: "fresh",
			reason: this.failure ?? (effective === null ? "limit_unavailable" : null),
		};
	}
	sample(): Promise<void> {
		if (this.flight) return this.flight;
		if (this.stopped) return Promise.resolve();
		// Assign flight before invoking dependency code, including synchronous throws.
		const work = Promise.resolve().then(() => this.collect());
		const flight = work.finally(() => {
			if (this.flight === flight) this.flight = null;
		});
		this.flight = flight;
		return flight;
	}
	private async collect(): Promise<void> {
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			this.failure = "sample_timeout";
			this.lowSamples = 0;
		}, 2000);
		timeout.unref?.();
		try {
			const refresh =
				this.limitsAt === null || this.now() - this.limitsAt >= 300000;
			const [fdResult, limitResult] = await Promise.allSettled([
				Promise.resolve().then(() => this.readFds()),
				refresh
					? Promise.resolve().then(() => this.readLimits())
					: Promise.resolve(null),
			]);
			if (fdResult.status === "rejected" || limitResult.status === "rejected")
				throw new Error("resource_sample_failed");
			const fds = fdResult.value;
			const limits = limitResult.value;
			if (timedOut || this.stopped) return;
			this.used = new Set(fds.filter((fd) => /^\d+$/.test(fd))).size;
			this.sampledAt = this.now();
			if (limits) {
				this.limits = limits;
				this.limitsAt = this.now();
			}
			this.failure = null;
		} catch {
			this.lowSamples = 0;
			if (!timedOut) this.failure = "sample_failed";
		} finally {
			clearTimeout(timeout);
		}
		if (!this.stopped) await this.checkPressure();
	}
	private async checkPressure(): Promise<void> {
		const snapshot = this.snapshot();
		if (snapshot.status !== "fresh" || snapshot.usage_ratio === null) {
			this.lowSamples = 0;
			return;
		}
		if (snapshot.usage_ratio > 0.8) {
			this.pressure = true;
			this.lowSamples = 0;
			try {
				(
					this.deps.warn ??
					((s) =>
						console.warn(
							`[bridge-fd] pressure used=${s.used} limit=${s.limit}`,
						))
				)(snapshot);
			} catch {
				/* logging must not stop monitoring */
			}
			if (!this.notified && this.deps.alert) {
				try {
					this.notified = await this.deps.alert(snapshot);
				} catch {
					/* retry next fresh sample */
				}
			}
		} else if (snapshot.usage_ratio < 0.7 && this.pressure) {
			this.lowSamples++;
			if (this.lowSamples < 2) return;
			try {
				if (this.deps.resolve && !(await this.deps.resolve())) return;
				this.pressure = false;
				this.notified = false;
				this.lowSamples = 0;
			} catch {
				/* retry recovery; no false resolution */
			}
		} else this.lowSamples = 0;
	}
}
