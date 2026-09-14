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
