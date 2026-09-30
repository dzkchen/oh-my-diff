import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.builtins({ commands: { hide: ['plan'] }, modes: { disable: ['plan'] } });
}
