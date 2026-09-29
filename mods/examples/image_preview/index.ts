import type { ModAPI, ResourceRef } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('preview_image', path => {
    const image = api.host.call('terminal.import_file', { path: String(path) });
    if ('status' in image) return { display: 'Import declined' };
    api.state.set(image);
    return { display: `Showing ${String(path)}` };
  });
  api.command('open_docs', url => {
    const opened = api.host.call('terminal.open', { url: String(url) });
    return { display: 'opened' in opened ? 'Opened in the browser' : 'Open declined' };
  });
  api.on('terminal', () => {
    const image = api.state.get() as ResourceRef | null;
    if (!image) return null;
    return { sites: { 'image_preview/preview': { components: [
      { type: 'image', id: 'preview-image', label: 'Preview', image, alt: 'imported image', height: 12 },
    ] } } };
  });
}
