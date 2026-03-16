import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { logger } from '../logger.js';
import { localBus } from './communication-adapter.js';
import { LocalProjectRegistry } from './project-registry.js';

const execFileAsync = promisify(execFile);

/**
 * Clone a remote git repo to a local directory.
 * Updates the project's clone_status in the DB as it progresses.
 * Broadcasts WebSocket events for real-time UI updates.
 */
export async function cloneRepo(
  projectId: string,
  remoteUrl: string,
  targetPath: string,
  registry: LocalProjectRegistry,
): Promise<void> {
  logger.info({ projectId, remoteUrl, targetPath }, 'Starting git clone');

  try {
    // Ensure parent directory exists
    await mkdir(targetPath, { recursive: true });

    await execFileAsync('git', ['clone', remoteUrl, targetPath], {
      timeout: 5 * 60 * 1000, // 5 min timeout
    });

    await registry.updateCloneStatus(projectId, 'ready');
    logger.info({ projectId }, 'Git clone completed');

    localBus.emit('message', {
      id: `clone-done-${projectId}`,
      content: `**[System]** Repository cloned successfully.`,
      channel_id: 'local:general',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const errorMsg = (err as Error).message;
    await registry.updateCloneStatus(projectId, 'error', errorMsg);
    logger.error({ err, projectId, remoteUrl }, 'Git clone failed');

    localBus.emit('message', {
      id: `clone-error-${projectId}`,
      content: `**[System]** Failed to clone repository: ${errorMsg}`,
      channel_id: 'local:general',
      timestamp: new Date().toISOString(),
    });
  }
}
