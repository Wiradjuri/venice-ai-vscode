interface SecretPattern {
  name: string;
  regex: RegExp;
}

// Patterns are intentionally conservative (favor false positives over missed secrets) since
// the cost of over-redacting a prompt is far lower than the cost of leaking a credential.
const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'PEM private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    name: 'Generic secret assignment',
    // key/token/secret/password near a quoted value of plausible entropy, e.g. api_key = "...".
    regex: /\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+.=]{12,}['"]/gi,
  },
  { name: 'Bearer token', regex: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g },
];

/** Redacts recognizable secret patterns before text leaves the machine. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
  }
  return result;
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => new RegExp(pattern.regex.source, pattern.regex.flags).test(text));
}
