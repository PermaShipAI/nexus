import { describe, it, expect } from 'vitest';
import { checkDestructiveAction } from './DestructiveActionGuard.js';

const DASHBOARD_URL = 'https://app.permaship.io/dashboard';
const EXPECTED_MESSAGE = `For security reasons, destructive actions must be performed via the Dashboard: ${DASHBOARD_URL}`;

describe('checkDestructiveAction', () => {
  describe('blocked cases', () => {
    it('blocks "delete the project"', () => {
      const result = checkDestructiveAction('delete the project', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.matchedPattern).toBe('delete:project');
        expect(result.message).toBe(EXPECTED_MESSAGE);
      }
    });

    it('blocks "REMOVE USER alice" (uppercase)', () => {
      const result = checkDestructiveAction('REMOVE USER alice', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.matchedPattern).toBe('remove:user');
      }
    });

    it('blocks "purge the repo"', () => {
      const result = checkDestructiveAction('purge the repo', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.matchedPattern).toBe('purge:repo');
      }
    });

    it('blocks "unlink repository"', () => {
      const result = checkDestructiveAction('unlink repository', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.matchedPattern).toBe('unlink:repository');
      }
    });

    it('blocks "reset account"', () => {
      const result = checkDestructiveAction('reset account', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.matchedPattern).toBe('reset:account');
      }
    });

    it('blocks "wipe the project"', () => {
      const result = checkDestructiveAction('wipe the project', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.matchedPattern).toBe('wipe:project');
      }
    });

    it('blocks "DROP user" (SQL-style, mixed case)', () => {
      const result = checkDestructiveAction('DROP user', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.matchedPattern).toBe('drop:user');
      }
    });

    it('blocks mixed-case "Delete the Project"', () => {
      const result = checkDestructiveAction('Delete the Project', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.matchedPattern).toBe('delete:project');
      }
    });

    it('blocks when verb and resource are far apart in a sentence', () => {
      const result = checkDestructiveAction('Can you please delete everything including the user account?', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
    });

    it('returns exact message string with dashboard URL', () => {
      const customUrl = 'https://custom.example.com/dashboard';
      const result = checkDestructiveAction('delete project', customUrl);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.message).toBe(
          `For security reasons, destructive actions must be performed via the Dashboard: ${customUrl}`,
        );
      }
    });
  });

  describe('not blocked cases', () => {
    it('does not block verb-only input ("delete")', () => {
      const result = checkDestructiveAction('delete', DASHBOARD_URL);
      expect(result.blocked).toBe(false);
    });

    it('does not block resource-only input ("the project")', () => {
      const result = checkDestructiveAction('the project', DASHBOARD_URL);
      expect(result.blocked).toBe(false);
    });

    it('does not block a benign project query ("what does the project do")', () => {
      const result = checkDestructiveAction('what does the project do', DASHBOARD_URL);
      expect(result.blocked).toBe(false);
    });

    it('does not block "I deleted my coffee" (no protected resource)', () => {
      const result = checkDestructiveAction('I deleted my coffee', DASHBOARD_URL);
      expect(result.blocked).toBe(false);
    });

    it('does not block an empty string', () => {
      const result = checkDestructiveAction('', DASHBOARD_URL);
      expect(result.blocked).toBe(false);
    });

    it('does not block a completely unrelated message', () => {
      const result = checkDestructiveAction('Can you summarize the latest sprint?', DASHBOARD_URL);
      expect(result.blocked).toBe(false);
    });
  });

  describe('return shape', () => {
    it('returns { blocked: false } with no extra fields for safe messages', () => {
      const result = checkDestructiveAction('hello world', DASHBOARD_URL);
      expect(result).toEqual({ blocked: false });
    });

    it('returns correct discriminated union shape for blocked messages', () => {
      const result = checkDestructiveAction('delete the project', DASHBOARD_URL);
      expect(result).toMatchObject({
        blocked: true,
        matchedPattern: 'delete:project',
        message: EXPECTED_MESSAGE,
      });
    });

    it('matchedPattern is always lowercase even when input is uppercase', () => {
      const result = checkDestructiveAction('DELETE REPOSITORY', DASHBOARD_URL);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.matchedPattern).toMatch(/^[a-z]+:[a-z]+$/);
        expect(result.matchedPattern).toBe('delete:repository');
      }
    });
  });
});
