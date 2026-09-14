import { afterEach, describe, expect, it } from 'vitest'
import {
  STAGE_IDS,
  STORAGE_KEY,
  advance,
  commitRecord,
  isPersistedState,
  loadRecord,
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
