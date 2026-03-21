import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redactSecrets, SecretRedactionProvider } from './secret-redaction.js';
import type { LLMProvider, GenerateTextOptions, GenerateWithToolsOptions } from '../interfaces/llm-provider.js';

// ---------------------------------------------------------------------------
// Structural mock secrets — these follow the exact format of real credentials
// but are well-known test/example values that are NOT real secrets.
// ---------------------------------------------------------------------------

/** AWS example key from AWS documentation */
const MOCK_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

/** GitHub classic PAT — synthetic 40-char token */
const MOCK_GITHUB_PAT = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234';

/** GitHub fine-grained PAT — synthetic */
const MOCK_GITHUB_FINE_GRAINED = 'github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Slack bot token — synthetic (assembled at runtime to avoid push protection) */
const MOCK_SLACK_TOKEN = ['xoxb', '1234567890', '1234567890123', 'ABCDEFghijklMNOPqrsTUV'].join('-');

/** JWT — three base64url segments (header.payload.signature), all synthetic */
const MOCK_JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
].join('.');

/** RSA private key — truncated/synthetic PEM block */
const MOCK_RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJLA4VoUZBFC+ZD1VoI0mEJz
examplekeynotrealatall0000000000000000000000000000000000000
-----END RSA PRIVATE KEY-----`;

/** Ed25519 / OPENSSH private key — synthetic PEM block */
const MOCK_OPENSSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
EXAMPLE_NOT_REAL_KEY_DATA_HERE_00000000000000000000000000000000000000
-----END OPENSSH PRIVATE KEY-----`;

const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// Unit tests for redactSecrets()
// ---------------------------------------------------------------------------

describe('redactSecrets', () => {
  it('redacts AWS access key IDs', () => {
    const input = `config: accessKeyId = ${MOCK_AWS_KEY}`;
    const { redacted, count } = redactSecrets(input);
    expect(redacted).not.toContain(MOCK_AWS_KEY);
    expect(redacted).toContain(REDACTED);
    expect(count).toBe(1);
  });

  it('redacts GitHub classic PATs (ghp_ and ghs_)', () => {
    const { redacted, count } = redactSecrets(`token: ${MOCK_GITHUB_PAT}`);
    expect(redacted).not.toContain(MOCK_GITHUB_PAT);
    expect(count).toBe(1);
  });

  it('redacts GitHub fine-grained PATs', () => {
    const { redacted, count } = redactSecrets(`auth: ${MOCK_GITHUB_FINE_GRAINED}`);
    expect(redacted).not.toContain(MOCK_GITHUB_FINE_GRAINED);
    expect(count).toBe(1);
  });

  it('redacts Slack tokens', () => {
    const { redacted, count } = redactSecrets(`SLACK_TOKEN=${MOCK_SLACK_TOKEN}`);
    expect(redacted).not.toContain(MOCK_SLACK_TOKEN);
    expect(count).toBe(1);
  });

  it('redacts JWTs', () => {
    const { redacted, count } = redactSecrets(`Authorization: Bearer ${MOCK_JWT}`);
    expect(redacted).not.toContain(MOCK_JWT);
    expect(count).toBe(1);
  });

  it('redacts RSA private keys', () => {
    const { redacted, count } = redactSecrets(`Here is a key:\n${MOCK_RSA_KEY}\nEnd.`);
    expect(redacted).not.toContain('MIIBogIBAAJ');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('redacts OPENSSH private keys', () => {
    const { redacted, count } = redactSecrets(MOCK_OPENSSH_KEY);
    expect(redacted).not.toContain('b3BlbnNzaC1rZXktdjE');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('redacts multiple secrets in a single string', () => {
    const input = `aws=${MOCK_AWS_KEY} github=${MOCK_GITHUB_PAT} slack=${MOCK_SLACK_TOKEN}`;
    const { redacted, count } = redactSecrets(input);
    expect(count).toBe(3);
    expect(redacted).not.toContain(MOCK_AWS_KEY);
    expect(redacted).not.toContain(MOCK_GITHUB_PAT);
    expect(redacted).not.toContain(MOCK_SLACK_TOKEN);
  });

  it('returns zero count and unchanged text when no secrets are present', () => {
    const clean = 'const x = 42; function hello() { return "world"; }';
    const { redacted, count } = redactSecrets(clean);
    expect(redacted).toBe(clean);
    expect(count).toBe(0);
  });

  // --- QA regression: false-positive checks ---

  it('does not redact normal code identifiers', () => {
    const code = 'const AKIAFOO = "test"; let token = getToken();';
    const { redacted, count } = redactSecrets(code);
    expect(count).toBe(0);
    expect(redacted).toBe(code);
  });

  it('does not redact short base64 strings that are not JWTs', () => {
    const text = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    const { redacted, count } = redactSecrets(text);
    expect(count).toBe(0);
    expect(redacted).toBe(text);
  });

  it('does not redact normal dotted identifiers', () => {
    const text = 'config.database.host = "localhost"';
    const { redacted, count } = redactSecrets(text);
    expect(count).toBe(0);
    expect(redacted).toBe(text);
  });

  it('does not redact short hyphenated strings mistaken for Slack tokens', () => {
    const text = 'npm install cross-env --save-dev';
    const { redacted, count } = redactSecrets(text);
    expect(count).toBe(0);
    expect(redacted).toBe(text);
  });

  it('does not redact PEM certificate blocks (only private keys)', () => {
    const cert = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJALRiMLAHudeSMA0GCSqGSIb3DQEBCwUA
-----END CERTIFICATE-----`;
    const { redacted, count } = redactSecrets(cert);
    expect(count).toBe(0);
    expect(redacted).toBe(cert);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for SecretRedactionProvider (decorator)
// ---------------------------------------------------------------------------

describe('SecretRedactionProvider', () => {
  let mockInner: LLMProvider;
  let provider: SecretRedactionProvider;

  beforeEach(() => {
    mockInner = {
      generateText: vi.fn().mockResolvedValue('response text'),
      generateWithTools: vi.fn().mockResolvedValue({
        text: 'tool response',
        functionCalls: [],
        raw: {},
      }),
      embedText: vi.fn().mockResolvedValue([0.1, 0.2]),
    };
    provider = new SecretRedactionProvider(mockInner);
  });

  it('redacts secrets from generateText contents before forwarding', async () => {
    const options: GenerateTextOptions = {
      model: 'AGENT',
      systemInstruction: `API key: ${MOCK_AWS_KEY}`,
      contents: [
        { role: 'user', parts: [{ text: `Here is my token: ${MOCK_GITHUB_PAT}` }] },
      ],
    };

    await provider.generateText(options);

    const call = (mockInner.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0] as GenerateTextOptions;
    expect(call.systemInstruction).not.toContain(MOCK_AWS_KEY);
    expect(call.systemInstruction).toContain(REDACTED);
    expect(call.contents[0].parts[0].text).not.toContain(MOCK_GITHUB_PAT);
    expect(call.contents[0].parts[0].text).toContain(REDACTED);
  });

  it('redacts secrets from generateWithTools contents before forwarding', async () => {
    const options: GenerateWithToolsOptions = {
      model: 'AGENT',
      contents: [
        { role: 'user', parts: [{ text: `Slack: ${MOCK_SLACK_TOKEN}` }] },
      ],
      tools: [{ name: 'search', description: 'search files' }],
    };

    await provider.generateWithTools(options);

    const call = (mockInner.generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as GenerateWithToolsOptions;
    expect(call.contents[0].parts[0].text).not.toContain(MOCK_SLACK_TOKEN);
    // Tools should pass through unchanged
    expect(call.tools).toEqual(options.tools);
  });

  it('redacts secrets from functionResponse payloads', async () => {
    const options: GenerateTextOptions = {
      model: 'AGENT',
      contents: [
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'readFile',
              response: { result: `file content with ${MOCK_JWT}` },
            },
          }],
        },
      ],
    };

    await provider.generateText(options);

    const call = (mockInner.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0] as GenerateTextOptions;
    const responseStr = JSON.stringify(call.contents[0].parts[0].functionResponse?.response);
    expect(responseStr).not.toContain(MOCK_JWT);
  });

  it('redacts secrets from embedText input', async () => {
    await provider.embedText(`embed this: ${MOCK_AWS_KEY}`);

    const passedText = (mockInner.embedText as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(passedText).not.toContain(MOCK_AWS_KEY);
    expect(passedText).toContain(REDACTED);
  });

  it('passes clean content through without modification', async () => {
    const options: GenerateTextOptions = {
      model: 'AGENT',
      systemInstruction: 'You are a helpful assistant.',
      contents: [
        { role: 'user', parts: [{ text: 'Explain how maps work in Go.' }] },
      ],
    };

    await provider.generateText(options);

    const call = (mockInner.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0] as GenerateTextOptions;
    expect(call.systemInstruction).toBe('You are a helpful assistant.');
    expect(call.contents[0].parts[0].text).toBe('Explain how maps work in Go.');
  });

  it('does not mutate the original options object', async () => {
    const originalText = `secret: ${MOCK_AWS_KEY}`;
    const options: GenerateTextOptions = {
      model: 'AGENT',
      contents: [{ role: 'user', parts: [{ text: originalText }] }],
    };

    await provider.generateText(options);

    // Original should be untouched
    expect(options.contents[0].parts[0].text).toBe(originalText);
  });
});
