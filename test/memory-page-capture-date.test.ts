import { describe, expect, test } from 'bun:test';
import { lintContent } from '../src/commands/lint.ts';
import { memberPageFrontmatter, scopePageFrontmatter } from '../src/core/access/member-facts.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

describe('first memory capture on a generated page', () => {
  const received = new Date('2024-05-06T15:01:02.345Z');
  for (const member of [true, false]) {
    const path = member ? 'memory/members/alice-example.md' : 'memory/scope.md';
    test(path, () => {
      const header = member ? memberPageFrontmatter('alice-example', received) : scopePageFrontmatter(received);
      const content = header + '\n# Memory\n';
      const { frontmatter } = parseMarkdown(content, path);
      expect(frontmatter.captured_at).toBe(received.toISOString());
      expect(frontmatter.readable_by).toEqual(member ? ['member:alice-example'] : undefined);
      expect(lintContent(content, path).map(issue => issue.rule)).not.toContain('missing-created');
    });
  }
});
