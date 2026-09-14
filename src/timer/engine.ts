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
 * rev；显式操作（开始/暂停/继续/校准/确认搅动/结束本阶段/重置）提升 rev，
 * 各标签页通过 storage 事件同步。低 rev 的陈旧写入（例如另一个仍在运行的
 * 标签页的定时 tick）不能覆盖高 rev 的暂停/校准记录。重置写一条高 rev 的
 * 墓碑，防止旧标签页把已放弃的会话「复活」。
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

// ---- 液温修正 ----

/** 配方基准温度（℃）：等于该温度时不做任何修正 */
export const TEMP_BASELINE = 20
/** 允许输入的液温范围（℃） */
export const TEMP_MIN = 18
export const TEMP_MAX = 24
/** 液温最小递增单位（℃） */
export const TEMP_STEP = 0.5

/** 随会话持久化的温度修正来源；停显/定影不参与换算，故只记录显影基准值 */
export interface TemperatureInfo {
  /** 启动时填写的当前液温（℃），取值 18–24 且为 0.5 的整数倍 */
  temperature: number
  /** 配方表上的基准显影秒数（换算前） */
  baseDevelop: number
}

// ---- 显影搅动提醒 ----

/** 允许的搅动间隔范围（秒） */
export const AGITATION_MIN = 10
export const AGITATION_MAX = 300

/**
 * 搅动节奏，只在显影阶段生效；随暂停/继续在「绝对时刻」与「冻结剩余」间转换：
 *  - running：下一次提示的绝对墙钟时刻 nextAt，now >= nextAt 即待确认，
 *    漏过多少个周期都只是同一条待确认提示，确认后按确认时刻重排
 *  - paused：暂停瞬间冻结的距下次提示剩余毫秒，暂停期间不流逝；
 *    due 记录暂停时提示是否已待确认——到期后才暂停也要继续明确提示搅动，
 *    不能把一条待确认提示伪装成「冻结剩余 0 秒」的普通倒计时
 * 跨入停显/定影、完成或回拨锁定时该字段整体清除。
 */
export type AgitationState =
  | { status: 'running'; intervalSeconds: number; nextAt: number }
  | { status: 'paused'; intervalSeconds: number; remainingMs: number; due: boolean }

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
  /**
   * 现用配方：倒计时、跨阶段、暂停继续、校准全部消费它。
   * 做过液温修正时，这里的 develop 已是修正后秒数；原始基准见 temperature。
   */
  recipe: Recipe
  /**
   * 温度修正来源。仅当启动时填写了液温才存在；缺省（旧本地记录）意味着
   * recipe 就是未修正的原配方。停显/定影不参与换算。
   */
  temperature?: TemperatureInfo
  /**
   * 显影搅动节奏。仅当启动时填写了搅动间隔才存在；缺省（含旧本地记录）意味着
   * 未启用搅动提醒。停显/定影、完成与锁定态均无此字段。
   */
  agitation?: AgitationState
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

/**
 * 校验可选搅动间隔：留空（null，表示不启用）合法；否则须为 10–300 的整数秒。
 */
export function parseAgitationInterval(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = raw.trim()
  if (t === '') return { ok: true, value: null }
  if (!/^-?\d+$/.test(t)) return { ok: false, error: '搅动间隔需为 10–300 的整数秒' }
  const n = Number(t)
  if (!Number.isSafeInteger(n) || n < AGITATION_MIN || n > AGITATION_MAX) {
    return { ok: false, error: '搅动间隔需在 10–300 秒之间' }
  }
  return { ok: true, value: n }
}

/**
 * 液温偏离 20℃ 时的显影秒数换算：
 *   修正秒数 = 基准秒数 × 2^((20 − 液温) / 6)
 * 结果四舍五入到整数秒。调用前必须已通过 parseTemperature 校验。
 */
export function adjustDevelopSeconds(baseDevelopSeconds: number, temperature: number): number {
  return Math.round(baseDevelopSeconds * 2 ** ((TEMP_BASELINE - temperature) / 6))
}

/**
 * 校验可选液温：留空（null，表示不修正）合法；否则须为数值、落在 18–24℃
 * 且以 0.5℃ 递增。返回数值或错误原因。
 */
export function parseTemperature(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = raw.trim()
  if (t === '') return { ok: true, value: null }
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return { ok: false, error: '请输入 18–24 之间的数值（可带 0.5）' }
  const n = Number(t)
  if (!Number.isFinite(n)) return { ok: false, error: '请输入 18–24 之间的数值（可带 0.5）' }
  if (n < TEMP_MIN || n > TEMP_MAX) return { ok: false, error: '液温需在 18–24℃ 之间' }
  if (Math.abs(n / TEMP_STEP - Math.round(n / TEMP_STEP)) > 1e-9) {
    return { ok: false, error: '液温需以 0.5℃ 递增' }
  }
  return { ok: true, value: n }
}

export interface ValidatedRecipe {
  valid: boolean
  errors: Record<StageId, string | null>
  temperatureError: string | null
  agitationError: string | null
  recipe: Recipe | null
  /** 留空或 20℃ 时为 null，表示未做温度修正 */
  temperature: number | null
  /** 基准显影秒数；未填温度时与 recipe.develop 相同 */
  baseDevelop: number | null
  /** 修正后的显影秒数；未填温度时为 null（界面直接展示基准三段秒数） */
  adjustedDevelop: number | null
  /** 搅动间隔（秒）；留空时为 null，表示不启用搅动提醒 */
  agitationInterval: number | null
}

export function validateRecipe(
  input: RecipeInput,
  tempRaw = '',
  agitationRaw = '',
): ValidatedRecipe {
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

  let temperatureError: string | null = null
  let temperature: number | null = null
  let baseDevelop: number | null = null
  let adjustedDevelop: number | null = null

  const temp = parseTemperature(tempRaw)
  if (!temp.ok) {
    temperatureError = temp.error
    valid = false
  } else if (temp.value !== null) {
    temperature = temp.value
    if (errors.develop === null) {
      // 仅在显影基准秒本身合法时才换算，避免 NaN 干扰
      baseDevelop = values.develop
      adjustedDevelop = adjustDevelopSeconds(values.develop, temperature)
      if (adjustedDevelop < 1 || adjustedDevelop > 1800) {
        temperatureError = `温度修正后的显影时长为 ${adjustedDevelop} 秒，超出 1–1800 秒范围`
        valid = false
      }
    } else {
      valid = false
    }
  }

  let agitationError: string | null = null
  let agitationInterval: number | null = null
  const agitation = parseAgitationInterval(agitationRaw)
  if (!agitation.ok) {
    agitationError = agitation.error
    valid = false
  } else {
    agitationInterval = agitation.value
  }

  if (valid) {
    if (temperature !== null) {
      // 现用配方：仅显影被替换为修正值，停显/定影保持原值
      values.develop = adjustedDevelop as number
    }
  }

  return {
    valid,
    errors,
    temperatureError,
    agitationError,
    recipe: valid ? values : null,
    temperature,
    baseDevelop,
    adjustedDevelop,
    agitationInterval,
  }
}

export function initialInput(): RecipeInput {
  return { develop: '60', stop: '30', fix: '300' }
}

/** 新会话默认不填液温（留空即按基准三段秒数直接启动） */
export function initialTemperature(): string {
  return ''
}

/** 新会话默认不填搅动间隔（留空即不启用搅动提醒） */
export function initialAgitation(): string {
  return ''
}

/**
 * 启动：从显影开始，记录绝对截止时间；rev 在调用方基于当前存储递增。
 * 传入的 recipe 必须是「现用配方」（液温修正后仅 develop 被替换）；
 * temperature 为修正来源（液温 + 基准显影秒），未修正时省略；
 * agitationInterval 为搅动间隔秒数，留空（undefined/null）时不启用搅动提醒。
 */
export function startTimer(
  recipe: Recipe,
  now: number,
  rev: number,
  temperature?: TemperatureInfo,
  agitationInterval?: number | null,
): PersistedState {
  return {
    version: 1,
    rev,
    recipe,
    ...(temperature ? { temperature } : {}),
    ...(agitationInterval != null
      ? { agitation: { status: 'running', intervalSeconds: agitationInterval, nextAt: now + agitationInterval * 1000 } }
      : {}),
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
 * 运行态按墙钟推进：未到点只刷新最近墙钟；已到点则用「未消费的逾期时长」
 * 连续跨过后续阶段，全部耗尽则完成。调用方需保证 timer.status === 'running'。
 *
 * 搅动提醒只属于显影：跨入停显/定影或完成时整体清除 agitation；
 * 仍在显影运行时保留（是否到期由 nextAt 与墙钟比较得出，漏过的周期自然合并）。
 */
function advanceRunning(state: PersistedState, now: number): PersistedState {
  let { stage, deadline } = state.timer as RunningState
  // 未到点：原样返回
  if (deadline > now) {
    return { ...state, lastWallClock: now }
  }

  // 连续跨过已到期的阶段，把逾期时长带到下一阶段
  let i = STAGE_IDS.indexOf(stage)
  while (deadline <= now) {
    i += 1
    if (i >= STAGE_IDS.length) {
      return { ...state, agitation: undefined, timer: { status: 'done' }, lastWallClock: now }
    }
    const next = STAGE_IDS[i]
    deadline += state.recipe[next] * 1000
    stage = next
  }
  return {
    ...state,
    // 离开显影（跨入停显）后不再产生搅动提醒
    ...(stage === 'develop' ? {} : { agitation: undefined }),
    timer: { status: 'running', stage, deadline },
    lastWallClock: now,
  }
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
      agitation: undefined,
      timer: { status: 'locked', lastWallClock: state.lastWallClock, observedAt: now },
    }
  }
  if (state.timer.status !== 'running') {
    return { ...state, lastWallClock: now }
  }
  return advanceRunning(state, now)
}

/** 暂停：保存当前剩余毫秒（刷新后仍为暂停） */
export function pauseTimer(state: PersistedState, now: number): PersistedState {
  const advanced = advance(state, now)
  if (advanced.timer.status !== 'running') return advanced
  const remainingMs = Math.max(0, advanced.timer.deadline - now)
  return {
    ...advanced,
    // 冻结距下次搅动提示的剩余毫秒；暂停期间不流逝。到期后才暂停时 due=true，
    // 暂停态继续明确显示「请搅动」，而不是伪装成剩余 0 秒的普通倒计时
    ...(advanced.agitation && advanced.agitation.status === 'running'
      ? {
          agitation: {
            status: 'paused',
            intervalSeconds: advanced.agitation.intervalSeconds,
            remainingMs: Math.max(0, advanced.agitation.nextAt - now),
            due: advanced.agitation.nextAt <= now,
          } satisfies AgitationState,
        }
      : {}),
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
  // 搅动节奏同样以冻结的剩余毫秒重建绝对时刻（remainingMs 可能为 0：已待确认）
  const agitation: AgitationState | undefined =
    state.agitation && state.agitation.status === 'paused'
      ? {
          status: 'running',
          intervalSeconds: state.agitation.intervalSeconds,
          nextAt: now + state.agitation.remainingMs,
        }
      : undefined
  return advance({ ...checked, ...(agitation ? { agitation } : {}), timer: running }, now)
}

/**
 * 校准剩余时间：把当前阶段的剩余时间改为指定秒数（1–1800，由调用方校验）。
 *  - 运行态：先按墙钟补推进（显影已归零却尚未由 tick 推进时跨入停显/完成），
 *    再以当前墙钟重建「推进后所在阶段」的绝对截止时间 deadline = now + seconds
 *  - 暂停态：替换已保存的剩余毫秒 remainingMs = seconds
 * 两种情况阶段都保持校准瞬间的当前阶段不变；完成/锁定态不接受校准。
 * 与暂停/继续一致，时钟回拨优先于校准：回拨时改为锁定。
 */
export function calibrateTimer(state: PersistedState, seconds: number, now: number): PersistedState {
  if (now < state.lastWallClock) {
    return {
      ...state,
      agitation: undefined,
      timer: { status: 'locked', lastWallClock: state.lastWallClock, observedAt: now },
    }
  }
  const timer0 = state.timer
  // 暂停态：墙钟不消耗，直接替换冻结剩余；完成/锁定态不接受校准（原样返回）
  if (timer0.status === 'done' || timer0.status === 'locked') return state
  if (timer0.status === 'paused') {
    return {
      ...state,
      timer: { status: 'paused', stage: timer0.stage, remainingMs: seconds * 1000 },
      lastWallClock: now,
    }
  }

  // 运行态：先消费已到期的阶段——显影倒计时已归零（界面尚未被 tick 推进）时
  // 校准，必须先进入停显/完成，绝不能把已结束的显影按校准秒数重新延长
  const advanced = advanceRunning(state, now)
  const timer = advanced.timer
  if (timer.status !== 'running') return advanced
  return {
    ...advanced,
    timer: { status: 'running', stage: timer.stage, deadline: now + seconds * 1000 },
    lastWallClock: now,
  }
}

/** endStageEarly 的结果：state 为应采纳的记录；ended 表示确实提前结束了所携阶段 */
export interface EndStageResult {
  state: PersistedState
  /** false 表示阶段已在另一标签页或计时推进中变化，本次未提前结束 */
  ended: boolean
}

/**
 * 提前结束当前药浴（试片密度已达标或需立即换液）。操作携带点击时面板显示的
 * 阶段 expectedStage，避免陈旧面板误跳两段：
 *  1. 先按当前墙钟消费自然到期时间（含回拨锁定）：当前阶段已到期却尚未被
 *     tick 推进时，自然跨入后续阶段/完成，本次操作不再额外跳段
 *  2. 推进后阶段仍与 expectedStage 一致：转入下一药浴——运行态以下一阶段
 *     完整时长倒数（deadline = now + 全量秒数）；暂停态保持暂停并保存完整
 *     时长。跳过显影时搅动提示一并清除；跳过定影（最后阶段）直接进入完成
 *  3. 推进后阶段已变化（另一标签页或计时推进先行）：不越过新阶段，返回
 *     推进结果且 ended=false，由界面采纳较高修订记录并提示
 *     「阶段已更新，未提前结束」
 */
export function endStageEarly(state: PersistedState, expectedStage: StageId, now: number): EndStageResult {
  const advanced = advance(state, now)
  const timer = advanced.timer
  // 完成/锁定态不接受结束操作；阶段已不一致时不越过新阶段
  if (timer.status !== 'running' && timer.status !== 'paused') {
    return { state: advanced, ended: false }
  }
  if (timer.stage !== expectedStage) {
    return { state: advanced, ended: false }
  }

  const nextIndex = STAGE_IDS.indexOf(timer.stage) + 1
  if (nextIndex >= STAGE_IDS.length) {
    // 跳过定影（最后阶段）：冲洗完成
    return {
      state: { ...advanced, agitation: undefined, timer: { status: 'done' }, lastWallClock: now },
      ended: true,
    }
  }

  const nextStage = STAGE_IDS[nextIndex]
  const fullMs = advanced.recipe[nextStage] * 1000
  const nextTimer: TimerState =
    timer.status === 'running'
      ? { status: 'running', stage: nextStage, deadline: now + fullMs }
      : { status: 'paused', stage: nextStage, remainingMs: fullMs }
  return {
    state: {
      ...advanced,
      // 跳过显影：搅动提示随显影结束一并清除
      ...(timer.stage === 'develop' ? { agitation: undefined } : {}),
      timer: nextTimer,
      lastWallClock: now,
    },
    ended: true,
  }
}

/**
 * 确认搅动：
 *  - 显影运行中、尚未到点（deadline > now）且提示已到期（now >= nextAt）：
 *    按当前墙钟排定下一次提示 nextAt = now + interval
 *  - 显影暂停中且暂停时提示已到期（冻结剩余 0、due=true）：确认后把冻结剩余
 *    恢复为完整间隔，继续后从间隔满量起倒数；暂停期间仍不流逝
 * 显影已经结束（deadline <= now，界面尚未被 tick 推进）时不再接受确认，
 * 而是按墙钟推进——结束显影并跨入停显/完成，绝不会排定下一次搅动提示。
 * 其余无提示可确认的情况原样返回（幂等）。
 */
export function acknowledgeAgitation(state: PersistedState, now: number): PersistedState {
  const a = state.agitation

  if (state.timer.status === 'paused') {
    if (state.timer.stage !== 'develop' || !a || a.status !== 'paused' || !a.due) return state
    return {
      ...state,
      agitation: {
        status: 'paused',
        intervalSeconds: a.intervalSeconds,
        remainingMs: a.intervalSeconds * 1000,
        due: false,
      },
      lastWallClock: now,
    }
  }

  if (state.timer.status !== 'running') return state
  if (state.timer.stage !== 'develop') return state
  if (!a || a.status !== 'running' || a.nextAt > now) return state
  // 显影已到期：确认无效，让阶段正常结束（advance 会一并清除 agitation）
  if (state.timer.deadline <= now) return advance(state, now)
  return {
    ...state,
    agitation: { status: 'running', intervalSeconds: a.intervalSeconds, nextAt: now + a.intervalSeconds * 1000 },
    lastWallClock: now,
  }
}

/** 计时面板消费的搅动提示视图：无搅动字段（含旧记录）时为 null */
export interface AgitationView {
  /** 提示已到期待确认（漏过多少周期都合并为同一条） */
  due: boolean
  /** 距下次提示的整秒（向上取整）；待确认时为 0；暂停时为冻结剩余 */
  remainingSeconds: number
  /** 本轮搅动间隔（秒） */
  intervalSeconds: number
}

export function agitationView(state: PersistedState, now: number): AgitationView | null {
  const a = state.agitation
  if (!a) return null
  if (a.status === 'paused') {
    return {
      // 暂停时已待确认的提示不能伪装成「冻结剩余 0 秒」：继续明确要求搅动
      due: a.due,
      remainingSeconds: Math.max(0, Math.ceil(a.remainingMs / 1000)),
      intervalSeconds: a.intervalSeconds,
    }
  }
  const due = a.nextAt <= now
  return {
    due,
    remainingSeconds: due ? 0 : Math.max(0, Math.ceil((a.nextAt - now) / 1000)),
    intervalSeconds: a.intervalSeconds,
  }
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

/**
 * 恢复温度修正来源：字段整体缺省（旧本地记录）合法地解释为「未修正配方」。
 * 一旦出现 temperature 字段，其形状必须完整且取值合法，否则整条记录拒绝。
 */
function reviveTemperature(v: unknown): TemperatureInfo | null {
  if (v === undefined || v === null) return null // 无字段：未修正
  if (typeof v !== 'object') return null
  const t = v as Record<string, unknown>
  const { temperature, baseDevelop } = t
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) return null
  if (temperature < TEMP_MIN || temperature > TEMP_MAX) return null
  if (Math.abs(temperature / TEMP_STEP - Math.round(temperature / TEMP_STEP)) > 1e-9) return null
  if (!isFiniteInteger(baseDevelop) || baseDevelop < 1) return null
  return { temperature, baseDevelop }
}

/**
 * 恢复搅动节奏：字段整体缺省（旧本地记录）合法地解释为「未启用」。
 * 一旦出现 agitation 字段，其形状必须完整合法，且与 timer 的状态/阶段一致
 * （搅动只在显影存在），否则整条记录拒绝。
 */
function reviveAgitation(v: unknown, timer: TimerState): AgitationState | null {
  if (v === undefined || v === null) return null // 无字段：未启用
  if (typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  if (!isFiniteInteger(a.intervalSeconds) || a.intervalSeconds < AGITATION_MIN || a.intervalSeconds > AGITATION_MAX) {
    return null
  }
  // 锁定/完成态不应再带搅动字段；停显/定影阶段也不应存在
  if (timer.status === 'done' || timer.status === 'locked' || timer.stage !== 'develop') return null
  if (a.status === 'running') {
    if (timer.status !== 'running' || !isFiniteInteger(a.nextAt)) return null
    return { status: 'running', intervalSeconds: a.intervalSeconds, nextAt: a.nextAt }
  }
  if (a.status === 'paused') {
    if (timer.status !== 'paused' || !isFiniteInteger(a.remainingMs) || a.remainingMs < 0) return null
    // due 只可能与冻结剩余 0 同时出现（到期即 nextAt<=now，冻结剩余必为 0）。
    // 旧版本写入的暂停记录没有 due 字段：按该不变量推导，避免把进行中的会话整体拒绝
    const derivedDue = a.remainingMs === 0
    if (a.due !== undefined && (typeof a.due !== 'boolean' || a.due !== derivedDue)) return null
    return {
      status: 'paused',
      intervalSeconds: a.intervalSeconds,
      remainingMs: a.remainingMs,
      due: derivedDue,
    }
  }
  return null
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

  // temperature / agitation 缺省 = 未修正/未启用（含旧本地记录）；
  // 一旦字段存在但形状非法或与 timer 状态不一致 = 损坏，整体拒绝
  let temperature: TemperatureInfo | null = null
  if ('temperature' in r) {
    temperature = reviveTemperature(r.temperature)
    if (!temperature) return null
  }

  let agitation: AgitationState | null = null
  if ('agitation' in r) {
    agitation = reviveAgitation(r.agitation, timer)
    if (!agitation) return null
  }

  return {
    version: 1,
    rev: r.rev,
    recipe,
    ...(temperature ? { temperature } : {}),
    ...(agitation ? { agitation } : {}),
    timer,
    lastWallClock: r.lastWallClock,
  }
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
