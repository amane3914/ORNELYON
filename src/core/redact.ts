/**
 * Removes secrets from text before it reaches logs, history or the GUI.
 * Pattern-based plus explicit values (for example the contents of an API key env var).
 */

const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /("?(?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)[^\s",}]{6,}/gi,
];

export function redact(text: string, knownSecrets: string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 6) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  for (const pattern of PATTERNS) {
    // The key=value pattern captures its prefix (group 1) so the key name stays readable.
    out = out.replace(pattern, (...args: unknown[]) => {
      const prefix = typeof args[1] === 'string' ? args[1] : '';
      return `${prefix}[REDACTED]`;
    });
  }
  return out;
}

/** Secret values currently present in the environment, for use with `redact`. */
export function envSecrets(names: string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length >= 6) {
      values.push(value);
    }
  }
  return values;
}
