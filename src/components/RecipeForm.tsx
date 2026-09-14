import { useMemo, useState } from 'react'
import {
  STAGE_IDS,
  STAGE_LABELS,
  TEMP_BASELINE,
  TEMP_MAX,
  TEMP_MIN,
  TEMP_STEP,
  initialInput,
  initialTemperature,
  validateRecipe,
  type Recipe,
  type RecipeInput,
  type TemperatureInfo,
} from '../timer/engine'

interface Props {
  onStart: (recipe: Recipe, temperature?: TemperatureInfo) => void
}

/**
 * 配方表单：三阶段各输入 1–1800 整数秒，另提供可选「当前液温」。
 *  - 液温留空：按原三段秒数直接启动，不做任何修正
 *  - 填写 18–24℃（0.5℃ 递增）：仅显影按
 *    基准秒 × 2^((20−液温)/6) 换算并四舍五入；停显/定影保持原值
 * 表单即时展示显影原值与修正值；任一非法（含修正结果越界）都禁止启动。
 */
export function RecipeForm({ onStart }: Props) {
  const [input, setInput] = useState<RecipeInput>(initialInput)
  const [tempRaw, setTempRaw] = useState<string>(initialTemperature)

  const { valid, errors, recipe, temperatureError, temperature, baseDevelop, adjustedDevelop } =
    useMemo(() => validateRecipe(input, tempRaw), [input, tempRaw])

  const update = (stage: (typeof STAGE_IDS)[number], value: string) => {
    setInput((prev) => ({ ...prev, [stage]: value }))
  }

  const corrected =
    temperature !== null &&
    baseDevelop !== null &&
    adjustedDevelop !== null &&
    !temperatureError

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid || !recipe) return
        // 留空（temperature 为 null）不传修正来源，会话即未修正原配方
        const info =
          temperature === null || baseDevelop === null
            ? undefined
            : { temperature, baseDevelop }
        onStart(recipe, info)
      }}
      aria-label="冲洗配方"
    >
      <h2>输入冲洗配方</h2>
      <p className="hint">每个阶段需输入 1–1800 之间的整数秒，任一非法均无法开始。</p>

      <div className="fields">
        {STAGE_IDS.map((stage, i) => (
          <label key={stage} className={`field field-${stage}`}>
            <span className="field-label">
              <span className="stage-index">{i + 1}</span>
              {STAGE_LABELS[stage]}
              {stage === 'develop' && corrected && (
                <span className="temp-corrected-tag" data-testid="develop-corrected-tag">
                  已按液温修正
                </span>
              )}
            </span>
            <input
              id={`input-${stage}`}
              type="text"
              inputMode="numeric"
              pattern="-?[0-9]*"
              value={input[stage]}
              aria-invalid={errors[stage] !== null}
              aria-describedby={`err-${stage}`}
              onChange={(e) => update(stage, e.target.value)}
            />
            <span className="unit">秒</span>
            {errors[stage] && (
              <span id={`err-${stage}`} className="error" role="alert">
                {errors[stage]}
              </span>
            )}
          </label>
        ))}
      </div>

      <div className="field field-temperature">
        <label className="field-label" htmlFor="input-temperature">
          当前液温（可选，{TEMP_MIN}–{TEMP_MAX}℃，按 {TEMP_STEP}℃ 递增）
        </label>
        <div className="temp-row">
          <input
            id="input-temperature"
            type="text"
            inputMode="decimal"
            placeholder={`留空 = 按基准 ${TEMP_BASELINE}℃ 原时长`}
            value={tempRaw}
            aria-invalid={temperatureError !== null}
            aria-describedby="err-temperature"
            data-testid="temperature-input"
            onChange={(e) => setTempRaw(e.target.value)}
          />
          <span className="unit">℃</span>
        </div>
        {temperatureError ? (
          <p id="err-temperature" className="error temp-error" role="alert" data-testid="temperature-error">
            {temperatureError}
          </p>
        ) : corrected ? (
          <p className="temp-preview" data-testid="temp-preview" aria-live="polite">
            {temperature === TEMP_BASELINE ? (
              <>
                液温 {TEMP_BASELINE}℃ 为基准温度，显影保持 <strong>{baseDevelop}</strong> 秒，停显/定影不换算。
              </>
            ) : (
              <>
                液温 {temperature}℃：显影 {baseDevelop} 秒 → <strong>{adjustedDevelop}</strong> 秒
                {adjustedDevelop !== baseDevelop ? '' : '（无变化）'}；停显、定影不参与换算。
              </>
            )}
          </p>
        ) : (
          <p className="hint temp-hint">
            偏离基准 {TEMP_BASELINE}℃ 时仅修正显影时长；留空则按上方原三段秒数直接启动。
          </p>
        )}
      </div>

      <button type="submit" className="btn primary" disabled={!valid} data-testid="start-button">
        开始冲洗
      </button>
    </form>
  )
}
