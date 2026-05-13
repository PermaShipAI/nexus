import { describe, it, expect } from 'vitest';
import { parseSuggestedActions } from './formatter.js';

describe('parseSuggestedActions', () => {
  it('returns original body and empty suggestions when no block is present', () => {
    const text = 'Here is my analysis of the issue.';
    const result = parseSuggestedActions(text);
    expect(result.body).toBe(text);
    expect(result.suggestions).toEqual([]);
  });

  it('extracts suggestions from a <suggested-actions> block', () => {
    const text = `Here is my analysis.

<suggested-actions>
- Investigate the auth module
- Check deployment logs
- Create a ticket for this bug
</suggested-actions>`;

    const result = parseSuggestedActions(text);
    expect(result.body).toBe('Here is my analysis.');
    expect(result.suggestions).toEqual([
      'Investigate the auth module',
      'Check deployment logs',
      'Create a ticket for this bug',
    ]);
  });

  it('strips the block from the body', () => {
    const text = `Analysis done.\n<suggested-actions>\n- Do X\n</suggested-actions>`;
    const { body } = parseSuggestedActions(text);
    expect(body).not.toContain('<suggested-actions>');
    expect(body).not.toContain('</suggested-actions>');
    expect(body).toBe('Analysis done.');
  });

  it('handles bullet points with asterisks and no prefix', () => {
    const text = `Done.\n<suggested-actions>\n* Check logs\n  plain line\n</suggested-actions>`;
    const { suggestions } = parseSuggestedActions(text);
    expect(suggestions).toEqual(['Check logs', 'plain line']);
  });

  it('caps suggestions at 5', () => {
    const items = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const block = `<suggested-actions>\n${items.map(i => `- ${i}`).join('\n')}\n</suggested-actions>`;
    const { suggestions } = parseSuggestedActions(block);
    expect(suggestions).toHaveLength(5);
  });

  it('ignores blank lines inside the block', () => {
    const text = `<suggested-actions>\n\n- Do A\n\n- Do B\n\n</suggested-actions>`;
    const { suggestions } = parseSuggestedActions(text);
    expect(suggestions).toEqual(['Do A', 'Do B']);
  });

  it('is case-insensitive for the tag name', () => {
    const text = `<Suggested-Actions>\n- Try this\n</Suggested-Actions>`;
    const { suggestions } = parseSuggestedActions(text);
    expect(suggestions).toEqual(['Try this']);
  });
});
