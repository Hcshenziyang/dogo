import { describe, expect, it } from 'vitest';
import { markdownRenderer, resolveNote } from '../workspace/markdown-render.js';

describe('workspace Markdown reader', () => {
  it('renders formatted text, tables and wiki links while escaping untrusted HTML', () => {
    const html = markdownRenderer.render(
      '# Heading\n\n**bold** [[目标|标签]]\n\n| a | b |\n| --- | --- |\n| **x** | y |\n\n<script>alert(1)</script>',
    );
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('data-wiki="目标"');
    expect(html).toContain('<strong>x</strong>');
    expect(html).not.toContain('<script>');
  });
  it('marks relative and wiki images for local resolution without permitting unsafe URLs', () => {
    const html = markdownRenderer.render(
      '![截图](附件/图.png) ![[图.png]] ![bad](javascript:alert(1))',
    );
    expect(html).toContain('data-image-path="%E9%99%84%E4%BB%B6/%E5%9B%BE.png"');
    expect(html).toContain('data-image-path="图.png"');
    expect(html).not.toContain('src="javascript:');
  });
  it('resolves file IDs before matching display titles', () => {
    const notes = [
      { id: '目标.md', title: '别名', kind: 'note' },
      { id: '别名.md', title: '其他', kind: 'note' },
    ];
    expect(resolveNote('别名', notes)?.id).toBe('别名.md');
    expect(resolveNote('目标#章节', notes)?.id).toBe('目标.md');
    expect(resolveNote('不存在', notes)).toBeUndefined();
  });
  it('resolves links relative to nested notes and refuses ambiguous file names', () => {
    const notes = [
      { id: 'one/plan.md', title: '计划一', kind: 'note' },
      { id: 'two/plan.md', title: '计划二', kind: 'note' },
      { id: 'two/current.md', title: '当前', kind: 'note' },
    ];
    expect(resolveNote('plan', notes, 'two/current.md')?.id).toBe('two/plan.md');
    expect(resolveNote('../one/plan', notes, 'two/current.md')?.id).toBe('one/plan.md');
    expect(resolveNote('plan', notes)).toBeUndefined();
  });
});
