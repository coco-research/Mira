/**
 * Added by Coco, 2026-10-08 (lab-0062). See repos/hyperframes/MODIFICATIONS.md.
 *
 * An alias (e.g. "IBM Plex Mono" -> JetBrains Mono, "Helvetica" -> Inter) is a
 * substitution: the compiler embeds the bundled canonical font under the alias
 * and must NOT also fetch the aliased name from Google Fonts, which would embed
 * that other font (an OFL subset that keeps a Reserved Font Name, or a
 * commercial face Google serves) under the alias. A canonical family requested
 * by its own name still gets its missing weights from Google.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cacheDir: string;
let prevCacheEnv: string | undefined;

beforeAll(() => {
  prevCacheEnv = process.env.HYPERFRAMES_FONT_CACHE_DIR;
  cacheDir = mkdtempSync(join(tmpdir(), "hf-font-cache-"));
  process.env.HYPERFRAMES_FONT_CACHE_DIR = cacheDir;
});

afterAll(() => {
  if (prevCacheEnv === undefined) delete process.env.HYPERFRAMES_FONT_CACHE_DIR;
  else process.env.HYPERFRAMES_FONT_CACHE_DIR = prevCacheEnv;
  rmSync(cacheDir, { recursive: true, force: true });
});

function recordingFetch(calls: string[]): typeof fetch {
  return (async (input: unknown) => {
    calls.push(String(input));
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("aliases do not pull the aliased name from Google Fonts", () => {
  it("maps IBM Plex Mono to the bundled JetBrains Mono", async () => {
    const { FONT_ALIASES } = await import("./deterministicFonts.js");
    expect(FONT_ALIASES["ibm plex mono"]).toBe("jetbrains-mono");
  });

  it("embeds the substitute and never requests IBM Plex Mono or Helvetica from Google", async () => {
    const { injectDeterministicFontFaces } = await import("./deterministicFonts.js");
    const calls: string[] = [];
    const html = `<!doctype html><html><head><style>
      pre { font-family: "IBM Plex Mono", monospace; }
      h1 { font-family: Helvetica, sans-serif; }
    </style></head><body><h1>A</h1><pre>b</pre></body></html>`;
    const result = await injectDeterministicFontFaces(html, { fetchImpl: recordingFetch(calls) });

    expect(calls.filter((u) => /plex|helvetica/i.test(decodeURIComponent(u)))).toEqual([]);
    // the substitutes are embedded under the requested names
    expect(result).toContain(`font-family: "IBM Plex Mono"`);
    expect(result).toContain(`font-family: "Helvetica"`);
  });

  it("maps Lato, Playfair Display and Source Code Pro (reserved names) to bundled families", async () => {
    const { FONT_ALIASES } = await import("./deterministicFonts.js");
    expect(FONT_ALIASES["lato"]).toBe("inter");
    expect(FONT_ALIASES["playfair display"]).toBe("eb-garamond");
    expect(FONT_ALIASES["source code pro"]).toBe("jetbrains-mono");
    const calls: string[] = [];
    const { injectDeterministicFontFaces } = await import("./deterministicFonts.js");
    const html = `<!doctype html><html><head><style>
      p { font-family: Lato, sans-serif; } h2 { font-family: "Playfair Display", serif; }
      code { font-family: "Source Code Pro", monospace; }
    </style></head><body><h2>A</h2><p>b</p><code>c</code></body></html>`;
    const result = await injectDeterministicFontFaces(html, { fetchImpl: recordingFetch(calls) });
    expect(calls.filter((u) => /lato|playfair|source/i.test(decodeURIComponent(u)))).toEqual([]);
    expect(result).toContain(`font-family: "Lato"`);
    expect(result).toContain(`font-family: "Playfair Display"`);
    expect(result).toContain(`font-family: "Source Code Pro"`);
  });

  it("still fills missing weights from Google for a canonical family requested by name", async () => {
    const { injectDeterministicFontFaces } = await import("./deterministicFonts.js");
    const calls: string[] = [];
    const html = `<!doctype html><html><head><style>
      h1 { font-family: "Inter", sans-serif; }
    </style></head><body><h1>A</h1></body></html>`;
    await injectDeterministicFontFaces(html, { fetchImpl: recordingFetch(calls) });
    expect(calls.some((u) => /family=Inter/i.test(u))).toBe(true);
  });
});
