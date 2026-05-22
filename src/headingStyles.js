// Distinct font sizes for each heading level. Layered on top of
// defaultHighlightStyle (which already gives headings bold + underline).
//
// The hideMarkdownMarkers plugin strips the leading `#` characters, so what
// remains is just the heading text — sized appropriately here.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const headingHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.8em', fontWeight: '700', textDecoration: 'none' },
  { tag: t.heading2, fontSize: '1.5em', fontWeight: '700', textDecoration: 'none' },
  { tag: t.heading3, fontSize: '1.3em', fontWeight: '700', textDecoration: 'none' },
  { tag: t.heading4, fontSize: '1.15em', fontWeight: '700', textDecoration: 'none' },
  { tag: t.heading5, fontSize: '1.05em', fontWeight: '700', textDecoration: 'none' },
  { tag: t.heading6, fontSize: '1em', fontWeight: '700', textDecoration: 'none' },
]);

export const headingStyles = syntaxHighlighting(headingHighlightStyle);
