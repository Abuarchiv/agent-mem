import type { Socket } from "node:net";

export const IPC_VERSION = 1 as const;
export const IPC_PSK_CIPHER = "PSK-AES256-GCM-SHA384" as const;
export const IPC_TLS_VERSION = "TLSv1.2" as const;
export const DEFAULT_MAX_FRAME_BYTES = 4_500_000;

export type IpcErrorCode =
  | "frame_too_large"
  | "frame_truncated"
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_frame";

export class IpcProtocolError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode) {
    super(code);
    this.name = "IpcProtocolError";
    this.code = code;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IpcProtocolError("invalid_frame");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new IpcProtocolError("invalid_frame");
}

/**
 * Grows one bounded buffer geometrically and scans only bytes added since the
 * previous push. An unterminated frame therefore cannot cause repeated copies
 * of the same prefix.
 */
export class NdjsonDecoder {
  private buffer: Buffer;
  private start = 0;
  private end = 0;
  private scan = 0;
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: true });

  constructor(readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    this.buffer = Buffer.allocUnsafe(Math.max(1, Math.min(256, maxFrameBytes + 1)));
  }

  push(chunk: Uint8Array): unknown[] {
    const frames: unknown[] = [];
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      this.ensureWritable();
      const amount = Math.min(chunk.length - offset, this.buffer.length - this.end);
      source.copy(this.buffer, this.end, offset, offset + amount);
      this.end += amount;
      offset += amount;
      this.decodeAvailable(frames);
    }
    this.decodeAvailable(frames);
    this.compactIfUseful();
    return frames;
  }

  finish(): void {
    if (this.end > this.start) throw new IpcProtocolError("frame_truncated");
  }

  hasPendingBytes(): boolean {
    return this.end > this.start;
  }

  private decodeAvailable(frames: unknown[]): void {
    while (this.scan < this.end) {
      const relativeNewline = this.buffer.subarray(this.scan, this.end).indexOf(0x0a);
      const newlineOffset = relativeNewline === -1 ? -1 : this.scan + relativeNewline;
      if (newlineOffset === -1) {
        this.scan = this.end;
        if (this.end - this.start > this.maxFrameBytes) throw new IpcProtocolError("frame_too_large");
        return;
      }
      if (newlineOffset - this.start > this.maxFrameBytes) throw new IpcProtocolError("frame_too_large");
      const frame = this.buffer.subarray(this.start, newlineOffset);
      const line = frame.length > 0 && frame[frame.length - 1] === 0x0d ? frame.subarray(0, frame.length - 1) : frame;
      let text: string;
      try {
        text = this.textDecoder.decode(line);
      } catch {
        throw new IpcProtocolError("invalid_utf8");
      }
      if (text.trim().length === 0) throw new IpcProtocolError("invalid_frame");
      try {
        frames.push(JSON.parse(text) as unknown);
      } catch {
        throw new IpcProtocolError("invalid_json");
      }
      this.start = newlineOffset + 1;
      this.scan = this.start;
    }
  }

  private ensureWritable(): void {
    if (this.end < this.buffer.length) return;
    this.compact();
    if (this.end < this.buffer.length) return;
    const maxCapacity = Math.max(1, this.maxFrameBytes + 1);
    if (this.buffer.length >= maxCapacity) throw new IpcProtocolError("frame_too_large");
    const capacity = Math.min(maxCapacity, Math.max(this.buffer.length * 2, this.end + 1));
    const grown = Buffer.allocUnsafe(capacity);
    this.buffer.copy(grown, 0, this.start, this.end);
    this.end -= this.start;
    this.scan -= this.start;
    this.start = 0;
    this.buffer = grown;
  }

  private compact(): void {
    if (this.start === 0) return;
    this.buffer.copy(this.buffer, 0, this.start, this.end);
    this.end -= this.start;
    this.scan = Math.max(0, this.scan - this.start);
    this.start = 0;
  }

  private compactIfUseful(): void {
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
      this.scan = 0;
      return;
    }
    if (this.start >= Math.floor(this.buffer.length / 2)) this.compact();
  }
}

export function encodeFrame(value: unknown, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  const encoded = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (encoded.length - 1 > maxFrameBytes) throw new IpcProtocolError("frame_too_large");
  return encoded;
}

export function writeFrame(socket: Socket, value: unknown, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): boolean {
  return socket.write(encodeFrame(value, maxFrameBytes));
}
