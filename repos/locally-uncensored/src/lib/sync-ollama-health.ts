/**
 * Mirror a typed Ollama provider error into the shared health store.
 *
 * The provider layer is intentionally store-free (see ProviderError
 * docstring in api/providers/types.ts) — that means every UI catch site
 * that wants the header chip + top banner to update needs to translate the
 * error code into a store call itself. This helper is that translation,
 * kept in one place so the mapping `code → store action` doesn't drift
 * between catch sites.
 *
 * Desktop note: the desktop `modelHealthStore` tracks a single
 * `staleModels` list (its fix and UI treatment — StaleModelsBanner
 * "Refresh All" + Header chip — are identical for both failure modes).
 * Both `ollama_stale_manifest` AND `ollama_missing_blob` share the exact
 * same recovery (`ollama pull <model>`), so both route into `staleModels`
 * here. (uselu's web build keeps a separate `missingBlobModels` array +
 * `markMissingBlob` action; desktop has no such slot, so we fold both
 * codes into the one list the store actually exposes.)
 *
 * Pure side-effect — no return value. Safe to call with any unknown
 * `err`; only acts on `ProviderError` with the recognised codes.
 */

import { ProviderError } from '../api/providers/types'
import { useModelHealthStore } from '../stores/modelHealthStore'

export function syncOllamaHealthFromError(err: unknown): void {
  if (!(err instanceof ProviderError) || !err.model) return
  if (err.code !== 'ollama_missing_blob' && err.code !== 'ollama_stale_manifest') return

  const store = useModelHealthStore.getState()
  if (!store.staleModels.includes(err.model)) {
    store.setStaleModels([...store.staleModels, err.model])
  }
}
