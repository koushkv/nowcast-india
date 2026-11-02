// Minimal, exact PNG decoder (no colour management, no alpha premultiplication).
// Radar tiles encode reflectivity in their colours, so we need the exact bytes the server sent;
// a canvas round-trip can shift semi-transparent colours. Falls back to canvas decoding when
// the stream API is missing or the PNG uses a feature we do not implement (Adam7 interlace).

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(bytes) {
  // PNG IDAT is a zlib stream == CompressionStream "deflate" format.
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export async function decodePNG(buffer) {
  const u8 = new Uint8Array(buffer);
  for (let i = 0; i < 8; i++) if (u8[i] !== SIG[i]) throw new Error('Not a PNG');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 8;
  let width = 0, height = 0, bitDepth = 8, colorType = 6, interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatLen = 0;
  while (pos + 8 <= u8.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
    const data = u8.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      bitDepth = u8[pos + 16];
      colorType = u8[pos + 17];
      interlace = u8[pos + 20];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
      idatLen += data.length;
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (interlace) throw new Error('Interlaced PNG not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('Unsupported PNG colour type ' + colorType);
  const joined = new Uint8Array(idatLen);
  let off = 0;
  for (const c of idat) { joined.set(c, off); off += c.length; }
  const raw = await inflate(joined);

  const bpp = Math.max(1, (bitDepth * channels) >> 3); // bytes per complete pixel for filtering
  const stride = Math.ceil((width * bitDepth * channels) / 8);
  const scan = new Uint8Array(stride * height);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[rp++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rp++];
      const a = x >= bpp ? scan[row + x - bpp] : 0;
      const b = y > 0 ? scan[prev + x] : 0;
      const c = x >= bpp && y > 0 ? scan[prev + x - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: v = rawByte + paeth(a, b, c); break;
        default: throw new Error('Bad PNG filter ' + ft);
      }
      scan[row + x] = v & 255;
    }
  }

  const out = new Uint8ClampedArray(width * height * 4);
  const sample = (row, i) => {
    // returns the i-th sample (0..255 scaled) of the row
    if (bitDepth === 8) return scan[row + i];
    if (bitDepth === 16) return scan[row + i * 2];
    const perByte = 8 / bitDepth;
    const byte = scan[row + Math.floor(i / perByte)];
    const shift = 8 - bitDepth * ((i % perByte) + 1);
    const v = (byte >> shift) & ((1 << bitDepth) - 1);
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << bitDepth) - 1));
  };
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        const s = x * 4;
        out[o] = sample(row, s); out[o + 1] = sample(row, s + 1); out[o + 2] = sample(row, s + 2); out[o + 3] = sample(row, s + 3);
      } else if (colorType === 2) {
        const s = x * 3;
        const r = sample(row, s), g = sample(row, s + 1), b = sample(row, s + 2);
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
        out[o + 3] = trns && trns.length >= 6 && r === trns[1] && g === trns[3] && b === trns[5] ? 0 : 255;
      } else if (colorType === 3) {
        const idx = sample(row, x);
        out[o] = palette ? palette[idx * 3] : 0;
        out[o + 1] = palette ? palette[idx * 3 + 1] : 0;
        out[o + 2] = palette ? palette[idx * 3 + 2] : 0;
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        const g = sample(row, x);
        out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255;
      } else if (colorType === 4) {
        const g = sample(row, x * 2);
        out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = sample(row, x * 2 + 1);
      }
    }
  }
  return { width, height, data: out };
}

async function decodeWithCanvas(buffer) {
  const blob = new Blob([buffer], { type: 'image/png' });
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** Decode PNG bytes to RGBA, exactly when possible. */
export async function decodeImage(buffer) {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      return await decodePNG(buffer);
    } catch (e) {
      if (typeof createImageBitmap === 'undefined') throw e;
    }
  }
  return decodeWithCanvas(buffer);
}
