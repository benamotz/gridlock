import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('styles.css', () => {
  // Regression: a stray closing brace after an edit silently dropped the next
  // rule, which put the touch vitals bar under the left thumb on the live site.
  it('has balanced braces, so no rule is silently swallowed', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    css.split('\n').forEach((line, i) => {
      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth < 0) throw new Error(`stray } on line ${i + 1}`);
      }
    });
    expect(depth).toBe(0);
  });
});
