// Screen capture for desktop control. Primary display only.
// Capture comes from nut-js (raw BGRA); downscaling and PNG encoding are done here with node:zlib,
// so there is no extra image dependency.
import zlib from "node:zlib";
import { loadNut } from "./nut.js";

export const MAX_LONG_EDGE = 1280;

export interface ScreenCapture {
  /** base64 PNG (no data: prefix), long edge at most 1280 px. */
  png: string;
  /** Size of the PNG in pixels. */
  width: number;
  height: number;
  /** Multiply a screenshot x / y by these to get real input coordinates (points on Retina displays). */
  scaleX: number;
  scaleY: number;
  /** True when every sampled pixel has (nearly) the same colour: usually a missing screen-capture grant. */
  blank: boolean;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes tightly packed 8-bit RGB rows as a PNG. */
export function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Box-filter downscale of a BGRA/RGBA buffer to packed RGB. */
export function downscaleToRgb(
  src: Buffer, sw: number, sh: number, stride: number, channels: number, bgr: boolean, dw: number, dh: number,
): Buffer {
  const out = Buffer.alloc(dw * dh * 3);
  const fx = sw / dw;
  const fy = sh / dh;
  const nx = Math.max(1, Math.min(3, Math.round(fx)));
  const ny = Math.max(1, Math.min(3, Math.round(fy)));
  const r0 = bgr ? 2 : 0;
  const b0 = bgr ? 0 : 2;
  let o = 0;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < ny; j++) {
        const sy = Math.min(sh - 1, Math.floor((y + (j + 0.5) / ny) * fy));
        for (let i = 0; i < nx; i++) {
          const sx = Math.min(sw - 1, Math.floor((x + (i + 0.5) / nx) * fx));
          const p = sy * stride + sx * channels;
          r += src[p + r0];
          g += src[p + 1];
          b += src[p + b0];
        }
      }
      const n = nx * ny;
      out[o++] = (r / n) | 0;
      out[o++] = (g / n) | 0;
      out[o++] = (b / n) | 0;
    }
  }
  return out;
}

function isBlank(rgb: Buffer, w: number, h: number): boolean {
  let min = 255, max = 0;
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 40)))
    for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 60))) {
      const p = (y * w + x) * 3;
      const v = (rgb[p] + rgb[p + 1] + rgb[p + 2]) / 3;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  return max - min < 6;
}

export async function captureScreen(): Promise<ScreenCapture> {
  const nut = await loadNut();
  const img = await nut.screen.grab();
  // Input coordinates use the logical screen size (points on macOS), not screenshot pixels.
  const [inputW, inputH] = await Promise.all([nut.screen.width(), nut.screen.height()]);
  const k = Math.min(1, MAX_LONG_EDGE / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * k));
  const height = Math.max(1, Math.round(img.height * k));
  const bgr = img.colorMode !== nut.ColorMode.RGB;
  const stride = img.byteWidth || img.width * img.channels;
  const rgb = downscaleToRgb(img.data, img.width, img.height, stride, img.channels, bgr, width, height);
  return {
    png: encodePng(rgb, width, height).toString("base64"),
    width,
    height,
    scaleX: (inputW || img.width) / width,
    scaleY: (inputH || img.height) / height,
    blank: isBlank(rgb, width, height),
  };
}
