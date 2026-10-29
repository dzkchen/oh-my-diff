import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { calls, emit, hostOperations, invoke, runScenario, settings } from '@oh-my-diff/mod-api/testing';

const here = fileURLToPath(new URL('.', import.meta.url));

test('a tick sends the whole raster as packed half-block cells', () => {
  const trace = runScenario(here, settings('raster_wave', { width: 5, height: 3 }), hostOperations({
    'events.publish': [{ result: { delivered: 1, dropped: 0 } }],
    'events.schedule': [{ result: { key: 'tick', delay_ms: 100 } }, { result: { key: 'tick', delay_ms: 16 } }],
    'terminal.blit': [{ result: { frame: 1, queued: 1, frame_ms: 16 } }],
  }), { steps: [
    invoke('raster_wave', 'command', 'wave', 'start'),
    emit('channel', { publisher: 'raster_wave', channel: 'raster_wave/wake', data: null, correlation: null, sequence: 1, dropped: 0 }),
    emit('timer', { key: 'tick' }),
  ] });
  const [blit] = calls(trace, 'terminal.blit');
  assert.deepEqual(blit.arguments.rect, { x: 0, y: 0, width: 5, height: 3 });
  const bytes = Buffer.from(blit.arguments.packed, 'base64');
  assert.equal(bytes.length, 5 * 3 * 12);
  for (let at = 0; at < bytes.length; at += 12) {
    assert.equal(bytes.readUInt32LE(at), 0x2580);
    assert.equal(bytes.readUInt32LE(at + 4) >>> 24, 0);
    assert.equal(bytes.readUInt32LE(at + 8) >>> 24, 0);
  }
});
