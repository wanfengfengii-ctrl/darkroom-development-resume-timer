import { useMemo, useState } from 'react'
import {
  AGITATION_MAX,
  AGITATION_MIN,
  STAGE_IDS,
  STAGE_LABELS,
  TEMP_BASELINE,
  TEMP_MAX,
  TEMP_MIN,
  TEMP_STEP,
  initialAgitation,
  initialInput,
  initialTemperature,
  validateRecipe,
  type Recipe,
  type RecipeInput,
  type TemperatureInfo,
} from '../timer/engine'

interface Props {
  onStart: (recipe: Recipe, temperature?: TemperatureInfo, agitationInterval?: number | null) => void
}

/**
 * 配方表单：三阶段各输入 1–1800 整数秒，另提供可选「当前液温」与「搅动间隔」。
 *  - 液温留空：按原三段秒数直接启动，不做任何修正
 *  - 填写 18–24℃（0.5℃ 递增）：仅显影按
 *    基准秒 × 2^((20−液温)/6) 换算并四舍五入；停显/定影保持原值
 *  - 搅动间隔留空：不启用搅动提醒；填写 10–300 整数秒时仅在显影阶段按节奏提示
 * 表单即时展示显影原值与修正值；任一非法（含修正结果越界）都禁止启动。
 */
export function RecipeForm({ onStart }: Props) {
  const [input, setInput] = useState<RecipeInput>(initialInput)
  const [tempRaw, setTempRaw] = useState<string>(initialTemperature)
  const [agitationRaw, setAgitationRaw] = useState<string>(initialAgitation)

  const {
    valid,
    errors,
    recipe,
    temperatureError,
    temperature,
    baseDevelop,
    adjustedDevelop,
    agitationError,
    agitationInterval,
  } = useMemo(() => validateRecipe(input, tempRaw, agitationRaw), [input, tempRaw, agitationRaw])

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
        onStart(recipe, info, agitationInterval)
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

      <div className="field field-agitation">
        <label className="field-label" htmlFor="input-agitation">
          搅动间隔（可选，{AGITATION_MIN}–{AGITATION_MAX} 秒，仅显影阶段提示）
        </label>
        <div className="temp-row">
          <input
            id="input-agitation"
            type="text"
            inputMode="numeric"
            placeholder="留空 = 不提醒搅动"
            value={agitationRaw}
            aria-invalid={agitationError !== null}
            aria-describedby="err-agitation"
            data-testid="agitation-input"
            onChange={(e) => setAgitationRaw(e.target.value)}
          />
          <span className="unit">秒</span>
        </div>
        {agitationError ? (
          <p id="err-agitation" className="error temp-error" role="alert" data-testid="agitation-error">
            {agitationError}
          </p>
        ) : agitationInterval !== null ? (
          <p className="hint temp-hint">
            显影阶段每 <strong>{agitationInterval}</strong> 秒提示搅动一次，跨入停显/定影后不再提醒；
            留空则按上方配方与液温修正直接启动。
          </p>
        ) : (
          <p className="hint temp-hint">
            显影阶段按固定节奏提示搅动；留空则按上方配方与液温修正直接启动，不产生搅动提醒。
          </p>
        )}
      </div>

      <button type="submit" className="btn primary" disabled={!valid} data-testid="start-button">
        开始冲洗
      </button>
    </form>
  )
}
