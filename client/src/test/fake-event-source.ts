// jsdom ships no EventSource. A controllable fake is the only way to pin the
// sole-writer rule, the fallback loop, and the stream-recreation count
// deterministically — a polyfill would just move the nondeterminism.
//
// It models `addEventListener("status", …)` on purpose: the server NAMES its
// event `status`, so a client that only wires `onmessage` receives nothing.
// A fake that ignored named events would let that bug ship green.
import { vi } from "vitest";

export class FakeEventSource {
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
  }

  // ── Test controls ───────────────────────────────────────────────────────

  open() {
    this.onopen?.();
  }

  /** Emit a named `status` frame, exactly as the server sends it. */
  emit(data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const listener of this.listeners.get("status") ?? []) {
      listener({ data: payload } as MessageEvent<string>);
    }
  }

  fail() {
    this.onerror?.();
  }
}

export function installFakeEventSource() {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  return FakeEventSource;
}
