import type { ModAPI } from '../../api.d.ts';

export default function activate(api: ModAPI) {
  api.builtins({ commands: { hide: ['plan'] }, modes: { disable: ['plan'] } });
}
