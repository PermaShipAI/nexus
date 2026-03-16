#!/usr/bin/env node

/**
 * CLI entry point — run via `npx nexus-command` or `node bin/cli.ts`.
 * Handles first-run setup (interactive LLM provider/key prompts),
 * then starts the local UI server.
 */

import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const ENV_PATH = join(process.cwd(), '.env');

const PROVIDERS = [
  { value: 'gemini', label: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey' },
  { value: 'anthropic', label: 'Anthropic Claude', keyUrl: 'https://console.anthropic.com/' },
  { value: 'openai', label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys' },
  { value: 'ollama', label: 'Ollama (local, no API key)', keyUrl: '' },
  { value: 'openrouter', label: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys' },
];

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function hasEnvKey(key: string): boolean {
  if (process.env[key]) return true;
  if (!existsSync(ENV_PATH)) return false;
  const content = readFileSync(ENV_PATH, 'utf-8');
  const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return !!(match && match[1].trim());
}

function writeEnvVar(key: string, value: string): void {
  let content = '';
  if (existsSync(ENV_PATH)) {
    content = readFileSync(ENV_PATH, 'utf-8');
  }
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `${content.endsWith('\n') || content === '' ? '' : '\n'}${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, content);
}

async function interactiveSetup(): Promise<void> {
  const needsSetup = !hasEnvKey('LLM_API_KEY') && !hasEnvKey('GEMINI_API_KEY');

  if (!needsSetup) return; // Already configured

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  Welcome to Nexus Command!\n');
  console.log('  Let\'s set up your Nexus Command LLM provider.\n');

  // Show provider options
  console.log('  Nexus Command LLM Providers:');
  PROVIDERS.forEach((p, i) => {
    console.log(`    ${i + 1}) ${p.label}`);
  });

  let providerIndex = -1;
  while (providerIndex < 0 || providerIndex >= PROVIDERS.length) {
    const answer = await ask(rl, `\n  Choose a provider (1-${PROVIDERS.length}): `);
    providerIndex = parseInt(answer, 10) - 1;
  }

  const provider = PROVIDERS[providerIndex];
  writeEnvVar('LLM_PROVIDER', provider.value);

  if (provider.value !== 'ollama') {
    if (provider.keyUrl) {
      console.log(`\n  Get your API key at: ${provider.keyUrl}`);
    }
    const apiKey = await ask(rl, '  Paste your API key: ');
    if (apiKey.trim()) {
      if (provider.value === 'gemini') {
        writeEnvVar('GEMINI_API_KEY', apiKey.trim());
      } else {
        writeEnvVar('LLM_API_KEY', apiKey.trim());
      }
    }
  }

  rl.close();
  console.log('\n  Configuration saved to .env\n');
}

async function main(): Promise<void> {
  // Check Node version
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    console.error(`Error: Node.js 20+ is required (you have ${process.versions.node}).`);
    process.exit(1);
  }

  // Run interactive setup if needed
  await interactiveSetup();

  // Load the .env we just wrote (or the existing one)
  // Then dynamically import and start the local server
  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  }

  // Start the local UI server
  await import('../src/local/index.js');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
