import { useState } from "react";
import { createPortal } from "react-dom";
import { Download, Eye, X } from "lucide-react";
import "./AnnouncementImage.css";

// Picks a sane download filename: keeps the original name if it already has
// an extension, otherwise derives one from the blob's mime type.
function downloadFileName(name: string, mimeType: string) {
  if (/\.[a-zA-Z0-9]+$/.test(name)) return name;
  const extension = mimeType.split("/")[1]?.split("+")[0];
  return extension ? `${name}.${extension}` : name;
}

// Renders an announcement's inline image as a clickable thumbnail (with a
// "Tap to view" hint over it) that opens a full-size lightbox with an
// explicit Download action — used by both AnnouncementsTab's own View modal
// and the employee-facing NotificationDetailModal (renderFormattedText in
// lib/richText.ts is shared by both). Portaled to document.body so the
// lightbox's fixed positioning isn't trapped by an ancestor modal's own
// stacking context.
export function AnnouncementImage({ src, alt }: { src: string; alt: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const fileName = alt || "image";

  // A plain `<a href={dataUri} download>` is unreliable for data: URIs in
  // Safari (and WebKit-based embedded browsers) — it just navigates to the
  // image instead of saving it. Converting to a blob: URL first is the
  // cross-browser-reliable way to force an actual download.
  async function handleDownload() {
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = downloadFileName(fileName, blob.type);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Last resort — opens the image in a new tab so the user can still
      // right-click/long-press to save it manually.
      window.open(src, "_blank", "noopener,noreferrer");
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <>
      <span
        className="announcement-image-thumb-wrap"
        role="button"
        tabIndex={0}
        onClick={() => setIsOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setIsOpen(true);
          }
        }}
      >
        <img src={src} alt={alt} className="announcement-inline-image" />
        <span className="announcement-image-tap-hint">
          <Eye size={13} /> Tap to view
        </span>
      </span>
      {isOpen &&
        createPortal(
          <div
            className="announcement-image-lightbox-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={fileName}
            onClick={() => setIsOpen(false)}
          >
            <div className="announcement-image-lightbox" onClick={(e) => e.stopPropagation()}>
              <img src={src} alt={alt} className="announcement-image-lightbox-img" />
              <div className="announcement-image-lightbox-actions">
                <button
                  type="button"
                  className="announcement-image-lightbox-download"
                  onClick={handleDownload}
                  disabled={isDownloading}
                >
                  <Download size={14} /> {isDownloading ? "Downloading…" : "Download"}
                </button>
                <button
                  type="button"
                  className="announcement-image-lightbox-close"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
