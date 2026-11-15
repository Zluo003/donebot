import { parentPort, workerData } from "node:worker_threads";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_SIDE = 2048;

function resize(data: Uint8Array, width: number, height: number) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return { data, width, height };
  const output = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = (x + 0.5) * width / w - 0.5, sy = (y + 0.5) * height / h - 0.5;
    const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const dx = Math.max(0, sx - x0), dy = Math.max(0, sy - y0);
    for (let channel = 0; channel < 4; channel++) {
      const a = data[(y0 * width + x0) * 4 + channel]! * (1 - dx) + data[(y0 * width + x1) * 4 + channel]! * dx;
      const b = data[(y1 * width + x0) * 4 + channel]! * (1 - dx) + data[(y1 * width + x1) * 4 + channel]! * dx;
      output[(y * w + x) * 4 + channel] = Math.round(a * (1 - dy) + b * dy);
    }
  }
  return { data: output, width: w, height: h };
}

function prepare(bytes: Buffer, mime: string): { bytes: Uint8Array; mime: string } {
  if (mime !== "image/png" && mime !== "image/jpeg") return { bytes, mime };
  // jpeg-js 0.4.4 does not apply the orientation stored in JPEG EXIF.
  if (mime === "image/jpeg" && bytes.includes(Buffer.from("Exif\0\0"))) return { bytes, mime };
  if (mime === "image/png" && (bytes.length < 33 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > MAX_PIXELS || bytes.includes(Buffer.from("acTL")))) return { bytes, mime };
  const decoded = mime === "image/png" ? PNG.sync.read(bytes) : jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 32, maxMemoryUsageInMB: 256 });
  if (decoded.width * decoded.height > MAX_PIXELS) return { bytes, mime };
  let transparent = false;
  for (let i = 3; i < decoded.data.length; i += 4) if (decoded.data[i] !== 255) { transparent = true; break; }
  if (transparent) return { bytes, mime };
  const scaled = resize(decoded.data, decoded.width, decoded.height);
  const encoded = jpeg.encode({ ...scaled, data: Buffer.from(scaled.data) }, 85).data;
  return encoded.length < bytes.length ? { bytes: encoded, mime: "image/jpeg" } : { bytes, mime };
}

if (parentPort) {
  try { parentPort.postMessage(prepare(Buffer.from(workerData.bytes), workerData.mime)); }
  catch { parentPort.postMessage({ bytes: workerData.bytes, mime: workerData.mime }); }
}
