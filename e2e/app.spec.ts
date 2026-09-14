import { expect, test, type Page } from '@playwright/test'

const STORAGE_KEY = 'darkroom-timer:v1'

/** 页面加载完成后写入持久化状态，再 reload 触发恢复（不会像 addInitScript 那样重复注入） */
async function seedAndReload(page: Page, state: unknown): Promise<void> {
  await page.goto('/')
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
    [STORAGE_KEY, state] as const,
  )
  await page.reload()
}

async function fillRecipe(page: Page, d: string, s: string, f: string): Promise<void> {
  await page.getByTestId('start-button').waitFor()
  await page.locator('#input-develop').fill(d)
  await page.locator('#input-stop').fill(s)
  await page.locator('#input-fix').fill(f)
}

async function startRecipe(page: Page, d: string, s: string, f: string): Promise<void> {
  await fillRecipe(page, d, s, f)
  await page.getByTestId('start-button').click()
  await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
}

async function setTemperature(page: Page, temp: string): Promise<void> {
  await page.getByTestId('temperature-input').fill(temp)
}

async function setAgitation(page: Page, seconds: string): Promise<void> {
  await page.getByTestId('agitation-input').fill(seconds)
}

async function readSeconds(page: Page): Promise<number> {
  return Number((await page.getByTestId('seconds').textContent())!.trim())
}

test.describe('配方校验', () => {
  test('任一非法值都禁止启动，全部合法才可启动', async ({ page }) => {
    await page.goto('/')
    const start = page.getByTestId('start-button')

    await page.locator('#input-develop').fill('0')
    await expect(start).toBeDisabled()

    await page.locator('#input-develop').fill('3')
    await page.locator('#input-stop').fill('1801')
    await expect(start).toBeDisabled()

    await page.locator('#input-stop').fill('2')
    await page.locator('#input-fix').fill('abc')
    await expect(start).toBeDisabled()
    await expect(page.getByText('请输入 1–1800 的整数秒').first()).toBeVisible()

    await page.locator('#input-fix').fill('1.5')
    await expect(start).toBeDisabled()

    await page.locator('#input-fix').fill('3')
    await expect(start).toBeEnabled()
    await start.click()
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
  })
})

test.describe('液温修正', () => {
  test('表单即时展示显影原值与修正值，停显/定影不参与换算', async ({ page }) => {
    await page.goto('/')
    await page.locator('#input-develop').fill('60')
    await page.locator('#input-stop').fill('30')
    await page.locator('#input-fix').fill('300')

    // 18℃：60 → 76
    await setTemperature(page, '18')
    await expect(page.getByTestId('temp-preview')).toContainText('60')
    await expect(page.getByTestId('temp-preview')).toContainText('76')

    // 24℃：60 → 38
    await setTemperature(page, '24')
    await expect(page.getByTestId('temp-preview')).toContainText('38')

    // 20℃ 为基准：保持 60
    await setTemperature(page, '20')
    await expect(page.getByTestId('temp-preview')).toContainText('保持 60 秒')

    // 留空：修正预览消失，可直接按原时长启动
    await setTemperature(page, '')
    await expect(page.getByTestId('temp-preview')).toHaveCount(0)
    await expect(page.getByTestId('start-button')).toBeEnabled()
  })

  test('20℃ 启动保持原显影时长，面板标明本轮温度来源', async ({ page }) => {
    await page.goto('/')
    await fillRecipe(page, '60', '30', '300')
    await setTemperature(page, '20')
    await page.getByTestId('start-button').click()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(page.getByTestId('current-stage')).toHaveText('显影')

    // 20℃ 不改变时长：首屏剩余仍为 60 秒（容差 1 秒给启动耗时）
    expect(await readSeconds(page)).toBeGreaterThan(59)
    expect(await readSeconds(page)).toBeLessThanOrEqual(60)

    const source = page.getByTestId('temp-source')
    await expect(source).toHaveAttribute('data-corrected', 'true')
    await expect(source).toContainText('20℃')
    await expect(source).toContainText('60')
  })

  test('18℃ 启动后刷新仍显示并使用修正后的显影时长', async ({ page }) => {
    await page.goto('/')
    await fillRecipe(page, '60', '30', '300')
    await setTemperature(page, '18')
    await page.getByTestId('start-button').click()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(page.getByTestId('current-stage')).toHaveText('显影')

    // 60 @18℃ → 76
    expect(await readSeconds(page)).toBeGreaterThan(75)
    expect(await readSeconds(page)).toBeLessThanOrEqual(76)
    const source = page.getByTestId('temp-source')
    await expect(source).toHaveAttribute('data-corrected', 'true')
    await expect(source).toContainText('18℃')
    await expect(source).toContainText('基准 60')
    await expect(source).toContainText('76')

    // 倒计时确实在走
    const before = await readSeconds(page)
    await page.waitForTimeout(1_200)
    const after = await readSeconds(page)
    expect(after).toBeLessThan(before)

    // 刷新后仍按修正值（约 74–75）计时，且面板仍标明 18℃ 修正来源
    await page.reload()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
    expect(await readSeconds(page)).toBeGreaterThan(70)
    expect(await readSeconds(page)).toBeLessThanOrEqual(76)
    await expect(page.getByTestId('temp-source')).toContainText('18℃')

    // 本地记录里确实写入了温度来源与基准显影秒
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY)
    expect(stored.temperature).toEqual({ temperature: 18, baseDevelop: 60 })
    expect(stored.recipe.develop).toBe(76)
    expect(stored.recipe.stop).toBe(30)
    expect(stored.recipe.fix).toBe(300)
  })

  test('非法液温（格式/越界/非 0.5 递增/修正越界）无法开始冲洗并说明原因', async ({ page }) => {
    await page.goto('/')
    await fillRecipe(page, '60', '30', '300')
    const start = page.getByTestId('start-button')
    const error = page.getByTestId('temperature-error')

    for (const bad of ['abc', '17', '25', '20.25', '18.2']) {
      await setTemperature(page, bad)
      await expect(start).toBeDisabled()
      await expect(error).toBeVisible()
    }

    // 修正结果超出 1800 秒：基准 1800 @18℃ → 2268
    await page.locator('#input-develop').fill('1800')
    await setTemperature(page, '18')
    await expect(start).toBeDisabled()
    await expect(error).toContainText('2268')

    // 清空液温后恢复可启动
    await setTemperature(page, '')
    await expect(start).toBeEnabled()
  })

  test('无温度信息的旧本地记录恢复为未修正配方，面板明确解释', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      timer: { status: 'running', stage: 'develop', deadline: now + 60_000 },
      lastWallClock: now,
    })
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    const source = page.getByTestId('temp-source')
    await expect(source).toHaveAttribute('data-corrected', 'false')
    await expect(source).toContainText('未做液温修正')
    expect(await readSeconds(page)).toBeGreaterThan(59)
  })

  test('18℃ 修正的冲洗完成后，结果页仍标明本轮液温与修正时长', async ({ page }) => {
    await page.goto('/')
    // 基准显影 4s @18℃ → 5s，停显/定影各 1s，约 7s 走完
    await fillRecipe(page, '4', '1', '1')
    await setTemperature(page, '18')
    await page.getByTestId('start-button').click()
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 15_000 })

    const source = page.getByTestId('temp-source')
    await expect(source).toHaveAttribute('data-corrected', 'true')
    await expect(source).toContainText('18℃')
    await expect(source).toContainText('基准 4')
    await expect(source).toContainText('5')

    // 刷新后仍是完成结果，温度来源不丢失
    await page.reload()
    await expect(page.getByTestId('done-title')).toBeVisible()
    await expect(page.getByTestId('temp-source')).toContainText('18℃')
    await expect(page.getByTestId('temp-source')).toContainText('基准 4')
  })

  test('18℃ 修正的会话因时钟回拨锁定后，锁定页仍标明本轮液温与修正时长', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 76, stop: 30, fix: 300 },
      temperature: { temperature: 18, baseDevelop: 60 },
      timer: { status: 'running', stage: 'develop', deadline: now + 76_000 },
      // 最近墙钟在 2 分钟后，当前时间更早，构成回拨
      lastWallClock: now + 120_000,
    })
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'locked')

    const source = page.getByTestId('temp-source')
    await expect(source).toHaveAttribute('data-corrected', 'true')
    await expect(source).toContainText('18℃')
    await expect(source).toContainText('基准 60')
    await expect(source).toContainText('76')

    // 刷新后锁定保持，温度来源仍在
    await page.reload()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'locked')
    await expect(page.getByTestId('temp-source')).toContainText('18℃')
    await expect(page.getByTestId('temp-source')).toContainText('76')
  })
})

test.describe('刷新续时', () => {
  test('刷新后倒计时接续，且跨入停显后刷新不会回到显影', async ({ page }) => {
    await page.goto('/')
    await startRecipe(page, '3', '2', '3')

    // 显影走约 1.3 秒后刷新：剩余秒数必须接续（小于满量程 3），阶段仍是显影
    await page.waitForTimeout(1300)
    await page.reload()
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
    const secondsAfterReload = Number((await page.getByTestId('seconds').textContent())!.trim())
    expect(secondsAfterReload).toBeGreaterThan(0)
    expect(secondsAfterReload).toBeLessThanOrEqual(2)

    // 等到停显阶段（显影 3s 已过），再刷新：必须显示停显，绝不重走显影
    await page.waitForTimeout(2600)
    await expect(page.getByTestId('current-stage')).toHaveText('停显')
    await page.reload()
    await expect(page.getByTestId('current-stage')).toHaveText('停显')
  })

  test('息屏很久后回来：用未消费的逾期时长连续跨过显影，直接落在停显', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      // 截止时间在 5 秒前：显影 60s 已完全耗尽，逾期 5s 从停显 30s 中扣减
      timer: { status: 'running', stage: 'develop', deadline: now - 5_000 },
      lastWallClock: now - 5_000,
    })

    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(page.getByTestId('current-stage')).toHaveText('停显')
    await expect.poll(async () => Number((await page.getByTestId('seconds').textContent())!.trim())).toBe(25)
  })

  test('逾期穿透显影与停显，落在定影阶段', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      // 100 秒前启动：显影 60 + 停显 30 已耗尽，定影剩 290 秒
      timer: { status: 'running', stage: 'develop', deadline: now - 40_000 },
      lastWallClock: now - 40_000,
    })
    await expect(page.getByTestId('current-stage')).toHaveText('定影')
    await expect.poll(async () => Number((await page.getByTestId('seconds').textContent())!.trim())).toBe(290)
  })
})

test.describe('后台跨阶段', () => {
  test('页面进入后台（息屏）期间阶段连续走完，唤醒后显示冲洗完成而非重走', async ({ page, context }) => {
    await page.goto('/')
    await startRecipe(page, '2', '2', '2')

    // 另开标签并切到前台，使原标签进入后台（模拟平板息屏/切应用）
    const other = await context.newPage()
    await other.goto('/')
    await other.bringToFront()

    // 后台停留超过三阶段总时长（6s）。计时器只认墙钟，interval 被限流也无所谓
    await page.waitForTimeout(7_000)

    // 唤醒原标签：visibilitychange 会立即按墙钟补推进
    await page.bringToFront()
    await expect(page.getByTestId('done-title')).toBeVisible()

    // 再刷新一次，结果仍明确为完成，绝不重走任何阶段
    await page.reload()
    await expect(page.getByTestId('done-title')).toBeVisible()
    await expect(page.getByTestId('current-stage')).toHaveCount(0)

    await other.close()
  })
})

test.describe('暂停 / 继续', () => {
  test('暂停保存剩余毫秒，刷新后仍暂停且时间不流逝；继续后按墙钟重建截止时间', async ({ page }) => {
    await page.goto('/')
    await startRecipe(page, '60', '60', '60')

    await page.getByTestId('pause-button').click()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'paused')
    await expect(page.getByTestId('seconds')).toHaveText('60')

    // 刷新后仍暂停
    await page.reload()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'paused')
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
    await expect(page.getByTestId('seconds')).toHaveText('60')

    // 暂停期间墙钟前进也不消耗
    await page.waitForTimeout(2_200)
    await expect(page.getByTestId('seconds')).toHaveText('60')

    // 继续后转为运行，剩余仍为 60 秒（暂停期间不消耗）
    await page.getByTestId('resume-button').click()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(page.getByTestId('seconds')).toHaveText('60')
  })

  test('同一冲洗在另一标签页仍开着时暂停，暂停标签刷新后仍保持暂停', async ({ context }) => {
    // 标签 A：启动冲洗并一直开着（其 200ms tick 仍在运行）
    const tabA = await context.newPage()
    await tabA.goto('/')
    await startRecipe(tabA, '60', '60', '60')

    // 标签 B：打开同一冲洗（从存储恢复为运行中）
    const tabB = await context.newPage()
    await tabB.goto('/')
    await expect(tabB.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(tabB.getByTestId('current-stage')).toHaveText('显影')

    // 在 B 暂停
    await tabB.getByTestId('pause-button').click()
    await expect(tabB.getByTestId('panel')).toHaveAttribute('data-status', 'paused')
    await expect(tabB.getByTestId('seconds')).toHaveText('60')

    // A 通过 storage 事件也应跟进为暂停，而不是继续把 running 写回
    await expect(tabA.getByTestId('panel')).toHaveAttribute('data-status', 'paused')

    // A 始终开着的情况下等待（其定时器若陈旧写回，本测试旧实现会复现 bug）
    await tabB.waitForTimeout(2_500)

    // 刷新暂停标签 B：必须仍是暂停，剩余时间不流逝
    await tabB.reload()
    await expect(tabB.getByTestId('panel')).toHaveAttribute('data-status', 'paused')
    await expect(tabB.getByTestId('current-stage')).toHaveText('显影')
    await expect(tabB.getByTestId('seconds')).toHaveText('60')

    await tabA.close()
  })
})

test.describe('校准剩余时间', () => {
  test('运行中校准后，刷新仍按新时间倒数', async ({ page }) => {
    await page.goto('/')
    await startRecipe(page, '60', '60', '60')

    // 运行中把显影剩余校准为 100 秒：阶段不变，立即按新值倒数
    await page.getByTestId('calibrate-input').fill('100')
    await page.getByTestId('calibrate-button').click()
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
    await expect(page.getByTestId('seconds')).toHaveText('100')

    // 刷新后仍按校准后的时间倒数（绝不会回到配方原来的 60 秒）
    await page.reload()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
    await expect
      .poll(async () => Number((await page.getByTestId('seconds').textContent())!.trim()))
      .toBeGreaterThan(90)

    // 且倒数确实在继续走
    const before = Number((await page.getByTestId('seconds').textContent())!.trim())
    await page.waitForTimeout(1_500)
    const after = Number((await page.getByTestId('seconds').textContent())!.trim())
    expect(after).toBeLessThan(before)
  })

  test('暂停中校准后，刷新仍保持新剩余值，再继续按校准值计时', async ({ page }) => {
    await page.goto('/')
    await startRecipe(page, '60', '60', '60')
    await page.getByTestId('pause-button').click()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'paused')

    // 暂停中校准为 90 秒
    await page.getByTestId('calibrate-input').fill('90')
    await page.getByTestId('calibrate-button').click()
    await expect(page.getByTestId('seconds')).toHaveText('90')
    await expect(page.getByTestId('current-stage')).toHaveText('显影')

    // 刷新后仍是暂停，剩余为校准值 90（不流逝）
    await page.reload()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'paused')
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
    await expect(page.getByTestId('seconds')).toHaveText('90')
    await page.waitForTimeout(1_200)
    await expect(page.getByTestId('seconds')).toHaveText('90')

    // 继续后从 90 开始正常倒数
    await page.getByTestId('resume-button').click()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(page.getByTestId('seconds')).toHaveText('90')
    await expect
      .poll(async () => Number((await page.getByTestId('seconds').textContent())!.trim()), {
        timeout: 3_000,
      })
      .toBeLessThan(90)
  })

  test('空、小数、越界或非数字输入就地提示，当前阶段与剩余时间不变', async ({ page }) => {
    await page.goto('/')
    await startRecipe(page, '60', '60', '60')

    for (const bad of ['abc', '1.5', '0', '1801', '']) {
      await page.getByTestId('calibrate-input').fill(bad)
      await page.getByTestId('calibrate-button').click()
      // 就地提示，且计时不受影响
      await expect(page.getByTestId('calibrate-error')).toBeVisible()
      await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
      await expect(page.getByTestId('current-stage')).toHaveText('显影')
      const seconds = Number((await page.getByTestId('seconds').textContent())!.trim())
      expect(seconds).toBeGreaterThan(50)
      expect(seconds).toBeLessThanOrEqual(60)
    }

    // 合法输入后错误消失，剩余时间按校准值更新
    await page.getByTestId('calibrate-input').fill('45')
    await page.getByTestId('calibrate-button').click()
    await expect(page.getByTestId('calibrate-error')).toHaveCount(0)
    await expect(page.getByTestId('seconds')).toHaveText('45')
  })

  test('完成态与时钟回拨锁定态不显示校准入口', async ({ page }) => {
    // 完成态
    await page.goto('/')
    await startRecipe(page, '1', '1', '1')
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('calibrate-input')).toHaveCount(0)
    await expect(page.getByTestId('calibrate-button')).toHaveCount(0)

    // 锁定态
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      timer: { status: 'running', stage: 'develop', deadline: now + 60_000 },
      lastWallClock: now + 120_000,
    })
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'locked')
    await expect(page.getByTestId('calibrate-input')).toHaveCount(0)
    await expect(page.getByTestId('calibrate-button')).toHaveCount(0)
  })
})

test.describe('冲洗完成', () => {
  test('正常走完三阶段显示完成，刷新后仍是完成结果', async ({ page }) => {
    await page.goto('/')
    await startRecipe(page, '2', '1', '1')
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 10_000 })
    await page.reload()
    await expect(page.getByTestId('done-title')).toBeVisible()
  })
})

test.describe('显影搅动提醒', () => {
  test('启用间隔后显影阶段提示「请搅动」，确认后按墙钟排下一次；进入停显后入口消失', async ({ page }) => {
    await page.goto('/')
    // 显影 12s：首次搅动 10s 到期，确认后约 2s 即跨入停显
    await fillRecipe(page, '12', '3', '3')
    await setAgitation(page, '10')
    await page.getByTestId('start-button').click()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')

    const prompt = page.getByTestId('agitation-prompt')
    await expect(prompt).toHaveAttribute('data-due', 'false')
    await expect(prompt).toContainText('距下次搅动还有')

    // 持久化中写入了间隔与下一次提示绝对时刻
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY)
    expect(stored.agitation.intervalSeconds).toBe(10)
    expect(typeof stored.agitation.nextAt).toBe('number')
    expect(stored.agitation.status).toBe('running')

    // 10 秒后到期：突出显示「请搅动」并出现确认按钮
    await expect(prompt).toHaveAttribute('data-due', 'true', { timeout: 20_000 })
    await expect(prompt).toContainText('请搅动')
    const confirm = page.getByTestId('agitation-confirm')
    await expect(confirm).toBeVisible()

    // 到期后不会自行消失（未确认前一直待确认）
    await page.waitForTimeout(1_200)
    await expect(prompt).toHaveAttribute('data-due', 'true')

    // 确认：回到倒计时，下一次约 10 秒
    await confirm.click()
    await expect(prompt).toHaveAttribute('data-due', 'false')
    await expect(page.getByTestId('agitation-remaining')).toHaveText('10')

    // 跨入停显：搅动入口整体消失，停显/定影都不再提醒
    await expect(page.getByTestId('current-stage')).toHaveText('停显', { timeout: 8_000 })
    await expect(prompt).toHaveCount(0)
    await expect(page.getByTestId('agitation-confirm')).toHaveCount(0)
    await expect(page.getByTestId('current-stage')).toHaveText('定影', { timeout: 8_000 })
    await expect(page.getByTestId('agitation-prompt')).toHaveCount(0)
  })

  test('待提示期间刷新：节奏保持，刷新后仍能到期并确认', async ({ page }) => {
    await page.goto('/')
    await fillRecipe(page, '60', '30', '60')
    await setAgitation(page, '10')
    await page.getByTestId('start-button').click()

    const prompt = page.getByTestId('agitation-prompt')
    await expect(prompt).toHaveAttribute('data-due', 'false')

    // 等待约 5 秒后刷新：仍在显影，搅动入口与倒计时都在
    await page.waitForTimeout(5_000)
    await page.reload()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
    await expect(prompt).toHaveAttribute('data-due', 'false')
    const remainingAfterReload = Number(
      (await page.getByTestId('agitation-remaining').textContent())!.trim(),
    )
    expect(remainingAfterReload).toBeGreaterThan(0)
    expect(remainingAfterReload).toBeLessThanOrEqual(6)

    // 刷新后到期时刻不变，仍会到期
    await expect(prompt).toHaveAttribute('data-due', 'true', { timeout: 15_000 })
    await expect(page.getByTestId('agitation-confirm')).toBeVisible()
    await page.getByTestId('agitation-confirm').click()
    await expect(prompt).toHaveAttribute('data-due', 'false')
    await expect(page.getByTestId('agitation-remaining')).toHaveText('10')
  })

  test('暂停冻结搅动剩余，继续后保持同一节奏', async ({ page }) => {
    await page.goto('/')
    await fillRecipe(page, '60', '30', '60')
    await setAgitation(page, '10')
    await page.getByTestId('start-button').click()

    await page.waitForTimeout(3_000)
    await page.getByTestId('pause-button').click()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'paused')

    const prompt = page.getByTestId('agitation-prompt')
    await expect(prompt).toContainText('暂停中')
    const frozen = Number((await page.getByTestId('agitation-remaining').textContent())!.trim())
    expect(frozen).toBeGreaterThan(5)
    expect(frozen).toBeLessThanOrEqual(7)

    // 暂停期间剩余不流逝
    await page.waitForTimeout(2_000)
    await expect(page.getByTestId('agitation-remaining')).toHaveText(String(frozen))

    // 继续：剩余从冻结值继续倒数
    await page.getByTestId('resume-button').click()
    await expect(prompt).toHaveAttribute('data-due', 'false')
    await expect(page.getByTestId('agitation-remaining')).toHaveText(String(frozen))
    await expect(prompt).toHaveAttribute('data-due', 'true', { timeout: 12_000 })
  })

  test('息屏漏过多个周期：恢复后只有一条待确认提示，确认后排下一次', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 600, stop: 30, fix: 300 },
      // 间隔 30s，下一次提示在 125 秒前（理论上错过 4 个周期）
      agitation: { status: 'running', intervalSeconds: 30, nextAt: now - 125_000 },
      timer: { status: 'running', stage: 'develop', deadline: now + 600_000 },
      lastWallClock: now - 125_000,
    })
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
    const prompts = page.getByTestId('agitation-prompt')
    await expect(prompts).toHaveCount(1)
    await expect(prompts).toHaveAttribute('data-due', 'true')
    await expect(prompts).toContainText('请搅动')

    await page.getByTestId('agitation-confirm').click()
    await expect(prompts).toHaveAttribute('data-due', 'false')
    await expect(page.getByTestId('agitation-remaining')).toHaveText('30')

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY)
    expect(stored.agitation.nextAt).toBeGreaterThan(now)
  })

  test('留空启动：显影/暂停/停显/定影/完成全程不出现搅动入口', async ({ page }) => {
    await page.goto('/')
    await startRecipe(page, '4', '2', '2')

    // 运行中的显影阶段也没有任何搅动入口
    await expect(page.getByTestId('agitation-prompt')).toHaveCount(0)
    await expect(page.getByTestId('agitation-confirm')).toHaveCount(0)

    // 暂停态同样没有
    await page.getByTestId('pause-button').click()
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'paused')
    await expect(page.getByTestId('agitation-prompt')).toHaveCount(0)
    await page.getByTestId('resume-button').click()

    // 一路到完成，入口始终不出现
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('agitation-prompt')).toHaveCount(0)
    await expect(page.getByTestId('agitation-confirm')).toHaveCount(0)

    // 持久化记录中也没有 agitation 字段
    const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect('agitation' in JSON.parse(raw!)).toBe(false)
  })

  test('间隔格式错误或越界时在配方旁说明并阻止启动', async ({ page }) => {
    await page.goto('/')
    await fillRecipe(page, '60', '30', '300')
    const start = page.getByTestId('start-button')
    const error = page.getByTestId('agitation-error')

    for (const bad of ['9', '301', '12.5', 'abc', '-10', '30秒']) {
      await setAgitation(page, bad)
      await expect(start).toBeDisabled()
      await expect(error).toBeVisible()
    }

    // 边界值合法；清空后也可直接启动
    await setAgitation(page, '10')
    await expect(start).toBeEnabled()
    await expect(error).toHaveCount(0)
    await setAgitation(page, '300')
    await expect(start).toBeEnabled()
    await setAgitation(page, '')
    await expect(start).toBeEnabled()
  })

  test('无搅动字段的旧会话记录按未启用读取，面板无搅动入口，倒计时/跨阶段正常', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 3, stop: 2, fix: 2 },
      timer: { status: 'running', stage: 'develop', deadline: now + 3_000 },
      lastWallClock: now,
    })
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(page.getByTestId('agitation-prompt')).toHaveCount(0)
    await expect(page.getByTestId('current-stage')).toHaveText('停显', { timeout: 8_000 })
    await expect(page.getByTestId('agitation-prompt')).toHaveCount(0)
  })

  test('一个标签确认搅动后，另一个标签的待确认提示同步消失', async ({ context }) => {
    // 标签 A：显影中、搅动间隔 10s
    const tabA = await context.newPage()
    await tabA.goto('/')
    await fillRecipe(tabA, '120', '30', '60')
    await setAgitation(tabA, '10')
    await tabA.getByTestId('start-button').click()

    // 标签 B 打开同一会话
    const tabB = await context.newPage()
    await tabB.goto('/')
    await expect(tabB.getByTestId('panel')).toHaveAttribute('data-status', 'running')
    await expect(tabB.getByTestId('agitation-prompt')).toHaveAttribute('data-due', 'false')

    // 到期后两个标签都提示
    await expect(tabA.getByTestId('agitation-prompt')).toHaveAttribute('data-due', 'true', { timeout: 20_000 })
    await expect(tabB.getByTestId('agitation-prompt')).toHaveAttribute('data-due', 'true')

    // 在 A 确认：B 经 storage 事件采纳高 rev 记录，提示消失且不复活
    await tabA.getByTestId('agitation-confirm').click()
    await expect(tabA.getByTestId('agitation-prompt')).toHaveAttribute('data-due', 'false')
    await expect(tabB.getByTestId('agitation-prompt')).toHaveAttribute('data-due', 'false')
    await tabB.waitForTimeout(1_500)
    await expect(tabB.getByTestId('agitation-prompt')).toHaveAttribute('data-due', 'false')

    await tabA.close()
    await tabB.close()
  })
})

test.describe('损坏记录拒绝恢复', () => {
  test('非数字截止时间的运行记录被拒绝，回到配方页可重新开始', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      timer: { status: 'running', stage: 'develop', deadline: 'soon' },
      lastWallClock: now,
    })
    // 绝不进入显示 NaN 的计时面板
    await expect(page.getByTestId('panel')).toHaveCount(0)
    await expect(page.getByTestId('start-button')).toBeVisible()

    // 重新开始后倒计时正常，剩余值为数字并随时间递减
    await startRecipe(page, '3', '2', '2')
    await expect(page.getByTestId('current-stage')).toHaveText('显影')
    const seconds = Number((await page.getByTestId('seconds').textContent())!.trim())
    expect(Number.isFinite(seconds)).toBe(true)
  })

  test('非数字剩余值的暂停记录被拒绝，回到可重新启动的配方页', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      timer: { status: 'paused', stage: 'develop', remainingMs: 'abc' },
      lastWallClock: now,
    })
    await expect(page.getByTestId('panel')).toHaveCount(0)
    await expect(page.getByTestId('start-button')).toBeVisible()
  })

  test('缺少定影时长且逾期跨过停显的不完整配方被拒绝，不进入计时面板', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30 }, // 缺少 fix：旧实现会在定影处算出 NaN
      timer: { status: 'running', stage: 'develop', deadline: now - 100_000 },
      lastWallClock: now - 100_000,
    })
    await expect(page.getByTestId('panel')).toHaveCount(0)
    await expect(page.getByTestId('start-button')).toBeVisible()
  })

  test('未知阶段标识的运行记录被拒绝，只允许恢复显影/停显/定影', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      timer: { status: 'running', stage: 'wash', deadline: now + 60_000 },
      lastWallClock: now,
    })
    await expect(page.getByTestId('panel')).toHaveCount(0)
    await expect(page.getByTestId('current-stage')).toHaveCount(0)
    await expect(page.getByTestId('start-button')).toBeVisible()
  })
})

test.describe('时钟回拨保护', () => {
  test('墙钟早于最近记录立即锁定并说明，只有重置可清除', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      timer: { status: 'running', stage: 'develop', deadline: now + 60_000 },
      // 最近墙钟在 2 分钟后，当前时间更早，构成回拨
      lastWallClock: now + 120_000,
    })

    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'locked')
    await expect(page.getByTestId('locked-title')).toContainText('时钟回拨')
    // 只有重置按钮，没有暂停/继续
    await expect(page.getByTestId('pause-button')).toHaveCount(0)
    await expect(page.getByTestId('resume-button')).toHaveCount(0)

    // 墙钟继续往前走也不会自动解锁
    await page.waitForTimeout(1_200)
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'locked')

    await page.getByTestId('reset-button').click()
    await expect(page.getByTestId('start-button')).toBeVisible()
  })

  test('重置后再次进入页面不再锁定', async ({ page }) => {
    const now = Date.now()
    await seedAndReload(page, {
      version: 1,
      rev: 1,
      recipe: { develop: 60, stop: 30, fix: 300 },
      timer: { status: 'running', stage: 'develop', deadline: now + 60_000 },
      lastWallClock: now + 120_000,
    })
    await expect(page.getByTestId('panel')).toHaveAttribute('data-status', 'locked')
    await page.getByTestId('reset-button').click()
    await page.reload()
    await expect(page.getByTestId('start-button')).toBeVisible()
  })
})
