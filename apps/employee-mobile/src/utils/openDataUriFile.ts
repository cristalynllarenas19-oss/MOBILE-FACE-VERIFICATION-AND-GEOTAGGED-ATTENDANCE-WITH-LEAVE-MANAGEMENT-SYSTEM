// Opens an announcement's attached document (a data: URI) — writes it to the
// cache and hands it to the share sheet, where the employee can open it in a
// PDF/Office viewer or save it to Files. Uses the legacy file-system module
// for its base64 write, same as downloadImage.ts.
import { EncodingType, cacheDirectory, writeAsStringAsync } from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

const DATA_URI_REGEX = /^data:([^;]+);base64,(.+)$/;

export async function openDataUriFile(dataUri: string, name: string) {
  const match = dataUri.match(DATA_URI_REGEX);
  if (!match) throw new Error("This file can't be opened.");
  const [, mimeType, base64] = match;

  const safeName = (name || "attachment").replace(/[\\/:*?"<>|]/g, "_");
  const fileUri = `${cacheDirectory}${Date.now()}-${safeName}`;
  await writeAsStringAsync(fileUri, base64, { encoding: EncodingType.Base64 });

  if (!(await Sharing.isAvailableAsync())) throw new Error("Opening files isn't supported on this device.");
  await Sharing.shareAsync(fileUri, { mimeType, dialogTitle: safeName });
}
