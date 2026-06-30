import { useEffect, useRef, useState } from 'react'

interface Props {
  isRunning: boolean
}

export function RealtimeCounter({ isRunning }: Props) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    if (!isRunning) { setElapsed(0); return }
    startRef.current = Date.now()
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 100)
    return () => clearInterval(interval)
  }, [isRunning])

  if (!isRunning || elapsed < 1) return null

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60

  return (
    <div className="absolute bottom-14 right-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-gray-100/80 dark:bg-white/5 backdrop-blur-sm z-10">
      <div className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 animate-pulse" />
      <span className="text-[0.5rem] text-gray-500 dark:text-gray-500 font-mono tabular-nums">
        {mins > 0 ? `${mins}m ` : ''}{secs}s
      </span>
    </div>
  )
}
