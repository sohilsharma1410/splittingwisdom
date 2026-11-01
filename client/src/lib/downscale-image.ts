const MAX_DIMENSION = 2000;
/** Formats the server accepts, and the size above which even a small-edged photo is re-encoded. */
const SERVER_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_PASSTHROUGH_BYTES = 3 * 1024 * 1024;

/** Camera captures can arrive with no type, "image/jpg" or HEIC; work out what they are from the name. */
function imageTypeOf(file: File): string {
  if (file.type.startsWith("image/")) return file.type === "image/jpg" ? "image/jpeg" : file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return file.type;
}

/** Caps an image file's longest edge at 2000px before upload — saves
 * bandwidth on the free tier and keeps Gemini's input size reasonable.
 * Returns the original file unchanged if it's already small enough or
 * isn't a format `<canvas>` can decode/re-encode. */
export async function downscaleImage(file: File): Promise<File> {
  const type = imageTypeOf(file);
  if (!type.startsWith("image/")) return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  // Small photos in a format the server takes go up as they are, with the type fixed if the
  // camera mislabelled it. Anything else (HEIC, huge files, odd labels) is re-encoded as JPEG.
  const longestEdge = Math.max(bitmap.width, bitmap.height);
  if (longestEdge <= MAX_DIMENSION && SERVER_TYPES.includes(type) && file.size <= MAX_PASSTHROUGH_BYTES) {
    bitmap.close();
    return file.type === type ? file : new File([file], file.name, { type });
  }

  const scale = Math.min(1, MAX_DIMENSION / longestEdge);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const outputType = type === "image/png" && file.size <= MAX_PASSTHROUGH_BYTES ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outputType, 0.85));
  if (!blob) return file;

  const extension = outputType === "image/png" ? "png" : "jpg";
  const name = file.name.replace(/\.[^.]+$/, "") + `.${extension}`;
  return new File([blob], name, { type: outputType });
}
