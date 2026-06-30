import { ArrowLeft, Trophy, Zap, Play, Square } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useBenchmarkStore, getLatestSpeed, getLeaderboard } from '../../stores/benchmarkStore'
import { useBenchmark } from '../../hooks/useBenchmark'

export function BenchmarkView() {
  const { setView } = useUIStore()
  const models = useModelStore((s) => s.models)
  const results = useBenchmarkStore((s) => s.results)
  const isRunning = useBenchmarkStore((s) => s.isRunning)
  const currentModel = useBenchmarkStore((s) => s.currentModel)
  const currentStep = useBenchmarkStore((s) => s.currentStep)
  const totalSteps = useBenchmarkStore((s) => s.totalSteps)
  const { runBenchmark, stopBenchmark } = useBenchmark()
  const leaderboard = getLeaderboard(results)

  // Only show text models (benchmarks don't apply to image/video)
  const textModels = models.filter((m) => m.type === 'text')

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-2xl mx-auto px-4 py-4">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => setView('models')} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/5 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors">
            <ArrowLeft size={16} />
          </button>
          <Trophy size={16} className="text-amber-400" />
          <h1 className="text-[0.8rem] font-semibold text-gray-800 dark:text-gray-200">Benchmark</h1>
        </div>

        {/* Leaderboard */}
        {leaderboard.length > 0 && (
          <div className="mb-6 p-4 rounded-xl bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/5">
            <h2 className="text-[0.7rem] font-semibold text-amber-500 flex items-center gap-1.5 mb-3">
              <Trophy size={13} />
              Leaderboard
            </h2>
            <div className="space-y-2">
              {leaderboard.map((entry, i) => {
                const maxTps = leaderboard[0].avgTps
                const barWidth = maxTps > 0 ? (entry.avgTps / maxTps) * 100 : 0

                return (
                  <div key={entry.model} className="flex items-center gap-3">
                    <span className={`text-[0.7rem] w-5 text-right font-bold ${i === 0 ? 'text-amber-400' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-orange-700' : 'text-gray-500'}`}>
                      {i + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[0.7rem] text-gray-800 dark:text-gray-200 truncate font-medium">{entry.model}</span>
                        <span className="text-[0.65rem] text-gray-600 dark:text-gray-400 font-mono shrink-0 ml-2 flex items-center gap-1">
                          <Zap size={10} className="text-amber-400" />
                          {entry.avgTps} t/s
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-gray-200 dark:bg-white/5 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${i === 0 ? 'bg-amber-400' : 'bg-gray-400 dark:bg-gray-500/60'}`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="text-[0.55rem] text-gray-500 mt-3">
              {leaderboard.reduce((s, e) => s + e.runs, 0)} total runs across {leaderboard.length} models
            </p>
          </div>
        )}

        {/* Model List with Bench Buttons */}
        <div className="space-y-1">
          <h2 className="text-[0.65rem] font-semibold uppercase tracking-widest text-gray-500 mb-2">
            {textModels.length} Text Models
          </h2>
          {textModels.map((model) => {
            const latestSpeed = getLatestSpeed(results, model.name)
            const isThisRunning = isRunning && currentModel === model.name

            return (
              <div
                key={model.name}
                className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.03] border border-transparent hover:border-gray-200 dark:hover:border-white/5 transition-all"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[0.7rem] text-gray-800 dark:text-gray-200 truncate">{model.name}</span>
                  {latestSpeed !== null && (
                    <span className="text-[0.55rem] text-gray-500 font-mono flex items-center gap-0.5 shrink-0" title="Most recent benchmark run">
                      <Zap size={9} className="text-amber-400" />
                      {latestSpeed} t/s
                    </span>
                  )}
                </div>
                <div className="shrink-0">
                  {isThisRunning ? (
                    <button
                      onClick={stopBenchmark}
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-red-500/15 text-red-500 text-[0.6rem] hover:bg-red-500/25 transition-colors"
                    >
                      <Square size={10} />
                      {currentStep}/{totalSteps}
                    </button>
                  ) : (
                    <button
                      onClick={() => runBenchmark(model.name)}
                      disabled={isRunning}
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-[0.6rem] hover:bg-gray-200 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-gray-200 transition-colors disabled:opacity-30"
                    >
                      <Play size={10} />
                      Run Benchmark
                    </button>
                  )}
                </div>
              </div>
            )
          })}

          {textModels.length === 0 && (
            <p className="text-center text-gray-500 text-[0.7rem] py-8">
              No text models installed. Pull a model from the Model Manager first.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
