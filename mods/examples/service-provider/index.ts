import type { ModAPI, ServiceContract } from '../../api.d.ts';

const contract: ServiceContract = {
  name: 'example.formatter',
  version: '1.0.0',
  methods: { format: { input: 'string', output: 'string' } },
};

export default function activate(api: ModAPI) {
  api.provide(contract, { format: input => String(input).trim() });
}
