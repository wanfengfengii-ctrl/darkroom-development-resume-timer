import {
  STAGE_IDS,
  STAGE_LABELS,
  pausedRemainingSeconds,
  remainingSecondsAt,
  type PersistedState,
} from '../timer/engine'

interface Props {
  state: PersistedState
  now: number
  onPause: () => void
  onResume: () => void
  onReset: () => void
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 三阶段进度提示：已完成阶段打勾，唯一当前阶段高亮，未到阶段置灰 */
function StageStepper({ currentIndex }: { currentIndex: number }) {
  return (
    <ol className="stepper" aria-label="阶段进度">
      {STAGE_IDS.map((id, i) => {
        const status = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo'
        return (
          <li key={id} className={`step step-${status}`} aria-current={status === 'current'}>
            <span className="step-mark">{i < currentIndex ? '✓' : i + 1}</span>
            <span className="step-name">{STAGE_LABELS[id]}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function TimerPanel({ state, now, onPause, onResume, onReset }: Props) {
  const timer = state.timer

  if (timer.status === 'locked') {
    return (
      <section className="card panel panel-locked" data-testid="panel" data-status="locked" aria-live="assertive">
        <h2 data-testid="locked-title">⛔ 时钟回拨，计时台已锁定</h2>
        <p>
          检测到当前墙钟时间（{new Date(timer.observedAt).toLocaleString()}）早于最近记录时间（
          {new Date(timer.lastWallClock).toLocaleString()}）。
        </p>
        <p className="hint">
          为避免已过去的药浴阶段被错误重走，计时已停止。请校准设备时钟后，只能通过「重置」清除锁定并重新开始。
        </p>
        <button type="button" className="btn danger" onClick={onReset} data-testid="reset-button">
          重置
        </button>
      </section>
    )
  }

  if (timer.status === 'done') {
    return (
      <section className="card panel panel-done" data-testid="panel" data-status="done" aria-live="assertive">
        <h2 data-testid="done-title">🎉 冲洗完成</h2>
        <p>显影、停显、定影三个阶段均已完成，可以取出胶片。</p>
        <StageStepper currentIndex={STAGE_IDS.length} />
        <button type="button" className="btn primary" onClick={onReset} data-testid="reset-button">
          开始新一轮冲洗
        </button>
      </section>
    )
  }

  const stageIndex = STAGE_IDS.indexOf(timer.stage)
  const statusLabel = timer.status === 'running' ? '进行中' : '已暂停'
  const seconds =
    timer.status === 'running'
      ? (remainingSecondsAt(timer, now) ?? 0)
      : pausedRemainingSeconds(timer)

  return (
    <section
      className={`card panel panel-${timer.status}`}
      data-testid="panel"
      data-status={timer.status}
      aria-live="polite"
    >
      <StageStepper currentIndex={stageIndex} />

      <p className="current-stage">
        当前阶段：<strong data-testid="current-stage">{STAGE_LABELS[timer.stage]}</strong>
        <span className={`badge badge-${timer.status}`}>{statusLabel}</span>
      </p>

      <div className="countdown" aria-label={`剩余 ${seconds} 秒`}>
        <span className="countdown-seconds" data-testid="seconds">
          {seconds}
        </span>
        <span className="countdown-unit">秒</span>
      </div>
      <p className="countdown-clock">剩余 {formatClock(seconds)}</p>

      <div className="actions">
        {timer.status === 'running' ? (
          <button type="button" className="btn" onClick={onPause} data-testid="pause-button">
            暂停
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={onResume} data-testid="resume-button">
            继续
          </button>
        )}
        <button
          type="button"
          className="btn danger ghost"
          onClick={onReset}
          aria-label="重置并放弃当前冲洗"
          data-testid="reset-button"
        >
          重置
        </button>
      </div>

      {timer.status === 'paused' && (
        <p className="hint">暂停中剩余时间已保存，即使刷新页面仍保持暂停。</p>
      )}
    </section>
  )
}
