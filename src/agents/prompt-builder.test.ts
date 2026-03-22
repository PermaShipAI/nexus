import '../tests/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAgentPrompt } from './prompt-builder.js';
import { getAgent } from './registry.js';
import { getRecentMessages } from '../conversation/service.js';
import { listTasks } from '../tasks/service.js';
import { getAgentMemories, getSharedKnowledge } from '../knowledge/service.js';

const mockListProjects = vi.fn();
const mockGetOrgName = vi.fn();

vi.mock('./registry.js');
vi.mock('../conversation/service.js');
vi.mock('../tasks/service.js');
vi.mock('../knowledge/service.js');
vi.mock('../db/index.js', () => {
  const mockQuery = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: any) => Promise.resolve([]).then(resolve),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(mockQuery),
    },
  };
});
vi.mock('../adapters/registry.js', () => ({
  getProjectRegistry: () => ({
    listProjects: mockListProjects,
  }),
  getTenantResolver: () => ({
    getOrgName: mockGetOrgName,
  }),
}));

describe('prompt-builder', () => {
  const mockAgent = {
    id: 'nexus',
    title: 'Nexus Director',
    personaMd: 'You are Nexus.',
    summary: 'Coordinator',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAgent).mockReturnValue(mockAgent as any);
    vi.mocked(getRecentMessages).mockResolvedValue([]);
    vi.mocked(listTasks).mockResolvedValue([]);
    vi.mocked(getAgentMemories).mockResolvedValue([]);
    vi.mocked(getSharedKnowledge).mockResolvedValue([]);
    mockListProjects.mockResolvedValue([]);
    mockGetOrgName.mockResolvedValue('the team');
  });

  it('should build an agent prompt', async () => {
    const prompt = await buildAgentPrompt('nexus', 'chan-1', 'org-1');
    expect(prompt).toContain('You are Nexus.');
    expect(prompt).toContain('Nexus Director');
  });

  it('matches snapshot for basic agent prompt', async () => {
    const prompt = await buildAgentPrompt('nexus', 'chan-1', 'org-1');
    expect(prompt).toMatchSnapshot();
  });

  it('matches snapshot with tasks and knowledge', async () => {
    vi.mocked(listTasks).mockResolvedValue([
      { id: 't1', title: 'Fix login bug', status: 'open', priority: 1 } as any,
    ]);
    vi.mocked(getSharedKnowledge).mockResolvedValue([
      { id: 'k1', topic: 'API Standards', content: 'Use REST with JSON responses' } as any,
    ]);
    const prompt = await buildAgentPrompt('nexus', 'chan-1', 'org-1');
    expect(prompt).toMatchSnapshot();
  });

  it('matches snapshot with conversation history', async () => {
    vi.mocked(getRecentMessages).mockResolvedValue([
      { authorName: 'user', content: 'What is the project status?', isAgent: false, agentId: null } as any,
      { authorName: 'nexus', content: 'The project is on track.', isAgent: true, agentId: 'nexus' } as any,
    ]);
    const prompt = await buildAgentPrompt('nexus', 'chan-1', 'org-1');
    expect(prompt).toMatchSnapshot();
  });

  it('matches snapshot with empty state', async () => {
    vi.mocked(getAgent).mockReturnValue({
      ...mockAgent,
      personaMd: '',
      summary: '',
    } as any);
    const prompt = await buildAgentPrompt('nexus', 'chan-1', 'org-1');
    expect(prompt).toMatchSnapshot();
  });
});
