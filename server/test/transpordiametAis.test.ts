import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sockets: [] as Array<{
    open(): void;
    message(data: unknown): void;
    terminate: ReturnType<typeof vi.fn>;
  }>,
  upsertPosition: vi.fn(),
  upsertMeta: vi.fn(),
}));

vi.mock('ws', () => {
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    #handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(_url: string) { mocks.sockets.push(this); }
    on(name: string, handler: (...args: unknown[]) => void) {
      this.#handlers.set(name, [...(this.#handlers.get(name) ?? []), handler]);
    }
    send(_data: string) {}
    open() { this.readyState = 1; this.#emit('open'); }
    message(data: unknown) { this.#emit('message', Buffer.from(JSON.stringify(data))); }
    close() { this.readyState = 3; this.#emit('close'); }
    terminate = vi.fn(() => this.close());
    #emit(name: string, ...args: unknown[]) {
      for (const handler of this.#handlers.get(name) ?? []) handler(...args);
    }
  }
  return { default: FakeWebSocket };
});
vi.mock('../src/config.js', () => ({ config: { aisBbox: [53, 9, 66, 31.5] } }));
vi.mock('../src/ais/registry.js', () => ({
  vessels: { upsertPosition: mocks.upsertPosition, upsertMeta: mocks.upsertMeta },
}));

import { TranspordiametAis } from '../src/ais/transpordiamet.js';

describe('Transpordiameti AIS-i vaikiva voo taastamine', () => {
  afterEach(() => {
    vi.useRealTimers();
    mocks.sockets.length = 0;
    mocks.upsertPosition.mockReset();
    mocks.upsertMeta.mockReset();
  });

  it('avab uue ühenduse, kui avatud voost ei tule viis minutit laevapunkte', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const stream = new TranspordiametAis();
    stream.start(log);
    const first = mocks.sockets[0]!;
    first.open();
    vi.advanceTimersByTime(6 * 60_000);
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('voog vaikis'));
    vi.advanceTimersByTime(2_000);
    expect(mocks.sockets).toHaveLength(2);
    stream.stop();
  });

  it('päris laevapunkt lükkab vaikuse piiri edasi', () => {
    vi.useFakeTimers();
    const stream = new TranspordiametAis();
    stream.start();
    const socket = mocks.sockets[0]!;
    socket.open();
    vi.advanceTimersByTime(4 * 60_000);
    socket.message({ geometry: { x: 24.7, y: 59.4 }, attributes: { mmsi: 123456789 } });
    expect(mocks.upsertPosition).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(4 * 60_000);
    expect(socket.terminate).not.toHaveBeenCalled();
    stream.stop();
  });
});
