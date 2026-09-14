# 暗房冲洗续时台

纯前端三阶段冲洗计时器（显影 → 停显 → 定影）。核心诉求：**冲洗中途刷新浏览器或平板息屏，重新出现的倒计时不会把已过去的药浴阶段再走一遍。**

- 不使用任何会在后台被暂停/漂移的计时累加，一切以墙钟（`Date.now()`）与**阶段绝对截止时间**之差为准。
- 状态持久化在 `localStorage`，无后端。
- TypeScript + React 19 + Vite；Vitest 校验状态机转换，Playwright 验收刷新续时与后台跨阶段。

## 时间模型（关键设计）

持久化结构（`src/timer/engine.ts`）：

```jsonc
{
  "version": 1,
  "recipe": { "develop": 60, "stop": 30, "fix": 300 },
  "timer": { "status": "running", "stage": "develop", "deadline": 1726… },
  "lastWallClock": 1726…   // 最近一次见到的墙钟
}
```

- **启动**：从显影开始，`deadline = Date.now() + 显影秒数`，立即持久化当前阶段、最近墙钟与绝对截止时间。
- **运行中显示**：`ceil((deadline - Date.now()) / 1000)`，向上取整的剩余整秒。
- **恢复/唤醒推进**：若 `now >= deadline`，把截止时间依次加上后续阶段时长，用**未消费的逾期时长连续跨过阶段**（`advance()`）。例如显影 60s、停显 30s，页面在启动后第 65s 才恢复：显影标记为已过，直接落在停显并剩余 25s；穿透所有阶段则为「冲洗完成」。
- **暂停**：保存当时剩余毫秒 `remainingMs` 与阶段；刷新后仍是暂停态，墙钟前进也不消耗。
- **继续**：以当前墙钟重建 `deadline = now + remainingMs`。
- **校准剩余时间**：冲洗中途可把运行中/暂停中的当前阶段剩余时间改为 1–1800 的整数秒。运行态以当前墙钟重建 `deadline = now + 校准秒数`；暂停态直接替换已保存的 `remainingMs`。阶段保持不变，属显式操作（rev +1），其它标签页经 storage 事件立即跟进，旧标签页的陈旧 tick 无法覆盖校准结果。输入非法（空、小数、越界、非数字）时在操作区就地提示，计时不受影响；完成态与回拨锁定态不显示校准入口。
- **时钟回拨**：每次推进先检查 `now < lastWallClock`，立即进入锁定态并展示回拨说明；锁定后不会自行恢复，**只有「重置」可清除**（清空持久化）。
- 页面重新可见（`visibilitychange` / `focus` / `pageshow`）时立即按墙钟补推进，因此息屏期间 setInterval 被限流也不影响结果。

正常刷新后，界面只会出现三种明确结果之一：唯一当前阶段 + 剩余秒数、暂停态、或「冲洗完成」。

### 多标签页并发

同一冲洗允许在多个标签页同时打开。每条持久化记录带单调递增的 **rev**，各标签页通过 `storage` 事件同步：

- 显式操作（开始/暂停/继续/校准/重置）把 rev +1；其余标签页收到更高 rev 立即跟进（例如在 B 标签暂停，A 标签也进入暂停）。
- 运行中的定时推进只以**相同 rev** 提交。`commitRecord` 做 rev 比较：低 rev 的陈旧 running 写入（比如另一个没刷新、仍在运行的标签页）无法覆盖更高 rev 的暂停/校准记录。
- 因此「另一个标签页仍开着时暂停，再刷新暂停标签」仍稳定保持暂停，剩余毫秒不被吞掉。
- 重置写入一条高 rev 的**墓碑**：所有标签页回到配方表单，旧标签页的运行 tick 也不能把已放弃的会话复活。

## 配方校验

三阶段分别输入秒数，必须是 **1–1800 的整数**；任一非法（0、负数、小数、非数字、超界、空白等）时「开始冲洗」按钮禁用并逐字段提示。

## 本地开发

```bash
npm ci
npm run dev        # http://localhost:5173

npm test           # Vitest：状态机转换（45 个用例）
npm run e2e        # Playwright：自动 build + preview 后跑验收
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
