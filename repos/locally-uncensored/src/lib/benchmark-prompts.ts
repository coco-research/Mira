/**
 * Standardized benchmark prompts for local model testing.
 */

export interface BenchmarkPrompt {
  id: string
  name: string
  category: 'speed' | 'reasoning' | 'code'
  prompt: string
  expectedMinTokens: number
}

export const BENCHMARK_PROMPTS: BenchmarkPrompt[] = [
  {
    id: 'speed',
    name: 'Speed Test',
    category: 'speed',
    prompt: 'List the numbers from 1 to 50, each on a new line. Just the numbers, nothing else.',
    expectedMinTokens: 50,
  },
  {
    id: 'reasoning',
    name: 'Reasoning',
    category: 'reasoning',
    prompt: 'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning step by step.',
    expectedMinTokens: 30,
  },
  {
    id: 'code',
    name: 'Code Generation',
    category: 'code',
    prompt: 'Write a Python function called `fibonacci` that returns the nth Fibonacci number using dynamic programming. Include a docstring.',
    expectedMinTokens: 40,
  },
]

export interface BenchmarkResult {
  modelName: string
  promptId: string
  tokensPerSec: number
  timeToFirstToken: number
  totalTime: number
  totalTokens: number
  timestamp: number
}
