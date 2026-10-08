#!/usr/bin/env node
/**
 * check-golden-font-licences.mjs — fail if a regression golden embeds a font
 * whose family has no licence text in tests/FONT-LICENSES/.
 *
 * Added by Coco, 2026-10-08 (lab-0062). See repos/hyperframes/MODIFICATIONS.md.
 *
 * Goldens (tests/<fixture>/output/compiled.html, at any depth) embed fonts as
 * base64 data: URIs. For each one this script decodes the font (TTF/OTF, WOFF
 * or WOFF2), reads its own name table (family = name ID 16, else 1; the CSS
 * font-family is only an alias) and requires that family to be listed in the
 * table of tests/FONT-LICENSES/README.md with an existing licence file. It also
 * fails if any embedded font's names contain a Reserved Font Name declared by a
 * licence text in that folder (a subset is an OFL Modified Version).
 *
 *   node scripts/check-golden-font-licences.mjs [testsDir]
 *
 * Exit 0 = clean, 1 = violations (listed), 2 = could not run.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const TESTS = process.argv[2] || join(here, "..", "tests");
const LICDIR = join(TESTS, "FONT-LICENSES");

// ---------- allowed families from FONT-LICENSES/README.md ----------
function allowedFamilies() {
  const readme = readFileSync(join(LICDIR, "README.md"), "utf8");
  const allowed = new Map();
  for (const line of readme.split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*`([^`]+\.txt)`\s*\|/);
    if (!m || m[1] === "Family") continue;
    if (!existsSync(join(LICDIR, m[2]))) {
      throw new Error(`FONT-LICENSES/README.md lists ${m[1]} with missing file ${m[2]}`);
    }
    allowed.set(m[1].toLowerCase(), m[2]);
  }
  return allowed;
}

function reservedNames() {
  const out = [];
  for (const f of readdirSync(LICDIR)) {
    if (!f.endsWith(".txt")) continue;
    const head = readFileSync(join(LICDIR, f), "utf8").split("This Font Software is licensed")[0];
    for (const m of head.matchAll(/Reserved Font Names?:?\s*["“]([^"”]+)["”]/gi)) {
      for (const n of m[1]
        .split(/["“”,]+/)
        .map((s) => s.trim())
        .filter(Boolean))
        out.push(n.toLowerCase());
    }
  }
  return out;
}

// ---------- font decoding ----------
function readBase128(buf, pos) {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[pos.p++];
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) return v;
  }
  throw new Error("bad UIntBase128");
}
// WOFF2 known-table tags (index = flags & 0x3f), from the WOFF2 spec
const WOFF2_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
];

/** returns the raw bytes of the 'name' table, or null */
function nameTable(font) {
  const sig = font.toString("latin1", 0, 4);
  if (sig === "wOF2") {
    const numTables = font.readUInt16BE(12);
    const pos = { p: 48 };
    let offset = 0;
    let nameAt = null;
    for (let i = 0; i < numTables; i++) {
      const flags = font[pos.p++];
      const tagIdx = flags & 0x3f;
      let tag;
      if (tagIdx === 63) {
        tag = font.toString("latin1", pos.p, pos.p + 4);
        pos.p += 4;
      } else tag = WOFF2_TAGS[tagIdx];
      const origLength = readBase128(font, pos);
      const xform = (flags >> 6) & 3;
      const transformed = tag === "glyf" || tag === "loca" ? xform !== 3 : xform !== 0;
      const length = transformed ? readBase128(font, pos) : origLength;
      if (tag === "name") nameAt = { offset, length };
      offset += length;
    }
    const totalCompressed = font.readUInt32BE(20);
    if (font.readUInt32BE(4) === 0x74746366) return null; // collections: not used in goldens
    const data = brotliDecompressSync(font.subarray(pos.p, pos.p + totalCompressed));
    return nameAt ? data.subarray(nameAt.offset, nameAt.offset + nameAt.length) : null;
  }
  if (sig === "wOFF") {
    const numTables = font.readUInt16BE(12);
    for (let i = 0; i < numTables; i++) {
      const r = 44 + 20 * i;
      if (font.toString("latin1", r, r + 4) !== "name") continue;
      const off = font.readUInt32BE(r + 4),
        comp = font.readUInt32BE(r + 8),
        orig = font.readUInt32BE(r + 12);
      const raw = font.subarray(off, off + comp);
      return comp < orig ? inflateSync(raw) : raw;
    }
    return null;
  }
  // TTF / OTF
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const r = 12 + 16 * i;
    if (font.toString("latin1", r, r + 4) === "name") {
      const off = font.readUInt32BE(r + 8),
        len = font.readUInt32BE(r + 12);
      return font.subarray(off, off + len);
    }
  }
  return null;
}

function names(table) {
  const count = table.readUInt16BE(2),
    strOff = table.readUInt16BE(4);
  const out = {};
  const all = new Set();
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    const pid = table.readUInt16BE(r),
      eid = table.readUInt16BE(r + 2),
      nid = table.readUInt16BE(r + 6);
    const len = table.readUInt16BE(r + 8),
      off = table.readUInt16BE(r + 10);
    const raw = table.subarray(strOff + off, strOff + off + len);
    let s;
    if (pid === 0 || pid === 3) s = Buffer.from(raw).swap16().toString("utf16le");
    else if (pid === 1 && eid === 0) s = raw.toString("latin1");
    else continue;
    s = s.trim();
    if (!s) continue;
    all.add(s);
    if (!(nid in out) || pid === 3) out[nid] = s;
  }
  return {
    family:
      out[16] ||
      out[1] ||
      out[4] ||
      out[6] ||
      `(no family name; ${[...all][0] || "empty name table"})`,
    all: [...all],
  };
}

// ---------- scan goldens ----------
function* goldens(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "FONT-LICENSES") continue;
      yield* goldens(p);
    } else if (e === "compiled.html" && p.includes(`${"/"}output${"/"}`)) yield p;
  }
}

function main() {
  let allowed, reserved;
  try {
    allowed = allowedFamilies();
    reserved = reservedNames();
  } catch (e) {
    console.error(`[golden-font-licences] ${e.message}`);
    return 2;
  }
  const DATA = /base64,([A-Za-z0-9+/=\s\\]{200,})/g;
  const MAGIC = new Set(["wOF2", "wOFF", "OTTO", "\0\x01\0\0", "true"]);
  const problems = [];
  let faces = 0;
  for (const file of goldens(TESTS)) {
    const html = readFileSync(file, "utf8");
    for (const m of html.matchAll(DATA)) {
      const font = Buffer.from(m[1].replace(/[\s\\]/g, ""), "base64");
      if (!MAGIC.has(font.toString("latin1", 0, 4))) continue;
      faces++;
      const rel = relative(TESTS, file);
      let n;
      try {
        const t = nameTable(font);
        if (!t) throw new Error("no name table");
        n = names(t);
      } catch (e) {
        problems.push(`${rel}: embedded font could not be read (${e.message})`);
        continue;
      }
      const fam = n.family.toLowerCase();
      const base = [...allowed.keys()].find((a) => fam === a || fam.startsWith(`${a} `));
      if (!base)
        problems.push(`${rel}: embeds "${n.family}", which has no licence text in FONT-LICENSES/`);
      const hit = reserved.find((r) => n.all.some((s) => s.toLowerCase().includes(r)));
      if (hit)
        problems.push(
          `${rel}: embeds "${n.family}", whose names use the Reserved Font Name "${hit}"`,
        );
    }
  }
  if (problems.length) {
    console.error(
      `[golden-font-licences] ${problems.length} problem(s):\n  ${problems.join("\n  ")}`,
    );
    console.error(
      "[golden-font-licences] Add the family's licence text and a README row to tests/FONT-LICENSES/, or keep the font out of the golden.",
    );
    return 1;
  }
  console.log(
    `[golden-font-licences] OK: ${faces} embedded faces, all families listed in FONT-LICENSES/`,
  );
  return 0;
}

process.exit(main());
