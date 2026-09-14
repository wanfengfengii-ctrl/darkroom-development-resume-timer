import { useCallback, useEffect, useRef, useState } from 'react'
import {
  advance,
  commitRecord,
  isPersistedState,
  loadRecord,
  pauseTimer,
  resetTombstone,
  resumeTimer,
  startTimer,
  withRev,
  STORAGE_KEY,
  type PersistedState,
  type Recipe,
  type StoredRecord,
} from './engine'

/**
 * 计时器状态机的 React 绑定，支持同一冲洗在多个标签页同时打开：
 *  - 挂载时从 localStorage 恢复并立即按墙钟推进（跨阶段/完成/回拨锁定）
 *  - 运行中每 200ms 按墙钟推进并以相同 rev 提交；暂停/完成/锁定不产生后台写入
 *  - 显式操作（开始/暂停/继续/重置）把 rev +1 后提交（commit）
 *  - 监听 storage 事件：其它标签页暂停/继续/重置后本页立即跟进
 *  - 提交带 rev 比较：低 rev 的陈旧 running tick 无法覆盖高 rev 的暂停记录；
 *    重置写高 rev 墓碑，旧标签页不能把会话复活
 *  - 页面重新可见时重新从存储读取并补推进（息屏唤醒、后台标签切回）
 */
export function useTimer(): {
  state: PersistedState | null
  now: number
  start: (recipe: Recipe) => void
  pause: () => void
  resume: () => void
  reset: () => void
} {
  const recordRef = useRef<StoredRecord | null>(null)
  const [record, setRecord] = useState<StoredRecord | null>(() => {
    const loaded = loadRecord()
    if (loaded && isPersistedState(loaded)) {
      // 挂载即按当前墙钟推进（可能跨阶段/完成/锁定），同 rev 提交
      const committed = commitRecord(advance(loaded, Date.now()))
      recordRef.current = committed
      return committed
    }
    recordRef.current = loaded
    return loaded
  })
  const [now, setNow] = useState<number>(() => Date.now())

  const adopt = useCallback((next: StoredRecord | null) => {
    recordRef.current = next
    setRecord(next)
  }, [])

  /** 从存储重新读取：采纳更新的记录；若为运行态则按墙钟补推进后提交 */
  const syncFromStorage = useCallback(
    (t: number) => {
      const stored = loadRecord()
      if (!stored) return
      const cur = recordRef.current
      const curRev = cur ? cur.rev : 0
      if (stored.rev < curRev) return // 存储比本地旧，不回退

      const statusOf = (r: StoredRecord): string =>
        isPersistedState(r) ? r.timer.status : 'reset'
      // rev 更高（显式操作）或状态种类变化（running→paused 等）才采纳，
      // 避免多个运行标签页在同一 rev 下因 tick 的墙钟刷新互相回环写入
      const meaningful = stored.rev > curRev || (cur !== null && statusOf(stored) !== statusOf(cur))
      if (!meaningful) return

      if (isPersistedState(stored) && stored.timer.status === 'running') {
        adopt(commitRecord(advance(stored, t)))
      } else {
        adopt(stored)
      }
    },
    [adopt],
  )

  // 定时依据墙钟推进；仅运行态写存储，避免暂停/完成/锁定标签页互相刷写
  useEffect(() => {
    const tick = () => {
      const t = Date.now()
      setNow(t)
      const cur = recordRef.current
      if (!cur || !isPersistedState(cur) || cur.timer.status !== 'running') return
      // 同 rev 提交：若其它标签已写入更高 rev（如已暂停），会被拒绝并返回那条更新记录
      const committed = commitRecord(advance(cur, t))
      if (committed !== cur) adopt(committed)
      else recordRef.current = committed // 内容可能仅 lastWallClock 变化，更新 ref
    }
    const id = window.setInterval(tick, 200)

    const onVisible = () => {
      if (document.visibilityState === 'visible') syncFromStorage(Date.now())
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== STORAGE_KEY) return
      setNow(Date.now())
      syncFromStorage(Date.now())
    }

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener('pageshow', onVisible)
    window.addEventListener('storage', onStorage)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('pageshow', onVisible)
      window.removeEventListener('storage', onStorage)
    }
  }, [adopt, syncFromStorage])

  const start = useCallback(
    (recipe: Recipe) => {
      const t = Date.now()
      setNow(t)
      const base = loadRecord() ?? recordRef.current
      const rev = (base ? base.rev : 0) + 1
      adopt(commitRecord(startTimer(recipe, t, rev)))
    },
    [adopt],
  )

  /** 显式操作：基于存储中最新记录计算，并把 rev +1 */
  const bump = useCallback(
    (fn: (base: PersistedState, now: number) => PersistedState) => {
      const t = Date.now()
      setNow(t)
      const base = loadRecord() ?? recordRef.current
      if (!base || !isPersistedState(base)) return
      const next = fn(base, t)
      const candidate = next.rev === base.rev ? withRev(next, base.rev + 1) : next
      adopt(commitRecord(candidate))
    },
    [adopt],
  )

  const pause = useCallback(() => bump(pauseTimer), [bump])
  const resume = useCallback(() => bump(resumeTimer), [bump])

  const reset = useCallback(() => {
    const base = loadRecord() ?? recordRef.current
    const rev = (base ? base.rev : 0) + 1
    // 高 rev 墓碑：本页与其它标签页都回到表单，且旧 running tick 无法复活会话
    adopt(commitRecord(resetTombstone(rev)))
  }, [adopt])

  const state = record && isPersistedState(record) ? record : null
  return { state, now, start, pause, resume, reset }
}
