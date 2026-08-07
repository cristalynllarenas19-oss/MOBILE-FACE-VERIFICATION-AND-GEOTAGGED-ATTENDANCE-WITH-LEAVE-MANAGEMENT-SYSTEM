import React from "react";
import { Image, Linking, StyleSheet, Text, TextStyle } from "react-native";

// Mirrors apps/admin-web/src/lib/richText.ts — the AnnouncementsTab compose
// toolbar writes this same small custom syntax (not full Markdown) into the
// plain-text message field:
//   **bold**  *italic*  __underline__  ~~strikethrough~~  `code`
//   [link text](https://example.com)   ![alt](https://example.com/x.png)
//   "# " line prefix = heading
// Bulleted/numbered lists and indentation are literal characters ("• ",
// "1. ", tab) the toolbar inserts directly, so they need no parsing here.
const INLINE_TOKEN_REGEX =
  /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|`([^`]+)`|\*([^*]+)\*/g;
const IMAGE_ONLY_REGEX = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

function renderInlineSegments(line: string, baseKey: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of line.matchAll(INLINE_TOKEN_REGEX)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(<Text key={`${baseKey}-t${key++}`}>{line.slice(lastIndex, index)}</Text>);

    const [, , imgUrl, linkText, linkUrl, bold, underline, strike, code, italic] = match;
    if (imgUrl !== undefined) {
      nodes.push(
        <Text key={`${baseKey}-i${key++}`} style={styles.imagePlaceholder}>
          [Image]
        </Text>,
      );
    } else if (linkUrl !== undefined) {
      nodes.push(
        <Text key={`${baseKey}-l${key++}`} style={styles.link} onPress={() => Linking.openURL(linkUrl).catch(() => undefined)}>
          {linkText || linkUrl}
        </Text>,
      );
    } else if (bold !== undefined) {
      nodes.push(
        <Text key={`${baseKey}-b${key++}`} style={styles.bold}>
          {bold}
        </Text>,
      );
    } else if (underline !== undefined) {
      nodes.push(
        <Text key={`${baseKey}-u${key++}`} style={styles.underline}>
          {underline}
        </Text>,
      );
    } else if (strike !== undefined) {
      nodes.push(
        <Text key={`${baseKey}-s${key++}`} style={styles.strike}>
          {strike}
        </Text>,
      );
    } else if (code !== undefined) {
      nodes.push(
        <Text key={`${baseKey}-c${key++}`} style={styles.code}>
          {code}
        </Text>,
      );
    } else if (italic !== undefined) {
      nodes.push(
        <Text key={`${baseKey}-e${key++}`} style={styles.italic}>
          {italic}
        </Text>,
      );
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < line.length) nodes.push(<Text key={`${baseKey}-tail`}>{line.slice(lastIndex)}</Text>);
  return nodes;
}

export function FormattedAnnouncementText({ message, textStyle }: { message: string; textStyle?: TextStyle }) {
  return (
    <>
      {message.split("\n").map((line, index) => {
        const imageMatch = line.trim().match(IMAGE_ONLY_REGEX);
        if (imageMatch) {
          return <Image key={index} source={{ uri: imageMatch[2] }} style={styles.image} resizeMode="cover" />;
        }
        if (line.startsWith("# ")) {
          return (
            <Text key={index} style={[textStyle, styles.heading]}>
              {renderInlineSegments(line.slice(2), `h${index}`)}
            </Text>
          );
        }
        if (line.trim() === "") return <Text key={index}>{"\n"}</Text>;
        return (
          <Text key={index} style={textStyle}>
            {renderInlineSegments(line, `l${index}`)}
          </Text>
        );
      })}
    </>
  );
}

// Plain-text fallback for contexts that can't render styled segments (the
// 2-line notification list preview) — formatting markers are removed
// rather than shown as literal asterisks/underscores.
export function stripFormattingTokens(message: string) {
  return message
    .replace(/!\[[^\]]*\]\([^)\s]+\)/g, "[Image]")
    .replace(/\[([^\]]*)\]\([^)\s]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();
}

const styles = StyleSheet.create({
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  underline: { textDecorationLine: "underline" },
  strike: { textDecorationLine: "line-through" },
  code: {
    fontFamily: "monospace",
    backgroundColor: "#F1F5F9",
    borderRadius: 4,
    paddingHorizontal: 3,
  },
  link: { color: "#1680D8", textDecorationLine: "underline" },
  heading: { fontWeight: "700", fontSize: 16 },
  imagePlaceholder: { color: "#94A3B8", fontStyle: "italic" },
  image: {
    width: "100%",
    height: 180,
    borderRadius: 12,
    backgroundColor: "#E2E8F0",
    marginVertical: 6,
  },
});
