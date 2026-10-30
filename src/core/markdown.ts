import { parser } from '@lezer/markdown';
import { AssetReference, supportedReference } from './references';
export const assetMarkdownParser = parser.configure({
  defineNodes: ['PictetherMath', 'PictetherMathBlock', 'PictetherFrontmatter'],
  parseInline: [
    {
      name: 'PictetherMath',
      before: 'Escape',
      parse(cx, next, pos) {
        if (next !== 36) return -1;
        const width = cx.char(pos + 1) === 36 ? 2 : 1;
        for (let end = pos + width; end < cx.end; end++) {
          if (cx.char(end) === 92) {
            end++;
            continue;
          }
          if (cx.char(end) === 36 && (width === 1 || cx.char(end + 1) === 36))
            return cx.addElement(cx.elt('PictetherMath', pos, end + width));
        }
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: 'PictetherProtectedBlock',
      before: 'FencedCode',
      parse(cx, line) {
        const token = line.text.slice(line.pos).trim();
        const frontmatter = cx.lineStart === 0 && token === '---';
        if (!frontmatter && token !== '$$') return false;
        const start = cx.lineStart + line.pos;
        const delimiter = frontmatter ? '---' : '$$';
        while (cx.nextLine()) {
          const current = line.text.slice(line.pos).trim();
          if (current === delimiter || (frontmatter && current === '...')) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(
          cx.elt(
            frontmatter ? 'PictetherFrontmatter' : 'PictetherMathBlock',
            start,
            cx.prevLineEnd(),
          ),
        );
        return true;
      },
      endLeaf: (_cx, line) => line.text.slice(line.pos).trim() === '$$',
    },
  ],
});
export interface MarkdownAsset {
  from: number;
  to: number;
  reference: AssetReference;
}
/** Syntax offsets preserve all non-target bytes, including math, code and titles. */
export function findMarkdownAssets(markdown: string): MarkdownAsset[] {
  const assets: MarkdownAsset[] = [];
  assetMarkdownParser.parse(markdown).iterate({
    enter(node) {
      if (
        node.name !== 'URL' ||
        !['Image', 'Link', 'LinkReference'].includes(node.node.parent?.name ?? '')
      )
        return;
      let from = node.from,
        to = node.to;
      if (markdown[from] === '<' && markdown[to - 1] === '>') {
        from++;
        to--;
      }
      const uri = markdown.slice(from, to);
      if (uri.startsWith('mdasset://')) {
        const reference = supportedReference(uri);
        if (reference) assets.push({ from, to, reference });
      }
    },
  });
  return assets;
}

/** Remove embed markers for portable video/PDF links, including reference-style embeds. */
export function mediaEmbedMarkers(markdown: string): number[] {
  const tree = assetMarkdownParser.parse(markdown),
    definitions = new Map<string, string>();
  const normalize = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  const text = (node: { from: number; to: number }) => markdown.slice(node.from, node.to);
  tree.iterate({
    enter(node) {
      if (node.name !== 'LinkReference') return;
      const label = node.node.getChild('LinkLabel'),
        url = node.node.getChild('URL');
      if (label && url)
        definitions.set(normalize(text(label).slice(1, -1)), text(url).replace(/^<|>$/g, ''));
    },
  });
  const positions: number[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== 'Image') return;
      const url = node.node.getChild('URL'),
        label = node.node.getChild('LinkLabel');
      const alternative = /^!\[([\s\S]*?)\]/.exec(text(node))?.[1] ?? '';
      const uri = url
        ? text(url).replace(/^<|>$/g, '')
        : definitions.get(normalize(label ? text(label).slice(1, -1) || alternative : alternative));
      if (!uri?.startsWith('mdasset://')) return;
      const reference = supportedReference(uri);
      if (!reference) return;
      const extension = reference.filename.split('.').at(-1)!;
      if (['mkv', 'mov', 'mp4', 'ogv', 'webm', 'pdf', 'md'].includes(extension))
        positions.push(node.from);
    },
  });
  return positions;
}
