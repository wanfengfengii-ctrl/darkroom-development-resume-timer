import { useState, type FormEvent } from 'react'
import {
  STAGE_IDS,
  STAGE_LABELS,
  agitationView,
  parseDurationSeconds,
  pausedRemainingSeconds,
  remainingSecondsAt,
  type PersistedState,
} from '../timer/engine'

interface Props {
  state: PersistedState
  now: number
  onPause: () => void
  onResume: () => void
  onCalibrate: (seconds: number) => void
  onAcknowledge: () => void
  onReset: () => void
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 显影搅动提示（字段不存在时——含启动留空与旧记录——整体不渲染）：
 *  - 运行中未到期：显示距下次提示的秒数
 *  - 运行中已到期：突出显示「请搅动」并提供确认；漏过多个周期也只此一条
 *  - 暂停中：显示冻结的剩余秒数，暂停期间不流逝
 * 进入停显/定影后 state.agitation 已被状态机清除，这里自然消失。
 */
function AgitationPrompt({
  state,
  now,
  onConfirm,
}: {
  state: PersistedState
  now: number
  onConfirm: () => void
}) {
  const view = agitationView(state, now)
  if (!view) return null
  const paused = state.timer.status === 'paused'

  if (view.due) {
    return (
      <div className="agitation agitation-due" data-testid="agitation-prompt" data-due="true" role="alert">
        <span className="agitation-text">🌀 请搅动显影罐</span>
        <button type="button" className="btn primary" onClick={onConfirm} data-testid="agitation-confirm">
          已搅动
        </button>
      </div>
    )
  }

  return (
    <p className="agitation agitation-wait" data-testid="agitation-prompt" data-due="false">
      {paused ? '暂停中：搅动提示已冻结，剩余 ' : `距下次搅动还有 `}
      <strong data-testid="agitation-remaining">{view.remainingSeconds}</strong> 秒
      <span className="agitation-meta">（每 {view.intervalSeconds} 秒，仅显影阶段）</span>
    </p>
  )
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

/**
 * 本轮温度修正来源：
 *  - 含 temperature：标明液温、基准显影秒数与现用（修正后）秒数
 *  - 不含 temperature（含启动时留空、以及旧版本写入的本地记录）：明确解释为未修正配方
 */
function TemperatureSource({ state }: { state: PersistedState }) {
  const info = state.temperature
  if (!info) {
    return (
      <p className="temp-source temp-source-none" data-testid="temp-source" data-corrected="false">
        本轮按基准配方原时长计时，未做液温修正。
      </p>
    )
  }
  const { temperature, baseDevelop } = info
  const activeDevelop = state.recipe.develop
  return (
    <p className="temp-source temp-source-on" data-testid="temp-source" data-corrected="true">
      本轮液温 <strong>{temperature}℃</strong>：显影基准 {baseDevelop} 秒 → 现用{' '}
      <strong>{activeDevelop}</strong> 秒；停显/定影未换算。
    </p>
  )
}

export function TimerPanel({ state, now, onPause, onResume, onCalibrate, onAcknowledge, onReset }: Props) {
  const timer = state.timer
  const [calibrateInput, setCalibrateInput] = useState('')
  const [calibrateError, setCalibrateError] = useState<string | null>(null)

  /** 校准提交：非法输入就地提示且绝不动计时；合法才走显式操作 */
  const submitCalibrate = (e: FormEvent) => {
    e.preventDefault()
    const seconds = parseDurationSeconds(calibrateInput)
    if (seconds === null) {
      setCalibrateError('请输入 1–1800 的整数秒')
      return
    }
    setCalibrateError(null)
    setCalibrateInput('')
    onCalibrate(seconds)
  }

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
        <TemperatureSource state={state} />
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
        <TemperatureSource state={state} />
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

      <TemperatureSource state={state} />

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

      <AgitationPrompt state={state} now={now} onConfirm={onAcknowledge} />

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

      <form className="calibrate" onSubmit={submitCalibrate} aria-label="校准剩余时间">
        <label className="calibrate-label" htmlFor="calibrate-input">
          校准剩余时间
        </label>
        <div className="calibrate-row">
          <input
            id="calibrate-input"
            type="text"
            inputMode="numeric"
            placeholder="1–1800"
            value={calibrateInput}
            aria-invalid={calibrateError !== null}
            aria-describedby="calibrate-error"
            data-testid="calibrate-input"
            onChange={(e) => {
              setCalibrateInput(e.target.value)
              setCalibrateError(null)
            }}
          />

          <span className="unit">秒</span>
          <button type="submit" className="btn ghost" data-testid="calibrate-button">
            校准
          </button>
        </div>
        {calibrateError && (
          <p id="calibrate-error" className="error" role="alert" data-testid="calibrate-error">
            {calibrateError}
          </p>
        )}
      </form>

      {timer.status === 'paused' && (
        <p className="hint">暂停中剩余时间已保存，即使刷新页面仍保持暂停。</p>
      )}
    </section>
  )
}
