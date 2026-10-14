import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Image, Modal, BackHandler } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import AestheticScrollView from "../components/AestheticScrollView";
import { ZoomableImage } from "../components/ZoomableImage";
import { MANUAL_EMPLOYEE, MANUAL_INTRO, ManualBlock, ManualImage } from "../assets/user-manual";

type Props = {
  onClose: () => void;
};

type Block = ManualBlock<ManualImage>;
type Heading = Extract<Block, { type: "heading" }>;

// The employee part of the user manual (Appendix J), shown from both the
// employee Settings and the supervisor More tab — it's the only part of the
// manual written for the mobile app.
// The introduction lists all three parts; keep only the Employees entry
// (and drop the "three parts" lead-in).
const INTRO: Block[] = MANUAL_INTRO.map((block) => {
  if (block.type === "paragraph") {
    return { ...block, text: block.text.replace(/\s*It is organized in three parts:$/, "") };
  }
  if (block.type === "list" && block.items.some((item) => item.lead)) {
    return { ...block, items: block.items.filter((item) => item.lead === "Employees") };
  }
  return block;
});
const BLOCKS: Block[] = [...INTRO, ...MANUAL_EMPLOYEE];
const HEADINGS = BLOCKS.filter((block): block is Heading => block.type === "heading");

const headingLabel = (heading: Heading) => (heading.number ? `${heading.number} ${heading.text}` : heading.text);

export default function HelpScreen({ onClose }: Props) {
  const scrollRef = useRef<any>(null);
  const headingOffsets = useRef<Record<string, number>>({});
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);

  // Android back closes the manual and returns to the screen that opened it.
  // While the zoomed picture is open its Modal's onRequestClose takes back.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  const jumpTo = (id: string) => {
    const y = headingOffsets.current[id];
    if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onClose} style={styles.backButton} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color="#062B59" />
        </Pressable>
        <Text style={styles.title}>Help</Text>
        <View style={styles.headerSpacer} />
      </View>

      <AestheticScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={styles.content}>
        <View style={styles.contents}>
          <Text style={styles.contentsCaption}>CONTENTS</Text>
          {HEADINGS.map((heading) => (
            <Pressable
              key={heading.id}
              onPress={() => jumpTo(heading.id)}
              style={({ pressed }) => [styles.contentsRow, pressed && styles.contentsRowPressed]}
            >
              <Text style={[styles.contentsText, heading.level === 1 && styles.contentsTextMain]}>{headingLabel(heading)}</Text>
              <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
            </Pressable>
          ))}
        </View>

        {BLOCKS.map((block, index) => (
          <ManualBlockView
            key={index}
            block={block}
            onHeadingLayout={(id, y) => {
              headingOffsets.current[id] = y;
            }}
            onOpenImage={setZoomedImage}
          />
        ))}
      </AestheticScrollView>

      <Modal visible={!!zoomedImage} transparent animationType="fade" onRequestClose={() => setZoomedImage(null)}>
        <View style={styles.viewerOverlay}>
          <BlurView intensity={65} tint="dark" experimentalBlurMethod="dimezisBlurView" style={StyleSheet.absoluteFillObject} />
          {zoomedImage && <ZoomableImage uri={zoomedImage} style={styles.viewerMedia} />}
          <Text style={styles.viewerHint}>Pinch to zoom</Text>
          <Pressable style={styles.viewerCloseButton} onPress={() => setZoomedImage(null)} hitSlop={10} accessibilityLabel="Close picture">
            <Ionicons name="close" size={22} color="#FFFFFF" />
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

// Screenshots are wide strips of several phone screens; shrunk to the
// screen's width they're unreadable, so they keep a readable height and
// scroll sideways instead. Size comes from the stored pixel dimensions
// (percentage width + aspectRatio wasn't reliable in some builds).
const FIGURE_HEIGHT = 380;

function FigureImage({ image, label, onOpen }: { image: ManualImage; label: string; onOpen: (uri: string) => void }) {
  const width = (FIGURE_HEIGHT * image.width) / image.height;
  return (
    <AestheticScrollView horizontal contentContainerStyle={styles.figureScroll}>
      <Pressable
        onPress={() => onOpen(Image.resolveAssetSource(image.source).uri)}
        accessibilityRole="imagebutton"
        accessibilityLabel={label}
      >
        <Image source={image.source} style={[styles.figureImage, { width, height: FIGURE_HEIGHT }]} resizeMode="contain" />
      </Pressable>
    </AestheticScrollView>
  );
}

function ManualBlockView({
  block,
  onHeadingLayout,
  onOpenImage,
}: {
  block: Block;
  onHeadingLayout: (id: string, y: number) => void;
  onOpenImage: (uri: string) => void;
}) {
  switch (block.type) {
    case "heading":
      return (
        <View onLayout={(event) => onHeadingLayout(block.id, event.nativeEvent.layout.y)}>
          <Text style={block.level === 1 ? styles.h1 : styles.h2}>{headingLabel(block)}</Text>
        </View>
      );
    case "subheading":
      return <Text style={styles.h3}>{block.text}</Text>;
    case "paragraph":
      return <Text style={styles.paragraph}>{block.text}</Text>;
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={styles.listRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.listText}>
                {item.lead ? <Text style={styles.strong}>{item.lead}: </Text> : null}
                {item.text}
              </Text>
            </View>
          ))}
        </View>
      );
    case "note":
      return (
        <View style={styles.note}>
          <Text style={styles.noteText}>
            <Text style={styles.strong}>Note: </Text>
            {block.text}
          </Text>
        </View>
      );
    case "figure":
      return (
        <View style={styles.figure}>
          {block.images.map((image, index) => (
            <FigureImage
              key={index}
              image={image}
              label={`Figure ${block.number}. ${block.caption}. Tap to enlarge`}
              onOpen={onOpenImage}
            />
          ))}
          <Text style={styles.figureCaption}>
            Figure {block.number}. {block.caption}
          </Text>
          <Text style={styles.figureHint}>Swipe sideways to see more · Tap to enlarge</Text>
        </View>
      );
    case "callouts":
      return (
        <View style={styles.callouts}>
          {block.items.map((item, index) => (
            <View key={index} style={[styles.calloutRow, index > 0 && styles.calloutRowDivider]}>
              <View style={styles.calloutNumber}>
                <Text style={styles.calloutNumberText}>{item.n}</Text>
              </View>
              <View style={{ flex: 1 }}>
                {item.title ? <Text style={styles.calloutTitle}>{item.title}</Text> : null}
                {item.text ? <Text style={styles.calloutText}>{item.text}</Text> : null}
                {item.bullets?.map((bullet) => (
                  <View key={bullet} style={styles.listRow}>
                    <Text style={styles.bullet}>•</Text>
                    <Text style={[styles.calloutText, { flex: 1 }]}>{bullet}</Text>
                  </View>
                ))}
              </View>
            </View>
          ))}
        </View>
      );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 4, marginBottom: 4 },
  backButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  // Balances the back button's width so the title sits truly centered.
  headerSpacer: { width: 36 },
  title: { fontSize: 17, fontWeight: "700", color: "#062B59" },

  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 32 },

  contents: { borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 14, backgroundColor: "#F8FAFC", paddingVertical: 8, marginBottom: 6 },
  contentsCaption: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5, color: "#64748B", paddingHorizontal: 14, paddingBottom: 4 },
  contentsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 8 },
  contentsRowPressed: { backgroundColor: "#E2E8F0" },
  contentsText: { flex: 1, fontSize: 13, color: "#334155", fontWeight: "500" },
  contentsTextMain: { color: "#062B59", fontWeight: "700" },

  h1: { fontSize: 18, fontWeight: "800", color: "#062B59", marginTop: 22, marginBottom: 8, paddingBottom: 6, borderBottomWidth: 2, borderBottomColor: "#E2E8F0" },
  h2: { fontSize: 15.5, fontWeight: "800", color: "#062B59", marginTop: 20, marginBottom: 6 },
  h3: { fontSize: 14, fontWeight: "700", color: "#062B59", marginTop: 14, marginBottom: 4 },
  paragraph: { fontSize: 13.5, lineHeight: 20, color: "#475569", marginVertical: 4 },
  strong: { fontWeight: "700", color: "#062B59" },

  list: { marginVertical: 4 },
  listRow: { flexDirection: "row", marginTop: 4 },
  bullet: { width: 14, fontSize: 13.5, lineHeight: 20, color: "#475569" },
  listText: { flex: 1, fontSize: 13.5, lineHeight: 20, color: "#475569" },

  note: { marginTop: 8, marginBottom: 12, padding: 12, borderRadius: 10, borderWidth: 1, borderLeftWidth: 4, borderColor: "#93C5FD", backgroundColor: "#EFF6FF" },
  noteText: { fontSize: 13, lineHeight: 19, color: "#475569" },

  figure: { marginTop: 18, marginBottom: 8 },
  figureScroll: { paddingBottom: 14 },
  figureImage: { borderRadius: 10, borderWidth: 1, borderColor: "#E2E8F0", backgroundColor: "#F1F5F9" },
  figureCaption: { marginTop: 6, fontSize: 12.5, fontWeight: "700", color: "#062B59", textAlign: "center" },
  figureHint: { marginTop: 2, fontSize: 11, color: "#94A3B8", textAlign: "center" },

  callouts: { borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 12, marginTop: 4, marginBottom: 10, overflow: "hidden" },
  calloutRow: { flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  calloutRowDivider: { borderTopWidth: 1, borderTopColor: "#E2E8F0" },
  // Red, like the numbered markers drawn on the screenshots.
  calloutNumber: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#DC2626", alignItems: "center", justifyContent: "center", marginTop: 1 },
  calloutNumberText: { color: "#FFFFFF", fontSize: 11.5, fontWeight: "800" },
  calloutTitle: { fontSize: 13.5, fontWeight: "700", color: "#062B59" },
  calloutText: { fontSize: 13, lineHeight: 19, color: "#475569", marginTop: 2 },

  viewerOverlay: { flex: 1, alignItems: "center", justifyContent: "center", padding: 12 },
  viewerMedia: { width: "100%", height: "70%", borderRadius: 12, backgroundColor: "#FFFFFF" },
  viewerHint: { marginTop: 10, fontSize: 12, color: "#E2E8F0" },
  viewerCloseButton: {
    position: "absolute",
    top: 50,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
});
