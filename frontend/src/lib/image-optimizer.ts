/**
 * Client-side image optimizer: resizes and re-encodes images in the
 * browser before upload so heavy originals never leave the user's
 * machine. Targets WebP under MAX_OPTIMIZED_BYTES by stepping quality
 * down; throws if the image cannot be brought under the limit.
 */

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024; // refuse absurd inputs outright
export const MAX_OPTIMIZED_BYTES = 500 * 1024; // frontend target; backend bucket allows 600 KB
export const MAX_DIMENSION = 1920; // longest edge after resize

const QUALITY_STEPS = [0.82, 0.72, 0.6, 0.5, 0.4];

/**
 * Below this longest edge a photo reads soft on a product card. The check is
 * DETERMINISTIC — pixels alone decide — so the same file always warns the
 * same way, and it only ever WARNS: refusing a small image would be the
 * panel deciding what a photo is worth, and upscaling it would be inventing
 * pixels the camera never captured. Neither happens.
 */
export const MIN_QUALITY_DIMENSION = 500;

/** Never upscales: a small image keeps its size. Invention is not correction. */
export function targetDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function isLowResolution(width: number, height: number): boolean {
  return Math.max(width, height) < MIN_QUALITY_DIMENSION;
}

export interface OptimizedImage {
  blob: Blob;
  fileName: string;
  originalBytes: number;
  optimizedBytes: number;
  width: number;
  height: number;
  /** Longest edge under MIN_QUALITY_DIMENSION — will look soft on a card. */
  lowResolution: boolean;
  /** The WebP quality step that fit the byte budget; the caller reports it. */
  quality: number;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function loadBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`"${file.name}" is not a readable image file`);
  }
}

function encodeCanvas(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
}

export async function optimizeImage(file: File): Promise<OptimizedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`"${file.name}" is not an image`);
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(
      `"${file.name}" is ${formatBytes(file.size)} — larger than the ${formatBytes(MAX_SOURCE_BYTES)} input limit`,
    );
  }

  const bitmap = await loadBitmap(file);

  const { width, height } = targetDimensions(bitmap.width, bitmap.height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Canvas is not available in this browser');
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let best: Blob | null = null;
  let usedQuality = QUALITY_STEPS[0];
  for (const quality of QUALITY_STEPS) {
    const blob = await encodeCanvas(canvas, quality);
    if (!blob) continue;
    best = blob;
    usedQuality = quality;
    if (blob.size <= MAX_OPTIMIZED_BYTES) break;
  }

  if (!best) {
    throw new Error(`"${file.name}" could not be encoded`);
  }
  if (best.size > MAX_OPTIMIZED_BYTES) {
    throw new Error(
      `"${file.name}" is still ${formatBytes(best.size)} after maximum compression — the ${formatBytes(MAX_OPTIMIZED_BYTES)} limit protects website performance`,
    );
  }

  const baseName = file.name.replace(/\.[^.]+$/, '');
  return {
    blob: best,
    fileName: `${baseName}.webp`,
    originalBytes: file.size,
    optimizedBytes: best.size,
    width,
    height,
    lowResolution: isLowResolution(width, height),
    quality: usedQuality,
  };
}
