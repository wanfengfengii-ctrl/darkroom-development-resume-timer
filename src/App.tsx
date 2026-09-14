import { RecipeForm } from './components/RecipeForm'
import { TimerPanel } from './components/TimerPanel'
import { useTimer } from './timer/useTimer'

export default function App() {
  const { state, now, start, pause, resume, calibrate, acknowledge, reset } = useTimer()

  return (
    <main className="app">
      <header className="app-header">
        <h1>暗房冲洗续时台</h1>
        <p className="subtitle">刷新或息屏都不会重走已完成的药浴阶段</p>
      </header>

      {state === null ? (
        <RecipeForm onStart={start} />
      ) : (
        <TimerPanel
          state={state}
          now={now}
          onPause={pause}
          onResume={resume}
          onCalibrate={calibrate}
          onAcknowledge={acknowledge}
          onReset={reset}
        />
      )}
    </main>
  )
}
