import { safeLink } from './presentation.js';

export function createUI(React: any) {
  const h = React.createElement;
  const paths: Record<string, string[]> = {
    note: ['M6 3h9l4 4v14H5V3h1', 'M14 3v5h5', 'M9 12h6M9 16h6'],
    devices: ['M3 4h15v11H3z', 'M8 19h5M10.5 15v4', 'M18 10h4v11h-6V10h2'],
    plus: ['M12 5v14M5 12h14'],
    search: ['M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15', 'm16 16 5 5'],
    settings: [
      'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
      'M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
    ],
    refresh: ['M20 7a9 9 0 1 0 1 8', 'M20 2v6h-6'],
    check: ['m5 12 4 4L19 6'],
    close: ['m6 6 12 12M6 18 18 6'],
    chevron: ['m9 5 7 7-7 7'],
    back: ['m14 6-6 6 6 6'],
    folder: ['M3 6h7l2 2h9v12H3V6z'],
    cloud: ['M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13 0 5 5 0 0 1 0 10', 'm8 14 3 3 5-5'],
    send: ['m4 4 18 8-18 8 4-8-4-8z', 'M8 12h14'],
    monitor: ['M3 4h18v13H3z', 'M8 21h8M12 17v4'],
    phone: ['M7 2h10v20H7z', 'M10 18h4'],
    logout: ['M10 4H4v16h6', 'M9 12h12m-4-4 4 4-4 4'],
    trash: ['M3 6h18M8 6V3h8v3M6 6l1 15h10l1-15M10 10v7M14 10v7'],
    edit: ['m16 3 5 5-12 12-6 1 1-6L16 3z', 'm13 6 5 5'],
    chat: ['M3 4h18v13H9l-6 4V4z', 'M7 9h10M7 13h6'],
    info: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20', 'M12 11v6M12 7v1'],
    stop: ['M6 6h12v12H6z'],
    arrow: ['M12 19V5m-6 6 6-6 6 6'],
    tag: ['M3 3h8l10 10-8 8L3 11V3z', 'M7 7h.01'],
  };
  function Icon({ name, size = 18, ...props }: any) {
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.65,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        ...props,
      },
      ...(paths[name] || paths.note).map((d, i) => h('path', { d, key: i })),
    );
  }
  function Button({ children, icon, variant = 'plain', className = '', ...props }: any) {
    return h(
      'button',
      { type: 'button', className: 'dg-button dg-' + variant + ' ' + className, ...props },
      icon && h(Icon, { name: icon, size: 16 }),
      children,
    );
  }
  function Empty({ icon = 'note', title, children, action }: any) {
    return h(
      'div',
      { className: 'dg-empty' },
      h('div', { className: 'dg-empty-icon' }, h(Icon, { name: icon, size: 28 })),
      h('h3', null, title),
      h('p', null, children),
      action,
    );
  }
  function Badge({ children, tone = 'muted' }: any) {
    return h('span', { className: 'dg-badge dg-tone-' + tone }, h('i'), children);
  }
  function Field({ label, hint, children, ...props }: any) {
    return h(
      'label',
      { className: 'dg-field' },
      h('span', null, label),
      children || h('input', { 'aria-label': label, ...props }),
      hint && h('small', null, hint),
    );
  }
  function Dialog({ title, children, close }: any) {
    const ref = React.useRef(null);
    React.useEffect(() => {
      const previous = document.activeElement as HTMLElement;
      ref.current?.focus();
      return () => previous?.focus();
    }, []);
    return h(
      'div',
      {
        className: 'dg-overlay',
        onMouseDown: (e: any) => {
          if (e.target === e.currentTarget) close();
        },
      },
      h(
        'section',
        {
          role: 'dialog',
          'aria-modal': true,
          'aria-label': title,
          className: 'dg-dialog',
          ref,
          tabIndex: -1,
          onKeyDown: (e: any) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
            if (e.key === 'Tab') {
              const nodes = [
                ...ref.current.querySelectorAll(
                  'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
                ),
              ] as HTMLElement[];
              const first = nodes[0],
                last = nodes[nodes.length - 1];
              if (
                e.shiftKey &&
                (document.activeElement === first || document.activeElement === ref.current)
              ) {
                e.preventDefault();
                last?.focus();
              }
              if (
                !e.shiftKey &&
                (document.activeElement === last || document.activeElement === ref.current)
              ) {
                e.preventDefault();
                first?.focus();
              }
            }
          },
        },
        h(
          'header',
          { className: 'dg-dialog-head' },
          h('h2', null, title),
          h(Button, { icon: 'close', 'aria-label': '关闭', onClick: close }),
        ),
        children,
      ),
    );
  }
  function Markdown({ text }: { text: string }) {
    const lines = text.split('\n'),
      result: any[] = [];
    const inline = (s: string) =>
      s.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**'))
          return h('strong', { key: i }, part.slice(2, -2));
        if (part.startsWith('`') && part.endsWith('`'))
          return h('code', { key: i }, part.slice(1, -1));
        const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/),
          url = match && safeLink(match[2]);
        return url
          ? h('a', { key: i, href: url, target: '_blank', rel: 'noopener noreferrer' }, match![1])
          : part;
      });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i],
        heading = line.match(/^(#{1,3})\s+(.+)/);
      if (line.startsWith('```')) {
        const code: string[] = [],
          key = i;
        while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
        result.push(h('pre', { key }, h('code', null, code.join('\n'))));
      } else if (heading)
        result.push(h('h' + (heading[1].length + 1), { key: i }, inline(heading[2])));
      else if (/^\s*[-*]\s/.test(line))
        result.push(
          h(
            'div',
            { key: i, className: 'dg-bullet' },
            h('span', null, '•'),
            h('span', null, inline(line.replace(/^\s*[-*]\s/, ''))),
          ),
        );
      else result.push(h('p', { key: i }, inline(line) || '\u00a0'));
    }
    return h('div', { className: 'dg-markdown' }, ...result);
  }
  return { h, Icon, Button, Empty, Badge, Field, Dialog, Markdown };
}
