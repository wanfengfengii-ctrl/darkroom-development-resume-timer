import { afterEach, describe, expect, it } from 'vitest'
import {
  AGITATION_MAX,
  AGITATION_MIN,
  STAGE_IDS,
  STORAGE_KEY,
  acknowledgeAgitation,
  adjustDevelopSeconds,
  advance,
  agitationView,
  calibrateTimer,
  commitRecord,
  isPersistedState,
  loadRecord,
  parseAgitationInterval,
  parseTemperature,
  pauseTimer,
  pausedRemainingSeconds,
  recordRev,
  remainingSecondsAt,
  resetTombstone,
  resumeTimer,
  saveRecord,
  startTimer,
  validateRecipe,
  withRev,
  type PersistedState,
  type Recipe,
  type RecipeInput,
} from './engine'

const recipe: Recipe = { develop: 60, stop: 30, fix: 300 }
const SECOND = 1000
const T0 = 1_000_000_000_000

afterEach(() => localStorage.removeItem(STORAGE_KEY))

/** 把当前持久化推进到指定阶段进行中（测试辅助），默认 rev=1 */
function runningAt(stageIndex: number, now: number, deadline: number, rev = 1): PersistedState {
  return {
    version: 1,
    rev,
    recipe,
    timer: { status: 'running', stage: STAGE_IDS[stageIndex], deadline },
    lastWallClock: now - 1,
  }
}

describe('validateRecipe', () => {
  it('接受 1–1800 的整数秒', () => {
    expect(validateRecipe({ develop: '1', stop: '1800', fix: '90' }).valid).toBe(true)
    expect(validateRecipe({ develop: ' 60 ', stop: '30', fix: '300' }).valid).toBe(true)
  })

  it.each([
    ['0', '下界'],
    ['-1', '负数'],
    ['1801', '上界外'],
    ['1.5', '小数'],
    ['abc', '非数字'],
    ['', '空值'],
    ['60秒', '带单位'],
    ['1e3', '科学计数'],
    ['  ', '空白'],
  ])('拒绝非法值 %s（%s）', (value, _name) => {
    const result = validateRecipe({ develop: value, stop: '30', fix: '300' })
    expect(result.valid).toBe(false)
    expect(result.errors.develop).not.toBeNull()
    expect(result.recipe).toBeNull()
  })

  it('允许前后空白与前导零（仍为整数）', () => {
    const r = validateRecipe({ develop: ' 60 ', stop: '007', fix: '300' })
    expect(r.valid).toBe(true)
    expect(r.recipe?.stop).toBe(7)
  })

  it('任一阶段非法即整体非法', () => {
    const r = validateRecipe({ develop: '60', stop: 'x', fix: '300' })
    expect(r.valid).toBe(false)
    expect(r.errors.stop).not.toBeNull()
    expect(r.errors.develop).toBeNull()
  })
})

describe('液温换算 adjustDevelopSeconds', () => {
  it('基准温度 20℃ 时修正值等于原值', () => {
    expect(adjustDevelopSeconds(60, 20)).toBe(60)
    expect(adjustDevelopSeconds(1, 20)).toBe(1)
    expect(adjustDevelopSeconds(1800, 20)).toBe(1800)
  })

  it('18℃ 按 2^((20-18)/6) 延长并四舍五入', () => {
    // 60 * 2^(2/6) ≈ 75.6 → 76
    expect(adjustDevelopSeconds(60, 18)).toBe(76)
    // 8 * 2^(2/6) ≈ 10.08 → 10
    expect(adjustDevelopSeconds(8, 18)).toBe(10)
  })

  it('24℃ 按 2^((20-24)/6) 缩短并四舍五入', () => {
    // 60 * 2^(-4/6) ≈ 37.8 → 38
    expect(adjustDevelopSeconds(60, 24)).toBe(38)
    // 1 * 0.63 ≈ 0.63 → 1（不会缩到 0）
    expect(adjustDevelopSeconds(1, 24)).toBe(1)
  })

  it('各固定温度档位的整数秒', () => {
    expect(adjustDevelopSeconds(60, 19)).toBe(67)
    expect(adjustDevelopSeconds(60, 21)).toBe(53)
    expect(adjustDevelopSeconds(60, 22)).toBe(48)
    expect(adjustDevelopSeconds(60, 23)).toBe(42)
  })

  it('接受 0.5℃ 档位', () => {
    // 19.5℃：60 * 2^(0.5/6) ≈ 63.6 → 64
    expect(adjustDevelopSeconds(60, 19.5)).toBe(64)
    expect(adjustDevelopSeconds(60, 22.5)).toBe(45)
  })
})

describe('parseTemperature', () => {
  it('留空解析为 null（不修正）', () => {
    expect(parseTemperature('')).toEqual({ ok: true, value: null })
    expect(parseTemperature('   ')).toEqual({ ok: true, value: null })
  })

  it.each([
    ['18', 18],
    ['24', 24],
    ['20', 20],
    ['20.0', 20],
    ['19.5', 19.5],
    [' 21.5 ', 21.5],
  ])('接受合法液温 %s', (raw, value) => {
    expect(parseTemperature(raw)).toEqual({ ok: true, value })
  })

  it.each([
    ['17.9', '越下界'],
    ['24.1', '越上界'],
    ['17', '低于 18'],
    ['25', '高于 24'],
    ['18.2', '非 0.5 递增'],
    ['20.25', '0.25 档位'],
    ['abc', '非数字'],
    ['20℃', '带单位'],
  ])('拒绝非法液温 %s（%s）', (raw, _name) => {
    const r = parseTemperature(raw)
    expect(r.ok).toBe(false)
  })
})

describe('validateRecipe — 液温修正', () => {
  const baseInput: RecipeInput = { develop: '60', stop: '30', fix: '300' }

  it('液温留空：现用配方即原三段秒数，无修正来源', () => {
    const r = validateRecipe(baseInput, '')
    expect(r.valid).toBe(true)
    expect(r.recipe).toEqual({ develop: 60, stop: 30, fix: 300 })
    expect(r.temperature).toBeNull()
    expect(r.adjustedDevelop).toBeNull()
    expect(r.temperatureError).toBeNull()
  })

  it('20℃：现用配方显影保持 60，停显/定影不变', () => {
    const r = validateRecipe(baseInput, '20')
    expect(r.valid).toBe(true)
    expect(r.temperature).toBe(20)
    expect(r.baseDevelop).toBe(60)
    expect(r.adjustedDevelop).toBe(60)
    expect(r.recipe).toEqual({ develop: 60, stop: 30, fix: 300 })
  })

  it('18℃：仅显影替换为修正值 76，停显/定影保持原值', () => {
    const r = validateRecipe(baseInput, '18')
    expect(r.valid).toBe(true)
    expect(r.temperature).toBe(18)
    expect(r.baseDevelop).toBe(60)
    expect(r.adjustedDevelop).toBe(76)
    expect(r.recipe).toEqual({ develop: 76, stop: 30, fix: 300 })
  })

  it('24℃：显影缩短为 38', () => {
    const r = validateRecipe(baseInput, '24')
    expect(r.valid).toBe(true)
    expect(r.recipe?.develop).toBe(38)
    expect(r.recipe?.stop).toBe(30)
    expect(r.recipe?.fix).toBe(300)
  })

  it('液温格式非法时整体非法并给出温度错误，阻止创建会话', () => {
    const r = validateRecipe(baseInput, '20.3')
    expect(r.valid).toBe(false)
    expect(r.recipe).toBeNull()
    expect(r.temperatureError).not.toBeNull()
  })

  it('液温越界（17℃）拒绝', () => {
    const r = validateRecipe(baseInput, '17')
    expect(r.valid).toBe(false)
    expect(r.temperatureError).toContain('18–24')
    expect(r.recipe).toBeNull()
  })

  it('修正结果超过 1800 秒（1800 秒基准 @18℃ → 2268）拒绝并说明', () => {
    const r = validateRecipe({ develop: '1800', stop: '30', fix: '300' }, '18')
    expect(r.valid).toBe(false)
    expect(r.adjustedDevelop).toBe(2268)
    expect(r.temperatureError).toContain('2268')
    expect(r.recipe).toBeNull()
  })

  it('修正结果不会低于 1 秒（1 秒基准 @24℃ → 1）仍合法', () => {
    const r = validateRecipe({ develop: '1', stop: '1', fix: '1' }, '24')
    expect(r.valid).toBe(true)
    expect(r.recipe?.develop).toBe(1)
  })

  it('显影基准本身非法时不因换算报错而掩盖，且仍整体非法', () => {
    const r = validateRecipe({ develop: 'x', stop: '30', fix: '300' }, '18')
    expect(r.valid).toBe(false)
    expect(r.errors.develop).not.toBeNull()
    expect(r.recipe).toBeNull()
  })

  it('液温非法与阶段秒非法可以同时出现', () => {
    const r = validateRecipe({ develop: '60', stop: '0', fix: '300' }, '30')
    expect(r.valid).toBe(false)
    expect(r.errors.stop).not.toBeNull()
    expect(r.temperatureError).not.toBeNull()
  })
})

describe('startTimer / 持久化 — 温度修正来源', () => {
  it('带修正启动：现用配方 develop 为修正值，并持久化温度与基准秒', () => {
    const active: Recipe = { develop: 76, stop: 30, fix: 300 }
    const s = startTimer(active, T0, 1, { temperature: 18, baseDevelop: 60 })
    expect(s.recipe).toEqual(active)
    expect(s.temperature).toEqual({ temperature: 18, baseDevelop: 60 })
    // deadline 消费的是修正后秒数
    expect(s.timer).toEqual({ status: 'running', stage: 'develop', deadline: T0 + 76 * SECOND })
  })

  it('未修正启动不写 temperature 字段', () => {
    const s = startTimer(recipe, T0, 1)
    expect(s.temperature).toBeUndefined()
    expect('temperature' in s).toBe(false)
  })

  it('含温度的记录保存后可完整恢复', () => {
    const s = startTimer({ develop: 76, stop: 30, fix: 300 }, T0, 1, {
      temperature: 18,
      baseDevelop: 60,
    })
    saveRecord(s)
    const loaded = loadRecord()
    expect(loaded).toEqual(s)
    if (loaded && isPersistedState(loaded)) {
      expect(loaded.temperature).toEqual({ temperature: 18, baseDevelop: 60 })
      expect(loaded.recipe.develop).toBe(76)
    }
  })

  it('旧本地记录（无 temperature 字段）恢复为未修正配方，时间线照常推进', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        rev: 1,
        recipe: { develop: 60, stop: 30, fix: 300 },
        timer: { status: 'running', stage: 'develop', deadline: T0 + 60 * SECOND },
        lastWallClock: T0,
      }),
    )
    const loaded = loadRecord()
    expect(loaded).not.toBeNull()
    expect(loaded && isPersistedState(loaded)).toBe(true)
    if (loaded && isPersistedState(loaded)) {
      expect(loaded.temperature).toBeUndefined()
      expect(loaded.recipe).toEqual(recipe)
      // 恢复后按原显影 60 秒计时
      const next = advance(loaded, T0 + 60 * SECOND)
      expect(next.timer).toEqual({ status: 'running', stage: 'stop', deadline: T0 + 90 * SECOND })
    }
  })

  it.each([
    [{ temperature: 17, baseDevelop: 60 }, '液温越界'],
    [{ temperature: 24.5, baseDevelop: 60 }, '液温越上界'],
    [{ temperature: 20.2, baseDevelop: 60 }, '非 0.5 档位'],
    [{ temperature: '18', baseDevelop: 60 }, '液温非数字'],
    [{ temperature: 18, baseDevelop: 0 }, '基准秒为 0'],
    [{ temperature: 18 }, '缺少基准秒'],
  ])('temperature 形状非法（%s）的记录整体拒绝恢复', (tempInfo, _name) => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        rev: 1,
        recipe: { develop: 76, stop: 30, fix: 300 },
        temperature: tempInfo,
        timer: { status: 'running', stage: 'develop', deadline: T0 + 76 * SECOND },
        lastWallClock: T0,
      }),
    )
    expect(loadRecord()).toBeNull()
  })
})

describe('startTimer', () => {
  it('从显影开始，截止时间 = 启动墙钟 + 显影时长', () => {
    const s = startTimer(recipe, T0, 1)
    expect(s.rev).toBe(1)
    expect(s.timer).toEqual({ status: 'running', stage: 'develop', deadline: T0 + 60 * SECOND })
    expect(s.lastWallClock).toBe(T0)
  })
})

describe('advance — 运行中推进', () => {
  it('未到截止时间时保持当前阶段，剩余秒数向上取整', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const next = advance(s, T0 + 59_400) // 还剩 600ms
    expect(next.timer.status).toBe('running')
    if (next.timer.status === 'running') {
      expect(next.timer.stage).toBe('develop')
      expect(remainingSecondsAt(next.timer, T0 + 59_400)).toBe(1) // 0.6s 向上取整为 1
    }
    expect(next.lastWallClock).toBe(T0 + 59_400)
  })

  it('正好到点跨入下一阶段', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const next = advance(s, T0 + 60 * SECOND)
    expect(next.timer).toEqual({ status: 'running', stage: 'stop', deadline: T0 + 90 * SECOND })
  })

  it('逾期较久时用未消费的逾期时长连续跨过阶段（不重走已过阶段）', () => {
    // 显影 60s、停显 30s；刷新发生在启动后 65s：显影已过、停显剩余 25s
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const next = advance(s, T0 + 65 * SECOND)
    expect(next.timer.status).toBe('running')
    if (next.timer.status === 'running') {
      expect(next.timer.stage).toBe('stop')
      expect(next.timer.deadline).toBe(T0 + 90 * SECOND)
      expect(remainingSecondsAt(next.timer, T0 + 65 * SECOND)).toBe(25)
    }
  })

  it('跨越多阶段：逾期穿透显影与停显，落在定影', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const next = advance(s, T0 + 100 * SECOND) // 60+30=90 已过，定影剩 260s
    if (next.timer.status === 'running') {
      expect(next.timer.stage).toBe('fix')
      expect(next.timer.deadline).toBe(T0 + 390 * SECOND)
      expect(remainingSecondsAt(next.timer, T0 + 100 * SECOND)).toBe(290)
    }
  })

  it('全部阶段耗尽则冲洗完成', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const next = advance(s, T0 + 390 * SECOND)
    expect(next.timer).toEqual({ status: 'done' })
  })

  it('远超总时长仍为完成，不会产生异常阶段', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const next = advance(s, T0 + 10_000 * SECOND)
    expect(next.timer).toEqual({ status: 'done' })
  })

  it('在最后一个阶段内逾期到点即完成', () => {
    const s = runningAt(2, T0 + 389 * SECOND, T0 + 390 * SECOND)
    expect(advance(s, T0 + 390 * SECOND).timer).toEqual({ status: 'done' })
  })
})

describe('暂停 / 继续', () => {
  it('暂停保存剩余毫秒，状态变为 paused', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const paused = pauseTimer(s, T0 + 20 * SECOND)
    expect(paused.timer).toEqual({ status: 'paused', stage: 'develop', remainingMs: 40 * SECOND })
    expect(pausedRemainingSeconds(paused.timer as Extract<PersistedState['timer'], { status: 'paused' }>)).toBe(40)
  })

  it('暂停期间墙钟前进也不消耗剩余时间；刷新恢复后仍暂停', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const paused = pauseTimer(s, T0 + 20 * SECOND)
    // 5 分钟后“刷新页面”：advance 不应推进暂停态
    const afterRefresh = advance(paused, T0 + 320 * SECOND)
    expect(afterRefresh.timer.status).toBe('paused')
    if (afterRefresh.timer.status === 'paused') {
      expect(afterRefresh.timer.remainingMs).toBe(40 * SECOND)
    }
  })

  it('继续时按当前墙钟重建截止时间', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const paused = pauseTimer(s, T0 + 20 * SECOND)
    const later = T0 + 320 * SECOND
    const resumed = resumeTimer(paused, later)
    expect(resumed.timer.status).toBe('running')
    if (resumed.timer.status === 'running') {
      expect(resumed.timer.stage).toBe('develop')
      expect(resumed.timer.deadline).toBe(later + 40 * SECOND)
    }
  })

  it('暂停时若该阶段恰好到点，先跨入停显再按其全量时长暂停', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const paused = pauseTimer(s, T0 + 60 * SECOND)
    expect(paused.timer).toEqual({ status: 'paused', stage: 'stop', remainingMs: 30 * SECOND })
  })

  it('对非暂停态调用 resume 等同于按墙钟推进', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const next = resumeTimer(s, T0 + 61 * SECOND)
    if (next.timer.status === 'running') expect(next.timer.stage).toBe('stop')
  })
})

describe('校准剩余时间', () => {
  it('运行态：以当前墙钟重建绝对截止时间，阶段保持不变', () => {
    // 停显进行中，截止 T0+20s；在 T0+5s 校准为 90 秒
    const s = runningAt(1, T0, T0 + 20 * SECOND)
    const calibrated = calibrateTimer(s, 90, T0 + 5 * SECOND)
    expect(calibrated.timer).toEqual({
      status: 'running',
      stage: 'stop',
      deadline: T0 + 5 * SECOND + 90 * SECOND,
    })
    expect(calibrated.lastWallClock).toBe(T0 + 5 * SECOND)
    if (calibrated.timer.status === 'running') {
      expect(remainingSecondsAt(calibrated.timer, T0 + 5 * SECOND)).toBe(90)
    }
  })

  it('运行态：校准可延长也可缩短剩余时间', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const longer = calibrateTimer(s, 1800, T0 + 10 * SECOND)
    if (longer.timer.status === 'running') {
      expect(longer.timer.deadline).toBe(T0 + 10 * SECOND + 1800 * SECOND)
    }
    const shorter = calibrateTimer(s, 1, T0 + 10 * SECOND)
    if (shorter.timer.status === 'running') {
      expect(shorter.timer.deadline).toBe(T0 + 10 * SECOND + 1 * SECOND)
    }
  })

  it('暂停态：替换已保存的剩余毫秒，阶段保持不变', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const paused = pauseTimer(s, T0 + 20 * SECOND) // 显影剩 40s
    const calibrated = calibrateTimer(paused, 120, T0 + 30 * SECOND)
    expect(calibrated.timer).toEqual({
      status: 'paused',
      stage: 'develop',
      remainingMs: 120 * SECOND,
    })
    expect(calibrated.lastWallClock).toBe(T0 + 30 * SECOND)
    // 校准后再继续：按新剩余值重建截止时间
    const resumed = resumeTimer(calibrated, T0 + 400 * SECOND)
    if (resumed.timer.status === 'running') {
      expect(resumed.timer.stage).toBe('develop')
      expect(resumed.timer.deadline).toBe(T0 + 400 * SECOND + 120 * SECOND)
    }
  })

  it('校准以更高 rev 提交后，旧标签页的陈旧 running tick 不能覆盖这次修改', () => {
    // 标签 A：运行中 rev=1
    const running = startTimer(recipe, T0, 1)
    expect(commitRecord(running)).toEqual(running)

    // 标签 B：校准剩余时间为 300 秒，rev 提升到 2 并提交
    const calibrated = withRev(calibrateTimer(running, 300, T0 + 10 * SECOND), 2)
    expect(commitRecord(calibrated)).toEqual(calibrated)

    // 标签 A 的定时器稍后才醒来，拿着旧 rev=1 的推进试图写回
    const staleTick = advance(running, T0 + 11 * SECOND)
    const result = commitRecord(staleTick)

    // 存储必须仍是校准后的记录，陈旧推进被拒绝
    const stored = loadRecord()
    expect(stored).toEqual(calibrated)
    expect(result).toEqual(calibrated)
    if (stored && isPersistedState(stored) && stored.timer.status === 'running') {
      expect(stored.timer.deadline).toBe(T0 + 10 * SECOND + 300 * SECOND)
    }
  })

  it('暂停态校准以更高 rev 提交后，陈旧 tick 同样无法覆盖', () => {
    const running = startTimer(recipe, T0, 1)
    commitRecord(running)
    const paused = withRev(pauseTimer(running, T0 + 20 * SECOND), 2)
    commitRecord(paused)

    // 暂停中校准为 90 秒，rev 提升到 3
    const calibrated = withRev(calibrateTimer(paused, 90, T0 + 25 * SECOND), 3)
    expect(commitRecord(calibrated)).toEqual(calibrated)

    // 旧标签拿着 rev=1 的 running 推进写回，被拒
    expect(commitRecord(advance(running, T0 + 26 * SECOND))).toEqual(calibrated)
    const stored = loadRecord()
    if (stored && isPersistedState(stored) && stored.timer.status === 'paused') {
      expect(stored.timer.remainingMs).toBe(90 * SECOND)
    } else {
      expect.unreachable('存储应保持暂停态校准结果')
    }
  })

  it('完成态与锁定态不接受校准', () => {
    const done: PersistedState = { ...runningAt(2, T0, T0), timer: { status: 'done' } }
    expect(calibrateTimer(done, 60, T0 + 1000)).toEqual(done)

    const locked = advance(runningAt(0, T0, T0 + 60 * SECOND), T0 - 1000)
    expect(locked.timer.status).toBe('locked')
    expect(calibrateTimer(locked, 60, T0 + 500 * SECOND)).toEqual(locked)
  })

  it('时钟回拨时校准转为锁定，而不是重建计时', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    s.lastWallClock = T0 + 100 * SECOND
    const result = calibrateTimer(s, 60, T0 + 50 * SECOND)
    expect(result.timer.status).toBe('locked')
    if (result.timer.status === 'locked') {
      expect(result.timer.observedAt).toBe(T0 + 50 * SECOND)
    }
  })

  it('带搅动的会话时钟回拨时（含校准路径）锁定并清除搅动字段', () => {
    const s = startTimer(recipe, T0, 1, undefined, 30)
    s.lastWallClock = T0 + 100 * SECOND
    const viaAdvance = advance(s, T0 + 50 * SECOND)
    expect(viaAdvance.timer.status).toBe('locked')
    expect(viaAdvance.agitation).toBeUndefined()

    const viaCalibrate = calibrateTimer(s, 60, T0 + 50 * SECOND)
    expect(viaCalibrate.timer.status).toBe('locked')
    expect(viaCalibrate.agitation).toBeUndefined()
  })
})

describe('时钟回拨保护', () => {
  it('当前墙钟早于最近墙钟时立即锁定', () => {
    const s = runningAt(1, T0 + 100 * SECOND, T0 + 120 * SECOND)
    s.lastWallClock = T0 + 100 * SECOND
    const next = advance(s, T0 + 50 * SECOND)
    expect(next.timer.status).toBe('locked')
    if (next.timer.status === 'locked') {
      expect(next.timer.lastWallClock).toBe(T0 + 100 * SECOND)
      expect(next.timer.observedAt).toBe(T0 + 50 * SECOND)
    }
  })

  it('锁定后即使墙钟恢复正常也保持锁定，只有重置可清除', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const locked = advance(s, T0 - 10 * SECOND)
    expect(locked.timer.status).toBe('locked')
    const later = advance(locked, T0 + 500 * SECOND)
    expect(later.timer.status).toBe('locked')
  })

  it('暂停期间发生回拨，恢复时同样锁定', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    const paused = pauseTimer(s, T0 + 10 * SECOND)
    const resumed = resumeTimer(paused, T0 - 1000)
    expect(resumed.timer.status).toBe('locked')
  })

  it('相等的墙钟不算回拨', () => {
    const s = runningAt(0, T0, T0 + 60 * SECOND)
    s.lastWallClock = T0
    expect(advance(s, T0).timer.status).toBe('running')
  })
})

describe('localStorage 持久化往返', () => {
  it('保存后可重新载入，结构保持不变', () => {
    const s = startTimer(recipe, T0, 1)
    saveRecord(s)
    const loaded = loadRecord()
    expect(loaded).toEqual(s)
    expect(loaded && isPersistedState(loaded)).toBe(true)
  })

  it('坏数据/旧版本安全返回 null', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadRecord()).toBeNull()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99 }))
    expect(loadRecord()).toBeNull()
    localStorage.removeItem(STORAGE_KEY)
    expect(loadRecord()).toBeNull()
  })

  it('空存储的 rev 视为 0', () => {
    expect(recordRev(loadRecord())).toBe(0)
  })
})

describe('损坏记录拒绝恢复', () => {
  /** 以一条正常运行记录为基底，覆盖字段后写入，期望恢复被整体拒绝 */
  const seed = (patch: Record<string, unknown>) => {
    const base = {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      timer: { status: 'running', stage: 'develop', deadline: T0 + 60 * SECOND },
      lastWallClock: T0,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...base, ...patch }))
  }

  it('运行记录的截止时间非数字时拒绝，允许重新开始', () => {
    seed({ timer: { status: 'running', stage: 'develop', deadline: 'soon' } })
    expect(loadRecord()).toBeNull()

    // 字符串型非数字（JSON 中 NaN 只能序列化为 null，二者都必须拒绝）
    localStorage.setItem(
      STORAGE_KEY,
      '{"version":1,"rev":1,"recipe":{"develop":60,"stop":30,"fix":300},' +
        '"timer":{"status":"running","stage":"develop","deadline":"120s"},"lastWallClock":1}',
    )
    expect(loadRecord()).toBeNull()
  })

  it('暂停记录的剩余值非数字时拒绝，回到可重新启动的配方页', () => {
    seed({ timer: { status: 'paused', stage: 'develop', remainingMs: 'abc' } })
    expect(loadRecord()).toBeNull()
  })

  it('缺少定影时长的不完整配方拒绝进入计时面板', () => {
    seed({ recipe: { develop: 60, stop: 30 } })
    expect(loadRecord()).toBeNull()

    // 即使已逾期并将跨过停显（旧实现会在定影处算出 NaN），同样拒绝
    seed({
      recipe: { develop: 60, stop: 30, fix: null },
      timer: { status: 'running', stage: 'develop', deadline: T0 - 100 * SECOND },
      lastWallClock: T0 - 100 * SECOND,
    })
    expect(loadRecord()).toBeNull()
  })

  it('未知阶段标识的运行记录只能拒绝（仅显影/停显/定影可恢复）', () => {
    seed({ timer: { status: 'running', stage: 'wash', deadline: T0 + 60 * SECOND } })
    expect(loadRecord()).toBeNull()
    seed({ timer: { status: 'paused', stage: 'rinse', remainingMs: 40 * SECOND } })
    expect(loadRecord()).toBeNull()
  })

  it('lastWallClock 非数字或 timer 结构缺失时拒绝', () => {
    seed({ lastWallClock: 'now' })
    expect(loadRecord()).toBeNull()
    seed({ timer: { status: 'running', stage: 'develop' } })
    expect(loadRecord()).toBeNull()
    seed({ timer: { status: 'paused', stage: 'develop', remainingMs: -5 } })
    expect(loadRecord()).toBeNull()
  })

  it('done / locked 等合法形状仍可正常恢复', () => {
    seed({ timer: { status: 'done' } })
    const done = loadRecord()
    expect(done && isPersistedState(done) && done.timer.status).toBe('done')

    seed({ timer: { status: 'locked', lastWallClock: T0 + 1000, observedAt: T0 } })
    const locked = loadRecord()
    expect(locked && isPersistedState(locked) && locked.timer.status).toBe('locked')
  })
})

describe('多标签页 rev 仲裁（跨标签暂停保持）', () => {
  it('低 rev 的陈旧 running tick 不能覆盖高 rev 的暂停记录', () => {
    // 标签 A：运行中 rev=1
    const running = startTimer(recipe, T0, 1)
    expect(commitRecord(running)).toEqual(running)

    // 标签 B：暂停，rev 提升到 2 并提交
    const pausedAt = T0 + 20 * SECOND
    const paused = withRev(pauseTimer(running, pausedAt), 2)
    expect(paused.timer.status).toBe('paused')
    expect(commitRecord(paused)).toEqual(paused)

    // 标签 A 的定时器稍后才醒来，拿着旧 rev=1 试图把 running 写回
    const staleTick = advance(running, T0 + 21 * SECOND) // 仍为 running，rev 仍是 1
    const result = commitRecord(staleTick)

    // 存储必须仍是暂停，绝不允许陈旧 running 覆盖
    const stored = loadRecord()
    expect(stored).toEqual(paused)
    expect(result).toEqual(paused)
    expect(isPersistedState(stored!) && stored.timer.status).toBe('paused')
  })

  it('暂停后“刷新页面”：重新载入得到的仍是暂停态，剩余毫秒不变', () => {
    const running = startTimer(recipe, T0, 1)
    commitRecord(running)
    const paused = withRev(pauseTimer(running, T0 + 20 * SECOND), 2)
    commitRecord(paused)

    // 5 分钟后另一个 running 标签的 tick 与新页面加载同时发生
    commitRecord(advance(running, T0 + 320 * SECOND)) // 低 rev，被拒
    const loaded = loadRecord()
    expect(loaded && isPersistedState(loaded) && loaded.timer.status).toBe('paused')
    if (loaded && isPersistedState(loaded) && loaded.timer.status === 'paused') {
      expect(loaded.timer.remainingMs).toBe(40 * SECOND)
    }
  })

  it('同 rev 的运行态推进可正常提交（单标签倒计时）', () => {
    const running = startTimer(recipe, T0, 1)
    commitRecord(running)
    const ticked = advance(running, T0 + 1 * SECOND)
    expect(commitRecord(ticked)).toEqual(ticked)
    expect(loadRecord()).toEqual(ticked)
  })

  it('继续操作以更高 rev 生效，随后的 running tick 同 rev 跟进', () => {
    const running = startTimer(recipe, T0, 1)
    commitRecord(running)
    const paused = withRev(pauseTimer(running, T0 + 20 * SECOND), 2)
    commitRecord(paused)

    const resumedAt = T0 + 320 * SECOND
    const resumed = withRev(resumeTimer(paused, resumedAt), 3)
    expect(commitRecord(resumed)).toEqual(resumed)
    if (resumed.timer.status === 'running') {
      expect(resumed.timer.deadline).toBe(resumedAt + 40 * SECOND)
    }
  })

  it('重置写高 rev 墓碑，旧 running tick 无法复活会话', () => {
    const running = startTimer(recipe, T0, 1)
    commitRecord(running)
    const tomb = resetTombstone(2)
    expect(commitRecord(tomb)).toEqual(tomb)

    // 旧标签的运行 tick（rev=1）尝试写回，被墓碑拒绝
    const stale = advance(running, T0 + 30 * SECOND)
    expect(commitRecord(stale)).toEqual(tomb)
    const stored = loadRecord()
    expect(stored && 'reset' in stored).toBe(true)
    expect(stored && isPersistedState(stored)).toBe(false)
  })

  it('墓碑之后可重新开始新一轮（rev 继续递增）', () => {
    commitRecord(resetTombstone(2))
    const fresh = startTimer(recipe, T0 + 1000, 3)
    expect(commitRecord(fresh)).toEqual(fresh)
    expect(loadRecord()).toEqual(fresh)
  })
})

describe('搅动间隔 parseAgitationInterval', () => {
  it('留空解析为 null（不启用）', () => {
    expect(parseAgitationInterval('')).toEqual({ ok: true, value: null })
    expect(parseAgitationInterval('   ')).toEqual({ ok: true, value: null })
  })

  it.each([
    ['10', AGITATION_MIN],
    ['300', AGITATION_MAX],
    [' 30 ', 30],
    ['060', 60],
  ])('接受合法整数秒 %s', (raw, value) => {
    expect(parseAgitationInterval(raw)).toEqual({ ok: true, value })
  })

  it.each([
    ['9', '低于下界'],
    ['0', '零'],
    ['-30', '负数'],
    ['301', '高于上界'],
    ['10.5', '小数'],
    ['abc', '非数字'],
    ['30秒', '带单位'],
    ['1e2', '科学计数'],
  ])('拒绝非法间隔 %s（%s）', (raw, _name) => {
    const r = parseAgitationInterval(raw)
    expect(r.ok).toBe(false)
  })
})

describe('validateRecipe — 搅动间隔', () => {
  const baseInput: RecipeInput = { develop: '60', stop: '30', fix: '300' }

  it('留空：合法且 agitationInterval 为 null，不阻止启动', () => {
    const r = validateRecipe(baseInput, '', '')
    expect(r.valid).toBe(true)
    expect(r.agitationInterval).toBeNull()
    expect(r.agitationError).toBeNull()
  })

  it('合法间隔随校验结果给出', () => {
    const r = validateRecipe(baseInput, '', '30')
    expect(r.valid).toBe(true)
    expect(r.agitationInterval).toBe(30)
  })

  it('可与液温修正同时启用', () => {
    const r = validateRecipe(baseInput, '18', '15')
    expect(r.valid).toBe(true)
    expect(r.recipe?.develop).toBe(76)
    expect(r.agitationInterval).toBe(15)
    expect(r.temperature).toBe(18)
  })

  it('越界（9 秒）时整体非法并在间隔字段说明，阻止启动', () => {
    const r = validateRecipe(baseInput, '', '9')
    expect(r.valid).toBe(false)
    expect(r.recipe).toBeNull()
    expect(r.agitationError).toContain('10–300')
  })

  it('格式错误（小数/非数字）时整体非法并说明', () => {
    const r1 = validateRecipe(baseInput, '', '12.5')
    expect(r1.valid).toBe(false)
    expect(r1.agitationError).not.toBeNull()
    const r2 = validateRecipe(baseInput, '', '快')
    expect(r2.valid).toBe(false)
    expect(r2.agitationError).not.toBeNull()
  })

  it('搅动间隔非法与液温非法可同时出现', () => {
    const r = validateRecipe(baseInput, '99', '5')
    expect(r.valid).toBe(false)
    expect(r.temperatureError).not.toBeNull()
    expect(r.agitationError).not.toBeNull()
  })
})

describe('启动写入搅动节奏', () => {
  it('带间隔启动：首次提示时刻 = 启动墙钟 + 间隔', () => {
    const s = startTimer(recipe, T0, 1, undefined, 30)
    expect(s.agitation).toEqual({ status: 'running', intervalSeconds: 30, nextAt: T0 + 30 * SECOND })
  })

  it('留空/未传间隔启动：不写 agitation 字段', () => {
    expect(startTimer(recipe, T0, 1).agitation).toBeUndefined()
    expect(startTimer(recipe, T0, 1, undefined, null).agitation).toBeUndefined()
    expect('agitation' in startTimer(recipe, T0, 1, undefined, undefined)).toBe(false)
  })

  it('可与温度来源同时持久化', () => {
    const s = startTimer({ develop: 76, stop: 30, fix: 300 }, T0, 1, { temperature: 18, baseDevelop: 60 }, 20)
    expect(s.temperature).toEqual({ temperature: 18, baseDevelop: 60 })
    expect(s.agitation).toEqual({ status: 'running', intervalSeconds: 20, nextAt: T0 + 20 * SECOND })
  })
})

describe('搅动提示到期与确认（固定墙钟）', () => {
  /** 启动一个显影 60s、搅动间隔 30s 的会话 */
  const agitated = () => startTimer(recipe, T0, 1, undefined, 30)

  it('显影中未到期：视图给出向上取整的剩余秒，且不突出', () => {
    const s = advance(agitated(), T0 + 10 * SECOND)
    const view = agitationView(s, T0 + 10 * SECOND)
    expect(view).toEqual({ due: false, remainingSeconds: 20, intervalSeconds: 30 })
  })

  it('到点（nextAt）即待确认；确认前一直保持待确认', () => {
    let s = agitated()
    s = advance(s, T0 + 30 * SECOND)
    expect(agitationView(s, T0 + 30 * SECOND)?.due).toBe(true)
    // 不再有自动变化：没有确认前，过 10 秒仍是同一条待确认提示
    s = advance(s, T0 + 40 * SECOND)
    expect(agitationView(s, T0 + 40 * SECOND)).toEqual({ due: true, remainingSeconds: 0, intervalSeconds: 30 })
  })

  it('确认后按确认时刻墙钟排定下次（nextAt = 确认墙钟 + 间隔）', () => {
    let s = advance(agitated(), T0 + 30 * SECOND)
    s = acknowledgeAgitation(s, T0 + 30 * SECOND)
    expect(s.agitation).toEqual({ status: 'running', intervalSeconds: 30, nextAt: T0 + 60 * SECOND })
    expect(agitationView(s, T0 + 30 * SECOND)?.due).toBe(false)

    // 稍晚确认（没有正好卡点）：节奏从确认时刻起算，而不是补齐漏掉的周期
    s = advance(agitated(), T0 + 40 * SECOND)
    s = acknowledgeAgitation(s, T0 + 40 * SECOND)
    expect(s.agitation).toEqual({ status: 'running', intervalSeconds: 30, nextAt: T0 + 70 * SECOND })
  })

  it('未到期确认是幂等空操作', () => {
    const s = agitated()
    expect(acknowledgeAgitation(s, T0 + 5 * SECOND)).toBe(s)
  })

  it('休眠漏过多个周期只显示一次待确认提示（不堆叠）', () => {
    // 间隔 30s；息屏后在 T0+125s 才恢复，显影校准得足够长，仍落在显影
    const long: Recipe = { develop: 600, stop: 30, fix: 300 }
    let s = startTimer(long, T0, 1, undefined, 30)
    // 直接“休眠”到 125s 后（理论上错过了 30/60/90/120 共 4 次）
    s = advance(s, T0 + 125 * SECOND)
    expect(s.timer).toEqual({ status: 'running', stage: 'develop', deadline: T0 + 600 * SECOND })
    const view = agitationView(s, T0 + 125 * SECOND)
    expect(view).toEqual({ due: true, remainingSeconds: 0, intervalSeconds: 30 })
    // 持久化中也只有一条 nextAt 记录，没有周期队列
    expect(s.agitation && 'nextAt' in s.agitation).toBe(true)
    // 确认后只安排一次新的提示
    s = acknowledgeAgitation(s, T0 + 125 * SECOND)
    expect(s.agitation).toEqual({ status: 'running', intervalSeconds: 30, nextAt: T0 + 155 * SECOND })
  })

  it('显影期内第二次提示同样可到期、确认', () => {
    // 间隔 30s、显影 120s：T0+30 确认后下一次为 T0+60
    const long = startTimer({ develop: 120, stop: 30, fix: 300 }, T0, 1, undefined, 30)
    let l = acknowledgeAgitation(advance(long, T0 + 30 * SECOND), T0 + 30 * SECOND)
    expect(agitationView(l, T0 + 59 * SECOND)?.due).toBe(false)
    l = advance(l, T0 + 60 * SECOND)
    expect(agitationView(l, T0 + 60 * SECOND)?.due).toBe(true)
    l = acknowledgeAgitation(l, T0 + 60 * SECOND)
    expect(l.agitation).toEqual({ status: 'running', intervalSeconds: 30, nextAt: T0 + 90 * SECOND })
  })
})

describe('搅动节奏随暂停冻结 / 继续重建', () => {
  it('暂停冻结距下次提示的剩余毫秒，暂停期间不流逝', () => {
    const s = startTimer(recipe, T0, 1, undefined, 30)
    const paused = pauseTimer(s, T0 + 5 * SECOND)
    expect(paused.agitation).toEqual({ status: 'paused', intervalSeconds: 30, remainingMs: 25 * SECOND })

    // 暂停很久后墙钟推进：冻结剩余不变
    const later = advance(paused, T0 + 320 * SECOND)
    expect(later.timer.status).toBe('paused')
    expect(later.agitation).toEqual({ status: 'paused', intervalSeconds: 30, remainingMs: 25 * SECOND })
    expect(agitationView(later, T0 + 320 * SECOND)).toEqual({
      due: false,
      remainingSeconds: 25,
      intervalSeconds: 30,
    })
  })

  it('继续时以冻结剩余重建绝对时刻，保持同一节奏', () => {
    const s = startTimer(recipe, T0, 1, undefined, 30)
    const paused = pauseTimer(s, T0 + 5 * SECOND) // 冻结 25s
    const resumeAt = T0 + 200 * SECOND
    const resumed = resumeTimer(paused, resumeAt)
    expect(resumed.agitation).toEqual({ status: 'running', intervalSeconds: 30, nextAt: resumeAt + 25 * SECOND })
    // 重建后 25 秒到期
    expect(agitationView(resumeTimer(paused, resumeAt), resumeAt + 24 * SECOND)?.due).toBe(false)
    const due = advance(resumed, resumeAt + 25 * SECOND)
    expect(agitationView(due, resumeAt + 25 * SECOND)?.due).toBe(true)
  })

  it('暂停时提示恰已到期：冻结剩余 0，继续后立即待确认', () => {
    const s = startTimer({ develop: 120, stop: 30, fix: 300 }, T0, 1, undefined, 30)
    const paused = pauseTimer(advance(s, T0 + 40 * SECOND), T0 + 40 * SECOND)
    expect(paused.agitation).toEqual({ status: 'paused', intervalSeconds: 30, remainingMs: 0 })
    const resumeAt = T0 + 500 * SECOND
    const resumed = resumeTimer(paused, resumeAt)
    expect(resumed.agitation).toEqual({ status: 'running', intervalSeconds: 30, nextAt: resumeAt })
    expect(agitationView(resumed, resumeAt)?.due).toBe(true)
  })

  it('刷新暂停态后再继续：节奏从持久化的冻结剩余恢复', () => {
    const s = startTimer(recipe, T0, 1, undefined, 30)
    const paused = pauseTimer(s, T0 + 12 * SECOND)
    saveRecord(paused)
    const loaded = loadRecord()
    expect(loaded && isPersistedState(loaded) && loaded.agitation).toEqual({
      status: 'paused',
      intervalSeconds: 30,
      remainingMs: 18 * SECOND,
    })
    const resumeAt = T0 + 999 * SECOND
    const resumed = resumeTimer(loaded as PersistedState, resumeAt)
    expect(resumed.agitation).toEqual({ status: 'running', intervalSeconds: 30, nextAt: resumeAt + 18 * SECOND })
  })
})

describe('搅动提示仅在显影阶段存在', () => {
  it('短显影到期跨入停显：agitation 被清除', () => {
    const s = startTimer({ develop: 10, stop: 30, fix: 300 }, T0, 1, undefined, 5)
    // T0+5 首次搅动到期
    expect(agitationView(advance(s, T0 + 5 * SECOND), T0 + 5 * SECOND)?.due).toBe(true)
    // 不确认，继续走到 T0+12：已跨入停显，搅动字段消失
    const inStop = advance(s, T0 + 12 * SECOND)
    expect(inStop.timer).toEqual({ status: 'running', stage: 'stop', deadline: T0 + 40 * SECOND })
    expect(inStop.agitation).toBeUndefined()
    expect(agitationView(inStop, T0 + 12 * SECOND)).toBeNull()

    // 定影阶段同样没有
    const inFix = advance(inStop, T0 + 45 * SECOND)
    expect(inFix.timer).toEqual({ status: 'running', stage: 'fix', deadline: T0 + 340 * SECOND })
    expect(inFix.agitation).toBeUndefined()
  })

  it('恰在显影截止点跨入停显时，即便搅动 nextAt 同时刻也清除（不提示）', () => {
    const s = startTimer({ develop: 30, stop: 30, fix: 300 }, T0, 1, undefined, 30)
    const next = advance(s, T0 + 30 * SECOND)
    expect(next.timer.status).toBe('running')
    expect(next.timer).toEqual({ status: 'running', stage: 'stop', deadline: T0 + 60 * SECOND })
    expect(next.agitation).toBeUndefined()
  })

  it('在停显暂停：不携带搅动字段；继续后也没有', () => {
    const s = startTimer({ develop: 10, stop: 30, fix: 300 }, T0, 1, undefined, 5)
    const inStop = advance(s, T0 + 12 * SECOND)
    const paused = pauseTimer(inStop, T0 + 12 * SECOND)
    expect(paused.timer.status).toBe('paused')
    expect(paused.agitation).toBeUndefined()
    expect(resumeTimer(paused, T0 + 100 * SECOND).agitation).toBeUndefined()
  })

  it('完成与回拨锁定时清除搅动', () => {
    const s = startTimer({ develop: 1, stop: 1, fix: 1 }, T0, 1, undefined, 1)
    const done = advance(s, T0 + 3 * SECOND)
    expect(done.timer).toEqual({ status: 'done' })
    expect(done.agitation).toBeUndefined()

    const running = startTimer({ develop: 60, stop: 30, fix: 300 }, T0, 1, undefined, 10)
    running.lastWallClock = T0 + 100 * SECOND
    const locked = advance(running, T0 + 50 * SECOND)
    expect(locked.timer.status).toBe('locked')
    expect(locked.agitation).toBeUndefined()
  })
})

describe('搅动 — 旧记录解析与损坏拒绝', () => {
  it('不含 agitation 字段的旧记录按未启用读取，视图为 null 且时间线照常', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        rev: 1,
        recipe: { develop: 60, stop: 30, fix: 300 },
        timer: { status: 'running', stage: 'develop', deadline: T0 + 60 * SECOND },
        lastWallClock: T0,
      }),
    )
    const loaded = loadRecord()
    expect(loaded && isPersistedState(loaded)).toBe(true)
    if (loaded && isPersistedState(loaded)) {
      expect(loaded.agitation).toBeUndefined()
      expect(agitationView(loaded, T0 + 10 * SECOND)).toBeNull()
      const next = advance(loaded, T0 + 65 * SECOND)
      expect(next.timer).toEqual({ status: 'running', stage: 'stop', deadline: T0 + 90 * SECOND })
      expect(next.agitation).toBeUndefined()
    }
  })

  it('合法的运行/暂停搅动记录可完整往返', () => {
    const running = startTimer(recipe, T0, 1, undefined, 30)
    saveRecord(running)
    expect(loadRecord()).toEqual(running)

    const paused = pauseTimer(running, T0 + 10 * SECOND)
    saveRecord(paused)
    expect(loadRecord()).toEqual(paused)
  })

  const seedAgitation = (agitation: unknown, timer: unknown = undefined) => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        rev: 1,
        recipe: { develop: 60, stop: 30, fix: 300 },
        agitation,
        timer:
          timer ?? { status: 'running', stage: 'develop', deadline: T0 + 60 * SECOND },
        lastWallClock: T0,
      }),
    )
  }

  it('间隔越界/非整数的搅动字段导致整条记录拒绝', () => {
    seedAgitation({ status: 'running', intervalSeconds: 9, nextAt: T0 + 9 * SECOND })
    expect(loadRecord()).toBeNull()
    seedAgitation({ status: 'running', intervalSeconds: 301, nextAt: T0 + 301 * SECOND })
    expect(loadRecord()).toBeNull()
    seedAgitation({ status: 'running', intervalSeconds: 30.5, nextAt: T0 + 30 * SECOND })
    expect(loadRecord()).toBeNull()
  })

  it('缺少 nextAt/remainingMs 或状态与 timer 不一致的搅动字段拒绝', () => {
    seedAgitation({ status: 'running', intervalSeconds: 30 })
    expect(loadRecord()).toBeNull()
    seedAgitation(
      { status: 'running', intervalSeconds: 30, nextAt: T0 + 30 * SECOND },
      { status: 'paused', stage: 'develop', remainingMs: 40 * SECOND },
    )
    expect(loadRecord()).toBeNull()
    seedAgitation({ status: 'paused', intervalSeconds: 30, remainingMs: -1 })
    expect(loadRecord()).toBeNull()
    seedAgitation({ status: 'paused', intervalSeconds: 30, remainingMs: 20 * SECOND })
    expect(loadRecord()).toBeNull()
    seedAgitation({ status: 'soon', intervalSeconds: 30 })
    expect(loadRecord()).toBeNull()
  })

  it('搅动只允许在显影：停显/完成/锁定态带 agitation 一律拒绝', () => {
    seedAgitation(
      { status: 'running', intervalSeconds: 30, nextAt: T0 + 30 * SECOND },
      { status: 'running', stage: 'stop', deadline: T0 + 90 * SECOND },
    )
    expect(loadRecord()).toBeNull()
    seedAgitation({ status: 'running', intervalSeconds: 30, nextAt: T0 }, { status: 'done' })
    expect(loadRecord()).toBeNull()
    seedAgitation(
      { status: 'running', intervalSeconds: 30, nextAt: T0 },
      { status: 'locked', lastWallClock: T0 + 1000, observedAt: T0 },
    )
    expect(loadRecord()).toBeNull()
  })
})

describe('搅动确认的多标签 rev 仲裁', () => {
  it('确认以更高 rev 提交后，旧标签的陈旧 running tick 不能让提示复活', () => {
    const running = startTimer({ develop: 120, stop: 30, fix: 300 }, T0, 1, undefined, 30)
    commitRecord(running)

    // 标签 B 在 T0+30 确认，rev=2，下一次 T0+60
    const acked = withRev(acknowledgeAgitation(advance(running, T0+30*SECOND), T0+30*SECOND), 2)
    expect(commitRecord(acked)).toEqual(acked)

    // 标签 A 的陈旧 tick（rev=1，agitation 仍指向 T0+30，已到期）写回被拒
    const stale = advance(running, T0 + 31 * SECOND)
    const result = commitRecord(stale)
    expect(result).toEqual(acked)
    const stored = loadRecord()
    expect(stored).toEqual(acked)
    if (stored && isPersistedState(stored) && stored.agitation?.status === 'running') {
      expect(stored.agitation.nextAt).toBe(T0 + 60 * SECOND)
    } else {
      expect.unreachable('存储应保持确认后的搅动节奏')
    }
  })

  it('确认提交若已被其它标签处理：本标签读到的高 rev 记录未到期，幂等采纳', () => {
    // 标签 B 已在 T0+32 确认并提交 rev=2（nextAt T0+62）
    const running = startTimer({ develop: 120, stop: 30, fix: 300 }, T0, 1, undefined, 30)
    commitRecord(running)
    const acked = withRev(acknowledgeAgitation(advance(running, T0 + 32 * SECOND), T0 + 32 * SECOND), 2)
    commitRecord(acked)

    // 标签 A 在 T0+33 才点确认：基线从存储读到 rev=2，其 nextAt=T0+62 未到期
    const base = loadRecord()
    expect(base && isPersistedState(base)).toBe(true)
    if (base && isPersistedState(base)) {
      const next = acknowledgeAgitation(base, T0 + 33 * SECOND)
      expect(next).toBe(base) // 幂等空操作，直接采纳较高修订记录
    }
  })

  it('暂停/继续搅动会话后，同 rev 的运行 tick 正常跟进节奏', () => {
    const running = startTimer(recipe, T0, 1, undefined, 30)
    commitRecord(running)
    const paused = withRev(pauseTimer(running, T0 + 10 * SECOND), 2)
    commitRecord(paused)
    const resumed = withRev(resumeTimer(paused, T0 + 100 * SECOND), 3)
    expect(commitRecord(resumed)).toEqual(resumed)
    if (resumed.agitation?.status === 'running') {
      // 冻结 20s → nextAt = T0+100s+20s
      expect(resumed.agitation.nextAt).toBe(T0 + 120 * SECOND)
    } else {
      expect.unreachable('继续后应为运行态搅动节奏')
    }
  })
})
