import { useState } from "react";
import { Download, FileText } from "lucide-react";

// An announcement's attached document (PDF, Word, …) — saved in the message
// as a `[name](data:...)` line by AnnouncementsTab. Browsers block opening
// data: URLs in a new tab, so it's shown as a file chip that downloads via a
// blob: URL instead (same approach as AnnouncementImage's Download button).
export function AnnouncementFile({ src, name }: { src: string; name: string }) {
  const [isDownloading, setIsDownloading] = useState(false);

  async function handleDownload() {
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      const blob = await (await fetch(src)).blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = name || "attachment";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <button type="button" className="announcement-file-chip" onClick={handleDownload} disabled={isDownloading} title={`Download ${name}`}>
      <FileText size={16} className="announcement-file-chip-icon" />
      <span className="announcement-file-chip-name">{name || "Attachment"}</span>
      <Download size={14} className="announcement-file-chip-download" />
    </button>
  );
}
