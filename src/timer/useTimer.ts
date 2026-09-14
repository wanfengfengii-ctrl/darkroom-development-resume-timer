import { useCallback, useEffect, useState } from 'react'
import {
  advance,
  loadState,
  pauseTimer,
  resumeTimer,
  saveState,
  startTimer,
  type PersistedState,
  type Recipe,
} from './engine'

/**
 * 计时器状态机的 React 绑定：
 *  - 挂载时从 localStorage 恢复，并立即按当前墙钟推进（跨阶段/完成/回拨锁定）
 *  - 每 200ms 重新依据墙钟推进；页面重新可见时立即再推进一次（息屏唤醒）
 *  - 每次状态变化都持久化
 */
export function useTimer(): {
  state: PersistedState | null
  now: number
  start: (recipe: Recipe) => void
  pause: () => void
  resume: () => void
  reset: () => void
} {
  const [state, setState] = useState<PersistedState | null>(() => {
    const loaded = loadState()
    return loaded ? advance(loaded, Date.now()) : null
  })
  const [now, setNow] = useState<number>(() => Date.now())

  // 持久化
  useEffect(() => {
    saveState(state)
  }, [state])

  // 定时依据墙钟推进（setInterval 在后台被限流也没关系，恢复可见时会补推进）
  useEffect(() => {
    const tick = () => {
      const t = Date.now()
      setNow(t)
      setState((s) => (s ? advance(s, t) : s))
    }
    const id = window.setInterval(tick, 200)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener('pageshow', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('pageshow', onVisible)
    }
  }, [])

  const start = useCallback((recipe: Recipe) => {
    const t = Date.now()
    setNow(t)
    setState(startTimer(recipe, t))
  }, [])

  const pause = useCallback(() => {
    const t = Date.now()
    setNow(t)
    setState((s) => (s ? pauseTimer(s, t) : s))
  }, [])

  const resume = useCallback(() => {
    const t = Date.now()
    setNow(t)
    setState((s) => (s ? resumeTimer(s, t) : s))
  }, [])

  const reset = useCallback(() => {
    // 置空后持久化 effect 会清除 localStorage，这是唯一能解除锁定的操作
    setState(null)
  }, [])

  return { state, now, start, pause, resume, reset }
}
