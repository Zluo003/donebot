import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Resvg } from "@resvg/resvg-js";

const root = fileURLToPath(new URL("..", import.meta.url));
const svg = readFileSync(join(root, "branding/donebot/app-icon.svg"), "utf8");
const macArtwork = svg.replace(/<svg\b[^>]*>/, tag => tag
  .replace(/\b(width|height)="[^"]*"/g, '$1="824"')
  .replace("<svg ", '<svg x="100" y="100" '));
const macSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="mac-icon-shape"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    <filter id="mac-icon-shadow" x="0" y="0" width="1024" height="1024" filterUnits="userSpaceOnUse">
      <feGaussianBlur stdDeviation="10"/><feOffset dy="8"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#000" opacity="0.18" filter="url(#mac-icon-shadow)"/>
  <g clip-path="url(#mac-icon-shape)">${macArtwork}</g>
</svg>`;
for (const name of ["build/icon.svg", "public/app-icon.svg"]) writeFileSync(join(root, name), svg);
const png = (size, source = svg) => new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng();
for (const [name, size] of [["build/icon-1024.png", 1024], ["electron/resources/app-icon.png", 512]]) {
  writeFileSync(join(root, name), png(size, macSvg));
}
for (const [name, size] of [["public/app-icon-192.png", 192], ["public/app-icon-512.png", 512], ["public/apple-touch-icon.png", 180]]) {
  writeFileSync(join(root, name), png(size));
}
for (const size of [16, 32, 64, 128, 256, 512]) {
  writeFileSync(join(root, `build/icon.iconset/icon_${size}x${size}.png`), png(size, macSvg));
  writeFileSync(join(root, `build/icon.iconset/icon_${size}x${size}@2x.png`), png(size * 2, macSvg));
}
const images = [16, 32, 48, 64, 128, 256].map(size => ({ size, data: png(size) }));
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, data }, i) => {
  const entry = 6 + i * 16;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += data.length;
});
writeFileSync(join(root, "build/icon.ico"), Buffer.concat([header, ...images.map(({ data }) => data)]));
if (process.platform === "darwin") execFileSync("iconutil", ["-c", "icns", join(root, "build/icon.iconset"), "-o", join(root, "build/icon.icns")]);
console.log("Generated DoneBot application icons.");
