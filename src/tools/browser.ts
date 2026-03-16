import { chromium, type Page } from 'playwright';
import { getSecret } from '../secrets/service.js';
import { logger } from '../logger.js';
import type { AgentId } from '../agents/types.js';

export interface BrowseOptions {
  url: string;
  screenshot?: boolean;
  loginRequired?: boolean;
  environment?: string;
  agentId?: AgentId;
}

export async function browse(options: BrowseOptions): Promise<{ content: string; screenshotPath?: string }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    logger.info({ url: options.url }, 'Browsing URL');

    if (options.loginRequired) {
      await handleLogin(page, options.url, options.environment ?? 'production', options.agentId);
    }

    await page.goto(options.url, { waitUntil: 'networkidle' });

    const content = await page.content();
    let screenshotPath: string | undefined;

    if (options.screenshot) {
      screenshotPath = `screenshots/${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    return { content, screenshotPath };
  } finally {
    await browser.close();
  }
}

async function handleLogin(page: Page, url: string, env: string, agentId?: AgentId): Promise<void> {
  // Generic login flow — retrieves credentials from the secrets service
  const email = await getSecret('APP_EMAIL', env, agentId);
  const password = await getSecret('APP_PASSWORD', env, agentId);

  if (!email || !password) {
    logger.warn({ env, agentId }, 'Missing credentials for app login');
    return;
  }

  // Navigate to the login page at the target origin
  await page.goto(`${new URL(url).origin}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle' });
  logger.info({ env, agentId }, 'Logged into app');
}
