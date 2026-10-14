import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  MANUAL_ADMIN,
  MANUAL_EMPLOYEE,
  MANUAL_INTRO,
  MANUAL_LOGIN,
  MANUAL_SUPERVISOR,
  ManualBlock,
  ManualImage,
} from "./userManualContent";
import "./HelpManualModal.css";

type Block = ManualBlock<ManualImage>;

export type ManualAudience = "admin" | "supervisor" | "employee";

// The introduction lists all three parts of the manual; each audience only
// sees the entry for its own part (and not the "three parts" lead-in).
function introFor(lead: string): Block[] {
  return MANUAL_INTRO.map((block) => {
    if (block.type === "paragraph") {
      return { ...block, text: block.text.replace(/\s*It is organized in three parts:$/, "") };
    }
    if (block.type === "list" && block.items.some((item) => item.lead)) {
      return { ...block, items: block.items.filter((item) => item.lead === lead) };
    }
    return block;
  });
}

// Each audience reads only its own part of the manual (plus the
// introduction, and the web login for the two web roles).
const MANUALS: Record<ManualAudience, { title: string; blocks: Block[] }> = {
  admin: { title: "Administrator / HR", blocks: [...introFor("Administrator / HR"), ...MANUAL_LOGIN, ...MANUAL_ADMIN] },
  supervisor: { title: "Supervisor", blocks: [...introFor("Supervisor"), ...MANUAL_LOGIN, ...MANUAL_SUPERVISOR] },
  employee: { title: "Employee", blocks: [...introFor("Employees"), ...MANUAL_EMPLOYEE] },
};

// DOM ids are prefixed so manual anchors can't collide with ids on the page
// underneath the modal.
const anchorId = (id: string) => `help-${id}`;

type Heading = Extract<Block, { type: "heading" }>;

function figureLabel(block: Extract<Block, { type: "figure" }>) {
  return `Figure ${block.number}. ${block.caption}`;
}

function headingLabel(block: Heading) {
  return block.number ? `${block.number} ${block.text}` : block.text;
}

// Scrollable reader for the role's section of the user manual (Appendix J).
// Closing it only unmounts the modal, so the page underneath keeps its state.
// Default export so the layout can lazy-load it with the manual text.
export default function HelpManualModal({
  audience,
  onClose,
}: {
  audience: ManualAudience;
  onClose: () => void;
}) {
  const { title, blocks } = MANUALS[audience];
  const contentRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // The layout re-renders on every notification poll with a fresh onClose;
  // keep it in a ref so focus is only moved once, when the manual opens.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Enlarged screenshot; Esc closes it first, then the manual.
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const zoomedRef = useRef(zoomed);
  zoomedRef.current = zoomed;

  useEffect(() => {
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (zoomedRef.current) setZoomed(null);
      else onCloseRef.current();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const tocEntries = blocks.filter(
    (block): block is Extract<Block, { type: "heading" | "figure" }> =>
      block.type === "heading" || block.type === "figure",
  );
  const headings = blocks.filter((block): block is Heading => block.type === "heading");

  const jumpTo = (id: string) => {
    const target = contentRef.current?.querySelector<HTMLElement>(`#${anchorId(id)}`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="help-manual-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="help-manual" role="dialog" aria-modal="true" aria-labelledby="help-manual-title">
        <header className="help-manual-header">
          <div>
            <h2 id="help-manual-title">User Manual</h2>
            <p>{title}</p>
          </div>
          <button ref={closeRef} type="button" className="help-manual-close" onClick={onClose} aria-label="Close user manual">
            <X size={18} />
          </button>
        </header>

        <div className="help-manual-body">
          <nav className="help-manual-toc" aria-label="Manual contents">
            <p className="help-manual-toc-caption">Contents</p>
            {tocEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`help-manual-toc-link ${entry.type === "figure" ? "figure" : `level-${entry.level}`}`}
                onClick={() => jumpTo(entry.id)}
              >
                {entry.type === "figure" ? figureLabel(entry) : headingLabel(entry)}
              </button>
            ))}
          </nav>

          <select
            className="help-manual-jump"
            aria-label="Jump to section"
            value=""
            onChange={(event) => event.target.value && jumpTo(event.target.value)}
          >
            <option value="">Jump to section…</option>
            {headings.map((heading) => (
              <option key={heading.id} value={heading.id}>
                {headingLabel(heading)}
              </option>
            ))}
          </select>

          <div className="help-manual-content" ref={contentRef}>
            {blocks.map((block, index) => (
              <ManualBlockView key={index} block={block} onOpenImage={(src, alt) => setZoomed({ src, alt })} />
            ))}
          </div>
        </div>
      </div>

      {zoomed && (
        <div
          className="help-manual-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={zoomed.alt}
          onMouseDown={(event) => event.target === event.currentTarget && setZoomed(null)}
        >
          <img src={zoomed.src} alt={zoomed.alt} />
          <button type="button" className="help-manual-lightbox-close" onClick={() => setZoomed(null)} aria-label="Close picture" autoFocus>
            <X size={20} />
          </button>
        </div>
      )}
    </div>
  );
}

function ManualBlockView({ block, onOpenImage }: { block: Block; onOpenImage: (src: string, alt: string) => void }) {
  switch (block.type) {
    case "heading": {
      const text = headingLabel(block);
      return block.level === 1 ? (
        <h3 id={anchorId(block.id)} className="help-manual-h1">{text}</h3>
      ) : (
        <h4 id={anchorId(block.id)} className="help-manual-h2">{text}</h4>
      );
    }
    case "subheading":
      return <h5 className="help-manual-h3">{block.text}</h5>;
    case "paragraph":
      return <p className="help-manual-paragraph">{block.text}</p>;
    case "list":
      return (
        <ul className="help-manual-list">
          {block.items.map((item, index) => (
            <li key={index}>
              {item.lead && <strong>{item.lead}: </strong>}
              {item.text}
            </li>
          ))}
        </ul>
      );
    case "note":
      return (
        <div className="help-manual-note">
          <strong>Note: </strong>
          {block.text}
        </div>
      );
    case "figure":
      return (
        <figure id={anchorId(block.id)} className="help-manual-figure">
          {block.images.map((image) => (
            <button
              key={image.src}
              type="button"
              className="help-manual-figure-open"
              title="Click to enlarge"
              onClick={() => onOpenImage(image.src, figureLabel(block))}
            >
              <img src={image.src} width={image.width} height={image.height} loading="lazy" alt={figureLabel(block)} />
            </button>
          ))}
          <figcaption>{figureLabel(block)}</figcaption>
        </figure>
      );
    case "callouts":
      return (
        <ol className="help-manual-callouts">
          {block.items.map((item, index) => (
            <li key={index}>
              <span className="help-manual-callout-number">{item.n}</span>
              <div>
                {item.title && <strong>{item.title}</strong>}
                {item.text && <p>{item.text}</p>}
                {item.bullets && (
                  <ul>
                    {item.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>
      );
  }
}
