import { describe, it, expect } from 'vitest';
import {
  targetDimensions,
  isLowResolution,
  formatBytes,
  MAX_DIMENSION,
  MIN_QUALITY_DIMENSION,
} from './image-optimizer';

/**
 * The optimizer's pure rules (Phase 8 D). What matters most is what it will
 * NOT do: a small photo is never upscaled — "correcting" an asset by
 * inventing pixels is exactly the kind of silent improvement this codebase
 * refuses — and the low-quality warning is deterministic, so the same file
 * warns the same way every time.
 */
describe('targetDimensions', () => {
  it('never upscales: a small image keeps exactly its size', () => {
    expect(targetDimensions(300, 200)).toEqual({ width: 300, height: 200 });
    expect(targetDimensions(1, 1)).toEqual({ width: 1, height: 1 });
    expect(targetDimensions(MAX_DIMENSION, 900)).toEqual({ width: MAX_DIMENSION, height: 900 });
  });

  it('clamps the LONGEST edge to the maximum, preserving proportion', () => {
    const clamped = targetDimensions(3840, 2160);
    expect(clamped.width).toBe(MAX_DIMENSION);
    expect(clamped.height).toBe(Math.round(2160 * (MAX_DIMENSION / 3840)));
    const portrait = targetDimensions(1000, 4000);
    expect(portrait.height).toBe(MAX_DIMENSION);
    expect(portrait.width).toBe(Math.round(1000 * (MAX_DIMENSION / 4000)));
  });
});

describe('isLowResolution', () => {
  it('is decided by the longest edge alone — deterministic, no heuristics', () => {
    expect(isLowResolution(MIN_QUALITY_DIMENSION - 1, MIN_QUALITY_DIMENSION - 1)).toBe(true);
    expect(isLowResolution(MIN_QUALITY_DIMENSION, 100)).toBe(false);
    expect(isLowResolution(100, MIN_QUALITY_DIMENSION)).toBe(false);
    expect(isLowResolution(4000, 3000)).toBe(false);
  });
});

describe('formatBytes', () => {
  it('reports real magnitudes, never zero for a non-empty file', () => {
    expect(formatBytes(500)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
