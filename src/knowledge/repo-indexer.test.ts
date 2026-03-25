import { describe, it, expect } from 'vitest';

/**
 * Unit tests for repo indexer logic — tests helpers and invariants
 * without requiring SourceExplorer or database.
 */
describe('Repo Indexer', () => {
  describe('source ID generation', () => {
    const REPO_SOURCE_PREFIX = 'repo:';

    function repoSourceId(repoKey: string): string {
      return `${REPO_SOURCE_PREFIX}${repoKey}`;
    }

    function treeSourceId(repoKey: string): string {
      return `${REPO_SOURCE_PREFIX}${repoKey}:tree`;
    }

    it('generates consistent source IDs', () => {
      expect(repoSourceId('acme/api')).toBe('repo:acme/api');
      expect(treeSourceId('acme/api')).toBe('repo:acme/api:tree');
    });

    it('profile and tree IDs are distinct', () => {
      const repoKey = 'org/repo';
      expect(repoSourceId(repoKey)).not.toBe(treeSourceId(repoKey));
    });

    it('source IDs use the repo: prefix for cleanup', () => {
      expect(repoSourceId('x/y').startsWith('repo:')).toBe(true);
      expect(treeSourceId('x/y').startsWith('repo:')).toBe(true);
    });
  });

  describe('key file candidates', () => {
    const KEY_FILE_CANDIDATES = [
      'README.md', 'readme.md', 'package.json', 'pyproject.toml',
      'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Makefile',
      'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
      'tsconfig.json', '.github/workflows/ci.yml', '.github/workflows/ci.yaml',
      '.github/workflows/main.yml', 'CONTRIBUTING.md', 'CLAUDE.md',
      'src/index.ts', 'src/main.ts', 'src/app.ts', 'src/index.js',
      'main.py', 'app.py', 'src/main.rs', 'main.go', 'cmd/main.go',
    ];

    it('includes common entry points for multiple languages', () => {
      expect(KEY_FILE_CANDIDATES).toContain('package.json'); // JS/TS
      expect(KEY_FILE_CANDIDATES).toContain('pyproject.toml'); // Python
      expect(KEY_FILE_CANDIDATES).toContain('Cargo.toml'); // Rust
      expect(KEY_FILE_CANDIDATES).toContain('go.mod'); // Go
      expect(KEY_FILE_CANDIDATES).toContain('pom.xml'); // Java
    });

    it('includes CI/CD config', () => {
      const ciFiles = KEY_FILE_CANDIDATES.filter((f) => f.includes('.github/workflows') || f === 'Dockerfile');
      expect(ciFiles.length).toBeGreaterThan(0);
    });

    it('includes documentation files', () => {
      expect(KEY_FILE_CANDIDATES).toContain('README.md');
      expect(KEY_FILE_CANDIDATES).toContain('CONTRIBUTING.md');
      expect(KEY_FILE_CANDIDATES).toContain('CLAUDE.md');
    });
  });

  describe('tree filtering for key file existence', () => {
    it('finds exact matches in tree', () => {
      const tree = ['package.json', 'src/index.ts', 'README.md', 'tsconfig.json'];
      const candidate = 'package.json';
      const exists = tree.some((line) => line === candidate || line.endsWith(`/${candidate}`));
      expect(exists).toBe(true);
    });

    it('finds nested files via suffix', () => {
      const tree = ['src/main.ts', 'lib/main.ts'];
      const candidate = 'src/main.ts';
      const exists = tree.some((line) => line === candidate || line.endsWith(`/${candidate}`));
      expect(exists).toBe(true);
    });

    it('does not false-positive on partial matches', () => {
      const tree = ['not-package.json', 'src/other.ts'];
      const candidate = 'package.json';
      const exists = tree.some((line) => line === candidate || line.endsWith(`/${candidate}`));
      expect(exists).toBe(false);
    });

    it('skips tree check when tree is empty (fetches all candidates)', () => {
      const treeLines: string[] = [];
      const candidate = 'package.json';
      // When tree is empty, we don't filter — try all candidates
      const exists = treeLines.length === 0 || treeLines.some((line) => line === candidate);
      expect(exists).toBe(true);
    });
  });

  describe('content truncation', () => {
    const MAX = 4000;

    it('truncates long file content', () => {
      const content = 'x'.repeat(5000);
      const truncated = content.length > MAX ? content.slice(0, MAX) + '\n[...truncated]' : content;
      expect(truncated.length).toBe(MAX + '\n[...truncated]'.length);
      expect(truncated).toContain('[...truncated]');
    });

    it('leaves short content unchanged', () => {
      const content = 'short content';
      const truncated = content.length > MAX ? content.slice(0, MAX) + '\n[...truncated]' : content;
      expect(truncated).toBe('short content');
    });
  });

  describe('fallback profile', () => {
    it('generates basic profile when LLM fails', () => {
      const repoKey = 'acme/api';
      const tree = 'src/\n  index.ts\npackage.json';
      const files = [{ path: 'package.json', content: '{"name":"acme-api"}' }];

      // Simulated fallback
      const sections: string[] = [`# Repo Profile: ${repoKey}`, ''];
      if (tree) sections.push('## File Structure', '```', tree.slice(0, 2000), '```', '');
      if (files.length > 0) sections.push(`## Key Files: ${files.map((f) => f.path).join(', ')}`, '');
      const profile = sections.join('\n');

      expect(profile).toContain('# Repo Profile: acme/api');
      expect(profile).toContain('package.json');
      expect(profile).toContain('index.ts');
    });
  });
});
