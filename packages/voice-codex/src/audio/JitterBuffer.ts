interface JitterBufferOptions {
	frameBytes: number;
	prebufferFrames: number;
	maxFrames: number;
}

export class JitterBuffer {
	private readonly frames: Buffer[] = [];
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
		if (frame.length !== this.options.frameBytes) {
			throw new Error(`jitter frame must be ${this.options.frameBytes} bytes`);
		}
		this.frames.push(Buffer.from(frame));
		while (this.frames.length > this.options.maxFrames) {
			this.frames.shift();
			this.droppedOverflow += 1;
		}
	}

	take(): Buffer {
		if (!this.playing) {
			if (this.frames.length < this.options.prebufferFrames) {
				return Buffer.from(this.silence);
			}
			this.playing = true;
		}
		const frame = this.frames.shift();
		if (frame) return frame;
		this.playing = false;
		return Buffer.from(this.silence);
	}

	depth(): number {
		return this.frames.length;
	}

	flush(): void {
		this.frames.length = 0;
		this.playing = false;
	}
}
