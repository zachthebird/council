import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Give each test an isolated state dir + fresh RunStore. */
export function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'moh-test-'));
  process.env.MOH_STATE_DIR = join(dir, 'state');
  process.env.MOH_CONFIG_DIR = join(dir, 'config');
  return dir;
}

export function demoSeats({ failA = false } = {}) {
  return [
    { seatId: 'seat-a', label: 'Seat A', adapterId: 'fake', requestedModel: 'alpha-mini', adapterConfig: { reportedModel: 'alpha-mini-2026', sessionPrefix: 'a', ...(failA ? { forceFail: true, forceFailRole: 'generate' } : {}) } },
    { seatId: 'seat-b', label: 'Seat B', adapterId: 'fake', requestedModel: null, adapterConfig: { reportedModel: null, sessionPrefix: 'b' } },
  ];
}
