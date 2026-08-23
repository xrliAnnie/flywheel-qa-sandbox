import { randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { Session } from "node:inspector";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { appendRotatedLogSync } from "flywheel-config";

const WINDOW_MS = 30_000;
const EPISODE_MS = 1_000;
const LONG_SPAN_MS = 500;
const PROFILE_LIMIT = 20;
const PROFILE_BYTES_LIMIT = 100 * 1024 * 1024;
const PROFILE_PATTERN =
	/^loop-profile-[A-Za-z0-9T_.-]+-max\d+(?:\.\d+)?\.cpuprofile$/;
const TEMP_PATTERN =
	/^loop-profile-[A-Za-z0-9T_.-]+\.cpuprofile\.tmp-[A-Za-z0-9-]+$/;

type InspectorSession = Pick<Session, "connect" | "disconnect" | "post">;

export interface EventLoopHealthSnapshot {
	p99_ms: number | null;
	max_ms: number | null;
	episodes: number;
}

interface WallSpan {
	name: string;
	start_ms: number;
	end_ms: number;
	duration_ms: number;
}

interface Episode {
	started_at: string;
	p99_ms: number;
	max_ms: number;
	event_loop_utilization: number;
	profile: string | null;
	profiler_gap_ms: number | null;
	long_wall_spans: WallSpan[];
}

interface WindowSnapshot {
	window_start_ts: string;
	window_end_ts: string;
	p50_ms: number | null;
	p99_ms: number | null;
	max_ms: number | null;
	event_loop_utilization: number;
	profiler_gap_ms: number | null;
}

export function nanosecondsToMilliseconds(value: number): number {
	return value / 1_000_000;
}

export class EventLoopAttribution {
	private readonly profileDir: string;
	private readonly episodeLog: string;
	private readonly delay = monitorEventLoopDelay({ resolution: 10 });
	private readonly spans: WallSpan[] = [];
	private readonly episodes: Episode[] = [];
	private readonly windows: WindowSnapshot[] = [];
	private profiles: string[] = [];
	private episodeCount = 0;
	private readonly createInspectorSession: () => InspectorSession;
	private timer: ReturnType<typeof setInterval> | null = null;
	private inspectorSession: InspectorSession | null = null;
	private profilerRunning = false;
	private started = false;
	private rolling: Promise<void> | null = null;
	private utilization = performance.eventLoopUtilization();
	private windowStartedAt = Date.now();
	private health: EventLoopHealthSnapshot = {
		p99_ms: null,
		max_ms: null,
		episodes: 0,
	};
	private state: "disabled" | "running" | "degraded" | "stopped" = "stopped";
	private error: string | null = null;

	constructor(
		private readonly options: {
			diagnosticsDir: string;
			profilerEnabled: boolean | (() => boolean);
			createInspectorSession?: () => InspectorSession;
		},
	) {
		this.profileDir = join(options.diagnosticsDir, "loop-profiles");
		this.episodeLog = join(options.diagnosticsDir, "event-loop-episodes.jsonl");
		this.createInspectorSession =
			options.createInspectorSession ?? (() => new Session());
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.delay.enable();
		this.utilization = performance.eventLoopUtilization();
		this.windowStartedAt = Date.now();
		this.timer = setInterval(() => {
			void this.rollWindow().catch((error) => this.markDegraded(error));
		}, WINDOW_MS);
		this.timer.unref?.();
		try {
			mkdirSync(this.options.diagnosticsDir, {
				recursive: true,
				mode: 0o700,
			});
			chmodSync(this.options.diagnosticsDir, 0o700);
			mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
			chmodSync(this.profileDir, 0o700);
			this.profiles = this.pruneProfiles();
		} catch (error) {
			this.markDegraded(error);
			return;
		}

		if (!this.profilerEnabled()) {
			this.state = "disabled";
			return;
		}
		await this.startProfiler();
	}

	private profilerEnabled(): boolean {
		return typeof this.options.profilerEnabled === "function"
			? this.options.profilerEnabled()
			: this.options.profilerEnabled;
	}

	private async startProfiler(): Promise<void> {
		if (this.profilerRunning) return;
		try {
			this.inspectorSession = this.createInspectorSession();
			this.inspectorSession.connect();
			await this.post("Profiler.enable");
			await this.post("Profiler.setSamplingInterval", { interval: 10_000 });
			await this.post("Profiler.start");
			this.profilerRunning = true;
			this.state = "running";
			this.error = null;
		} catch (error) {
			this.markDegraded(error);
			this.disconnectInspector();
		}
	}

	private async disableProfiler(): Promise<void> {
		if (!this.inspectorSession) {
			this.profilerRunning = false;
			this.state = "disabled";
			return;
		}
		try {
			if (this.profilerRunning) await this.post("Profiler.stop");
			await this.post("Profiler.disable");
			this.state = "disabled";
			this.error = null;
		} catch (error) {
			this.markDegraded(error);
		} finally {
			this.disconnectInspector();
		}
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.rolling) await this.rolling;
		if (this.inspectorSession) await this.disableProfiler();
		this.delay.disable();
		this.state = "stopped";
	}

	/**
	 * Wall-clock correlation only: spans include benign await time and do not
	 * establish CPU ownership. The retained CPU profile is attribution authority.
	 */
	recordSpan(name: string, startMs: number, endMs: number): void {
		const durationMs = endMs - startMs;
		if (!Number.isFinite(durationMs) || durationMs <= LONG_SPAN_MS) return;
		this.spans.push({
			name,
			start_ms: startMs,
			end_ms: endMs,
			duration_ms: durationMs,
		});
		if (this.spans.length > 200) this.spans.splice(0, this.spans.length - 200);
	}

	healthSnapshot(): EventLoopHealthSnapshot {
		return { ...this.health };
	}

	snapshot(): {
		state: string;
		error: string | null;
		health: EventLoopHealthSnapshot;
		episodes: { count: number; latest: Episode | null };
		profiles: string[];
		long_wall_spans: WallSpan[];
		windows: WindowSnapshot[];
	} {
		return {
			state: this.state,
			error: this.error,
			health: this.healthSnapshot(),
			episodes: {
				count: this.episodeCount,
				latest: this.episodes.at(-1) ?? null,
			},
			profiles: [...this.profiles],
			long_wall_spans: [...this.spans],
			windows: [...this.windows],
		};
	}

	private async rollWindow(): Promise<void> {
		if (this.rolling) return this.rolling;
		const run = this.finishWindow();
		const guarded = run.finally(() => {
			if (this.rolling === guarded) this.rolling = null;
		});
		this.rolling = guarded;
		return this.rolling;
	}

	private async finishWindow(): Promise<void> {
		const windowEndedAt = Date.now();
		const windowStartedAt = this.windowStartedAt;
		this.windowStartedAt = windowEndedAt;
		const p50Ms = nanosecondsToMilliseconds(this.delay.percentile(50));
		const p99Ms = nanosecondsToMilliseconds(this.delay.percentile(99));
		const maxMs = nanosecondsToMilliseconds(this.delay.max);
		const utilization = performance.eventLoopUtilization(this.utilization);
		this.utilization = performance.eventLoopUtilization();
		this.delay.reset();
		this.health = {
			p99_ms: maxMs > 0 ? p99Ms : null,
			max_ms: maxMs > 0 ? maxMs : null,
			episodes: this.episodeCount,
		};

		const profilerControlEnabled = this.profilerEnabled();
		let profile: object | null = null;
		let profilerGapMs: number | null = null;
		if (this.profilerRunning) {
			try {
				const stoppedAt = Date.now();
				const result = await this.post<{ profile: object }>("Profiler.stop");
				this.profilerRunning = false;
				if (profilerControlEnabled) {
					await this.post("Profiler.start");
					this.profilerRunning = true;
					this.state = "running";
				} else {
					await this.disableProfiler();
				}
				profilerGapMs = Date.now() - stoppedAt;
				profile = result.profile;
			} catch (error) {
				this.profilerRunning = false;
				this.markDegraded(error);
				this.disconnectInspector();
			}
		} else if (profilerControlEnabled) {
			await this.startProfiler();
		} else if (this.inspectorSession) {
			await this.disableProfiler();
		}
		this.windows.push({
			window_start_ts: new Date(windowStartedAt).toISOString(),
			window_end_ts: new Date(windowEndedAt).toISOString(),
			p50_ms: maxMs > 0 ? p50Ms : null,
			p99_ms: maxMs > 0 ? p99Ms : null,
			max_ms: maxMs > 0 ? maxMs : null,
			event_loop_utilization: utilization.utilization,
			profiler_gap_ms: profilerGapMs,
		});
		if (this.windows.length > PROFILE_LIMIT) this.windows.shift();

		if (maxMs < EPISODE_MS) return;
		const correlatedSpans = this.spans.filter(
			(span) =>
				span.end_ms >= windowStartedAt && span.start_ms <= windowEndedAt,
		);
		const profileName = profile
			? this.persistProfile(profile, maxMs, windowStartedAt)
			: null;
		const episode: Episode = {
			started_at: new Date(windowStartedAt).toISOString(),
			p99_ms: p99Ms,
			max_ms: maxMs,
			event_loop_utilization: utilization.utilization,
			profile: profileName,
			profiler_gap_ms: profilerGapMs,
			long_wall_spans: correlatedSpans,
		};
		this.episodes.push(episode);
		if (this.episodes.length > PROFILE_LIMIT) this.episodes.shift();
		this.episodeCount += 1;
		this.health.episodes = this.episodeCount;
		appendRotatedLogSync(this.episodeLog, `${JSON.stringify(episode)}\n`, {
			maxBytes: 10 * 1024 * 1024,
			keep: 3,
		});
		chmodSync(this.episodeLog, 0o600);
	}

	private markDegraded(error: unknown): void {
		this.state = "degraded";
		this.error = error instanceof Error ? error.message : String(error);
	}

	private post<T = Record<string, never>>(
		method: string,
		params?: Record<string, unknown>,
	): Promise<T> {
		if (!this.inspectorSession)
			throw new Error("inspector session unavailable");
		return new Promise<T>((resolve, reject) => {
			const callback = (error: Error | null, result?: T) =>
				error ? reject(error) : resolve(result ?? ({} as T));
			if (params)
				this.inspectorSession?.post(method, params, callback as never);
			else this.inspectorSession?.post(method, callback as never);
		});
	}

	private disconnectInspector(): void {
		this.profilerRunning = false;
		try {
			this.inspectorSession?.disconnect();
		} catch {
			// A partially-connected injected session may not support disconnect.
		}
		this.inspectorSession = null;
	}

	private persistProfile(
		profile: object,
		maxMs: number,
		windowStartedAt: number,
	): string | null {
		const timestamp = new Date(windowStartedAt)
			.toISOString()
			.replaceAll(":", "-");
		const basename = `loop-profile-${timestamp}-max${Math.round(maxMs)}.cpuprofile`;
		const destination = join(this.profileDir, basename);
		const temporary = `${destination}.tmp-${randomUUID()}`;
		writeFileSync(temporary, JSON.stringify(profile), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, destination);
		chmodSync(destination, 0o600);
		this.profiles = this.pruneProfiles();
		return this.profiles.includes(basename) ? basename : null;
	}

	private profileEntries(): Array<{
		name: string;
		mtimeMs: number;
		bytes: number;
	}> {
		return readdirSync(this.profileDir)
			.flatMap((name) => {
				if (!PROFILE_PATTERN.test(name)) return [];
				try {
					const stat = lstatSync(join(this.profileDir, name));
					return stat.isFile()
						? [{ name, mtimeMs: stat.mtimeMs, bytes: stat.size }]
						: [];
				} catch {
					return [];
				}
			})
			.sort(
				(left, right) =>
					left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
			);
	}

	private pruneProfiles(): string[] {
		for (const name of readdirSync(this.profileDir)) {
			const path = join(this.profileDir, name);
			let regular = false;
			try {
				regular = lstatSync(path).isFile();
			} catch {
				continue;
			}
			if (regular && TEMP_PATTERN.test(name)) unlinkSync(path);
		}
		const profiles = this.profileEntries();
		let totalBytes = profiles.reduce((sum, entry) => sum + entry.bytes, 0);
		while (
			profiles.length > PROFILE_LIMIT ||
			totalBytes > PROFILE_BYTES_LIMIT
		) {
			const oldest = profiles.shift();
			if (!oldest) break;
			unlinkSync(join(this.profileDir, oldest.name));
			totalBytes -= oldest.bytes;
		}
		return profiles.map((entry) => entry.name);
	}
}
