#!/usr/bin/env node
/**
 * check-golden-font-licences.mjs — fail if a regression golden or the
 * producer's bundled font data carries a font it may not redistribute.
 *
 * Added by Coco, 2026-10-08 (lab-0062). See repos/hyperframes/MODIFICATIONS.md.
 *
 * Goldens: every file under a tests/<fixture>/output/ directory (any depth).
 * Raw font files (TTF/OTF, TTC/OTC, WOFF, WOFF2) are read directly; text files
 * are searched for data: URIs (any case, spacing or percent-encoding, base64
 * or not) and for bare base64 blobs. Each face's own name table gives its
 * family (name ID 16, else 1, after dropping trailing style words; the CSS
 * font-family is only an alias), which must exactly equal a family listed in
 * tests/FONT-LICENSES/README.md with an existing licence text.
 *
 * Bundled data: the @fontsource faces that scripts/generate-font-data.ts
 * bundles, and src/services/fontData.generated.ts if present (the build
 * reuses an existing file, so a stale one would ship).
 *
 * Reserved Font Names: every name declared by a licence text in
 * FONT-LICENSES/, by the bundled package's LICENSE, or by the face's own
 * copyright/licence records (name IDs 0 and 13). No face's naming records
 * (IDs 1, 3, 4, 6, 16-18, 21, 22, 25) may use one: a subset is an OFL
 * Modified Version. A face that can't be read, an unsupported format, or a
 * run that finds no goldens is an error, never "OK".
 *
 *   node scripts/check-golden-font-licences.mjs [testsDir] [--bundled-only]
 *
 * Exit 0 = clean, 1 = violations (listed), 2 = could not run.
 * Tests: scripts/check-golden-font-licences.test.mjs (node --test).
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export class SetupError extends Error {}

// ---------- licence texts ----------
const QUOTED = /["“”'‘’]([^"“”'‘’\n]{1,60})["“”'‘’]/g;

/** every Reserved Font Name declared in a licence text or copyright string */
export function reservedNamesFromText(text) {
  const head = text.split(/\bPREAMBLE\b|This Font Software is licensed/)[0];
  const out = new Set();
  for (const m of head.matchAll(/Reserved\s+Font\s+Names?\b/gi)) {
    let seg = head.slice(m.index + m[0].length, m.index + m[0].length + 240);
    if (/^["”]?\s*refers to/i.test(seg)) continue; // the OFL's own definition
    seg = seg.split(/\n\s*\n|\.(?=\s|$)|\bThis Font Software\b/)[0];
    const quoted = [...seg.matchAll(QUOTED)].map((q) => q[1].trim());
    const names = quoted.length
      ? quoted
      : seg
          .replace(/^[\s:]+/, "")
          .split(/,|\band\b|;/)
          .map((s) => s.trim().replace(/[).;:]+$/, ""));
    for (const n of names) if (/^[\p{L}\p{N}]/u.test(n) && n.length <= 60) out.add(n);
  }
  return [...out];
}

/** families listed in FONT-LICENSES/README.md (exact names) and their RFNs */
export function readLicences(licDir) {
  if (!existsSync(join(licDir, "README.md")))
    throw new SetupError(`no FONT-LICENSES/README.md in ${licDir}`);
  const allowed = new Map();
  for (const line of readFileSync(join(licDir, "README.md"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*`([^`]+\.txt)`\s*\|/);
    if (!m || m[1] === "Family") continue;
    if (!existsSync(join(licDir, m[2])))
      throw new SetupError(`FONT-LICENSES/README.md lists ${m[1]} with missing file ${m[2]}`);
    allowed.set(m[1].toLowerCase(), m[2]);
  }
  if (!allowed.size) throw new SetupError("FONT-LICENSES/README.md lists no families");
  const reserved = new Map();
  for (const f of readdirSync(licDir)) {
    if (!f.endsWith(".txt")) continue;
    for (const n of reservedNamesFromText(readFileSync(join(licDir, f), "utf8")))
      reserved.set(n, `FONT-LICENSES/${f}`);
  }
  return { allowed, reserved };
}

// ---------- font decoding ----------
const MAGIC = new Set(["wOF2", "wOFF", "OTTO", "true", "ttcf", "\0\x01\0\0"]);
export const isFont = (b) => b.length >= 12 && MAGIC.has(b.toString("latin1", 0, 4));
const isEot = (b) =>
  b.length >= 36 && b.readUInt16LE(34) === 0x504c && b.readUInt32LE(0) === b.length;

function base128(buf, pos) {
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

function sfntName(buf, dir) {
  const n = buf.readUInt16BE(dir + 4);
  for (let i = 0; i < n; i++) {
    const r = dir + 12 + 16 * i;
    if (buf.toString("latin1", r, r + 4) === "name") {
      const off = buf.readUInt32BE(r + 8);
      return buf.subarray(off, off + buf.readUInt32BE(r + 12));
    }
  }
  return null;
}

/** the 'name' table of every face in a font file (collections give several) */
export function nameTables(font) {
  const sig = font.toString("latin1", 0, 4);
  if (sig === "ttcf") {
    const count = font.readUInt32BE(8);
    if (!count || count > 1000) throw new Error("bad collection header");
    return Array.from({ length: count }, (_, i) => sfntName(font, font.readUInt32BE(12 + 4 * i)));
  }
  if (sig === "wOF2") {
    if (font.readUInt32BE(4) === 0x74746366)
      throw new Error("WOFF2 font collection: unsupported, inspect by hand");
    const numTables = font.readUInt16BE(12);
    const pos = { p: 48 };
    let offset = 0;
    let at = null;
    for (let i = 0; i < numTables; i++) {
      const flags = font[pos.p++];
      let tag = WOFF2_TAGS[flags & 0x3f];
      if ((flags & 0x3f) === 63) {
        tag = font.toString("latin1", pos.p, pos.p + 4);
        pos.p += 4;
      }
      const orig = base128(font, pos);
      const xf = (flags >> 6) & 3;
      const transformed = tag === "glyf" || tag === "loca" ? xf !== 3 : xf !== 0;
      const len = transformed ? base128(font, pos) : orig;
      if (tag === "name") at = { offset, len };
      offset += len;
    }
    const data = brotliDecompressSync(font.subarray(pos.p, pos.p + font.readUInt32BE(20)));
    return [at ? data.subarray(at.offset, at.offset + at.len) : null];
  }
  if (sig === "wOFF") {
    const numTables = font.readUInt16BE(12);
    for (let i = 0; i < numTables; i++) {
      const r = 44 + 20 * i;
      if (font.toString("latin1", r, r + 4) !== "name") continue;
      const off = font.readUInt32BE(r + 4);
      const comp = font.readUInt32BE(r + 8);
      const raw = font.subarray(off, off + comp);
      return [comp < font.readUInt32BE(r + 12) ? inflateSync(raw) : raw];
    }
    return [null];
  }
  return [sfntName(font, 0)];
}

const NAMING_IDS = new Set([1, 3, 4, 6, 16, 17, 18, 21, 22, 25]);

/** name records of one face: { family, naming[], declared[] (RFNs from IDs 0/13) } */
export function readNames(table) {
  if (!table) throw new Error("no name table");
  const count = table.readUInt16BE(2);
  const strOff = table.readUInt16BE(4);
  const byId = {};
  const naming = new Set();
  const declared = new Set();
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    const pid = table.readUInt16BE(r);
    const eid = table.readUInt16BE(r + 2);
    const id = table.readUInt16BE(r + 6);
    const raw = table.subarray(
      strOff + table.readUInt16BE(r + 10),
      strOff + table.readUInt16BE(r + 10) + table.readUInt16BE(r + 8),
    );
    let s;
    if (pid === 0 || pid === 3) s = Buffer.from(raw).swap16().toString("utf16le");
    else if (pid === 1 && eid === 0) s = raw.toString("latin1");
    else continue;
    s = s.trim();
    if (!s) continue;
    if (!(id in byId) || pid === 3) byId[id] = s;
    if (NAMING_IDS.has(id)) naming.add(s);
    if (id === 0 || id === 13) for (const n of reservedNamesFromText(s)) declared.add(n);
  }
  return {
    family: byId[16] || byId[1] || byId[4] || byId[6] || "",
    legacyFamily: byId[1] || "",
    naming: [...naming],
    declared: [...declared],
  };
}

const STYLE_WORD =
  /^(thin|hairline|extralight|ultralight|light|book|regular|normal|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique)$/i;
const stripStyle = (n) => {
  const w = n.trim().split(/\s+/);
  while (w.length > 1 && STYLE_WORD.test(w[w.length - 1])) w.pop();
  return w.join(" ").toLowerCase();
};
/** exact match of the face's family (ID 16 or 1, minus trailing style words) */
export const familyListed = (n, allowed) =>
  [n.family, n.legacyFamily]
    .filter(Boolean)
    .some((f) => allowed.has(f.toLowerCase()) || allowed.has(stripStyle(f)));

/** does any naming record use the reserved name (also inside PostScript/CamelCase forms)? */
export function usesReservedName(naming, rfn) {
  const words = rfn
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[\\s_-]*")}(?![\\p{Ll}\\p{N}])`, "iu");
  const reCase = new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[\\s_-]*")}(?![\\p{L}\\p{N}])`, "iu");
  return naming.some((s) => reCase.test(s) || re.test(s.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")));
}

// ---------- extraction from text ----------
function percentDecode(s) {
  if (!s.includes("%")) return Buffer.from(s, "latin1");
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
const b64 = (s) =>
  Buffer.from(
    s
      .replace(/[^A-Za-z0-9+/=_-]/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/"),
    "base64",
  );

/** every font payload in a text: data: URIs in any spelling, plus bare base64 blobs */
export function extractFonts(text) {
  const found = [];
  const covered = [];
  const DATA = /data\s*:\s*([^,"'()<>]{0,200}?)\s*,([^"'()<>]*)/gi;
  for (const m of text.matchAll(DATA)) {
    const meta = percentDecode(m[1]).toString("latin1");
    const isB64 = /;\s*base64\s*$/i.test(meta);
    let bytes;
    try {
      bytes = isB64
        ? b64(percentDecode(m[2].replace(/\\\r?\n/g, "")).toString("latin1"))
        : percentDecode(m[2]);
    } catch {
      continue;
    }
    covered.push([m.index, m.index + m[0].length]);
    if (isFont(bytes) || isEot(bytes))
      found.push({ at: m.index, bytes, how: `data: URI (${meta.trim() || "no type"})` });
  }
  for (const m of text.matchAll(/[A-Za-z0-9+/]{800,}={0,2}/g)) {
    if (covered.some(([a, z]) => m.index >= a && m.index < z)) continue;
    const bytes = b64(m[0]);
    if (isFont(bytes) || isEot(bytes)) found.push({ at: m.index, bytes, how: "bare base64" });
  }
  return found;
}

// ---------- goldens ----------
/** platform-neutral: true for any file below an output/ directory of a fixture */
export const isGoldenPath = (rel) =>
  rel
    .split(/[\\/]+/)
    .slice(0, -1)
    .includes("output");

function* walk(dir, root) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "FONT-LICENSES" || e === ".git") continue;
      yield* walk(p, root);
    } else if (isGoldenPath(relative(root, p))) yield p;
  }
}

const TEXT_EXT = /\.(html?|css|m?js|cjs|json|svg|txt|xml|ts)$/i;

function facesInFile(buf, name) {
  if (isFont(buf) || isEot(buf)) return [{ at: 0, bytes: buf, how: "font file" }];
  if (TEXT_EXT.test(name) || buf.indexOf(0) === -1) return extractFonts(buf.toString("latin1"));
  return [];
}

// ---------- bundled data ----------
function bundledSources(producerDir) {
  const gen = join(producerDir, "scripts", "generate-font-data.ts");
  if (!existsSync(gen)) throw new SetupError(`missing ${gen}`);
  const src = readFileSync(gen, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const req = createRequire(join(producerDir, "package.json"));
  const out = [];
  for (const m of src.matchAll(/packageName:\s*"(@fontsource\/[^"]+)",\s*faces:\s*\[([^\]]*)\]/g)) {
    let root;
    try {
      root = dirname(req.resolve(`${m[1]}/package.json`));
    } catch {
      throw new SetupError(
        `cannot resolve ${m[1]}; run bun install (the bundled font check needs node_modules)`,
      );
    }
    const files = readdirSync(join(root, "files"));
    const licence = ["LICENSE", "LICENSE.txt", "OFL.txt"]
      .map((f) => join(root, f))
      .find(existsSync);
    const rfn = licence ? reservedNamesFromText(readFileSync(licence, "utf8")) : [];
    const slug = m[1].replace("@fontsource/", "");
    for (const f of m[2].matchAll(/weight:\s*"(\d+)"(?:,\s*style:\s*"(\w+)")?/g)) {
      const style = f[2] || "normal";
      const name =
        files.find((x) => x === `${slug}-latin-${f[1]}-${style}.woff2`) ||
        files.find((x) => x.endsWith(`-${f[1]}-${style}.woff2`) && x.includes("-latin-"));
      if (!name) throw new SetupError(`${m[1]}: no latin ${f[1]} ${style} woff2`);
      out.push({
        label: `${m[1]}/files/${name}`,
        bytes: readFileSync(join(root, "files", name)),
        rfn,
        licence: licence && `${m[1]}/${licence.split(/[\\/]/).pop()}`,
      });
    }
  }
  if (!out.length) throw new SetupError(`found no bundled faces in ${gen}`);
  return out;
}

// ---------- the check ----------
export function check({
  testsDir,
  licDir = join(testsDir, "FONT-LICENSES"),
  producerDir = join(testsDir, ".."),
  goldens = true,
  bundled = true,
}) {
  const { allowed, reserved } = readLicences(licDir);
  const problems = [];
  const stats = { goldenFiles: 0, goldenFaces: 0, bundledFaces: 0 };

  const inspect = (where, bytes, extraRfn, needListed) => {
    let tables;
    if (isEot(bytes) && !isFont(bytes)) {
      problems.push(`${where}: Embedded OpenType (EOT) font: unsupported, inspect by hand`);
      return;
    }
    try {
      tables = nameTables(bytes);
    } catch (e) {
      problems.push(`${where}: font could not be read (${e.message})`);
      return;
    }
    tables.forEach((t, i) => {
      const at = tables.length > 1 ? `${where} [face ${i}]` : where;
      let n;
      try {
        n = readNames(t);
      } catch (e) {
        problems.push(`${at}: font could not be read (${e.message})`);
        return;
      }
      if (needListed && !familyListed(n, allowed))
        problems.push(
          `${at}: embeds "${n.family || "(no family name)"}", which has no licence text in FONT-LICENSES/ (exact family match)`,
        );
      const rfns = new Map(reserved);
      for (const r of n.declared) rfns.set(r, "the font's own name table");
      for (const r of extraRfn.names) rfns.set(r, extraRfn.from);
      for (const [r, from] of rfns)
        if (usesReservedName(n.naming, r))
          problems.push(
            `${at}: "${n.family}" uses the Reserved Font Name "${r}" (declared in ${from}); a subset may not`,
          );
    });
  };

  if (goldens) {
    for (const file of walk(testsDir, testsDir)) {
      stats.goldenFiles++;
      const rel = relative(testsDir, file);
      for (const f of facesInFile(readFileSync(file), file)) {
        stats.goldenFaces++;
        inspect(`${rel} (${f.how})`, f.bytes, { names: [] }, true);
      }
    }
    if (!stats.goldenFiles)
      throw new SetupError(
        `found no golden files under ${testsDir} (no */output/* paths); refusing to report OK`,
      );
  }
  if (bundled) {
    for (const s of bundledSources(producerDir)) {
      stats.bundledFaces++;
      inspect(`bundled ${s.label}`, s.bytes, { names: s.rfn, from: s.licence }, false);
    }
    const gen = join(producerDir, "src", "services", "fontData.generated.ts");
    if (existsSync(gen))
      for (const f of extractFonts(readFileSync(gen, "latin1"))) {
        stats.bundledFaces++;
        inspect(`src/services/fontData.generated.ts@${f.at}`, f.bytes, { names: [] }, false);
      }
  }
  return { problems, stats };
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const bundledOnly = argv.includes("--bundled-only");
  const testsDir = resolve(args[0] || join(here, "..", "tests"));
  let r;
  try {
    r = check({ testsDir, goldens: !bundledOnly });
  } catch (e) {
    console.error(`[golden-font-licences] cannot run: ${e.message}`);
    return 2;
  }
  if (r.problems.length) {
    console.error(
      `[golden-font-licences] ${r.problems.length} problem(s):\n  ${r.problems.join("\n  ")}`,
    );
    console.error(
      "[golden-font-licences] Add the family's licence text and a README row to tests/FONT-LICENSES/, keep the font out of the golden, or alias the family to a bundled face with no Reserved Font Name.",
    );
    return 1;
  }
  const s = r.stats;
  console.log(
    `[golden-font-licences] OK: ${bundledOnly ? "" : `${s.goldenFaces} embedded faces in ${s.goldenFiles} golden files, all families listed in FONT-LICENSES/; `}${s.bundledFaces} bundled faces, none using a Reserved Font Name`,
  );
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exit(main(process.argv.slice(2)));
