# HyperFrames — OpenMontage composition runtime (deep-dive)

- **Repo:** `github.com/heygen-com/hyperframes` · **fork:** `github.com/rkz91/hyperframes` · **local:** `repos/hyperframes`
- **License:** Apache-2.0 (permissive)
- **Verdict:** **KEEP — OpenMontage runtime**
- **Canonical analysis:** chat [HyperFrames analysis](8c103821-455b-4fc7-b045-6b7e6362f425)

## What it actually is
A TypeScript/Bun **composition framework** (Remotion-family) for programmatic video: kinetic typography, motion graphics, rigged SVG character animation, and compositing of *your* uploaded clips. Monorepo with `packages/`, a `registry/`, `examples/`, `skills/`, and a `DESIGN.md`.

## On disk (verified)
- `packages/` (the framework), `registry/`, `examples/`, `docs/`, `skills/`, `bun.lock`, `package.json`, `DESIGN.md`, `ADOPTERS.md`, `SECURITY.md`.

## Role in Mira
Not run standalone — it's the **render runtime *inside* OpenMontage**, wired via `lib/hyperframes_style_bridge.py`. It produces the **no-GPU** designed-graphics look (the cheap, high-quality faceless/explainer visuals) and composits your footage/photos.

## Why keep it
- Apache-2.0, free, no GPU.
- It's what makes OpenMontage's faceless/explainer output look *designed* rather than slideshow-y (supports the Quality pillar + anti-inauthentic).

## Integration tasks
- Ensure the `hyperframes_style_bridge` is configured; map per-channel **brand kit** (fonts/colors/intro-outro/caption style) onto HyperFrames templates.

## Caveats
Node/Bun toolchain alongside the Python core — part of OpenMontage's `make setup`; not a separate engine to learn.
