import { ReactNode, createElement } from "react";

// A deliberately small, custom formatting syntax (not full Markdown) that
// the AnnouncementsTab toolbar writes and renderFormattedText reads back.
// Plain text in, plain text out — this is never treated as HTML, so
// there's no injection surface, and the same syntax is easy to re-parse in
// the mobile app without pulling in a markdown library there too.
//
//   **bold**  *italic*  __underline__  ~~strikethrough~~  `code`
//   [link text](https://example.com)   ![alt](https://example.com/x.png)
//   "# " line prefix = heading (via the Body/Heading toolbar toggle)
//
// Bulleted/numbered lists and indentation are NOT part of this syntax —
// the toolbar inserts their markers ("• ", "1. ", tab) as literal
// characters, so they read fine as plain text with no parsing at all.
const INLINE_TOKEN_REGEX =
  /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|`([^`]+)`|\*([^*]+)\*/g;

function renderInline(line: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of line.matchAll(INLINE_TOKEN_REGEX)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(line.slice(lastIndex, index));

    const [, imgAlt, imgUrl, linkText, linkUrl, bold, underline, strike, code, italic] = match;
    if (imgUrl !== undefined) {
      nodes.push(createElement("img", { key: key++, src: imgUrl, alt: imgAlt, className: "announcement-inline-image" }));
    } else if (linkUrl !== undefined) {
      nodes.push(
        createElement("a", { key: key++, href: linkUrl, target: "_blank", rel: "noreferrer" }, linkText || linkUrl),
      );
    } else if (bold !== undefined) {
      nodes.push(createElement("strong", { key: key++ }, bold));
    } else if (underline !== undefined) {
      nodes.push(createElement("u", { key: key++ }, underline));
    } else if (strike !== undefined) {
      nodes.push(createElement("s", { key: key++ }, strike));
    } else if (code !== undefined) {
      nodes.push(createElement("code", { key: key++ }, code));
    } else if (italic !== undefined) {
      nodes.push(createElement("em", { key: key++ }, italic));
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes;
}

export function renderFormattedText(message: string): ReactNode {
  return message.split("\n").map((line, index) => {
    if (line.startsWith("# ")) {
      return createElement("h4", { key: index, className: "announcement-view-heading" }, renderInline(line.slice(2)));
    }
    if (line.trim() === "") {
      return createElement("br", { key: index });
    }
    return createElement("p", { key: index, className: "announcement-view-line" }, renderInline(line));
  });
}
