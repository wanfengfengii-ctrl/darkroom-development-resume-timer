import { useMemo, useState } from 'react'
import {
  STAGE_IDS,
  STAGE_LABELS,
  initialInput,
  validateRecipe,
  type Recipe,
  type RecipeInput,
} from '../timer/engine'

interface Props {
  onStart: (recipe: Recipe) => void
}

/**
 * 配方表单：三阶段各输入 1–1800 整数秒。
 * 任一非法值都禁止启动（按钮禁用 + 即时错误提示）。
 */
export function RecipeForm({ onStart }: Props) {
  const [input, setInput] = useState<RecipeInput>(initialInput)

  const { valid, errors, recipe } = useMemo(() => validateRecipe(input), [input])

  const update = (stage: (typeof STAGE_IDS)[number], value: string) => {
    setInput((prev) => ({ ...prev, [stage]: value }))
  }

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && recipe) onStart(recipe)
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

      <button type="submit" className="btn primary" disabled={!valid} data-testid="start-button">
        开始冲洗
      </button>
    </form>
  )
}
