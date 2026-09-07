const MAX_DIMENSION = 2000;

/** Caps an image file's longest edge at 2000px before upload — saves
 * bandwidth on the free tier and keeps Gemini's input size reasonable.
 * Returns the original file unchanged if it's already small enough or
 * isn't a format `<canvas>` can decode/re-encode. */
export async function downscaleImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const longestEdge = Math.max(bitmap.width, bitmap.height);
  if (longestEdge <= MAX_DIMENSION) {
    bitmap.close();
    return file;
  }

  const scale = MAX_DIMENSION / longestEdge;
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

  const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outputType, 0.85));
  if (!blob) return file;

  const extension = outputType === "image/png" ? "png" : "jpg";
  const name = file.name.replace(/\.[^.]+$/, "") + `.${extension}`;
  return new File([blob], name, { type: outputType });
}
