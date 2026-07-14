// jsdom ships no EventSource. A controllable fake is the only way to pin the
// sole-writer rule, the fallback loop, and the stream-recreation count
// deterministically — a polyfill would just move the nondeterminism.
//
// It models `addEventListener("status", …)` on purpose: the server NAMES its
// event `status`, so a client that only wires `onmessage` receives nothing.
// A fake that ignored named events would let that bug ship green.
import { vi } from "vitest";

export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static instances: FakeEventSource[] = [];

  static reset() {
    FakeEventSource.instances = [];
  }

  /** The stream the hook is currently holding. */
  static get current(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (last === undefined) {
      throw new Error("no EventSource was constructed");
    }
    return last;
  }

  readonly url: string;
  closed = false;
  /** Mirrors the real EventSource lifecycle: CONNECTING → OPEN → CLOSED. */
  readyState: number = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  // ── Test controls ───────────────────────────────────────────────────────

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  /** Emit a named `status` frame, exactly as the server sends it. */
  emit(data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const listener of this.listeners.get("status") ?? []) {
      listener({ data: payload } as MessageEvent<string>);
    }
  }

  /** Fire a named `heartbeat` event — the server's 25 s keep-alive, now an
   *  observable event so the client watchdog can see a quiet live stream. */
  heartbeat() {
    for (const listener of this.listeners.get("heartbeat") ?? []) {
      listener({ data: "{}" } as MessageEvent<string>);
    }
  }

  /** Fire `error`. A real EventSource sets `readyState` before the handler
   *  runs: CLOSED for a fatal error (a non-2xx handshake, e.g. a 503), or
   *  CONNECTING for a recoverable mid-stream drop it is already retrying.
   *  Defaults to fatal, the 503 case the fallback loop was built for. */
  fail(readyState: number = FakeEventSource.CLOSED) {
    this.readyState = readyState;
    if (readyState === FakeEventSource.CLOSED) {
      this.closed = true;
    }
    this.onerror?.();
  }
}

export function installFakeEventSource() {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  return FakeEventSource;
}
