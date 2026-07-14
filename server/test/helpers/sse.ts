// Raw node:http SSE reader for streaming endpoint tests — supertest buffers
// the whole body until the response ends, so it can never observe an open
// event stream. openSse() starts the Express app on an ephemeral port
// (listen(0)), issues a raw request, and accumulates frames split on the
// SSE "\n\n" delimiter. Always close streams in afterEach via closeAllSse().
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface SseStream {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  /** Complete frames received so far (each still ending in "\n\n"). */
  frames(): string[];
  /** Resolves once at least `count` frames have arrived. */
  waitForFrames(count: number, timeoutMs?: number): Promise<string[]>;
  /** Resolves when the server ends the stream. */
  closed(): Promise<void>;
  close(): Promise<void>;
}

const openStreams: SseStream[] = [];

export async function openSse(app: Express, path = "/api/sale/events"): Promise<SseStream> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;

  const req = http.request({
    host: "127.0.0.1",
    port,
    path,
    method: "GET",
    headers: { accept: "text/event-stream" },
  });
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    req.on("response", resolve);
    req.on("error", reject);
    req.end();
  });

  const frames: string[] = [];
  let buffer = "";
  let ended = false;
  const frameWaiters: Array<() => void> = [];
  const endWaiters: Array<() => void> = [];

  const notifyFrames = (): void => {
    for (const waiter of frameWaiters.splice(0)) {
      waiter();
    }
  };
  const markEnded = (): void => {
    if (ended) {
      return;
    }
    ended = true;
    for (const waiter of endWaiters.splice(0)) {
      waiter();
    }
    notifyFrames();
  };

  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n\n");
    buffer = parts.pop() as string;
    for (const part of parts) {
      frames.push(`${part}\n\n`);
    }
    if (parts.length > 0) {
      notifyFrames();
    }
  });
  res.on("end", markEnded);
  res.on("close", markEnded);
  req.on("error", markEnded);

  const stream: SseStream = {
    statusCode: res.statusCode ?? 0,
    headers: res.headers,
    frames: () => [...frames],
    waitForFrames: async (count, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (frames.length < count) {
        if (ended) {
          throw new Error(`stream ended after ${frames.length}/${count} frames`);
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} frames (got ${frames.length})`);
        }
        await new Promise<void>((resolve) => {
          frameWaiters.push(resolve);
          setTimeout(resolve, 25);
        });
      }
      return [...frames];
    },
    closed: () =>
      ended
        ? Promise.resolve()
        : new Promise((resolve) => {
            endWaiters.push(resolve);
          }),
    close: async () => {
      req.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      markEnded();
    },
  };
  openStreams.push(stream);
  return stream;
}

/** afterEach hook — tears down every stream + ephemeral server opened. */
export async function closeAllSse(): Promise<void> {
  await Promise.all(openStreams.splice(0).map((stream) => stream.close()));
}

/** Parse the JSON payload of a `data:` line out of one SSE frame. */
export function frameData(frame: string): unknown {
  const line = frame.split("\n").find((l) => l.startsWith("data: "));
  if (line === undefined) {
    throw new Error(`frame has no data line: ${JSON.stringify(frame)}`);
  }
  return JSON.parse(line.slice("data: ".length));
}
