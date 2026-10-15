// Structured, single-line JSON logs with every known secret value scrubbed before the line leaves the Worker.

import type { JsonValue } from './json.ts';

export type LogEvent = { readonly [key: string]: JsonValue | undefined };

export interface Logger {
  log(event: LogEvent): void;
  /** Remember a secret value so it can never appear in a line, raw or JSON-escaped. */
  register(secret: string): void;
}

/** Values shorter than this are not credentials and would blank ordinary words. */
export const MIN_REDACTED_LENGTH = 8;
export const MAX_REGISTERED_SECRETS = 64;
export const REDACTED = '[redacted]';

export function createLogger(sink: (line: string) => void): Logger {
  const secrets: string[] = [];
  const scrub = (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      out = out.split(secret).join(REDACTED);
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) out = out.split(escaped).join(REDACTED);
    }
    return out;
  };
  return {
    register(secret) {
      if (secret.length < MIN_REDACTED_LENGTH || secrets.includes(secret)) return;
      secrets.push(secret);
      if (secrets.length > MAX_REGISTERED_SECRETS) secrets.shift();
    },
    log(event) {
      sink(scrub(JSON.stringify({ service: 'promoter', ...event })));
    },
  };
}
