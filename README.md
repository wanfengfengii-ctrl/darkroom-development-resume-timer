# 暗房冲洗续时台

纯前端三阶段冲洗计时器（显影 → 停显 → 定影）。核心诉求：**冲洗中途刷新浏览器或平板息屏，重新出现的倒计时不会把已过去的药浴阶段再走一遍。**

- 不使用任何会在后台被暂停/漂移的计时累加，一切以墙钟（`Date.now()`）与**阶段绝对截止时间**之差为准。
- 可选的**显影搅动提醒**：按固定间隔（10–300 秒整数）提示搅动，只在显影阶段出现；同样只认墙钟，暂停冻结、息屏合并、跨标签与刷新保持同一节奏。
- 状态持久化在 `localStorage`，无后端。
- TypeScript + React 19 + Vite；Vitest 校验状态机转换，Playwright 验收刷新续时与后台跨阶段。

## 时间模型（关键设计）

持久化结构（`src/timer/engine.ts`）：

```jsonc
{
  "version": 1,
  "recipe": { "develop": 60, "stop": 30, "fix": 300 },
  "timer": { "status": "running", "stage": "develop", "deadline": 1726… },
  // 可选：启用搅动时存在，缺省（含旧记录）即未启用
  "agitation": { "status": "running", "intervalSeconds": 30, "nextAt": 1726… },
  "lastWallClock": 1726…   // 最近一次见到的墙钟
}
```

- **启动**：从显影开始，`deadline = Date.now() + 显影秒数`，立即持久化当前阶段、最近墙钟与绝对截止时间。
- **搅动提醒（可选）**：仅当配方页填写 10–300 的整数秒间隔时启用，只属于显影阶段。
  - 启动时写入下一次提示的**绝对墙钟时刻** `nextAt = 启动时刻 + 间隔`；运行中以 `now >= nextAt` 判定到期，面板突出显示「请搅动」并提供确认。
  - 确认是显式操作（rev +1），`nextAt = 确认墙钟 + 间隔`；**休眠漏过多少个周期都只是同一条待确认提示**（到期状态是布尔值，不排队列），确认后节奏从确认时刻起算。
  - **暂停**时把 `nextAt` 换算成冻结的剩余毫秒保存，暂停期间不流逝；若提示在暂停瞬间已到期，会随暂停记录保留「待确认」标记，暂停态继续突出显示「请搅动」（可直接在暂停中确认，冻结剩余恢复为整个间隔），而不是伪装成剩余零秒的普通倒计时。**继续**时以冻结剩余重建绝对时刻，刷新与跨标签同步后保持同一节奏。
  - 显影已到点但面板尚未被 tick 推进的临界窗口里，确认搅动不会被接受、也不会排下一次提示，而是按墙钟结束显影进入停显；此时校准剩余同样先消费已到期阶段，校准作用于停显，绝不会给已结束的显影续命。
  - 跨入停显/定影、完成或回拨锁定时整体清除 `agitation`，后续阶段不再产生提醒。旧记录无该字段，按未启用读取。
- **运行中显示**：`ceil((deadline - Date.now()) / 1000)`，向上取整的剩余整秒。
- **恢复/唤醒推进**：若 `now >= deadline`，把截止时间依次加上后续阶段时长，用**未消费的逾期时长连续跨过阶段**（`advance()`）。例如显影 60s、停显 30s，页面在启动后第 65s 才恢复：显影标记为已过，直接落在停显并剩余 25s；穿透所有阶段则为「冲洗完成」。
- **暂停**：保存当时剩余毫秒 `remainingMs` 与阶段；刷新后仍是暂停态，墙钟前进也不消耗。
- **继续**：以当前墙钟重建 `deadline = now + remainingMs`。
- **校准剩余时间**：冲洗中途可把运行中/暂停中的当前阶段剩余时间改为 1–1800 的整数秒。运行态先按墙钟补推进（显影已归零却尚未由 tick 推进时先进入停显/完成），再以当前墙钟重建推进后所在阶段的 `deadline = now + 校准秒数`；暂停态直接替换已保存的 `remainingMs`。阶段保持校准瞬间的当前阶段不变，属显式操作（rev +1），其它标签页经 storage 事件立即跟进，旧标签页的陈旧 tick 无法覆盖校准结果。输入非法（空、小数、越界、非数字）时在操作区就地提示，计时不受影响；完成态与回拨锁定态不显示校准入口。
- **时钟回拨**：每次推进先检查 `now < lastWallClock`，立即进入锁定态并展示回拨说明；锁定后不会自行恢复，**只有「重置」可清除**（清空持久化）。
- 页面重新可见（`visibilitychange` / `focus` / `pageshow`）时立即按墙钟补推进，因此息屏期间 setInterval 被限流也不影响结果。

正常刷新后，界面只会出现三种明确结果之一：唯一当前阶段 + 剩余秒数、暂停态、或「冲洗完成」。

### 多标签页并发

同一冲洗允许在多个标签页同时打开。每条持久化记录带单调递增的 **rev**，各标签页通过 `storage` 事件同步：

- 显式操作（开始/暂停/继续/校准/确认搅动/重置）把 rev +1；其余标签页收到更高 rev 立即跟进（例如在 B 标签暂停，A 标签也进入暂停）。
- 运行中的定时推进只以**相同 rev** 提交。`commitRecord` 做 rev 比较：低 rev 的陈旧 running 写入（比如另一个没刷新、仍在运行的标签页）无法覆盖更高 rev 的暂停/校准/确认搅动记录。
- 因此「另一个标签页仍开着时暂停，再刷新暂停标签」仍稳定保持暂停，剩余毫秒不被吞掉。
- 重置写入一条高 rev 的**墓碑**：所有标签页回到配方表单，旧标签页的运行 tick 也不能把已放弃的会话复活。

## 配方校验

三阶段分别输入秒数，必须是 **1–1800 的整数**；任一非法（0、负数、小数、非数字、超界、空白等）时「开始冲洗」按钮禁用并逐字段提示。

可选的**搅动间隔**留空即按现有配方与温度修正直接启动；填写时必须是 **10–300 的整数秒**，格式错误或越界在配方旁说明并阻止启动。

## 本地开发

```bash
npm ci
npm run dev        # http://localhost:5173

npm test           # Vitest：状态机转换（142 个用例）
npm run e2e        # Playwright：自动 build + preview 后跑验收（37 个用例）
npm run build      # 类型检查 + 生产构建到 dist/
```

> 本机首次跑 Playwright 需 `npx playwright install chromium`。

## Docker Compose

只运行 Web（nginx 静态托管 `dist/`）：

```bash
docker compose up -d --build
# http://localhost:8080
```

宿主端口由 `WEB_PORT` 覆盖：

```bash
WEB_PORT=9090 docker compose up -d        # 或复制 .env.example 为 .env
```

一次性验收服务 `verify`（构建镜像、启动 web、在容器内跑完 Playwright 即退出）：

```bash
docker compose build web verify
docker compose --profile verify run --rm verify
```

`verify` 位于 `verify` profile，不会被普通的 `docker compose up` 拉起；它通过 compose 网络访问 `http://web:80`。

## 目录结构

```
src/
  timer/engine.ts      纯函数状态机：校验/启动/推进跨阶段/暂停/继续/校准/回拨锁定/持久化
  timer/engine.test.ts Vitest 状态转换测试
  timer/useTimer.ts    React 绑定：tick、可见性恢复、localStorage 读写
  components/          配方表单、计时面板（阶段提示/倒计时/校准/完成/锁定）
e2e/app.spec.ts        Playwright 验收：刷新、息屏逾期跨阶段、后台、暂停、校准、回拨
Dockerfile.web         多阶段：node 构建 → nginx 托管
Dockerfile.verify      基于 mcr.microsoft.com/playwright，跑一次性验收
```
