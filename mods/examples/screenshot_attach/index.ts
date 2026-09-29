import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('attach_screenshot', () => {
    const run = api.host.call('exec.run', { program: 'base64', argv: ['-i', 'screenshot.png'], max_output_bytes: 8_000_000 });
    const image = api.host.call('evidence.write', { media_type: 'image/png', base64: run.stdout.replace(/\s+/g, ''), label: 'screenshot' });
    api.host.call('composer.write', { attach: [{ image }] });
    return { display: 'Screenshot attached to the composer' };
  });
}
