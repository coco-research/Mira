import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cloud, Check, Loader2 } from 'lucide-react'
import { useCloudTeaserStore } from '../../stores/cloudTeaserStore'
import { submitWaitlist, isValidEmail } from '../../api/waitlist'
import { log } from '../../lib/logger'

/**
 * Cloud "Hosted LU Workflows" waitlist teaser — a subtle purple badge next to
 * the brand monogram (top-left). Click opens a small popover with one optional
 * email field.
 *
 * Deliberately NOT naggy (the adversarial call): no pulsing/animation on the
 * dot, the network call fires ONLY on the explicit "Notify me" click (never on
 * render or launch), and there is honest microcopy that this is the one thing
 * LU sends off-device. The badge disappears for good once the user clicks
 * "Don't show me again", or on the next launch after they join the waitlist
 * (a fresh submit still shows the "you're on the list" confirmation first).
 * Closing the popover or clicking outside leaves it.
 *
 * The popover is a self-contained dark gradient card (black → dark-grey) in
 * both themes — David 2026-06-06 wanted it distinct from the flat grey panels,
 * so all inner text is light regardless of light/dark mode.
 */
export function CloudWaitlistBadge() {
  const dismissed = useCloudTeaserStore((s) => s.dismissed)
  const submitted = useCloudTeaserStore((s) => s.submitted)
  const setDismissed = useCloudTeaserStore((s) => s.setDismissed)
  const setSubmitted = useCloudTeaserStore((s) => s.setSubmitted)

  // A user who joined the waitlist in a PREVIOUS session (incl. v2.5.0) should
  // not see the badge again (David 2026-06-07: gone for people who already
  // submitted OR dismissed). `submitted` persists in lu_cloud_teaser (a
  // STORE_KEY, so it survives updates). Snapshot it once at mount so a fresh
  // same-session submit still shows the confirmation before it's gone next launch.
  const [submittedBeforeThisSession] = useState(() => useCloudTeaserStore.getState().submitted)

  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Click outside closes the popover (does NOT dismiss the badge).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Gone for good once the user opts out, or if they already joined the
  // waitlist in an earlier session (see snapshot above).
  if (dismissed || submittedBeforeThisSession) return null

  const handleSubmit = async () => {
    if (busy) return
    const value = email.trim()
    if (!isValidEmail(value)) {
      setError('Please enter a valid email address.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await submitWaitlist(value, 'app-badge')
      setSubmitted(true) // popover flips to the "you're on the list" state
    } catch (err) {
      log.error('[waitlist] submit failed', { err })
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void handleSubmit() }
  }

  return (
    <div ref={ref} className="relative">
      {/* Trigger — subtle, no pulse */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-1 rounded-md text-purple-500 hover:text-purple-400 hover:bg-purple-500/10 transition-colors"
        title="LU in the cloud — early access"
        aria-label="Cloud early access"
      >
        <Cloud size={14} />
        <span className="absolute -top-0.5 -right-0.5 min-w-[13px] h-[13px] flex items-center justify-center rounded-full bg-purple-500 text-[0.5rem] font-bold text-white leading-none px-0.5">
          {submitted ? <Check size={8} strokeWidth={3} /> : '1'}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute left-0 top-full mt-1.5 w-72 rounded-lg overflow-hidden z-50 bg-gradient-to-br from-black via-neutral-900 to-neutral-700 border border-white/10 shadow-2xl shadow-black/60"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            <div className="p-3.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Cloud size={13} className="text-purple-400" />
                <span className="text-[0.72rem] font-semibold text-white">
                  LU in the cloud is coming
                </span>
              </div>

              {submitted ? (
                <div className="py-1">
                  <div className="flex items-center gap-1.5 text-green-400">
                    <Check size={13} strokeWidth={3} />
                    <span className="text-[0.72rem] font-medium">You're on the list.</span>
                  </div>
                  <p className="mt-1 text-[0.64rem] leading-relaxed text-gray-300">
                    We'll email you once early access opens. Nothing else.
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-[0.64rem] leading-relaxed text-gray-300 mb-2.5">
                    Run LU from your phone or any light setup — hosted workflows.
                    Local stays free &amp; private.
                  </p>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); if (error) setError(null) }}
                      onKeyDown={onKeyDown}
                      placeholder="you@email.com"
                      disabled={busy}
                      className="flex-1 min-w-0 px-2 py-1 rounded-md text-[0.7rem] bg-white/10 border border-white/15 text-white placeholder:text-gray-400 focus:outline-none focus:border-purple-400/70 disabled:opacity-50"
                    />
                    <button
                      onClick={() => void handleSubmit()}
                      disabled={busy}
                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[0.68rem] font-medium bg-purple-500 hover:bg-purple-400 text-white disabled:opacity-60 transition-colors"
                    >
                      {busy ? <Loader2 size={11} className="animate-spin" /> : null}
                      Notify me
                    </button>
                  </div>
                  {error && (
                    <p className="mt-1.5 text-[0.62rem] text-red-400">{error}</p>
                  )}
                  <p className="mt-2 text-[0.58rem] leading-relaxed text-gray-400">
                    This is the only thing LU sends off your device.
                  </p>
                </>
              )}
            </div>

            {/* Explicit opt-out — the ONLY way the badge goes away for good. */}
            <div className="border-t border-white/10 px-3.5 py-1.5">
              <button
                onClick={() => { setDismissed(true); setOpen(false) }}
                className="text-[0.6rem] text-gray-400 hover:text-gray-200 transition-colors"
              >
                Don't show me again
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
