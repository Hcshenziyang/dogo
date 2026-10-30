import { describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';
import { styles } from '../shared/styles.js';

// This is a stylesheet contract, not a browser computed-style/layout test.
const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
const declarations = (selector: string) => {
  const rule = rules.find((match) =>
    match[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim())
      .includes(selector),
  );
  expect(rule, selector).toBeDefined();
  return new Map(
    rule![2]
      .split(';')
      .filter(Boolean)
      .map((value) => {
        const colon = value.indexOf(':');
        return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
      }),
  );
};
const input = '.dogo[data-dogo=memos] .dg-memo-toolbar .dg-search>input[type=search]';

describe('memo search focus styling', () => {
  it('resets inner focus decoration in every state, above the generic DogO ring and normal host styles', () => {
    for (const state of ['', ':focus', ':focus-visible']) {
      const rule = declarations(input + state);
      for (const [property, value] of Object.entries({
        border: '0!important',
        'border-radius': '0!important',
        outline: 'none!important',
        'outline-offset': '0!important',
        'box-shadow': 'none!important',
        background: 'transparent!important',
        padding: '0!important',
        margin: '0!important',
        'min-height': '0!important',
      }))
        expect(rule.get(property), `${state} ${property}`).toBe(value);
      // Unlike .dg-search input, this scoped selector is more specific than
      // .dogo :focus-visible. Important decoration resets also resist host utilities.
      expect(rule.get('appearance')).toBe('none');
      expect(rule.get('height')).toBe('100%');
      expect(rule.get('box-sizing')).toBe('border-box');
    }
  });
  it('keeps one visible wrapper focus treatment and aligns the controls at 38px', () => {
    const wrapper = declarations('.dogo[data-dogo=memos] .dg-memo-toolbar .dg-search:focus-within');
    expect(wrapper.get('border-color')).toBe('var(--dg-accent)');
    expect(wrapper.get('box-shadow')).toBe('0 0 0 1px var(--dg-accent)');
    expect(wrapper.get('outline')).toBe('none');
    expect(styles).toContain(
      '@media(forced-colors:active){.dogo[data-dogo=memos] .dg-memo-toolbar .dg-search:focus-within{outline:2px solid Highlight;outline-offset:2px;box-shadow:none}}',
    );
    expect(declarations('.dg-memo-toolbar .dg-search').get('height')).toBe('38px');
    expect(declarations('.dg-memo-toolbar .dg-button').get('height')).toBe('38px');
  });
  it('parses the complete CSS with the official build parser', () => {
    const result = transformSync(styles, { loader: 'css', minify: true });
    expect(result.warnings).toEqual([]);
    expect(result.code).toContain(':focus-visible');
  });
});
