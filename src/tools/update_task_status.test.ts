import '../tests/env.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Must import AFTER vi.mock
import { updateTaskStatus } from './update_task_status.js';
import { logger } from '../logger.js';

const mockLoggerInfo = vi.mocked(logger.info);
const mockLoggerWarn = vi.mocked(logger.warn);
const mockLoggerError = vi.mocked(logger.error);

const baseInput = {
  orgId: 'org-123',
  taskId: 'task-456',
  status: 'in_progress',
  agentId: 'qa-manager' as const,
};

describe('updateTaskStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_API_URL = 'https://api.example.com';
    process.env.APP_API_KEY = 'test-app-key';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('missing APP_API_URL', () => {
    it('returns { success: false } when APP_API_URL is not set', async () => {
      delete process.env.APP_API_URL;

      const result = await updateTaskStatus(baseInput);

      expect(result.success).toBe(false);
    });

    it('message mentions APP_API_URL when not configured', async () => {
      delete process.env.APP_API_URL;

      const result = await updateTaskStatus(baseInput);

      expect(result.message).toMatch(/APP_API_URL/);
    });

    it('calls logger.warn with event agent.tool.conductor_url_missing when APP_API_URL is missing', async () => {
      delete process.env.APP_API_URL;

      await updateTaskStatus(baseInput);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.conductor_url_missing',
          success: false,
        }),
      );
    });

    it('does NOT call fetch when APP_API_URL is missing', async () => {
      delete process.env.APP_API_URL;

      await updateTaskStatus(baseInput);

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('HTTP 409 conflict', () => {
    it('returns { success: false } on 409', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 409,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'locked' }),
      } as unknown as Response);

      const result = await updateTaskStatus(baseInput);

      expect(result.success).toBe(false);
    });

    it('message mentions waiting_for_human on 409', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 409,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'locked' }),
      } as unknown as Response);

      const result = await updateTaskStatus(baseInput);

      expect(result.message).toMatch(/waiting_for_human/);
    });

    it('calls logger.warn with event agent.tool.update_task_status and success:false on 409', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 409,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'locked' }),
      } as unknown as Response);

      await updateTaskStatus(baseInput);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.update_task_status',
          statusCode: 409,
          success: false,
        }),
      );
    });
  });

  describe('HTTP 422 unprocessable', () => {
    it('returns { success: false } on 422', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 422,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'invalid transition' }),
      } as unknown as Response);

      const result = await updateTaskStatus(baseInput);

      expect(result.success).toBe(false);
    });

    it('message mentions invalid state transition on 422', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 422,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'invalid transition' }),
      } as unknown as Response);

      const result = await updateTaskStatus(baseInput);

      expect(result.message).toMatch(/invalid/i);
    });

    it('calls logger.warn with event agent.tool.update_task_status and statusCode:422 on 422', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 422,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'invalid transition' }),
      } as unknown as Response);

      await updateTaskStatus(baseInput);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.update_task_status',
          statusCode: 422,
          success: false,
        }),
      );
    });
  });

  describe('other HTTP errors', () => {
    it('returns { success: false } on 500', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 500,
        ok: false,
        json: vi.fn().mockResolvedValue({}),
      } as unknown as Response);

      const result = await updateTaskStatus(baseInput);

      expect(result.success).toBe(false);
    });

    it('message includes HTTP status code on unexpected error', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 500,
        ok: false,
        json: vi.fn().mockResolvedValue({}),
      } as unknown as Response);

      const result = await updateTaskStatus(baseInput);

      expect(result.message).toMatch(/500/);
    });

    it('calls logger.error on unexpected HTTP error', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 500,
        ok: false,
        json: vi.fn().mockResolvedValue({}),
      } as unknown as Response);

      await updateTaskStatus(baseInput);

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.update_task_status',
          success: false,
        }),
      );
    });
  });

  describe('successful update', () => {
    it('returns { success: true } on 200', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({ taskId: 'task-456', status: 'in_progress' }),
      } as unknown as Response);

      const result = await updateTaskStatus(baseInput);

      expect(result.success).toBe(true);
    });

    it('returns taskId and status on success', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({ taskId: 'task-456', status: 'in_progress' }),
      } as unknown as Response);

      const result = await updateTaskStatus(baseInput);

      expect(result.taskId).toBe('task-456');
      expect(result.status).toBe('in_progress');
    });

    it('calls fetch with PATCH method and correct URL', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      } as unknown as Response);

      await updateTaskStatus(baseInput);

      expect(fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/orgs/org-123/tasks/task-456/status',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('calls logger.info with event agent.tool.update_task_status and success:true on success', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      } as unknown as Response);

      await updateTaskStatus(baseInput);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.update_task_status',
          success: true,
        }),
      );
    });
  });

  describe('network error (fetch throws)', () => {
    it('returns { success: false } when fetch throws', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network failure'));

      const result = await updateTaskStatus(baseInput);

      expect(result.success).toBe(false);
    });

    it('calls logger.error when fetch throws', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network failure'));

      await updateTaskStatus(baseInput);

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.update_task_status',
          success: false,
        }),
      );
    });
  });

  describe('telemetry logging', () => {
    it('logger.warn is called with success:false on 409', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 409,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'locked' }),
      } as unknown as Response);

      await updateTaskStatus(baseInput);

      const warnCalls = mockLoggerWarn.mock.calls;
      const matchingCall = warnCalls.find(
        ([obj]) => typeof obj === 'object' && obj !== null && 'event' in obj && obj.event === 'agent.tool.update_task_status',
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![0]).toMatchObject({ success: false });
    });

    it('logger.info is called with success:true on successful update', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      } as unknown as Response);

      await updateTaskStatus(baseInput);

      const infoCalls = mockLoggerInfo.mock.calls;
      const matchingCall = infoCalls.find(
        ([obj]) => typeof obj === 'object' && obj !== null && 'event' in obj && obj.event === 'agent.tool.update_task_status',
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![0]).toMatchObject({ success: true });
    });
  });
});
