import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
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

// Every piece of text a block shows, for search.
function blockText(block: Block): string {
  switch (block.type) {
    case "heading":
      return headingLabel(block);
    case "subheading":
    case "paragraph":
    case "note":
      return block.text;
    case "list":
      return block.items.map((item) => `${item.lead} ${item.text}`).join(" ");
    case "figure":
      return figureLabel(block);
    case "callouts":
      return block.items.map((item) => `${item.title} ${item.text} ${(item.bullets ?? []).join(" ")}`).join(" ");
  }
}

// The manual split at every heading: search shows or hides whole sections
// (a heading with its text, pictures and callouts) so results keep context.
function toSections(blocks: Block[]) {
  const sections: { blocks: Block[]; text: string }[] = [];
  for (const block of blocks) {
    if (block.type === "heading" || sections.length === 0) sections.push({ blocks: [], text: "" });
    const section = sections[sections.length - 1];
    section.blocks.push(block);
    section.text += ` ${blockText(block).toLowerCase()}`;
  }
  return sections;
}

// Wraps every case-insensitive occurrence of the query in <mark>.
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(query, from);
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + query.length)}</mark>);
    from = at + query.length;
    at = lower.indexOf(query, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
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
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  // The layout re-renders on every notification poll with a fresh onClose;
  // keep it in a ref so focus is only moved once, when the manual opens.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Enlarged screenshot; Esc closes it first, then the manual.
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const zoomedRef = useRef(zoomed);
  zoomedRef.current = zoomed;

  useEffect(() => {
    searchRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (zoomedRef.current) setZoomed(null);
      else onCloseRef.current();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const sections = useMemo(() => toSections(blocks), [blocks]);
  const visibleSections = query ? sections.filter((section) => section.text.includes(query)) : sections;
  const visibleBlocks = visibleSections.flatMap((section) => section.blocks);
  const tocEntries = visibleBlocks.filter(
    (block): block is Extract<Block, { type: "heading" | "figure" }> =>
      block.type === "heading" || block.type === "figure",
  );
  const headings = visibleBlocks.filter((block): block is Heading => block.type === "heading");

  const jumpTo = (id: string) => {
    const target = contentRef.current?.querySelector<HTMLElement>(`#${anchorId(id)}`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // New results start from the top.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [query]);

  return (
    <div className="help-manual-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="help-manual" role="dialog" aria-modal="true" aria-labelledby="help-manual-title">
        <header className="help-manual-header">
          <div>
            <h2 id="help-manual-title">User Manual</h2>
            <p>{title}</p>
          </div>
          <div className="help-manual-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search the manual..."
              aria-label="Search the manual"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </div>
          <button type="button" className="help-manual-close" onClick={onClose} aria-label="Close user manual">
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
            {query && (
              <p className="help-manual-results" role="status">
                {visibleSections.length === 0
                  ? `No results for "${search.trim()}".`
                  : `${visibleSections.length} section${visibleSections.length === 1 ? "" : "s"} found for "${search.trim()}".`}
              </p>
            )}
            {visibleSections.map((section, sectionIndex) => (
              <Fragment key={sectionIndex}>
                {section.blocks.map((block, index) => (
                  <ManualBlockView
                    key={index}
                    block={block}
                    query={query}
                    onOpenImage={(src, alt) => setZoomed({ src, alt })}
                  />
                ))}
              </Fragment>
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

function ManualBlockView({
  block,
  query,
  onOpenImage,
}: {
  block: Block;
  query: string;
  onOpenImage: (src: string, alt: string) => void;
}) {
  const mark = (text: string) => highlight(text, query);
  switch (block.type) {
    case "heading": {
      const text = headingLabel(block);
      return block.level === 1 ? (
        <h3 id={anchorId(block.id)} className="help-manual-h1">{mark(text)}</h3>
      ) : (
        <h4 id={anchorId(block.id)} className="help-manual-h2">{mark(text)}</h4>
      );
    }
    case "subheading":
      return <h5 className="help-manual-h3">{mark(block.text)}</h5>;
    case "paragraph":
      return <p className="help-manual-paragraph">{mark(block.text)}</p>;
    case "list":
      return (
        <ul className="help-manual-list">
          {block.items.map((item, index) => (
            <li key={index}>
              {item.lead && <strong>{mark(item.lead)}: </strong>}
              {mark(item.text)}
            </li>
          ))}
        </ul>
      );
    case "note":
      return (
        <div className="help-manual-note">
          <strong>Note: </strong>
          {mark(block.text)}
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
          <figcaption>{mark(figureLabel(block))}</figcaption>
        </figure>
      );
    case "callouts":
      return (
        <ol className="help-manual-callouts">
          {block.items.map((item, index) => (
            <li key={index}>
              <span className="help-manual-callout-number">{item.n}</span>
              <div>
                {item.title && <strong>{mark(item.title)}</strong>}
                {item.text && <p>{mark(item.text)}</p>}
                {item.bullets && (
                  <ul>
                    {item.bullets.map((bullet) => (
                      <li key={bullet}>{mark(bullet)}</li>
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
