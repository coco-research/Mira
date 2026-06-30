import { motion } from 'framer-motion'

export function TypingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-1.5">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-gray-300"
            animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.2, 0.8] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
          />
        ))}
      </div>
      {label && (
        <span className="text-[10px] text-gray-400 dark:text-gray-500">{label}</span>
      )}
    </div>
  )
}
