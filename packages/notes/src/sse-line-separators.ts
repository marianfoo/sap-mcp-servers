import type { NextFunction, Request, Response } from 'express';

/**
 * Keep U+2028, U+2029 and U+0085 (NEXT LINE) out of SSE frames.
 *
 * The Streamable HTTP transport sends every JSON-RPC message as a single `data: <json>` line.
 * JSON allows these characters unescaped inside strings, and SAP Note text contains them (e.g. note
 * 3425804). SSE itself only treats LF, CR and CRLF as line ends, but some clients split on every
 * Unicode line break (Python's `str.splitlines()` does), cut the `data:` line at the first U+2028
 * and fail with "EOF while parsing a string". Writing them as six-character JSON escapes
 * (`\u2028`, `\u2029`, `\u0085`) preserves the JSON value without adding a line break.
 *
 * This works on bytes (UTF-8 E2 80 A8 / E2 80 A9 / C2 85), so it does not depend on how the SDK writes its
 * chunks, and it holds back a trailing partial sequence until the next chunk arrives.
 * Remove this middleware when the minimum SDK version escapes all three characters and the
 * HTTP endpoint regression passes without it. Keep that regression when removing this module.
 */

const ESCAPED_LS = Buffer.from('\\u2028');
const ESCAPED_PS = Buffer.from('\\u2029');
const ESCAPED_NEL = Buffer.from('\\u0085');

export interface LineSeparatorEscaper {
  /** Escape one chunk. May return fewer bytes than given if the chunk ends inside a sequence. */
  push(chunk: Buffer): Buffer;
  /** Release any held-back bytes (call once, when the stream ends). */
  flush(): Buffer;
}

export function createLineSeparatorEscaper(): LineSeparatorEscaper {
  let carry: Buffer = Buffer.alloc(0);

  const run = (input: Buffer, final: boolean): Buffer => {
    const buf = carry.length ? Buffer.concat([carry, input]) : input;
    carry = Buffer.alloc(0);

    // A chunk may end after E2, E2 80 or C2: keep those bytes for the next chunk.
    let hold = 0;
    if (!final) {
      const n = buf.length;
      if (n >= 1 && (buf[n - 1] === 0xe2 || buf[n - 1] === 0xc2)) hold = 1;
      else if (n >= 2 && buf[n - 2] === 0xe2 && buf[n - 1] === 0x80) hold = 2;
      if (hold) carry = Buffer.from(buf.subarray(n - hold));
    }

    const end = buf.length - hold;
    const parts: Buffer[] = [];
    let last = 0;
    for (let i = 0; i + 1 < end; i++) {
      if (buf[i] === 0xc2 && buf[i + 1] === 0x85) {
        parts.push(buf.subarray(last, i), ESCAPED_NEL);
        last = i + 2;
        i++;
      } else if (i + 2 < end && buf[i] === 0xe2 && buf[i + 1] === 0x80 && (buf[i + 2] === 0xa8 || buf[i + 2] === 0xa9)) {
        parts.push(buf.subarray(last, i), buf[i + 2] === 0xa8 ? ESCAPED_LS : ESCAPED_PS);
        last = i + 3;
        i += 2;
      }
    }
    if (parts.length === 0) return hold ? buf.subarray(0, end) : buf;
    parts.push(buf.subarray(last, end));
    return Buffer.concat(parts);
  };

  return {
    push: (chunk) => run(chunk, false),
    flush: () => run(Buffer.alloc(0), true)
  };
}

const EVENT_STREAM = /^text\/event-stream/i;

function toBuffer(chunk: unknown, encoding?: unknown): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  }
  if (Buffer.isBuffer(chunk)) return chunk;
  const view = chunk as Uint8Array;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * Express middleware: escapes Unicode line separators in `text/event-stream` responses only. JSON responses
 * keep their bytes (and their Content-Length) untouched.
 *
 * The MCP SDK sets the content type through `writeHead(status, headers)` rather than `setHeader()`,
 * so both are checked.
 */
export function escapeSseLineSeparators(_req: Request, res: Response, next: NextFunction): void {
  const escaper = createLineSeparatorEscaper();
  let sse = false;

  const isSse = (): boolean => {
    if (sse) return true;
    const contentType = res.getHeader('content-type');
    return typeof contentType === 'string' && EVENT_STREAM.test(contentType);
  };

  // The Node typings for write/end/writeHead are heavily overloaded; the wrappers below forward all
  // arguments unchanged except the body chunk, so they are typed loosely on purpose.
  const target = res as unknown as Record<string, (...args: unknown[]) => unknown>;
  const writeHead = target.writeHead.bind(res);
  const write = target.write.bind(res);
  const end = target.end.bind(res);

  target.writeHead = (status: unknown, ...rest: unknown[]) => {
    const headers = rest.find((arg) => arg !== null && typeof arg === 'object');
    if (Array.isArray(headers)) {
      const flat = headers.flat();
      for (let i = 0; i + 1 < flat.length; i += 2) {
        if (String(flat[i]).toLowerCase() === 'content-type' && EVENT_STREAM.test(String(flat[i + 1]))) sse = true;
      }
    } else if (headers) {
      for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
        if (name.toLowerCase() === 'content-type' && EVENT_STREAM.test(String(value))) sse = true;
      }
    }
    return writeHead(status, ...rest);
  };

  target.write = (chunk: unknown, encoding?: unknown, callback?: unknown) => {
    if (chunk === null || chunk === undefined || !isSse()) return write(chunk, encoding, callback);
    const cb = typeof encoding === 'function' ? encoding : callback;
    return write(escaper.push(toBuffer(chunk, encoding)), cb);
  };

  target.end = (chunk?: unknown, encoding?: unknown, callback?: unknown) => {
    if (!isSse()) return end(chunk, encoding, callback);
    const cb = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
    const body = typeof chunk === 'function' || chunk === null || chunk === undefined
      ? Buffer.alloc(0)
      : toBuffer(chunk, encoding);
    const out = Buffer.concat([escaper.push(body), escaper.flush()]);
    return out.length ? end(out, cb) : end(cb);
  };

  next();
}
