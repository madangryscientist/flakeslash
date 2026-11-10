/**
 * Removes secrets from log text before the text is stored or sent to a model.
 *
 * The rules are applied in order, each over the whole text. They catch known token shapes, credentials
 * in a URL, a value whose name looks secret and long strings that mix upper case, lower case and
 * digits. Plain hex is left alone, and so is a run that sits inside a path, so commit SHAs, memory
 * addresses, file paths and stack traces come through unchanged.
 */

/** What replaces a secret. */
const MARKER = "[redacted]";

/** Rule 9's neighbours: a run next to one of these is part of a path, a version or a word. */
const SEGMENT_EDGE = "\\w/.\\-";

/** Characters a long mixed string can be made of. */
const RUN = "A-Za-z0-9_+=";

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // 1. GitHub token: ghp_, gho_, ghu_, ghs_, ghr_.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MARKER],

  // 2. GitHub fine-grained token.
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MARKER],

  // 3. OpenAI-style key.
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MARKER],

  // 4. AWS access key id.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MARKER],

  // 5. JWT: three base64url segments, the first starting with `eyJ`.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, MARKER],

  // 6. An auth scheme then a value: the word and the space stay, the value goes.
  [/\b(bearer|token|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${MARKER}`],

  // 7. Credentials in a URL: `scheme://user:password@host` becomes `scheme://[redacted]@host`.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MARKER}@`],

  // 8. `NAME=value` or `NAME: value` where NAME looks secret. The name, separator and quotes stay.
  //    The value is at least six characters, so `persist-credentials: false` is left alone.
  [
    new RegExp(
      `\\b([A-Za-z0-9_]*(?:token|secret|password|passwd|pwd|api_key|api-key|apikey|access_key|access-key|accesskey|private_key|private-key|privatekey|credential|auth)[A-Za-z0-9_]*)(\\s*[=:]\\s*)(["']?)[^\\s"']{6,}\\3`,
      "gi",
    ),
    `$1$2$3${MARKER}$3`,
  ],

  // 9. A long string mixing upper case, lower case and digits, that is not part of a path segment.
  [
    new RegExp(
      `(?<![${SEGMENT_EDGE}])(?=[${RUN}]*[A-Z])(?=[${RUN}]*[a-z])(?=[${RUN}]*[0-9])[${RUN}]{24,}(?![${RUN}${SEGMENT_EDGE}])`,
      "g",
    ),
    MARKER,
  ],
];

/** Returns `text` with each secret replaced by `[redacted]`. Text with nothing to redact comes back identical. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
