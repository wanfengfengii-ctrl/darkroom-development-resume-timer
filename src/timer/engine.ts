/**
 * 暗房冲洗续时台 —— 纯函数状态机
 *
 * 持久化的状态只有两类：
 *  - running：当前阶段 + 该阶段绝对截止时间
 *  - paused：当前阶段 + 当时剩余毫秒
 * 另存「最近墙钟时间 lastWallClock」用于检测时钟回拨。
 *
 * 所有时间均为 Date.now() 形式的 Unix 毫秒时间戳，不依赖任何 tick 计时，
 * 因此刷新页面或平板息屏后，已过去的阶段绝不会被重走。
 *
 * 多标签页：同一冲洗可能在多个标签页打开。每条持久化记录带单调递增的
 * rev；显式操作（开始/暂停/继续/校准/重置）提升 rev，各标签页通过 storage
 * 事件同步。低 rev 的陈旧写入（例如另一个仍在运行的标签页的定时 tick）
 * 不能覆盖高 rev 的暂停/校准记录。重置写一条高 rev 的墓碑，防止旧标签页把
 * 已放弃的会话「复活」。
 */

export const STAGE_IDS = ['develop', 'stop', 'fix'] as const
export type StageId = (typeof STAGE_IDS)[number]

export const STAGE_LABELS: Record<StageId, string> = {
  develop: '显影',
  stop: '停显',
  fix: '定影',
}

export interface Recipe {
  develop: number
  stop: number
  fix: number
}

export type RecipeInput = Record<StageId, string>

/** 运行中：阶段由 deadline 驱动 */
export interface RunningState {
  status: 'running'
  stage: StageId
  deadline: number
}

/** 暂停中：保留当时剩余毫秒 */
export interface PausedState {
  status: 'paused'
  stage: StageId
  remainingMs: number
}

/** 全部三阶段走完 */
export interface DoneState {
  status: 'done'
}

/** 检测到墙钟回拨，锁定；只有重置可清除 */
export interface LockedState {
  status: 'locked'
  /** 持久化中曾见到的最大墙钟时间 */
  lastWallClock: number
  /** 本次读到、却更早的墙钟时间 */
  observedAt: number
}

export type TimerState = RunningState | PausedState | DoneState | LockedState

/** 一次进行中的冲洗会话 */
export interface PersistedState {
  version: 1
  /** 单调版本号，跨标签页用于判定新旧，显式操作时递增 */
  rev: number
  recipe: Recipe
  timer: TimerState
  /** 最近一次见到的墙钟时间（启动/暂停/恢复/每次 tick 都会刷新） */
  lastWallClock: number
}

/** 重置墓碑：会话已放弃，但保留更高 rev 以防陈旧标签页复活旧状态 */
export interface ResetTombstone {
  version: 1
  rev: number
  reset: true
}

export type StoredRecord = PersistedState | ResetTombstone

export function isPersistedState(record: StoredRecord): record is PersistedState {
  return !('reset' in record)
}

export function recordRev(record: StoredRecord | null): number {
  return record ? record.rev : 0
}

export const STORAGE_KEY = 'darkroom-timer:v1'

/** 校验单个秒数输入：必须是 1..1800 的整数 */
export function parseDurationSeconds(raw: string): number | null {
  const t = raw.trim()
  if (!/^-?\d+$/.test(t)) return null
  const n = Number(t)
  if (!Number.isSafeInteger(n)) return null
  if (n < 1 || n > 1800) return null
  return n
}

export function validateRecipe(input: RecipeInput): {
  valid: boolean
  errors: Record<StageId, string | null>
  recipe: Recipe | null
} {
  const errors = { develop: null, stop: null, fix: null } as Record<StageId, string | null>
  const values = {} as Recipe
  let valid = true
  for (const stage of STAGE_IDS) {
    const n = parseDurationSeconds(input[stage])
    if (n === null) {
      errors[stage] = '请输入 1–1800 的整数秒'
      valid = false
    } else {
      values[stage] = n
    }
  }
  return { valid, errors, recipe: valid ? values : null }
}

export function initialInput(): RecipeInput {
  return { develop: '60', stop: '30', fix: '300' }
}

/** 启动：从显影开始，记录绝对截止时间；rev 在调用方基于当前存储递增 */
export function startTimer(recipe: Recipe, now: number, rev: number): PersistedState {
  return {
    version: 1,
    rev,
    recipe,
    timer: { status: 'running', stage: 'develop', deadline: now + recipe.develop * 1000 },
    lastWallClock: now,
  }
}

/** 替换 rev（显式操作后调用） */
export function withRev(state: PersistedState, rev: number): PersistedState {
  return state.rev === rev ? state : { ...state, rev }
}

/** 构造重置墓碑 */
export function resetTombstone(rev: number): ResetTombstone {
  return { version: 1, rev, reset: true }
}

/**
 * 恢复/推进状态机：根据当前墙钟与 deadline 的关系推进。
 * 若已逾期，用「未消费的逾期时长」连续跨过后续阶段；全部耗尽则完成。
 *
 * 另负责时钟回拨检测：now < lastWallClock 时立即锁定。
 */
export function advance(state: PersistedState, now: number): PersistedState {
  if (now < state.lastWallClock) {
    return {
      ...state,
      timer: { status: 'locked', lastWallClock: state.lastWallClock, observedAt: now },
    }
  }
  if (state.timer.status !== 'running') {
    return { ...state, lastWallClock: now }
  }

  let { stage, deadline } = state.timer
  // 未到点：原样返回
  if (deadline > now) {
    return { ...state, lastWallClock: now }
  }

  // 连续跨过已到期的阶段，把逾期时长带到下一阶段
  let i = STAGE_IDS.indexOf(stage)
  while (deadline <= now) {
    i += 1
    if (i >= STAGE_IDS.length) {
      return { ...state, timer: { status: 'done' }, lastWallClock: now }
    }
    const next = STAGE_IDS[i]
    deadline += state.recipe[next] * 1000
    stage = next
  }
  return {
    ...state,
    timer: { status: 'running', stage, deadline },
    lastWallClock: now,
  }
}

/** 暂停：保存当前剩余毫秒（刷新后仍为暂停） */
export function pauseTimer(state: PersistedState, now: number): PersistedState {
  const advanced = advance(state, now)
  if (advanced.timer.status !== 'running') return advanced
  const remainingMs = Math.max(0, advanced.timer.deadline - now)
  return {
    ...advanced,
    timer: { status: 'paused', stage: advanced.timer.stage, remainingMs },
    lastWallClock: now,
  }
}

/** 继续：按当前墙钟重建截止时间 */
export function resumeTimer(state: PersistedState, now: number): PersistedState {
  if (state.timer.status !== 'paused') {
    return advance(state, now)
  }
  // 先用持久化的最近墙钟检测回拨（锁定优先于一切）
  const checked = advance(state, now)
  if (checked.timer.status === 'locked') return checked
  // 暂停期间不消耗时间；恢复时以剩余毫秒重建 deadline
  const running: RunningState = {
    status: 'running',
    stage: state.timer.stage,
    deadline: now + state.timer.remainingMs,
  }
  return advance({ ...checked, timer: running }, now)
}

/**
 * 校准剩余时间：把当前阶段的剩余时间改为指定秒数（1–1800，由调用方校验）。
 *  - 运行态：以当前墙钟重建绝对截止时间 deadline = now + seconds
 *  - 暂停态：替换已保存的剩余毫秒 remainingMs = seconds
 * 两种情况阶段都保持不变；完成/锁定态不接受校准。
 * 与暂停/继续一致，时钟回拨优先于校准：回拨时改为锁定。
 */
export function calibrateTimer(state: PersistedState, seconds: number, now: number): PersistedState {
  if (now < state.lastWallClock) {
    return {
      ...state,
      timer: { status: 'locked', lastWallClock: state.lastWallClock, observedAt: now },
    }
  }
  const timer = state.timer
  if (timer.status === 'running') {
    return {
      ...state,
      timer: { status: 'running', stage: timer.stage, deadline: now + seconds * 1000 },
      lastWallClock: now,
    }
  }
  if (timer.status === 'paused') {
    return {
      ...state,
      timer: { status: 'paused', stage: timer.stage, remainingMs: seconds * 1000 },
      lastWallClock: now,
    }
  }
  return state
}

/** 剩余整秒数（向上取整）；非运行态返回 null */
export function remainingSecondsAt(timer: TimerState, now: number): number | null {
  if (timer.status !== 'running') return null
  return Math.max(0, Math.ceil((timer.deadline - now) / 1000))
}

/** 暂停态剩余整秒（向上取整） */
export function pausedRemainingSeconds(timer: PausedState): number {
  return Math.max(0, Math.ceil(timer.remainingMs / 1000))
}

// ---- localStorage 序列化 ----

/** 有限整数（拒绝 NaN/Infinity/小数字段，时间戳与时长都必须是整数毫秒/秒） */
function isFiniteInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v)
}

/** 阶段标识只能是显影/停显/定影三者之一；未知阶段一律拒绝恢复 */
function isStageId(v: unknown): v is StageId {
  return typeof v === 'string' && (STAGE_IDS as readonly string[]).includes(v)
}

/**
 * 恢复配方：三阶段时长必须各自为正整数秒。缺少定影时长等不完整配方
 * 会让逾期穿透后的 deadline 计算变成 NaN，因此禁止其进入计时面板。
 */
function reviveRecipe(v: unknown): Recipe | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const recipe = {} as Record<StageId, unknown>
  for (const stage of STAGE_IDS) {
    const seconds = r[stage]
    if (!isFiniteInteger(seconds) || seconds < 1) return null
    recipe[stage] = seconds
  }
  return recipe as Recipe
}

/** 按各状态的形状严格校验 timer，任一字段缺失/非有限值都拒绝 */
function reviveTimer(v: unknown): TimerState | null {
  if (!v || typeof v !== 'object') return null
  const t = v as Record<string, unknown>
  switch (t.status) {
    case 'running':
      // deadline 非数字会导致剩余值与后续阶段 deadline 全部变成 NaN
      if (!isStageId(t.stage) || !isFiniteInteger(t.deadline)) return null
      return { status: 'running', stage: t.stage, deadline: t.deadline }
    case 'paused':
      // remainingMs 非数字会让暂停时间显示异常，继续后也无法倒数
      if (!isStageId(t.stage) || !isFiniteInteger(t.remainingMs) || t.remainingMs < 0) return null
      return { status: 'paused', stage: t.stage, remainingMs: t.remainingMs }
    case 'done':
      return { status: 'done' }
    case 'locked':
      if (!isFiniteInteger(t.lastWallClock) || !isFiniteInteger(t.observedAt)) return null
      return { status: 'locked', lastWallClock: t.lastWallClock, observedAt: t.observedAt }
    default:
      return null
  }
}

function revive(raw: string): StoredRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const r = parsed as Record<string, unknown>
  if (r.version !== 1 || !isFiniteInteger(r.rev)) return null
  if (r.reset === true) return { version: 1, rev: r.rev, reset: true }

  // 任何字段损坏（非数字时间、不完整配方、未知阶段）都整体拒绝，
  // 让调用方回到配方页允许重新开始，而不是把 NaN 带进状态机与面板。
  const recipe = reviveRecipe(r.recipe)
  const timer = reviveTimer(r.timer)
  if (!recipe || !timer || !isFiniteInteger(r.lastWallClock)) return null
  return { version: 1, rev: r.rev, recipe, timer, lastWallClock: r.lastWallClock }
}

export function loadRecord(): StoredRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? revive(raw) : null
  } catch {
    return null
  }
}

export function saveRecord(record: StoredRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    // 隐私模式等情况下静默失败；计时功能本身不依赖存储写入成功
  }
}

/**
 * 提交一条记录：仅当候选 rev 不低于存储中现有 rev 时才写入。
 * 这样另一个标签页里陈旧的 running tick（低 rev）不可能覆盖更新的暂停（高 rev）。
 * 返回存储中当前最新的记录：被拒时是更高 rev 的现存记录，调用方应当采纳它。
 */
export function commitRecord(candidate: StoredRecord): StoredRecord {
  const stored = loadRecord()
  if (stored && recordRev(stored) > recordRev(candidate)) {
    return stored
  }
  saveRecord(candidate)
  return candidate
}
