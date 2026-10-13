import type { ModAPI } from '@oh-my-diff/mod-api';

const secrets = [/\bsk-[A-Za-z0-9_-]{16,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g];

export default function activate(api: ModAPI) {
  api.intercept('history_persist', (batch, next) => next({ ...batch,
    entries: batch.entries.map(entry => ({ ...entry,
      text: secrets.reduce((text, pattern) => text.replace(pattern, (match, prefix) => `${typeof prefix === 'string' ? prefix : ''}[redacted]`), entry.text) })) }));
}
