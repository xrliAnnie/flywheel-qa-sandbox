interface JitterBufferOptions {
	frameBytes: number;
	prebufferFrames: number;
	maxFrames: number;
}

export class JitterBuffer {
	private readonly frames: Array<{ frame: Buffer; metadata: unknown }> = [];
	private playing = false;
	readonly silence: Buffer;
	droppedOverflow = 0;

	constructor(private readonly options: JitterBufferOptions) {
		if (
			!Number.isInteger(options.frameBytes) ||
			options.frameBytes <= 0 ||
			!Number.isInteger(options.prebufferFrames) ||
			options.prebufferFrames <= 0 ||
			!Number.isInteger(options.maxFrames) ||
			options.maxFrames < options.prebufferFrames
		) {
			throw new Error("invalid jitter buffer options");
		}
		this.silence = Buffer.alloc(options.frameBytes);
	}

	push(frame: Buffer): void {
		this.pushTagged(frame, undefined);
	}

	pushTagged(frame: Buffer, metadata: unknown): void {
		if (frame.length !== this.options.frameBytes) {
			throw new Error(`jitter frame must be ${this.options.frameBytes} bytes`);
		}
		this.frames.push({ frame: Buffer.from(frame), metadata });
		while (this.frames.length > this.options.maxFrames) {
			this.frames.shift();
			this.droppedOverflow += 1;
		}
	}

	take(): Buffer {
		return this.takeTagged().frame;
	}

	takeTagged(): { frame: Buffer; metadata: unknown } {
		if (!this.playing) {
			if (this.frames.length < this.options.prebufferFrames) {
				return { frame: Buffer.from(this.silence), metadata: undefined };
			}
			this.playing = true;
		}
		const tagged = this.frames.shift();
		if (tagged) return tagged;
		this.playing = false;
		return { frame: Buffer.from(this.silence), metadata: undefined };
	}

	depth(): number {
		return this.frames.length;
	}

	flush(): void {
		this.frames.length = 0;
		this.playing = false;
	}
}
