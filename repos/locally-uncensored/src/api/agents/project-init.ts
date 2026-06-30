/**
 * project_init — System-Wide Setup builtin (Bonus, 2026-05).
 *
 * Pure recipe library: maps a stack spec ("next-postgres-stripe") to an
 * ordered list of shell commands the model can execute via shell_execute.
 * The tool itself does not run the commands — it returns a structured
 * plan so the Codex/Agent loop can orchestrate, surface progress, and
 * ask before destructive steps.
 *
 * Adding a new recipe = appending to RECIPES below. Each entry stays
 * cross-platform by emitting POSIX shell first; Windows-specific
 * differences (e.g. `pnpm` vs `pnpm.exe`) are handled by the user's
 * shell wrapper, not by this module.
 */

export interface InitStep {
  /** One-line description shown to the user before the command runs. */
  description: string
  /** Shell command. Empty means the step is a note (no command). */
  command: string
  /** Steps marked optional won't halt the plan if they fail. */
  optional?: boolean
}

export interface InitRecipe {
  id: string
  name: string
  summary: string
  prerequisites: string[]
  steps: InitStep[]
}

export const RECIPES: Record<string, InitRecipe> = {
  'next-postgres': {
    id: 'next-postgres',
    name: 'Next.js + Postgres',
    summary: 'Next 15 App Router + Postgres via Prisma + a starter README.',
    prerequisites: ['node', 'pnpm', 'psql'],
    steps: [
      {
        description: 'Scaffold Next.js (app router, TS, Tailwind, src/, App Router, no eslint prompt)',
        command: 'pnpm create next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"',
      },
      {
        description: 'Install Prisma + Postgres client',
        command: 'pnpm add -D prisma && pnpm add @prisma/client',
      },
      {
        description: 'Initialise Prisma schema',
        command: 'pnpm exec prisma init --datasource-provider postgresql',
      },
      {
        description: 'Create local Postgres database (skip if you already have one)',
        command: 'createdb $(basename "$PWD")',
        optional: true,
      },
      {
        description: 'Write the first migration once you edit prisma/schema.prisma',
        command: '',
      },
    ],
  },
  'next-supabase': {
    id: 'next-supabase',
    name: 'Next.js + Supabase',
    summary: 'Next 15 + @supabase/ssr ready for auth + RLS-backed APIs.',
    prerequisites: ['node', 'pnpm', 'supabase'],
    steps: [
      {
        description: 'Scaffold Next.js',
        command: 'pnpm create next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"',
      },
      {
        description: 'Install Supabase SSR + JS client',
        command: 'pnpm add @supabase/ssr @supabase/supabase-js',
      },
      {
        description: 'Initialise Supabase locally (linked project)',
        command: 'supabase init',
        optional: true,
      },
      {
        description: 'Stub .env.local with the required keys',
        command: 'printf "NEXT_PUBLIC_SUPABASE_URL=\\nNEXT_PUBLIC_SUPABASE_ANON_KEY=\\nSUPABASE_SERVICE_ROLE_KEY=\\n" > .env.local',
      },
    ],
  },
  'next-stripe': {
    id: 'next-stripe',
    name: 'Next.js + Stripe Checkout',
    summary: 'Stripe-payment-ready Next.js with a /pricing + /api/checkout pair.',
    prerequisites: ['node', 'pnpm', 'stripe'],
    steps: [
      {
        description: 'Scaffold Next.js',
        command: 'pnpm create next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"',
      },
      {
        description: 'Install Stripe + Server SDK',
        command: 'pnpm add stripe @stripe/stripe-js',
      },
      {
        description: 'Stub .env.local for Stripe keys',
        command: 'printf "STRIPE_SECRET_KEY=\\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=\\nSTRIPE_WEBHOOK_SECRET=\\n" > .env.local',
      },
      {
        description: 'Pull the Stripe CLI for local webhook forwarding',
        command: 'stripe listen --print-secret',
        optional: true,
      },
    ],
  },
  'rust-axum': {
    id: 'rust-axum',
    name: 'Rust + Axum',
    summary: 'A new Cargo binary crate with Axum 0.7 + tokio + tracing pre-wired.',
    prerequisites: ['cargo'],
    steps: [
      { description: 'Create the crate', command: 'cargo init --bin .' },
      {
        description: 'Add Axum + Tokio + tracing',
        command: 'cargo add axum tokio --features tokio/full && cargo add tracing tracing-subscriber --features tracing-subscriber/env-filter',
      },
      {
        description: 'Verify it compiles',
        command: 'cargo check',
      },
    ],
  },
  'vite-react': {
    id: 'vite-react',
    name: 'Vite + React + TypeScript',
    summary: 'Vite 6 + React 19 + Tailwind 4 — the minimal SPA starter.',
    prerequisites: ['node', 'pnpm'],
    steps: [
      {
        description: 'Scaffold Vite with the React-TS template',
        command: 'pnpm create vite@latest . --template react-ts',
      },
      { description: 'Install deps', command: 'pnpm install' },
      {
        description: 'Add Tailwind 4',
        command: 'pnpm add -D tailwindcss @tailwindcss/postcss',
      },
    ],
  },
}

export interface InitPlan {
  recipe: InitRecipe
  /** Combined prerequisite check command — fails fast when a required tool is missing. */
  prereqCheck: string
}

/** Looks up a recipe by id (case-insensitive). Returns null when unknown. */
export function findRecipe(id: string): InitRecipe | null {
  const key = (id ?? '').trim().toLowerCase()
  return RECIPES[key] ?? null
}

/** Builds the prerequisite-check shell snippet for a recipe. */
export function prereqCheckCommand(recipe: InitRecipe): string {
  if (!recipe.prerequisites.length) return ': # no prerequisites'
  const tests = recipe.prerequisites
    .map((p) => `command -v ${p} >/dev/null 2>&1 || { echo "missing: ${p}"; exit 127; }`)
    .join(' && ')
  return tests
}

/** Renders the plan as a markdown the model can quote / show the user. */
export function renderInitPlan(recipe: InitRecipe): string {
  const lines: string[] = []
  lines.push(`# ${recipe.name}`)
  lines.push('')
  lines.push(recipe.summary)
  lines.push('')
  lines.push(`**Prerequisites:** ${recipe.prerequisites.join(', ') || '(none)'}`)
  lines.push('')
  lines.push('## Steps')
  recipe.steps.forEach((s, i) => {
    const opt = s.optional ? ' _(optional)_' : ''
    lines.push(`### ${i + 1}. ${s.description}${opt}`)
    if (s.command) {
      lines.push('```sh')
      lines.push(s.command)
      lines.push('```')
    } else {
      lines.push('_(no command — manual step)_')
    }
  })
  return lines.join('\n')
}

/** Lists every known recipe id with its one-line summary. */
export function listRecipes(): Array<{ id: string; name: string; summary: string }> {
  return Object.values(RECIPES).map((r) => ({ id: r.id, name: r.name, summary: r.summary }))
}
