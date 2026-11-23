/**
 * Self-describing, zero-dependency chunk codecs tuned for PostgreSQL 8 KiB pages.
 * Works identically in Node.js, Bun, Deno, and Browser WASM/OPFS.
 *
 * Wire format (first byte = codec tag):
 *   empty (0 bytes):         all-zero page (omitted from redb chunks table)
 *   0x00 (TAG_RAW):          raw bytes (trailing zeros trimmed)
 *   0x02 (TAG_LZ4):          LZ4 block stream (high compression ratio)
 *   0x03 (TAG_BITSPARSE32):  u32 word bitmap (1 bit / 4B word) + non-zero u32 words
 *   0x04 (TAG_BITSPARSE16):  u16 word bitmap (1 bit / 2B word) + non-zero u16 words
 *   0x05 (TAG_ZEROBYTEMASK): 2-level bitmap (64B block mask + 8B byte mask) + non-zero bytes
 *   0x06 (TAG_PGHOLE):       PostgreSQL 8 KiB page with verified [pd_lower..pd_upper) zero hole elided
 *   0x07 (TAG_SPLIT):        Multi-part chunk wrapper (used by SingleFileFS to avoid redb's 16 KiB cliff)
 */

const TAG_RAW = 0;
const TAG_LZ4 = 2;
const TAG_BITSPARSE32 = 3;
const TAG_BITSPARSE16 = 4;
const TAG_ZEROBYTEMASK = 5;
const TAG_PGHOLE = 6;
export const TAG_SPLIT = 7;

// Generation-tagged LZ4 hash table (eliminates per-page fill(-1) memset)
const LZ4_HASH_BITS = 10;
const LZ4_HASH_SIZE = 1 << LZ4_HASH_BITS;
const lz4HashPos = new Uint16Array(LZ4_HASH_SIZE);
const lz4HashGen = new Uint32Array(LZ4_HASH_SIZE);
let lz4Gen = 1;

/**
 * Fast 4x-unrolled 32-bit-word all-zero check on a page slice.
 */
export function isAllZero(buf, offset = 0, length = buf.byteLength - offset) {
  const absOff = buf.byteOffset + offset;
  let i = 0;
  if ((absOff & 3) === 0 && length >= 4) {
    const words = length >>> 2;
    const u32 = new Uint32Array(buf.buffer, absOff, words);
    let w = 0;
    const lim4 = words & ~3;
    for (; w < lim4; w += 4) {
      if ((u32[w] | u32[w + 1] | u32[w + 2] | u32[w + 3]) !== 0) return false;
    }
    for (; w < words; w++) {
      if (u32[w] !== 0) return false;
    }
    i = words << 2;
  }
  for (; i < length; i++) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

function trimmedLength(page) {
  let end = page.byteLength;
  const words = end >>> 2;
  if ((page.byteOffset & 3) === 0 && (end & 3) === 0) {
    const u32 = new Uint32Array(page.buffer, page.byteOffset, words);
    let w = words;
    while (w > 0 && u32[w - 1] === 0) w--;
    end = w << 2;
    while (end > 0 && page[end - 1] === 0) end--;
    return end;
  }
  while (end > 0 && page[end - 1] === 0) end--;
  return end;
}

function encodeRaw(page, scratch) {
  const end = trimmedLength(page);
  if (end === 0) return scratch.subarray(0, 0);
  scratch[0] = TAG_RAW;
  scratch.set(page.subarray(0, end), 1);
  return scratch.subarray(0, end + 1);
}

/**
 * BitSparse-u32: 1 bit per non-zero u32 word.
 * Header: [tag=3: u8][reserved=0: u8][maskWords: u16 LE][mask: maskWords*4B][non-zero u32 words...]
 */
function encodeBitSparse32(page, scratch) {
  const n = page.byteLength;
  if ((page.byteOffset & 3) !== 0 || (n & 3) !== 0) return encodeRaw(page, scratch);
  const words = n >>> 2;
  const u32 = new Uint32Array(page.buffer, page.byteOffset, words);
  let endWord = words;
  while (endWord > 0 && u32[endWord - 1] === 0) endWord--;
  if (endWord === 0) return scratch.subarray(0, 0);

  const maskWords = (endWord + 31) >>> 5;
  const outU32 = new Uint32Array(scratch.buffer, scratch.byteOffset, scratch.byteLength >>> 2);
  scratch[0] = TAG_BITSPARSE32;
  scratch[1] = 0;
  scratch[2] = maskWords & 0xff;
  scratch[3] = maskWords >>> 8;

  let dataIdx = 1 + maskWords;
  const rawLimitWords = endWord;
  for (let m = 0; m < maskWords; m++) {
    let bits = 0;
    const base = m << 5;
    const lim = Math.min(32, endWord - base);
    for (let b = 0; b < lim; b++) {
      const w = u32[base + b];
      if (w !== 0) {
        bits |= 1 << b;
        outU32[dataIdx++] = w;
      }
    }
    outU32[1 + m] = bits;
    if (dataIdx > rawLimitWords) return encodeRaw(page, scratch);
  }
  return scratch.subarray(0, dataIdx << 2);
}

/**
 * BitSparse-u16: 1 bit per non-zero u16 word.
 * Header: [tag=4: u8][reserved=0: u8][maskWords: u16 LE][mask: maskWords*4B][non-zero u16 words...]
 */
function encodeBitSparse16(page, scratch) {
  const n = page.byteLength;
  if ((page.byteOffset & 3) !== 0 || (n & 3) !== 0) return encodeRaw(page, scratch);
  const u32 = new Uint32Array(page.buffer, page.byteOffset, n >>> 2);
  let endU32 = n >>> 2;
  while (endU32 > 0 && u32[endU32 - 1] === 0) endU32--;
  if (endU32 === 0) return scratch.subarray(0, 0);

  const u16 = new Uint16Array(page.buffer, page.byteOffset, endU32 << 1);
  let endWord = endU32 << 1;
  if (u16[endWord - 1] === 0) endWord--;

  const maskWords = (endWord + 31) >>> 5;
  const outU32 = new Uint32Array(scratch.buffer, scratch.byteOffset, 1 + maskWords);
  const outU16 = new Uint16Array(scratch.buffer, scratch.byteOffset, scratch.byteLength >>> 1);
  scratch[0] = TAG_BITSPARSE16;
  scratch[1] = 0;
  scratch[2] = maskWords & 0xff;
  scratch[3] = maskWords >>> 8;

  let dataIdx16 = (1 + maskWords) << 1;
  const maxIdx16 = endWord;
  for (let m = 0; m < maskWords; m++) {
    let bits = 0;
    const base = m << 5;
    const lim = Math.min(32, endWord - base);
    for (let b = 0; b < lim; b++) {
      const w = u16[base + b];
      if (w !== 0) {
        bits |= 1 << b;
        outU16[dataIdx16++] = w;
      }
    }
    outU32[1 + m] = bits;
    if (dataIdx16 > maxIdx16) return encodeRaw(page, scratch);
  }
  return scratch.subarray(0, dataIdx16 << 1);
}

/**
 * Count zero bytes in a quick 16-word (64-byte) strided sample over [start, end).
 * Used to fast-bail dense/incompressible pages to TAG_PGHOLE or TAG_RAW in ~0.15 us.
 */
function sampleZeroBytes(page, start, end) {
  const span = end - start;
  if (span < 64) return 32; // too small to bail out
  const step = span >>> 4;
  let zeros = 0;
  for (let i = 0; i < 16; i++) {
    const p = start + i * step;
    if (page[p] === 0) zeros++;
    if (page[p + 1] === 0) zeros++;
    if (page[p + 2] === 0) zeros++;
    if (page[p + 3] === 0) zeros++;
  }
  return zeros; // out of 64 sampled bytes
}

/**
 * Hybrid PG-Page-Hole + ZeroByteMask (default 'sparse' / 'zerobytemask' codec):
 * 1. If the 8 KiB page has a PostgreSQL PageHeaderData signature (pd_pagesize_version == 0x2004)
 *    with a verified all-zero [pd_lower..pd_upper) hole AND dense active payload, emits TAG_PGHOLE
 *    via two Uint8Array.set() memcpys (~0.25 us encode & decode).
 * 2. If a non-PG page is clearly dense/incompressible (<10% sampled zero bytes), bails out to
 *    TAG_RAW immediately without scanning all 8 KiB (~0.2 us).
 * 3. Otherwise encodes with 2-level 64B-block + 8B-byte ZeroByteMask (skipping verified PG hole
 *    blocks in O(1)), stripping every zero byte across sparse PG structs/OIDs/tuples.
 *
 * TAG_PGHOLE header:
 *   [tag=6: u8][reserved=0: u8][lower: u16 LE][upper: u16 LE][prefix: lower B][suffix: rawEnd - upper B]
 * TAG_ZEROBYTEMASK header:
 *   [tag=5: u8][bmWords: u8][reserved: u16][blockMask: bmWords*4B][per-set-block: 8B byteMask + non-zero bytes]
 */
function encodeZeroByteMask(page, scratch) {
  const n = page.byteLength;
  if ((page.byteOffset & 3) !== 0 || (n & 63) !== 0) return encodeRaw(page, scratch);
  const words = n >>> 2;
  const u32 = new Uint32Array(page.buffer, page.byteOffset, words);
  let endU32 = words;
  while (endU32 > 0 && u32[endU32 - 1] === 0) endU32--;
  if (endU32 === 0) return scratch.subarray(0, 0);

  const rawTrimmedBytes = endU32 << 2;
  let holeBlkStart = -1;
  let holeBlkEnd = -1;

  // Fast path: PostgreSQL 8 KiB page hole detection (pd_pagesize_version == 0x2004)
  if (n === 8192 && page[18] === 0x04 && page[19] === 0x20) {
    const lower = page[12] | (page[13] << 8);
    const upper = page[14] | (page[15] << 8);
    if (lower >= 24 && upper <= 8192 && upper - lower >= 64 && isAllZero(page, lower, upper - lower)) {
      const suffixStart = upper;
      const suffixEnd = rawTrimmedBytes > suffixStart ? rawTrimmedBytes : suffixStart;
      const activeBytes = lower + (suffixEnd - suffixStart);
      // Sample active suffix (where tuple data lives); if dense (<16% zero bytes)
      // and TAG_PGHOLE fits under redb's 8,170 B leaf cliff, emit TAG_PGHOLE directly!
      const suffixLen = suffixEnd - suffixStart;
      if (
        6 + activeBytes < rawTrimmedBytes &&
        6 + activeBytes <= 8170 &&
        suffixLen >= 256 &&
        sampleZeroBytes(page, suffixStart, suffixEnd) <= 10
      ) {
        scratch[0] = TAG_PGHOLE;
        scratch[1] = 0;
        scratch[2] = lower & 0xff;
        scratch[3] = lower >>> 8;
        scratch[4] = upper & 0xff;
        scratch[5] = upper >>> 8;
        scratch.set(page.subarray(0, lower), 6);
        if (suffixLen > 0) {
          scratch.set(page.subarray(suffixStart, suffixEnd), 6 + lower);
        }
        return scratch.subarray(0, 6 + activeBytes);
      }
      // Otherwise skip 64B blocks completely inside the verified zero hole in O(1)
      holeBlkStart = (lower + 63) >>> 6;
      holeBlkEnd = upper >>> 6;
    }
  } else if (rawTrimmedBytes >= 2048 && sampleZeroBytes(page, 0, rawTrimmedBytes) <= 5) {
    // Non-PG dense/incompressible page (e.g. random TOAST/media/crypto): skip 8 KiB scan
    let end = rawTrimmedBytes;
    while (end > 0 && page[end - 1] === 0) end--;
    scratch[0] = TAG_RAW;
    scratch.set(page.subarray(0, end), 1);
    return scratch.subarray(0, end + 1);
  }

  const activeBlocks = (endU32 + 15) >>> 4; // 64-byte blocks up to last non-zero word
  const bmWords = (activeBlocks + 31) >>> 5;
  const outU32 = new Uint32Array(scratch.buffer, scratch.byteOffset, 1 + bmWords);

  scratch[0] = TAG_ZEROBYTEMASK;
  scratch[1] = bmWords;
  scratch[2] = 0;
  scratch[3] = 0;
  for (let g = 0; g < bmWords; g++) outU32[1 + g] = 0;

  let op = (1 + bmWords) << 2;
  const maxOut = rawTrimmedBytes;

  for (let blk = 0; blk < activeBlocks; blk++) {
    if (blk >= holeBlkStart && blk < holeBlkEnd) continue;
    const wBase = blk << 4;
    const any =
      u32[wBase] | u32[wBase + 1] | u32[wBase + 2] | u32[wBase + 3] |
      u32[wBase + 4] | u32[wBase + 5] | u32[wBase + 6] | u32[wBase + 7] |
      u32[wBase + 8] | u32[wBase + 9] | u32[wBase + 10] | u32[wBase + 11] |
      u32[wBase + 12] | u32[wBase + 13] | u32[wBase + 14] | u32[wBase + 15];
    if (any === 0) continue;

    outU32[1 + (blk >>> 5)] |= 1 << (blk & 31);
    const maskPos = op;
    op += 8;
    if (op >= maxOut) return encodeRaw(page, scratch);
    let lo = 0;
    for (let j = 0; j < 8; j++) {
      const w = u32[wBase + j];
      if (w === 0) continue;
      const sh = j << 2;
      const b0 = w & 0xff;
      if (b0 !== 0) { lo |= 1 << sh; scratch[op++] = b0; }
      const b1 = (w >>> 8) & 0xff;
      if (b1 !== 0) { lo |= 2 << sh; scratch[op++] = b1; }
      const b2 = (w >>> 16) & 0xff;
      if (b2 !== 0) { lo |= 4 << sh; scratch[op++] = b2; }
      const b3 = w >>> 24;
      if (b3 !== 0) { lo |= 8 << sh; scratch[op++] = b3; }
    }
    let hi = 0;
    for (let j = 0; j < 8; j++) {
      const w = u32[wBase + 8 + j];
      if (w === 0) continue;
      const sh = j << 2;
      const b0 = w & 0xff;
      if (b0 !== 0) { hi |= 1 << sh; scratch[op++] = b0; }
      const b1 = (w >>> 8) & 0xff;
      if (b1 !== 0) { hi |= 2 << sh; scratch[op++] = b1; }
      const b2 = (w >>> 16) & 0xff;
      if (b2 !== 0) { hi |= 4 << sh; scratch[op++] = b2; }
      const b3 = w >>> 24;
      if (b3 !== 0) { hi |= 8 << sh; scratch[op++] = b3; }
    }
    if (op >= maxOut) return encodeRaw(page, scratch);
    scratch[maskPos] = lo & 0xff;
    scratch[maskPos + 1] = (lo >>> 8) & 0xff;
    scratch[maskPos + 2] = (lo >>> 16) & 0xff;
    scratch[maskPos + 3] = (lo >>> 24) & 0xff;
    scratch[maskPos + 4] = hi & 0xff;
    scratch[maskPos + 5] = (hi >>> 8) & 0xff;
    scratch[maskPos + 6] = (hi >>> 16) & 0xff;
    scratch[maskPos + 7] = (hi >>> 24) & 0xff;
  }

  return scratch.subarray(0, op);
}

/**
 * Accelerated pure-JS LZ4 block encoder (generation-tagged hash table,
 * miss-step acceleration, 4-byte match extension, early raw bailout).
 */
function encodeLz4(page, scratch) {
  const rawEnd = trimmedLength(page);
  if (rawEnd === 0) return scratch.subarray(0, 0);
  if (rawEnd < 32) return encodeRaw(page, scratch);

  lz4Gen = (lz4Gen + 1) >>> 0;
  if (lz4Gen === 0) {
    lz4HashGen.fill(0);
    lz4Gen = 1;
  }
  const curGen = lz4Gen;
  const src = page;
  const maxOut = rawEnd - 16;

  scratch[0] = TAG_LZ4;
  let ip = 0;
  let anchor = 0;
  let op = 1;
  const limit = rawEnd - 12;
  let stepCount = 64;

  while (ip < limit) {
    const v = src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24);
    const h = (Math.imul(v, 2654435761) >>> (32 - LZ4_HASH_BITS)) & (LZ4_HASH_SIZE - 1);
    const ref = lz4HashGen[h] === curGen ? lz4HashPos[h] : -1;
    lz4HashPos[h] = ip;
    lz4HashGen[h] = curGen;

    if (
      ref < 0 ||
      ip - ref > 65535 ||
      src[ref] !== src[ip] ||
      src[ref + 1] !== src[ip + 1] ||
      src[ref + 2] !== src[ip + 2] ||
      src[ref + 3] !== src[ip + 3]
    ) {
      ip += stepCount++ >>> 6;
      continue;
    }
    stepCount = 64;

    const litLen = ip - anchor;
    const litExt = litLen >= 15 ? Math.floor((litLen - 15) / 255) + 1 : 0;
    if (op + 1 + litExt + litLen + 16 >= maxOut) return encodeRaw(page, scratch);

    const tokenPos = op++;
    if (litLen >= 15) {
      scratch[tokenPos] = 0xf0;
      let rem = litLen - 15;
      while (rem >= 255) {
        scratch[op++] = 255;
        rem -= 255;
      }
      scratch[op++] = rem;
    } else {
      scratch[tokenPos] = litLen << 4;
    }

    if (litLen > 0) {
      scratch.set(src.subarray(anchor, ip), op);
      op += litLen;
    }

    const dist = ip - ref;
    scratch[op++] = dist & 0xff;
    scratch[op++] = dist >>> 8;

    let mLen = 4;
    const maxM = rawEnd - 5 - ip;
    while (
      mLen + 4 <= maxM &&
      src[ref + mLen] === src[ip + mLen] &&
      src[ref + mLen + 1] === src[ip + mLen + 1] &&
      src[ref + mLen + 2] === src[ip + mLen + 2] &&
      src[ref + mLen + 3] === src[ip + mLen + 3]
    ) {
      mLen += 4;
    }
    while (mLen < maxM && src[ref + mLen] === src[ip + mLen]) mLen++;

    const encM = mLen - 4;
    const mExt = encM >= 15 ? Math.floor((encM - 15) / 255) + 1 : 0;
    if (op + mExt >= maxOut) return encodeRaw(page, scratch);
    if (encM >= 15) {
      scratch[tokenPos] |= 0x0f;
      let rem = encM - 15;
      while (rem >= 255) {
        scratch[op++] = 255;
        rem -= 255;
      }
      scratch[op++] = rem;
    } else {
      scratch[tokenPos] |= encM;
    }

    ip += mLen;
    anchor = ip;
  }

  const lastLit = rawEnd - anchor;
  const lastExt = lastLit >= 15 ? Math.floor((lastLit - 15) / 255) + 1 : 0;
  if (op + 1 + lastExt + lastLit >= rawEnd + 1) return encodeRaw(page, scratch);
  const tokenPos = op++;
  if (lastLit >= 15) {
    scratch[tokenPos] = 0xf0;
    let rem = lastLit - 15;
    while (rem >= 255) {
      scratch[op++] = 255;
      rem -= 255;
    }
    scratch[op++] = rem;
  } else {
    scratch[tokenPos] = lastLit << 4;
  }
  if (lastLit > 0) {
    scratch.set(src.subarray(anchor, rawEnd), op);
    op += lastLit;
  }
  return scratch.subarray(0, op);
}

/**
 * Encode a page into `scratch` (4-byte aligned, length >= page.length + 1024).
 * Returns a subarray view into `scratch` (length 0 means all-zero page).
 */
export function encodeChunk(page, mode, scratch) {
  if (mode === 'sparse' || mode === 'zerobytemask') return encodeZeroByteMask(page, scratch);
  if (mode === 'bitsparse32') return encodeBitSparse32(page, scratch);
  if (mode === 'bitsparse16') return encodeBitSparse16(page, scratch);
  if (mode === 'lz4') return encodeLz4(page, scratch);
  return encodeRaw(page, scratch);
}

/**
 * Decode any self-describing chunk directly into `dst`.
 * Safe for any `src.byteOffset` alignment (including unaligned WASM views).
 * Validates bounds and throws on malformed/truncated chunk payloads.
 */
export function decodeChunkInto(src, dst, zeroDst = false) {
  if (zeroDst) dst.fill(0);
  const n = src.byteLength;
  if (n === 0) return;
  const dstLen = dst.byteLength;

  const tag = src[0];
  if (tag === TAG_RAW) {
    if (n - 1 > dstLen) throw new Error('Corrupt pglite-singlefile-fs RAW chunk payload');
    dst.set(src.subarray(1), 0);
    return;
  }
  if (tag === TAG_PGHOLE) {
    if (n < 6) throw new Error('Corrupt pglite-singlefile-fs PGHOLE chunk header');
    const lower = src[2] | (src[3] << 8);
    const upper = src[4] | (src[5] << 8);
    if (lower > upper || upper > dstLen || 6 + lower > n) {
      throw new Error('Corrupt pglite-singlefile-fs PGHOLE chunk bounds');
    }
    const suffixLen = n - 6 - lower;
    if (upper + suffixLen > dstLen) {
      throw new Error('Corrupt pglite-singlefile-fs PGHOLE suffix overflow');
    }
    if (lower > 0) dst.set(src.subarray(6, 6 + lower), 0);
    if (suffixLen > 0) dst.set(src.subarray(6 + lower, n), upper);
    return;
  }
  if (tag === TAG_BITSPARSE32) {
    if (n < 4) throw new Error('Corrupt pglite-singlefile-fs BITSPARSE32 chunk header');
    const maskWords = src[2] | (src[3] << 8);
    const headerBytes = (1 + maskWords) << 2;
    if (headerBytes > n || (n & 3) !== 0) {
      throw new Error('Corrupt pglite-singlefile-fs BITSPARSE32 chunk bounds');
    }
    const dstWords = dstLen >>> 2;
    if ((src.byteOffset & 3) === 0 && (dst.byteOffset & 3) === 0) {
      const srcU32 = new Uint32Array(src.buffer, src.byteOffset, n >>> 2);
      const outU32 = new Uint32Array(dst.buffer, dst.byteOffset, dstWords);
      const srcWords = srcU32.length;
      let dataIdx = 1 + maskWords;
      for (let m = 0; m < maskWords; m++) {
        let bits = srcU32[1 + m];
        if (bits === 0) continue;
        const base = m << 5;
        while (bits !== 0) {
          const tz = 31 - Math.clz32(bits & -bits);
          const outPos = base + tz;
          if (outPos >= dstWords || dataIdx >= srcWords) {
            throw new Error('Corrupt pglite-singlefile-fs BITSPARSE32 chunk payload');
          }
          outU32[outPos] = srcU32[dataIdx++];
          bits &= bits - 1;
        }
      }
    } else {
      let dataPos = headerBytes;
      for (let m = 0; m < maskWords; m++) {
        const mp = (1 + m) << 2;
        let bits = src[mp] | (src[mp + 1] << 8) | (src[mp + 2] << 16) | (src[mp + 3] << 24);
        if (bits === 0) continue;
        const base = m << 5;
        while (bits !== 0) {
          const tz = 31 - Math.clz32(bits & -bits);
          const off = (base + tz) << 2;
          if (off + 4 > dstLen || dataPos + 4 > n) {
            throw new Error('Corrupt pglite-singlefile-fs BITSPARSE32 chunk payload');
          }
          dst[off] = src[dataPos];
          dst[off + 1] = src[dataPos + 1];
          dst[off + 2] = src[dataPos + 2];
          dst[off + 3] = src[dataPos + 3];
          dataPos += 4;
          bits &= bits - 1;
        }
      }
    }
    return;
  }
  if (tag === TAG_BITSPARSE16) {
    if (n < 4) throw new Error('Corrupt pglite-singlefile-fs BITSPARSE16 chunk header');
    const maskWords = src[2] | (src[3] << 8);
    const headerBytes = (1 + maskWords) << 2;
    if (headerBytes > n || (n & 1) !== 0) {
      throw new Error('Corrupt pglite-singlefile-fs BITSPARSE16 chunk bounds');
    }
    const dstU16Len = dstLen >>> 1;
    if ((src.byteOffset & 3) === 0 && (dst.byteOffset & 1) === 0) {
      const srcU32 = new Uint32Array(src.buffer, src.byteOffset, 1 + maskWords);
      const srcU16 = new Uint16Array(src.buffer, src.byteOffset, n >>> 1);
      const outU16 = new Uint16Array(dst.buffer, dst.byteOffset, dstU16Len);
      const srcU16Len = srcU16.length;
      let dataIdx16 = (1 + maskWords) << 1;
      for (let m = 0; m < maskWords; m++) {
        let bits = srcU32[1 + m];
        if (bits === 0) continue;
        const base = m << 5;
        while (bits !== 0) {
          const tz = 31 - Math.clz32(bits & -bits);
          const outPos = base + tz;
          if (outPos >= dstU16Len || dataIdx16 >= srcU16Len) {
            throw new Error('Corrupt pglite-singlefile-fs BITSPARSE16 chunk payload');
          }
          outU16[outPos] = srcU16[dataIdx16++];
          bits &= bits - 1;
        }
      }
    } else {
      let dataPos = headerBytes;
      for (let m = 0; m < maskWords; m++) {
        const mp = (1 + m) << 2;
        let bits = src[mp] | (src[mp + 1] << 8) | (src[mp + 2] << 16) | (src[mp + 3] << 24);
        if (bits === 0) continue;
        const base = m << 5;
        while (bits !== 0) {
          const tz = 31 - Math.clz32(bits & -bits);
          const off = (base + tz) << 1;
          if (off + 2 > dstLen || dataPos + 2 > n) {
            throw new Error('Corrupt pglite-singlefile-fs BITSPARSE16 chunk payload');
          }
          dst[off] = src[dataPos];
          dst[off + 1] = src[dataPos + 1];
          dataPos += 2;
          bits &= bits - 1;
        }
      }
    }
    return;
  }
  if (tag === TAG_ZEROBYTEMASK) {
    if (n < 4) throw new Error('Corrupt pglite-singlefile-fs ZEROBYTEMASK chunk header');
    const bmWords = src[1];
    let ip = (1 + bmWords) << 2;
    if (ip > n) throw new Error('Corrupt pglite-singlefile-fs ZEROBYTEMASK chunk bounds');
    for (let g = 0; g < bmWords; g++) {
      const mp = (1 + g) << 2;
      let bm = src[mp] | (src[mp + 1] << 8) | (src[mp + 2] << 16) | (src[mp + 3] << 24);
      if (bm === 0) continue;
      const grpBase = g << 5;
      while (bm !== 0) {
        const bit = 31 - Math.clz32(bm & -bm);
        bm &= bm - 1;
        const bBase = (grpBase + bit) << 6;
        if (ip + 8 > n || bBase + 64 > dstLen) {
          throw new Error('Corrupt pglite-singlefile-fs ZEROBYTEMASK block bounds');
        }
        let lo = src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24);
        let hi = src[ip + 4] | (src[ip + 5] << 8) | (src[ip + 6] << 16) | (src[ip + 7] << 24);
        ip += 8;
        while (lo !== 0) {
          const tz = 31 - Math.clz32(lo & -lo);
          if (ip >= n) throw new Error('Corrupt pglite-singlefile-fs ZEROBYTEMASK truncated');
          dst[bBase + tz] = src[ip++];
          lo &= lo - 1;
        }
        while (hi !== 0) {
          const tz = 31 - Math.clz32(hi & -hi);
          if (ip >= n) throw new Error('Corrupt pglite-singlefile-fs ZEROBYTEMASK truncated');
          dst[bBase + 32 + tz] = src[ip++];
          hi &= hi - 1;
        }
      }
    }
    return;
  }
  if (tag === TAG_LZ4) {
    let ip = 1;
    let op = 0;
    while (ip < n) {
      const tok = src[ip++];
      let litLen = tok >>> 4;
      if (litLen === 15) {
        let b;
        do {
          if (ip >= n) throw new Error('Corrupt pglite-singlefile-fs LZ4 literal length');
          b = src[ip++];
          litLen += b;
        } while (b === 255);
      }
      if (litLen > 0) {
        if (ip + litLen > n || op + litLen > dstLen) {
          throw new Error('Corrupt pglite-singlefile-fs LZ4 literal overflow');
        }
        dst.set(src.subarray(ip, ip + litLen), op);
        ip += litLen;
        op += litLen;
      }
      if (ip >= n) break;
      if (ip + 2 > n) throw new Error('Corrupt pglite-singlefile-fs LZ4 match distance');
      const dist = src[ip] | (src[ip + 1] << 8);
      ip += 2;
      if (dist === 0 || dist > op) {
        throw new Error('Corrupt pglite-singlefile-fs LZ4 invalid distance');
      }
      let mLen = (tok & 0x0f) + 4;
      if (mLen === 19) {
        let b;
        do {
          if (ip >= n) throw new Error('Corrupt pglite-singlefile-fs LZ4 match length');
          b = src[ip++];
          mLen += b;
        } while (b === 255);
      }
      if (op + mLen > dstLen) {
        throw new Error('Corrupt pglite-singlefile-fs LZ4 match overflow');
      }
      let ref = op - dist;
      if (dist >= mLen) {
        dst.copyWithin(op, ref, ref + mLen);
        op += mLen;
      } else {
        for (let k = 0; k < mLen; k++) {
          dst[op++] = dst[ref++];
        }
      }
    }
    return;
  }
  throw new Error(`Unknown pglite-singlefile-fs chunk codec tag: ${tag}`);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Compact binary inode encoding:
 *   [version=1: u8][ino: u32 LE][mode: u32 LE][size: f64 LE][mtime: f64 LE][pathLen: u16 LE][path UTF-8]
 *   pathLen = 0xffff represents path === null (unlinked while open).
 */
export function encodeNodeBinary(n, scratch) {
  const isNull = n.path === null;
  const pathBytes = isNull ? null : textEncoder.encode(n.path);
  const pathLen = isNull ? 0 : pathBytes.byteLength;
  if (!isNull && pathLen >= 0xffff) {
    throw new RangeError('Virtual filesystem path exceeds maximum encoded length (65534 bytes)');
  }
  const total = 27 + pathLen;
  const buf = scratch && scratch.byteLength >= total ? scratch : new Uint8Array(total);
  const view = new DataView(buf.buffer, buf.byteOffset, total);
  buf[0] = 1;
  view.setUint32(1, n.ino >>> 0, true);
  view.setUint32(5, n.mode >>> 0, true);
  view.setFloat64(9, n.size, true);
  view.setFloat64(17, n.mtime, true);
  view.setUint16(25, isNull ? 0xffff : pathLen, true);
  if (!isNull && pathLen > 0) {
    buf.set(pathBytes, 27);
  }
  return buf.subarray(0, total);
}

export function decodeNodeBinary(bytes) {
  if (!bytes || bytes.byteLength === 0) return null;
  if (bytes[0] === 1 && bytes.byteLength >= 27) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ino = view.getUint32(1, true);
    const mode = view.getUint32(5, true);
    const size = view.getFloat64(9, true);
    const mtime = view.getFloat64(17, true);
    const pathLen = view.getUint16(25, true);
    if (pathLen !== 0xffff && 27 + pathLen > bytes.byteLength) {
      throw new Error('Corrupt pglite-singlefile-fs inode record');
    }
    const path = pathLen === 0xffff ? null : textDecoder.decode(bytes.subarray(27, 27 + pathLen));
    return { ino, path, mode, size, mtime };
  }
  throw new Error('Corrupt pglite-singlefile-fs inode record');
}
