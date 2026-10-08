// The new expo-file-system API (SDK 54) dropped writeAsStringAsync's
// base64 encoding option, so this intentionally reaches for the legacy
// module — Expo keeps it importable specifically for cases like this.
import { EncodingType, cacheDirectory, writeAsStringAsync } from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";

const DATA_URI_REGEX = /^data:([^;]+);base64,(.+)$/;

// Saves a data: URI image straight to the device's Photos — no share sheet,
// no extra tap. `true` on requestPermissionsAsync asks for the write-only
// "Add Photos" permission (NSPhotoLibraryAddUsageDescription on iOS)
// instead of full gallery read access, since this never needs to read
// anything back.
export async function saveDataUriToDevice(dataUri: string, suggestedName: string) {
  const match = dataUri.match(DATA_URI_REGEX);
  if (!match) throw new Error("This image can't be downloaded.");
  const [, mimeType, base64] = match;

  const { status } = await MediaLibrary.requestPermissionsAsync(true);
  if (status !== "granted") {
    throw new Error("Allow photo access in Settings to save images.");
  }

  const extension = mimeType.split("/")[1]?.split("+")[0] || "jpg";
  const safeName = /\.[a-zA-Z0-9]+$/.test(suggestedName) ? suggestedName : `${suggestedName}.${extension}`;
  const fileUri = `${cacheDirectory}${Date.now()}-${safeName}`;

  await writeAsStringAsync(fileUri, base64, { encoding: EncodingType.Base64 });
  await MediaLibrary.saveToLibraryAsync(fileUri);
}
