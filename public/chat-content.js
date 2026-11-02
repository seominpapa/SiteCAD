// shortcut: a safe Markdown subset for chat replies; extend only for a needed output format.
export function renderChatContent(element, text) {
  const doc = element.ownerDocument ?? document;
  const node = (tag, value) => { const item = doc.createElement(tag); if (value !== undefined) item.textContent = value; return item; };
  function inline(parent, value) {
    const pattern = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|\*([^*]+?)\*|\[([^\]]+)\]\(([^\s)]+)\)|\\([\\|*`])/g;
    let end = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index > end) parent.append(node('span', value.slice(end, match.index)));
      if (match[2]) parent.append(node('code', match[2]));
      else if (match[3] || match[4]) parent.append(node(match[3] ? 'strong' : 'em', match[3] ?? match[4]));
      else if (match[5]) {
        let url;
        try { url = new URL(match[6]); } catch {}
        if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
          const link = node('a', match[5]); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link);
        } else parent.append(node('span', match[5]));
      } else parent.append(node('span', match[7]));
      end = match.index + match[0].length;
    }
    if (end < value.length) parent.append(node('span', value.slice(end)));
  }
  function cells(line) {
    if (!line.includes('|')) return;
    const parts = []; let value = '', fence = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '\\' && i + 1 < line.length) { value += char + line[++i]; continue; }
      if (char === '`') {
        const run = line.slice(i).match(/^`+/)[0];
        if (!fence) fence = run; else if (fence === run) fence = '';
        value += run; i += run.length - 1; continue;
      }
      if (char === '|' && !fence) { parts.push(value.trim()); value = ''; } else value += char;
    }
    parts.push(value.trim());
    if (line.trimStart().startsWith('|')) parts.shift();
    if (line.trimEnd().endsWith('|') && !fence && parts.at(-1) === '') parts.pop();
    return parts;
  }
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  element.replaceChildren();
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const content = []; i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) content.push(lines[i++]);
      const pre = node('pre'); pre.append(node('code', content.join('\n'))); element.append(pre); i++; continue;
    }
    const header = cells(line), separator = cells(lines[i + 1] ?? '');
    if (header?.length && separator?.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const scroll = node('div'), table = node('table'), head = node('thead'), body = node('tbody');
      scroll.className = 'chat-table-scroll'; scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '검토 결과 표, 가로 스크롤 가능');
      const row = (values, tag) => {
        const tr = node('tr');
        values.forEach((value, index) => {
          const cell = node(tag); if (tag === 'th') cell.setAttribute('scope', 'col');
          cell.style.textAlign = separator[index].endsWith(':') ? separator[index].startsWith(':') ? 'center' : 'right' : 'left';
          inline(cell, value); tr.append(cell);
        }); return tr;
      };
      head.append(row(header, 'th')); i += 2;
      for (; i < lines.length; i++) { const values = cells(lines[i]); if (values?.length !== header.length) break; body.append(row(values, 'td')); }
      table.append(head, body); scroll.append(table); element.append(scroll); continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/), list = line.match(/^\s*(?:([-+*])|\d+[.)])\s+(.+)$/);
    if (list) {
      const tag = list[1] ? 'ul' : 'ol', container = node(tag);
      while (i < lines.length) {
        const item = lines[i].match(/^\s*(?:([-+*])|\d+[.)])\s+(.+)$/);
        if (!item || (item[1] ? 'ul' : 'ol') !== tag) break;
        const li = node('li'); inline(li, item[2]); container.append(li); i++;
      }
      element.append(container); continue;
    }
    const paragraph = node(heading ? `h${heading[1].length}` : 'p');
    inline(paragraph, heading?.[2] ?? line); element.append(paragraph); i++;
  }
}
