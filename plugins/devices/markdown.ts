import MarkdownIt from 'markdown-it';
import { safeLink } from '../shared/presentation.js';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
markdown.validateLink = (url) => !!safeLink(url);
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index]?.content || '图片');
const renderLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet('target', '_blank');
  tokens[index]!.attrSet('rel', 'noopener noreferrer');
  return renderLink
    ? renderLink(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};
markdown.core.ruler.after('inline', 'devices-task-list', (state) => {
  for (let index = 2; index < state.tokens.length; index++) {
    const token = state.tokens[index]!;
    if (
      token.type !== 'inline' ||
      state.tokens[index - 1]?.type !== 'paragraph_open' ||
      state.tokens[index - 2]?.type !== 'list_item_open' ||
      !token.children?.length
    )
      continue;
    const first = token.children[0]!;
    const match = first.type === 'text' && first.content.match(/^\[([ xX])\]\s+/);
    if (!match) continue;
    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" disabled${match[1]!.toLowerCase() === 'x' ? ' checked' : ''}> `;
    token.children.unshift(checkbox);
  }
});

export function renderDeviceMarkdown(text: string): string {
  return markdown.render(text);
}
