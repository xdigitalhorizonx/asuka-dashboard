#!/usr/bin/env node
// Generates the "Add to Home Screen" icon set for Central Dogma.
//
// Zero dependencies: hand-authored 32x32 pixel art, encoded to PNG with
// node:zlib. Run `node scripts/make-icons.mjs` from anywhere; output paths
// are resolved relative to the repo root.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// ART — edit here.
// ---------------------------------------------------------------------------

// Chibi Asuka Langley Soryu, front-facing, head + shoulders.
// 32 rows x 32 columns. Every cell must be a key in PALETTE.
const GRID = [
  "..............................~~", // 0
  "......#####..........#####...~~~", // 1
  "......#Rrx#.########.#xrR#..~~~.", // 2
  "..*...#rrx##hhhooooo##xrr#.~~~..", // 3
  ".......#rrxohhhhoooooxrr#.~~~...", // 4
  ".......#rrxohhhooooooxrr#~~~....", // 5
  ".......#dddhoooooooooddd#~~.....", // 6
  "......#ooohoooooooooooooo#......", // 7
  ".....#oooooooooooooooooooo#.....", // 8
  "....#ohoooooooooooooooooooo#....", // 9
  "....#oho#oooootoooooooo#oho#..+.", // 10
  "....#oho#ooooottooooooo#oho#....", // 11
  ".+..#ohd#tdttdtttdttdtt#dho#....", // 12
  "....#ohd#teesssssssseet#dho#....", // 13
  "....#ood#tssessssssesst#doo#....", // 14
  "....#ood#sskksssssskkss#doo#....", // 15
  "....#ood#sswbsssssswbss#doo#....", // 16
  "....#ood#ssbkssssssbkss#doo#....", // 17
  "....#ood#ssbkssssssbkss#doo#....", // 18
  "....#ood#ssBBssssssBBss#doo#....", // 19
  "....#ood#sppsssmsmsspps#doo#....", // 20
  "....#ood#sssssssmssssss#doo#....", // 21
  "....#ood##tsssssssssst##doo#..*.", // 22
  "....#ood#.##tsssssst##.#doo#....", // 23
  "....#ood#..##tttttt##..#doo#....", // 24
  "....#ood#...#ssssss#...#doo#....", // 25
  "....#ood#...#gggggg#...#doo#....", // 26
  "...~#ood#.#CccccccccC#.#doo#....", // 27
  "..~~#ood##CccccllccccC##doo#....", // 28
  ".~~~#ood#CcccccllcccccC#doo#....", // 29
  "~~~.#ood#CcccccllcccccC#doo#....", // 30
  "~~..#ood#CcccccllcccccC#doo#....", // 31
];

const PALETTE = {
  ".": "#17122a", // background, deep plum
  "~": "#3b2f5e", // soft lavender band
  "*": "#cdb8ff", // sparkle, lavender
  "+": "#ffa3b5", // sparkle, pink
  "#": "#2a1b2e", // outline
  o: "#f5893a", // hair base (Asuka orange)
  d: "#cf5f22", // hair shadow
  h: "#ffb56a", // hair highlight
  r: "#e8323f", // A10 clip red
  R: "#ff7a83", // clip highlight
  x: "#a3141f", // clip dark edge
  s: "#ffe3cf", // skin
  t: "#f1c3a4", // skin shadow
  b: "#4c9bff", // iris blue
  B: "#2a5fd6", // iris dark blue
  k: "#0e0b16", // pupil / lash line
  w: "#ffffff", // eye highlight
  e: "#8a4a2a", // eyebrow
  m: "#8c2f3f", // mouth
  p: "#ffb6c4", // blush
  c: "#d8283a", // plugsuit red
  C: "#8f1420", // plugsuit dark edge
  g: "#b6f0c6", // neck ring, pale green
  l: "#f2f2f2", // chest panel
};

const BACKGROUND = PALETTE["."];
const SIZE = 32;

// The "~" band in GRID follows the anti-diagonal x + y in [30, 32]. The
// maskable render continues it into the padding so the art's square edge
// does not show. Set to null to pad with the plain background instead.
const BAND_DIAGONAL = [30, 32];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function validateGrid(grid) {
  if (grid.length !== SIZE) throw new Error(`grid must have ${SIZE} rows, got ${grid.length}`);
  grid.forEach((row, y) => {
    if (row.length !== SIZE) throw new Error(`row ${y} must have ${SIZE} chars, got ${row.length}`);
    for (const ch of row) {
      if (!(ch in PALETTE)) throw new Error(`row ${y}: unknown palette key "${ch}"`);
    }
  });
}

/** Nearest-neighbour scale of the 32x32 grid to outSize x outSize RGB. */
function render(grid, outSize) {
  const rgb = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, hexToRgb(v)]));
  const px = Buffer.alloc(outSize * outSize * 3);
  for (let y = 0; y < outSize; y++) {
    const sy = Math.floor((y * SIZE) / outSize);
    for (let x = 0; x < outSize; x++) {
      const sx = Math.floor((x * SIZE) / outSize);
      const [r, g, b] = rgb[grid[sy][sx]];
      const i = (y * outSize + x) * 3;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
    }
  }
  return { width: outSize, height: outSize, px };
}

/** Art scaled by an integer factor, centred in a canvas padded with the background colour. */
function renderMaskable(grid, canvas, scale) {
  const art = SIZE * scale;
  const offset = Math.floor((canvas - art) / 2);
  const [br, bg, bb] = hexToRgb(BACKGROUND);
  const rgb = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, hexToRgb(v)]));
  const px = Buffer.alloc(canvas * canvas * 3);
  for (let y = 0; y < canvas; y++) {
    for (let x = 0; x < canvas; x++) {
      const ax = x - offset;
      const ay = y - offset;
      const gx = Math.floor(ax / scale);
      const gy = Math.floor(ay / scale);
      let c;
      if (gx < 0 || gy < 0 || gx >= SIZE || gy >= SIZE) {
        const onBand = BAND_DIAGONAL && gx + gy >= BAND_DIAGONAL[0] && gx + gy <= BAND_DIAGONAL[1];
        c = onBand ? rgb["~"] : [br, bg, bb];
      } else {
        c = rgb[grid[gy][gx]];
      }
      const i = (y * canvas + x) * 3;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
    }
  }
  return { width: canvas, height: canvas, px };
}

// ---------------------------------------------------------------------------
// PNG encoding (8-bit RGB, colour type 2, no alpha)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng({ width, height, px }) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // One filter byte (0 = None) per scanline, then raw RGB.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");

const OUTPUTS = [
  { file: "public/apple-touch-icon.png", image: () => render(GRID, 180) },
  { file: "public/icons/icon-32.png", image: () => render(GRID, 32) },
  { file: "public/icons/icon-64.png", image: () => render(GRID, 64) },
  { file: "public/icons/icon-192.png", image: () => render(GRID, 192) },
  { file: "public/icons/icon-512.png", image: () => render(GRID, 512) },
  { file: "public/icons/icon-512-maskable.png", image: () => renderMaskable(GRID, 512, 12) },
];

validateGrid(GRID);
for (const { file, image } of OUTPUTS) {
  const abs = join(ROOT, file);
  mkdirSync(dirname(abs), { recursive: true });
  const png = encodePng(image());
  writeFileSync(abs, png);
  console.log(`${relative(process.cwd(), abs) || file}  (${png.length} bytes)`);
}
