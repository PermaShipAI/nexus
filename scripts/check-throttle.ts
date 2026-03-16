import { computeThrottleLevel, countPendingSuggestions } from '../src/idle/throttle.js';
import { getBackoffStep, getIdleInvocations24h, BACKOFF_DELAYS_MS } from '../src/idle/backoff.js';
import { getLastHumanActivityTimestamp, getLastIdleTimestamp } from '../src/idle/activity.js';
import { config } from '../src/config.js';

async function main() {
  const orgId = config.PERMASHIP_ORG_ID;

  const [metrics, pending, backoff, idle24h, lastHuman, lastIdle] = await Promise.all([
    computeThrottleLevel(orgId),
    countPendingSuggestions(orgId),
    getBackoffStep(orgId),
    getIdleInvocations24h(orgId),
    getLastHumanActivityTimestamp(orgId),
    getLastIdleTimestamp(orgId),
  ]);

  console.log('=== THROTTLE STATE ===');
  console.log('Level:', metrics.level);
  console.log('Pending suggestions:', pending);
  console.log('Created (7d):', metrics.created);
  console.log('Resolved (7d):', metrics.resolved);
  console.log('Velocity:', metrics.velocity);
  console.log('Backlog level:', metrics.backlogLevel);
  console.log('Velocity level:', metrics.velocityLevel);
  console.log('Reason:', metrics.reason);
  console.log('');
  console.log('=== BACKOFF STATE ===');
  console.log('Backoff step:', backoff, '/', BACKOFF_DELAYS_MS.length - 1);
  console.log('Current delay:', BACKOFF_DELAYS_MS[backoff] / 1000 / 60, 'minutes');
  console.log('Idle invocations (24h):', idle24h, '/ 5 cap');
  console.log('');
  console.log('=== ACTIVITY ===');
  console.log('Last human activity:', lastHuman?.toISOString() ?? 'never');
  console.log('Last idle trigger:', lastIdle?.toISOString() ?? 'never');
  const humanAgo = lastHuman ? (Date.now() - lastHuman.getTime()) / 1000 / 60 : Infinity;
  const idleAgo = lastIdle ? (Date.now() - lastIdle.getTime()) / 1000 / 60 : Infinity;
  console.log('Human activity ago:', humanAgo.toFixed(0), 'minutes');
  console.log('Idle trigger ago:', idleAgo.toFixed(0), 'minutes');

  process.exit(0);
}

main();
