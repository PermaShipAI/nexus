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
import { createPermashipTicket } from './create_permaship_ticket.js';
import { logger } from '../logger.js';

const mockLoggerInfo = vi.mocked(logger.info);
const mockLoggerWarn = vi.mocked(logger.warn);
const mockLoggerError = vi.mocked(logger.error);

const baseInput = {
  orgId: 'org-123',
  kind: 'bug' as const,
  title: 'Test bug',
  description: 'Something broke',
  agentId: 'qa-manager' as const,
};

describe('createPermashipTicket', () => {
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

      const result = await createPermashipTicket(baseInput);

      expect(result.success).toBe(false);
    });

    it('message mentions APP_API_URL when not configured', async () => {
      delete process.env.APP_API_URL;

      const result = await createPermashipTicket(baseInput);

      expect(result.message).toMatch(/APP_API_URL/);
    });

    it('calls logger.warn with event agent.tool.conductor_url_missing when APP_API_URL is missing', async () => {
      delete process.env.APP_API_URL;

      await createPermashipTicket(baseInput);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.conductor_url_missing',
          success: false,
        }),
      );
    });

    it('does NOT call fetch when APP_API_URL is missing', async () => {
      delete process.env.APP_API_URL;

      await createPermashipTicket(baseInput);

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('HTTP 409 conflict', () => {
    it('returns { success: false } on 409', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 409,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'conflict' }),
      } as unknown as Response);

      const result = await createPermashipTicket(baseInput);

      expect(result.success).toBe(false);
    });

    it('message mentions waiting_for_human on 409', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 409,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'conflict' }),
      } as unknown as Response);

      const result = await createPermashipTicket(baseInput);

      expect(result.message).toMatch(/waiting_for_human/);
    });

    it('calls logger.warn with event agent.tool.create_permaship_ticket and success:false on 409', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 409,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'conflict' }),
      } as unknown as Response);

      await createPermashipTicket(baseInput);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.create_permaship_ticket',
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
        json: vi.fn().mockResolvedValue({ error: 'unprocessable' }),
      } as unknown as Response);

      const result = await createPermashipTicket(baseInput);

      expect(result.success).toBe(false);
    });

    it('message mentions current state on 422', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 422,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'unprocessable' }),
      } as unknown as Response);

      const result = await createPermashipTicket(baseInput);

      expect(result.message).toMatch(/current state/i);
    });

    it('calls logger.warn with event agent.tool.create_permaship_ticket and statusCode:422 on 422', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 422,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'unprocessable' }),
      } as unknown as Response);

      await createPermashipTicket(baseInput);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.create_permaship_ticket',
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

      const result = await createPermashipTicket(baseInput);

      expect(result.success).toBe(false);
    });

    it('message includes HTTP status code on unexpected error', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 500,
        ok: false,
        json: vi.fn().mockResolvedValue({}),
      } as unknown as Response);

      const result = await createPermashipTicket(baseInput);

      expect(result.message).toMatch(/500/);
    });

    it('calls logger.error on unexpected HTTP error', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 500,
        ok: false,
        json: vi.fn().mockResolvedValue({}),
      } as unknown as Response);

      await createPermashipTicket(baseInput);

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.create_permaship_ticket',
          success: false,
        }),
      );
    });
  });

  describe('successful creation', () => {
    it('returns { success: true } on 201', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 201,
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'ticket-789' }),
      } as unknown as Response);

      const result = await createPermashipTicket(baseInput);

      expect(result.success).toBe(true);
    });

    it('returns ticketId from response data on success', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 201,
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'ticket-789' }),
      } as unknown as Response);

      const result = await createPermashipTicket(baseInput);

      expect(result.ticketId).toBe('ticket-789');
    });

    it('calls fetch with POST method and correct URL', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 201,
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'ticket-789' }),
      } as unknown as Response);

      await createPermashipTicket(baseInput);

      expect(fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/orgs/org-123/tickets',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('calls logger.info with event agent.tool.create_permaship_ticket and success:true on success', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 201,
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'ticket-789' }),
      } as unknown as Response);

      await createPermashipTicket(baseInput);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.create_permaship_ticket',
          success: true,
        }),
      );
    });

    it('includes priority in the request body when provided', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 201,
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'ticket-789' }),
      } as unknown as Response);

      await createPermashipTicket({ ...baseInput, priority: 1 });

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"priority":1'),
        }),
      );
    });
  });

  describe('network error (fetch throws)', () => {
    it('returns { success: false } when fetch throws', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network failure'));

      const result = await createPermashipTicket(baseInput);

      expect(result.success).toBe(false);
    });

    it('calls logger.error when fetch throws', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network failure'));

      await createPermashipTicket(baseInput);

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent.tool.create_permaship_ticket',
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
        json: vi.fn().mockResolvedValue({ error: 'conflict' }),
      } as unknown as Response);

      await createPermashipTicket(baseInput);

      const warnCalls = mockLoggerWarn.mock.calls;
      const matchingCall = warnCalls.find(
        ([obj]) => typeof obj === 'object' && obj !== null && 'event' in obj && obj.event === 'agent.tool.create_permaship_ticket',
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![0]).toMatchObject({ success: false });
    });

    it('logger.info is called with success:true on successful creation', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 201,
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'ticket-789' }),
      } as unknown as Response);

      await createPermashipTicket(baseInput);

      const infoCalls = mockLoggerInfo.mock.calls;
      const matchingCall = infoCalls.find(
        ([obj]) => typeof obj === 'object' && obj !== null && 'event' in obj && obj.event === 'agent.tool.create_permaship_ticket',
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![0]).toMatchObject({ success: true });
    });
  });
});
