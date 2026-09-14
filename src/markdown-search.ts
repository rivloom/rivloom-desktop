import { searchTextParts } from './conversation-search.ts';

type TextNode = { type: string; value?: string; children?: TextNode[]; tagName?: string; properties?: Record<string, unknown> };

/** Highlight text nodes after Markdown parsing; never parse search terms as HTML. */
export function rehypeSearch({ query }: { query: string }) {
  return (tree: TextNode) => {
    if (!query.trim()) return;
    const visit = (node: TextNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child): TextNode[] => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child]; }
        return searchTextParts(child.value, query).map((part) => part.match
          ? { type: 'element', tagName: 'mark', properties: { className: ['search-highlight'] }, children: [{ type: 'text', value: part.text }] }
          : { type: 'text', value: part.text });
      });
    };
    visit(tree);
  };
}
