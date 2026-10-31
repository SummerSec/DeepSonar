/** A single-flight, bounded WebSocket sender used by the process stream. */
export interface WsSendSocket {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
}

export interface WsSendQueueOptions {
  maxItems: number;
  maxBytes: number;
  onClose?: (code: number, reason: string) => void;
}

export class WsSendQueue {
  private readonly pending: string[] = [];
  private pendingBytes = 0;
  private flushing = false;
  private stopped = false;

  constructor(private readonly socket: WsSendSocket, private readonly options: WsSendQueueOptions) {}

  get size(): number {
    return this.pending.length + (this.flushing ? 1 : 0);
  }

  get closed(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
    this.pendingBytes = 0;
  }

  enqueue(value: unknown): boolean {
    if (this.stopped || this.socket.readyState !== this.socket.OPEN) return false;
    let encoded: string;
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized !== "string") return false;
      encoded = serialized;
    } catch {
      return false;
    }
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (
      this.size >= this.options.maxItems ||
      this.pendingBytes + bytes + this.socket.bufferedAmount > this.options.maxBytes
    ) {
      this.failBackpressure();
      return false;
    }
    this.pending.push(encoded);
    this.pendingBytes += bytes;
    this.flush();
    return !this.stopped;
  }

  private failBackpressure(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending.length = 0;
    this.pendingBytes = 0;
    try {
      this.socket.close(1013, "stream backpressure");
    } finally {
      this.options.onClose?.(1013, "stream backpressure");
    }
  }

  private failSend(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending.length = 0;
    this.pendingBytes = 0;
    try {
      this.socket.close(1011, "stream send failed");
    } finally {
      this.options.onClose?.(1011, "stream send failed");
    }
  }

  private flush(): void {
    if (this.stopped || this.flushing || this.pending.length === 0 || this.socket.readyState !== this.socket.OPEN) return;
    if (this.socket.bufferedAmount > this.options.maxBytes) {
      this.failBackpressure();
      return;
    }
    const encoded = this.pending.shift();
    if (!encoded) return;
    this.pendingBytes -= Buffer.byteLength(encoded, "utf8");
    this.flushing = true;
    try {
      this.socket.send(encoded, (error?: Error) => {
        this.flushing = false;
        if (error) this.failSend();
        else this.flush();
      });
    } catch {
      this.flushing = false;
      this.failSend();
    }
  }
}
