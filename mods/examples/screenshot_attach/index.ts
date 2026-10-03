import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  // Slash commands can't write evidence, so the command hops to this mod's own native channel handler.
  api.command('attach_screenshot', () => {
    const asked = api.host.tryCall('events.publish', { channel: 'attach', data: null });
    return { display: asked.ok ? 'Attaching screenshot.png to the composer' : 'Attaching is unavailable here' };
  });
  api.on('channel', ({ channel }) => {
    if (channel !== 'screenshot_attach/attach') return;
    const run = api.host.call('exec.run', { program: 'base64', argv: ['-i', 'screenshot.png'], max_output_bytes: 8_000_000 });
    const image = api.host.call('evidence.write', { media_type: 'image/png', base64: run.stdout.replace(/\s+/g, ''), label: 'screenshot' });
    api.host.call('composer.write', { attach: [{ image }] });
  });
}
