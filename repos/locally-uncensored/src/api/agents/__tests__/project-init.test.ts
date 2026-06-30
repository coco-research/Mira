import { describe, it, expect } from 'vitest'
import {
  RECIPES,
  findRecipe,
  prereqCheckCommand,
  renderInitPlan,
  listRecipes,
} from '../project-init'

describe('RECIPES table', () => {
  it('exposes every known recipe by its id', () => {
    for (const [id, recipe] of Object.entries(RECIPES)) {
      expect(recipe.id).toBe(id)
      expect(recipe.name).toBeTruthy()
      expect(recipe.summary).toBeTruthy()
      expect(recipe.steps.length).toBeGreaterThan(0)
    }
  })

  it('every step has a description (commands may be empty for notes)', () => {
    for (const recipe of Object.values(RECIPES)) {
      for (const step of recipe.steps) {
        expect(step.description).toBeTruthy()
      }
    }
  })
})

describe('findRecipe', () => {
  it('returns a recipe by id', () => {
    expect(findRecipe('next-postgres')?.name).toBe('Next.js + Postgres')
  })

  it('is case-insensitive and trim-tolerant', () => {
    expect(findRecipe('  Next-Postgres ')?.id).toBe('next-postgres')
  })

  it('returns null for unknown ids', () => {
    expect(findRecipe('xyz')).toBeNull()
    expect(findRecipe('')).toBeNull()
  })
})

describe('prereqCheckCommand', () => {
  it('builds a chain that exits 127 on the first missing tool', () => {
    const recipe = findRecipe('next-postgres')!
    const cmd = prereqCheckCommand(recipe)
    expect(cmd).toMatch(/command -v node/)
    expect(cmd).toMatch(/command -v pnpm/)
    expect(cmd).toMatch(/exit 127/)
  })

  it('handles the no-prereq case without crashing', () => {
    const cmd = prereqCheckCommand({
      id: 'x',
      name: 'X',
      summary: '',
      prerequisites: [],
      steps: [],
    })
    expect(cmd).toMatch(/^:/) // no-op shell
  })
})

describe('renderInitPlan', () => {
  it('renders title, summary, prereqs, and each step as a fenced block', () => {
    const md = renderInitPlan(findRecipe('rust-axum')!)
    expect(md).toMatch(/^# Rust \+ Axum/)
    expect(md).toMatch(/Prerequisites:/)
    expect(md).toMatch(/cargo/)
    expect(md).toMatch(/```sh/)
  })

  it('marks optional steps with the optional tag', () => {
    const md = renderInitPlan(findRecipe('next-postgres')!)
    expect(md).toMatch(/_\(optional\)_/)
  })

  it('renders empty commands as a manual step note', () => {
    const md = renderInitPlan({
      id: 'x',
      name: 'X',
      summary: 's',
      prerequisites: [],
      steps: [{ description: 'just think', command: '' }],
    })
    expect(md).toMatch(/manual step/)
    expect(md).not.toMatch(/```sh/)
  })
})

describe('listRecipes', () => {
  it('lists at least the 5 launch recipes with id/name/summary', () => {
    const list = listRecipes()
    expect(list.length).toBeGreaterThanOrEqual(5)
    expect(list.find((r) => r.id === 'next-postgres')).toBeTruthy()
    expect(list.find((r) => r.id === 'next-supabase')).toBeTruthy()
    expect(list.find((r) => r.id === 'next-stripe')).toBeTruthy()
    expect(list.find((r) => r.id === 'rust-axum')).toBeTruthy()
    expect(list.find((r) => r.id === 'vite-react')).toBeTruthy()
  })
})
