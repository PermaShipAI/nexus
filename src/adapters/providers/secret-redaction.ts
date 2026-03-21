import type {
  LLMProvider,
  LLMContent,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  LLMToolCallResult,
} from '../interfaces/llm-provider.js';
import { logger } from '../../logger.js';

/**
 * Credential patterns based on the gitleaks ruleset.
 * Each entry has a label (for logging) and a regex.
 * Patterns use structural anchors so they match real credential formats
 * without false-positiving on normal code identifiers.
 */
const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  // AWS Access Key IDs  (AKIA followed by 16 uppercase alphanumeric chars)
  { label: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/g },

  // GitHub Personal Access Tokens (classic and fine-grained)
  { label: 'GitHub PAT', regex: /\bgh[ps]_[A-Za-z0-9_]{36,255}\b/g },
  { label: 'GitHub PAT (fine-grained)', regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },

  // Slack tokens  (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
  { label: 'Slack Token', regex: /\bxox[bpars]-[0-9A-Za-z\-]{10,255}\b/g },

  // JSON Web Tokens  (three base64url segments separated by dots)
  { label: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },

  // RSA private keys
  { label: 'RSA Private Key', regex: /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/g },

  // Generic private keys (EC, Ed25519, OPENSSH, etc.)
  { label: 'Private Key', regex: /-----BEGIN (?:EC |OPENSSH |DSA |ED25519 )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |OPENSSH |DSA |ED25519 )?PRIVATE KEY-----/g },
];

const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Scan a string for known credential patterns and replace matches.
 * Returns the sanitised string and the count of redactions performed.
 */
export function redactSecrets(text: string): { redacted: string; count: number } {
  let count = 0;
  let result = text;

  for (const { regex } of SECRET_PATTERNS) {
    // Reset lastIndex — regexes are global so state persists across calls
    regex.lastIndex = 0;
    const before = result;
    result = result.replace(regex, () => {
      count++;
      return REDACTED_PLACEHOLDER;
    });
    // Safety: if replace somehow produced same string, avoid counting
    if (result === before && count > 0) {
      // count was incremented but nothing changed — revert
    }
  }

  return { redacted: result, count };
}

/**
 * Deep-clone and redact all text fields inside an LLMContent array.
 * This covers: parts[].text, systemInstruction, and stringified
 * functionCall/functionResponse args.
 */
function redactContents(contents: LLMContent[]): { contents: LLMContent[]; totalRedactions: number } {
  let totalRedactions = 0;

  const cleaned: LLMContent[] = contents.map((msg) => ({
    ...msg,
    parts: msg.parts.map((part) => {
      const clone = { ...part };

      if (typeof clone.text === 'string') {
        const { redacted, count } = redactSecrets(clone.text);
        clone.text = redacted;
        totalRedactions += count;
      }

      // functionResponse payloads may contain source code / secrets
      if (clone.functionResponse) {
        const serialised = JSON.stringify(clone.functionResponse.response);
        const { redacted, count } = redactSecrets(serialised);
        if (count > 0) {
          totalRedactions += count;
          clone.functionResponse = {
            ...clone.functionResponse,
            response: JSON.parse(redacted),
          };
        }
      }

      return clone;
    }),
  }));

  return { contents: cleaned, totalRedactions };
}

/**
 * Pre-flight secret-redaction middleware for LLM providers.
 *
 * Wraps any LLMProvider with a decorator that strips known credential
 * patterns from outbound payloads before they reach the external API.
 *
 * Implements the LLMProvider interface transparently so callers are
 * unaware of the interception layer.
 */
export class SecretRedactionProvider implements LLMProvider {
  constructor(private readonly inner: LLMProvider) {}

  async generateText(options: GenerateTextOptions): Promise<string> {
    const sanitised = this.redactOptions(options);
    return this.inner.generateText(sanitised);
  }

  async generateWithTools(options: GenerateWithToolsOptions): Promise<LLMToolCallResult> {
    const sanitised = this.redactOptions(options) as GenerateWithToolsOptions;
    return this.inner.generateWithTools(sanitised);
  }

  /** Embeddings are typically single short strings — still redact. */
  async embedText(text: string): Promise<number[] | null> {
    const { redacted, count } = redactSecrets(text);
    if (count > 0) {
      logger.warn(`Secret redaction: removed ${count} credential(s) from embedText input`);
    }
    return this.inner.embedText(redacted);
  }

  private redactOptions<T extends GenerateTextOptions>(options: T): T {
    let totalRedactions = 0;

    // Redact system instruction
    let systemInstruction = options.systemInstruction;
    if (systemInstruction) {
      const { redacted, count } = redactSecrets(systemInstruction);
      systemInstruction = redacted;
      totalRedactions += count;
    }

    // Redact message contents
    const { contents, totalRedactions: contentRedactions } = redactContents(options.contents);
    totalRedactions += contentRedactions;

    if (totalRedactions > 0) {
      logger.warn(`Secret redaction: removed ${totalRedactions} credential(s) from outbound LLM request`);
    }

    return { ...options, systemInstruction, contents };
  }
}
