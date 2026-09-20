/** Keep credentials out of user-visible diagnostics and code previews. */
export function redact(text: string) {
  return text
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{16,})\b/g, '[REDACTED]')
    .replace(/(Bearer|Basic)\s+[a-zA-Z0-9_+/=.-]{10,}/gi, '$1 [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/https:\/\/opencode\.ai\/workspace\/[^\s"\\]+/g, 'https://opencode.ai');
}
