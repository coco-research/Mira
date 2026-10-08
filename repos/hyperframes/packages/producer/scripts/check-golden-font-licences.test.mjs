// Tests for check-golden-font-licences.mjs: one case per bypass found in
// review (Noor, round 4) plus the bundled-data check.
// Added by Coco, 2026-10-08 (lab-0062). Run: node --test scripts/check-golden-font-licences.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  check,
  isGoldenPath,
  reservedNamesFromText,
  SetupError,
} from "./check-golden-font-licences.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** minimal sfnt with only a 'name' table (enough for the checker) */
function sfnt(names, { at = 0 } = {}) {
  const recs = Object.entries(names).map(([id, s]) => [
    Number(id),
    Buffer.from(s, "utf16le").swap16(),
  ]);
  const head = Buffer.alloc(6 + 12 * recs.length);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(recs.length, 2);
  head.writeUInt16BE(head.length, 4);
  let off = 0;
  recs.forEach(([id, b], i) => {
    const r = 6 + 12 * i;
    head.writeUInt16BE(3, r);
    head.writeUInt16BE(1, r + 2);
    head.writeUInt16BE(0x409, r + 4);
    head.writeUInt16BE(id, r + 6);
    head.writeUInt16BE(b.length, r + 8);
    head.writeUInt16BE(off, r + 10);
    off += b.length;
  });
  const name = Buffer.concat([head, ...recs.map((r) => r[1])]);
  const dir = Buffer.alloc(28);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(1, 4);
  dir.write("name", 12, "latin1");
  dir.writeUInt32BE(at + 28, 20); // absolute offset (collections share one buffer)
  dir.writeUInt32BE(name.length, 24);
  return Buffer.concat([dir, name]);
}
/** TrueType collection of minimal faces */
function ttc(...faces) {
  const headLen = 12 + 4 * faces.length;
  const parts = [];
  const offs = [];
  let at = headLen;
  for (const f of faces) {
    const b = sfnt(f, { at });
    offs.push(at);
    parts.push(b);
    at += b.length;
  }
  const h = Buffer.alloc(headLen);
  h.write("ttcf", 0, "latin1");
  h.writeUInt32BE(0x00010000, 4);
  h.writeUInt32BE(faces.length, 8);
  offs.forEach((o, i) => h.writeUInt32BE(o, 12 + 4 * i));
  return Buffer.concat([h, ...parts]);
}
const face = (family, extra = {}) =>
  sfnt({ 1: family, 4: family, 6: family.replace(/\s+/g, "") + "-Regular", ...extra });
const OFL = (copyright) =>
  `${copyright}\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n`;

/** a throwaway tests/ tree: FONT-LICENSES listing Inter and Roboto, plus goldens */
function tree(goldens, { licences = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "golden-check-"));
  const lic = join(root, "tests", "FONT-LICENSES");
  mkdirSync(lic, { recursive: true });
  const rows = {
    Inter: "OFL-inter.txt",
    Roboto: "OFL-roboto.txt",
    ...Object.fromEntries(Object.keys(licences).map((f) => [licences[f].family, f])),
  };
  writeFileSync(
    join(lic, "README.md"),
    `| Family | Licence text |\n|---|---|\n${Object.entries(rows)
      .map(([f, t]) => `| ${f} | \`${t}\` |`)
      .join("\n")}\n`,
  );
  writeFileSync(join(lic, "OFL-inter.txt"), OFL("Copyright 2020 The Inter Project Authors"));
  writeFileSync(join(lic, "OFL-roboto.txt"), OFL("Copyright 2011 The Roboto Project Authors"));
  for (const [f, { text }] of Object.entries(licences)) writeFileSync(join(lic, f), text);
  for (const [rel, content] of Object.entries(goldens)) {
    mkdirSync(dirname(join(root, "tests", rel)), { recursive: true });
    writeFileSync(join(root, "tests", rel), content);
  }
  return root;
}
function run(goldens, opts) {
  const root = tree(goldens, opts);
  try {
    return check({ testsDir: join(root, "tests"), bundled: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const html = (uri) => `<style>@font-face{font-family:X;src:url(${uri})}</style>`;
const b64 = (b) => b.toString("base64");
const pct = (b) => [...b].map((x) => "%" + x.toString(16).padStart(2, "0")).join("");

test("a listed family passes; style words are dropped, but only as whole trailing words", () => {
  const r = run({
    "a/output/compiled.html":
      html(`data:font/ttf;base64,${b64(face("Inter"))}`) +
      html(`data:font/ttf;base64,${b64(face("Inter Medium"))}`),
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.stats.goldenFaces, 2);
});

test("prefix matches no longer pass: Inter Tight and Roboto Mono need their own licence rows", () => {
  const r = run({
    "a/output/compiled.html":
      html(`data:font/ttf;base64,${b64(face("Inter Tight"))}`) +
      html(`data:font/ttf;base64,${b64(face("Roboto Mono"))}`),
  });
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /"Inter Tight", which has no licence text/);
  assert.match(r.problems[1], /"Roboto Mono", which has no licence text/);
});

test("data: URIs are found in any case, spacing or percent-encoding", () => {
  const f = face("Evil Sans");
  const variants = [
    `data:font/woff2;BASE64,${b64(f)}`,
    `data:font/ttf; base64,${b64(f)}`,
    `DATA:font/ttf ; Base64 ,${b64(f)}`,
    `data:font/ttf;charset=utf-8;base64,${b64(f).replace(/(.{20})/g, "$1\n")}`,
    `data:font%2Fttf;base64,${b64(f).replace(/\+/g, "%2B").replace(/\//g, "%2F").replace(/=/g, "%3D")}`,
    `data:font/ttf,${pct(f)}`,
    `data:application/octet-stream,${pct(f)}`,
  ];
  for (const v of variants) {
    const r = run({ "a/output/compiled.html": html(v) });
    assert.equal(r.stats.goldenFaces, 1, v.slice(0, 40));
    assert.match(r.problems[0] || "", /"Evil Sans", which has no licence text/, v.slice(0, 40));
  }
});

test("a bare base64 font outside any data: URI is found", () => {
  const big = sfnt({ 1: "Evil Sans", 5: "x".repeat(600) });
  const r = run({ "a/output/compiled.html": `<script>const f = atob("${b64(big)}");</script>` });
  assert.match(r.problems[0], /bare base64.*"Evil Sans"/);
});

test("raw TTC/OTC files and TTC data URIs are read face by face", () => {
  const c = ttc({ 1: "Inter" }, { 1: "Evil Serif" });
  for (const g of [
    { "a/output/fonts/x.ttc": c },
    { "a/output/x.otc": c },
    { "a/output/compiled.html": html(`data:font/collection;base64,${b64(c)}`) },
  ]) {
    const r = run(g);
    assert.equal(r.problems.length, 1, Object.keys(g)[0]);
    assert.match(r.problems[0], /\[face 1\].*"Evil Serif"/);
  }
});

test("unsupported or unreadable fonts are problems, not skipped", () => {
  const woff2Collection = Buffer.alloc(64);
  woff2Collection.write("wOF2", 0, "latin1");
  woff2Collection.write("ttcf", 4, "latin1");
  const r = run({
    "a/output/compiled.html": html(`data:font/woff2;base64,${b64(woff2Collection)}`),
  });
  assert.match(r.problems[0], /WOFF2 font collection: unsupported/);
  const eot = Buffer.alloc(120);
  eot.writeUInt32LE(120, 0);
  eot.writeUInt16LE(0x504c, 34);
  assert.match(run({ "a/output/x.eot": eot }).problems[0], /EOT\) font: unsupported/);
});

test("every Reserved Font Name in a licence text is read: several, quoted any way, or unquoted", () => {
  assert.deepEqual(
    reservedNamesFromText(OFL('Copyright 2020 Foo, with Reserved Font Names "Alpha" and "Beta".')),
    ["Alpha", "Beta"],
  );
  assert.deepEqual(
    reservedNamesFromText(OFL("Copyright 2010 Adobe, with Reserved Font Name 'Source'.")),
    ["Source"],
  );
  assert.deepEqual(
    reservedNamesFromText(OFL("Copyright 2012 Bar, with Reserved Font Name Gamma.")),
    ["Gamma"],
  );
  assert.deepEqual(
    reservedNamesFromText(
      OFL(
        'Copyright A, with Reserved Font Name "Delta".\nCopyright B, with Reserved Font Name: "Eps Mono", "Zeta".',
      ),
    ),
    ["Delta", "Eps Mono", "Zeta"],
  );
  const text = OFL(
    'Copyright 2020 Foo, with Reserved Font Names "Alpha" and "Beta".\nCopyright 2012 Bar, with Reserved Font Name Gamma.',
  );
  const r = run(
    {
      "a/output/compiled.html": ["Beta Sans", "Gamma", "Alpha"]
        .map((f) => html(`data:font/ttf;base64,${b64(face(f))}`))
        .join(""),
    },
    {
      licences: {
        "OFL-alpha.txt": { family: "Alpha", text },
        "OFL-beta.txt": { family: "Beta Sans", text },
        "OFL-gamma.txt": { family: "Gamma", text },
      },
    },
  );
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.join("\n"), /"Beta Sans" uses the Reserved Font Name "Beta"/);
  assert.match(r.problems.join("\n"), /"Gamma" uses the Reserved Font Name "Gamma"/);
});

test("a face's own copyright record declares RFNs too; PostScript forms count; copyright text alone doesn't", () => {
  const lato = face("Inter", {
    0: 'Copyright (c) 2010 tyPoland, with Reserved Font Name "Lato".',
    6: "Lato-Regular",
  });
  assert.match(
    run({ "a/output/compiled.html": html(`data:font/ttf;base64,${b64(lato)}`) }).problems[0],
    /uses the Reserved Font Name "Lato" \(declared in the font's own name table\)/,
  );
  const scp = face("Roboto", {
    0: "Copyright 2010 Adobe, with Reserved Font Name 'Source'.",
    6: "SourceCodePro-Regular",
  });
  assert.match(
    run({ "a/output/compiled.html": html(`data:font/ttf;base64,${b64(scp)}`) }).problems[0],
    /Reserved Font Name "Source"/,
  );
  const noto = face("Inter", {
    0: "Copyright 2014 Adobe, with Reserved Font Name 'Source'.",
    6: "Inter-Regular",
  });
  assert.deepEqual(
    run({ "a/output/compiled.html": html(`data:font/ttf;base64,${b64(noto)}`) }).problems,
    [],
  );
});

test("golden paths are matched by path segment on any platform, and finding none fails", () => {
  assert.equal(isGoldenPath("style-1\\output\\compiled.html"), true);
  assert.equal(isGoldenPath("style-1/output/compiled.html"), true);
  assert.equal(isGoldenPath("style-1\\src\\index.html"), false);
  assert.equal(isGoldenPath("output-notes.html"), false);
  assert.throws(() => run({ "a/src/index.html": "<p>no goldens</p>" }), SetupError);
});

test("bundled font data: an RFN subset in the generator's sources or in fontData.generated.ts fails", () => {
  const root = mkdtempSync(join(tmpdir(), "bundled-check-"));
  try {
    const tests = join(root, "tests");
    mkdirSync(join(tests, "FONT-LICENSES"), { recursive: true });
    writeFileSync(
      join(tests, "FONT-LICENSES", "README.md"),
      "| Family | Licence text |\n|---|---|\n| Inter | `OFL-inter.txt` |\n",
    );
    writeFileSync(join(tests, "FONT-LICENSES", "OFL-inter.txt"), OFL("Copyright Inter"));
    writeFileSync(join(root, "package.json"), '{"name":"p"}');
    mkdirSync(join(root, "scripts"));
    writeFileSync(
      join(root, "scripts", "generate-font-data.ts"),
      'const C = {\n  fake: {\n    packageName: "@fontsource/fake",\n    faces: [{ weight: "400" }],\n  },\n};\n',
    );
    assert.throws(
      () => check({ testsDir: tests, producerDir: root, goldens: false }),
      /cannot resolve @fontsource\/fake; run bun install/,
    );
    const pkg = join(root, "node_modules", "@fontsource", "fake");
    mkdirSync(join(pkg, "files"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"@fontsource/fake"}');
    writeFileSync(
      join(pkg, "LICENSE"),
      OFL('Copyright 2017 Claus Eggers Sorensen, with Reserved Font Name "Playfair Display".'),
    );
    writeFileSync(join(pkg, "files", "fake-latin-400-normal.woff2"), face("Playfair Display"));
    const r = check({ testsDir: tests, producerDir: root, goldens: false });
    assert.match(
      r.problems[0],
      /bundled @fontsource\/fake\/files\/fake-latin-400-normal\.woff2: "Playfair Display" uses the Reserved Font Name "Playfair Display" \(declared in @fontsource\/fake\/LICENSE\)/,
    );
    writeFileSync(join(pkg, "files", "fake-latin-400-normal.woff2"), face("Inter"));
    mkdirSync(join(root, "src", "services"), { recursive: true });
    const lato = face("Lato", { 0: 'Copyright 2010, with Reserved Font Name "Lato".' });
    writeFileSync(
      join(root, "src", "services", "fontData.generated.ts"),
      `export const D = new Map([["@fontsource/lato:400:normal", "data:font/woff2;base64,${b64(lato)}"]]);\n`,
    );
    const r2 = check({ testsDir: tests, producerDir: root, goldens: false });
    assert.equal(r2.problems.length, 1);
    assert.match(
      r2.problems[0],
      /fontData\.generated\.ts@\d+: "Lato" uses the Reserved Font Name "Lato"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repo's goldens and bundled data pass", () => {
  const r = check({ testsDir: join(here, "..", "tests") });
  assert.deepEqual(r.problems, []);
  assert.ok(r.stats.goldenFaces > 500 && r.stats.bundledFaces >= 32);
});
