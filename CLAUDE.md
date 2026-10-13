# 时间安排 App

## 这是什么

一个个人用的任务排程 + 苹果日历同步桌面应用。用户是备考人员，需要管理一堆有截止日期的复习任务，
每天能投入的时间有限，还有固定的课程/写论文时间占用，App 负责算出"每天该做哪几项任务、各几个小时"，
并且能把结果写进苹果日历、也能从苹果日历读回真实占用时间来避让。

最初是一个纯前端单文件 HTML 应用（LLM 生成，用 localStorage 存数据），后来一步步加上了：
Electron 桌面封装 → 本地 JSON 文件存储 → 苹果日历双向同步 → 菜单栏常驻/开机自启/自动同步 →
任务最早开始日期约束。是逐个阶段迭代出来的，不是一次性设计的，如果发现某段代码看起来像是
"为了兼容上一版数据格式"，大概率就是。

## 技术栈

- **Electron**（package.json devDependency，用 `electron-packager` 打包成 macOS .app，
  不是 electron-builder，没有走签名/公证/自动更新那一套，纯本地个人使用）
- 前端就是原生 JS + DOM，没有任何框架，没有构建步骤，`index.html` 打开就是全部
- 主进程（`main.js`）负责：窗口/托盘管理、开机自启、本地 JSON 文件读写、通过 `osascript`
  调用苹果日历（AppleScript），没有用任何日历相关的 npm 包
- 渲染进程和主进程之间用 `contextBridge` + `ipcMain`/`ipcRenderer` 通信（`preload.js`），
  `nodeIntegration: false`、`contextIsolation: true`

## 目录结构

```
~/Desktop/时间安排App/          ← 项目源码，改代码都在这里改
  ├── index.html               ← 渲染进程：UI + 全部业务逻辑（排程算法、日历读写的渲染端逻辑、
  │                               任务/固定安排的增删改、设置弹窗、自动同步定时器）
  ├── main.js                  ← 主进程：窗口/托盘/登录项、IPC handler、两段硬编码日历名的 AppleScript
  ├── preload.js                ← 暴露给渲染进程的桥接对象：window.dataFile / window.calendarBridge / window.appBridge
  ├── package.json              ← name/productName 是"时间安排"（这个名字决定了 userData 目录名和登录项显示名）
  ├── package-lock.json
  ├── node_modules/             ← electron、electron-packager（都是 devDependency）
  └── dist/                     ← 打包输出目录，`npm run pack` 之后这里会出现
                                    时间安排-darwin-arm64/时间安排.app
```

**已安装的应用**：`/Applications/时间安排.app`（这是从 `dist/` 手动搬过去的一份独立拷贝，
跟源码文件夹没有任何自动关联，见下面"重新打包"一节）。

**数据文件**：`~/Library/Application Support/时间安排/schedule-data.json`
（由 `app.getPath('userData')` 决定，取决于 package.json 里的 productName "时间安排"）。

## 数据文件格式

整个文件就是一个 JSON 对象，结构：

```json
{
  "tasks": [ ... ],
  "fixedBlocks": [ ... ],
  "settings": { ... },
  "updatedAt": 1234567890123
}
```

### tasks（任务）

```json
{
  "id": "id-xxxxx-xxxxx",
  "name": "行测套题模拟一",
  "deadline": "2026-10-18",
  "hours": 3,
  "priority": 3,
  "earliestStart": "2026-10-17",
  "done": false
}
,
  "subtasks": [
    { "id": "id-xxxxx-xxxxx", "text": "查资料", "done": false }
  ]
}
```

- `subtasks`：可选，数组，默认不存在或空数组都等价于没有子任务（跟 earliestStart 一样的容错写法）。纯粘性清单，子任务的完成状态不影响排程算法（不参与 computeSchedule），也不会自动把父任务标成 done，只是给用户自己跟进进度用。在日历视图点开某一天弹出的详情框（day-detail modal）里可以勾选/删除/添加。

- `deadline`：截止日期，`YYYY-MM-DD`，必填
- `hours`：预计需要的小时数，可以是小数（比如 1.5）
- `priority`：`1`=低，`2`=中，`3`=高
- `earliestStart`：**最早开始日期**，可选，`YYYY-MM-DD`。空字符串 `""` 或者字段整个不存在，
  都表示"不限制，随时可以开始"——历史数据没有这个字段是正常的，代码里所有判断都是
  `!!task.earliestStart && task.earliestStart > todayIso` 这种写法，缺字段等价于不限制，
  不会报错。新增这个字段的时候特意保证了不改老数据的行为。
- `done`：完成的任务不会出现在排程里，也不会被写进日历

### fixedBlocks（固定安排）

```json
{
  "id": "id-xxxxx-xxxxx",
  "name": "课程二集中授课",
  "type": "once",
  "date": "2026-09-16",
  "weekday": "1",
  "start": "09:00",
  "end": "16:00"
}
```

- `type`：`"once"`（某一天）或者 `"weekly"`（每周固定星期几）。界面上添加的时候还有个
  `"range"`（连续多天）选项，但那只是输入时的便利写法，保存的时候会拆成一串 `"once"` 条目，
  数据里从来不会真的出现 `type:"range"`
- `once` 用 `date` 字段，`weekly` 用 `weekday` 字段（`"0"`=周日 … `"6"`=周六，字符串类型）
- `start`/`end`：`HH:MM`，24 小时制
- **名字前缀"日历 "的条目**是从苹果日历自动导入的（见下面日历同步一节），不是用户手动加的，
  重新点"从日历读取占用"会把上一批同前缀的条目整个删掉再重新导入

### settings

```json
{
  "capacityHours": 6,
  "horizonDays": 90,
  "viewMode": "list",
  "autoLaunch": true,
  "autoSync": false,
  "lastSyncAt": 1234567890123
}
```

- `capacityHours`：每天能分配给任务的时间上限（小时），跟固定安排是分开算的两件事，
  见下面排程算法一节。缺省默认 4
- `horizonDays`：往后规划多少天，缺省默认 30。当前实际数据用的是 90
- `viewMode`：`"list"` 或 `"calendar"`，纯 UI 状态
- `autoLaunch`：开机自动启动开关，**缺省当 `true` 处理**（`!== false` 才算 false），
  历史数据没这个字段就是默认开
- `autoSync`：自动同步到日历开关，**缺省当 `false` 处理**，默认关，需要用户在设置里手动打开
- `lastSyncAt`：上次成功同步到日历的时间戳（毫秒），`0` 表示从没同步过，显示在设置弹窗里

## 排程算法（`index.html` 里的 `computeSchedule()`）

这是全部逻辑的核心，改任何排程相关需求之前一定要先读这个函数（`index.html` 里搜
`function computeSchedule`）。规则：

1. 从"今天 00:00"开始，往后数 `horizonDays` 天，逐天建一个 `day` 对象。
2. **先放固定安排**：遍历 `fixedBlocks`，`weekly` 类型按星期几匹配落到每个符合的日期，
   `once` 类型按精确日期匹配。命中的累加到 `day.fixedHours`，并记录进 `day.fixed` 数组
   （带 `start`/`end`/`hours`）。
3. 每天可用于任务的时间 = `max(0, capacityHours - day.fixedHours)`，也就是 `day.remaining`。
   **注意这是纯小时数的预算模型，不是按具体钟点排的**——固定安排在几点几分对这一步没有影响，
   只有总时长有影响。只有"同步到日历"那一步（写具体事件的时候）才会用到真实的钟点，见下面。
4. **只处理未完成的任务**（`!t.done`），排序规则：
   - 截止日期早的排前面
   - 截止日期相同时，优先级高的排前面
   - 再相同时，预计用时短的排前面
5. 按上面排好的顺序，**逐个任务贪心分配**：
   - 如果任务填了"最早开始日期"并且这个日期晚于今天，分配的起点就是这个日期，
     **之前的所有天，哪怕完全空着，也绝不分配**（见 `tryAllocate` 的 `startIso` 参数）。
     没填或者已经过去了，起点就是今天。
   - 先尝试"留一天缓冲"：只用到截止日前一天为止的时间（`tryAllocate(..., deadline-1, startIso)`）。
     如果这样就能凑够任务需要的小时数，就用这个方案。
   - 凑不够的话，退而求其次，允许用到截止日当天（`tryAllocate(..., deadline, startIso)`）。
   - `tryAllocate` 内部：从起点开始逐天扫描到终点，每天能拿多少算多少（`min(当天剩余, 还差多少)`），
     **一个任务可以拆到好几天**，直到凑够或者扫完区间。
   - 分配结果落进对应 `day.tasks`（`{id, name, hours, priority}`），同时从 `day.remaining` 里扣掉。
6. **警告判断**（结果在 `schedule.atRisk` 里，UI 上红框显示）：
   - 如果最终分配到的小时数比任务需要的少（差 > 0.01h），判定"排不下"，`shortHours` 就是差多少：
     - 截止日期本身超出了 `horizonDays` 规划范围 → "截止日期超出当前规划范围"
     - 填了最早开始日期、导致可用区间被压缩 → "从最早开始日期 X 到截止日期之间排不完"
     - 单纯每天上限不够 → "按现在的每日时间上限排不完"
   - 如果刚好能排完，但用的是"不留缓冲"的那个退而求其次的方案 → 软警告
     "能排完，但截止日前一天没有缓冲，时间很紧"（`shortHours: 0`）
   - **关键点**：警告判断天然就是"从最早开始日期（或今天）到截止日期"这个区间内算的，
     不是"从今天到截止日期"——因为 `tryAllocate` 本身已经用 `startIso` 限制了扫描范围，
     不需要额外再写一套区间逻辑。

## 日历同步逻辑

### 安全底线（写在 `main.js` 里，硬编码，不是运行时判断）

`main.js` 顶部有整段注释说明这件事：**日历名 `"学习安排"` 是直接写死在两段 AppleScript
模板文本里的字面量字符串**，不接受任何来自 IPC 参数、渲染进程或者别的地方传进来的日历名。
代码里根本不存在"日历名当参数"这条路径。具体：

- 写入/清空/新建事件的 AppleScript（`buildSyncAppleScript`）：只对 `calendar "学习安排"` 操作
- 读取占用的 AppleScript（`READ_BUSY_SCRIPT`）：反过来，排除条件是 `calName is not "学习安排"`

不管是手动点按钮还是自动同步定时器触发，走的都是这两个 IPC handler
（`calendar:readBusy` / `calendar:sync`），没有第二套代码路径，所以自动触发和手动触发的
安全限制是同一份，不会出现"自动同步时忘了加限制"这种事。

### 方向一：从日历读取占用 → 导入成固定安排

对应 `main.js` 的 `READ_BUSY_SCRIPT` + 渲染进程的 `handleCalendarRead()` / `splitEventsIntoBlocks()`。

- 读取范围固定是"今天到往后 90 天"，这个 90 是写死的，不跟 `settings.horizonDays` 挂钩
- 跳过全天事件（`allday event`）
- 每个事件按自然日拆分（`splitEventsIntoBlocks`，处理跨天/跨午夜的事件），落成
  `{date, start, end, name}`
- 导入时名称统一加 `"日历 "` 前缀，**导入前会先把上一批带这个前缀的条目整个删掉**再重新导入，
  不会越堆越多
- 导入完成后会做"疑似重复"检测：新导入的条目 vs 手动添加的条目，同一天（或同一星期几）+
  时间段有重叠，就列出来提示用户自己判断要不要删——**不会自动删除任何一条**

### 方向二：把排好的日程写进日历

对应渲染进程的 `buildCalendarEventsForSync()` + `computeFreeGaps()`，主进程的
`buildSyncAppleScript()`。

排程算法本身（`computeSchedule`）只知道"这天要做哪几项任务、各几小时"，不含具体钟点。
写日历需要具体时间点，处理方式：

1. 每天的可写入窗口固定是 **9:00–22:00**（`DAY_WINDOW_START`/`DAY_WINDOW_END`，写死的常量）
2. 用当天 `day.fixed`（固定安排，此时包含手动加的和"日历 "前缀导入的）裁剪出这个窗口内的空档
   （`computeFreeGaps`，会先把多个固定安排的时间段合并去重叠，再算剩下的间隙）
3. 按 `day.tasks` 里的先后顺序（也就是排程算法本身的处理顺序：截止日期/优先级/时长排序），
   依次把每个任务需要的小时数往空档里塞，一个连续的时间段对应一个日历事件，标题=任务名。
   如果一个任务当天的时长比一个空档还长，会自然分成同一天里的好几个事件（同名）。
4. 如果某天所有空档加起来还是不够当天分配到的任务小时数，**不会硬塞**，记进 `shortDays`
   报告给用户，格式是哪天、差哪个任务多少小时
5. 实际写入：先 `delete every event of calendar "学习安排"` 清空，再逐个 `make new event`

同步前会先弹确认框（手动点"同步到日历"按钮的情况），说明会清空重写；自动同步（见下）走的是
"静默版本"，不弹窗、不用确认。

### 自动化：托盘 / 开机自启 / 自动同步

这几个不在用户这次列的清单里，但理解 `settings.autoLaunch`/`autoSync`/`lastSyncAt`
这几个字段必须知道：

- **菜单栏图标**：`main.js` 用 `nativeImage.createEmpty()` + `tray.setTitle('🗓')`
  做的托盘图标（没有真的图片资源）。左键切换主窗口显示/隐藏，右键弹菜单
  （打开主窗口/立即同步到日历/退出）。
- **关窗口不退出**：`mainWindow.on('close', ...)` 里拦截，非真正退出（`isQuitting` 标记）
  就 `preventDefault()` 改成 `hide()`。真退出只有托盘"退出"或者 Cmd+Q（走 Electron 默认菜单）。
- **开机自启**：`app.setLoginItemSettings()`，这是 Electron 封装的官方 macOS API
  （现代 macOS 上走 Background Task Management），不是手动写 plist。每次启动
  （`app.whenReady()`）都会按 `settings.autoLaunch` 重新设一遍，所以哪怕文件被直接改过，
  下次启动也会自愈成正确状态。可以用 `sfltool dumpbtm | grep -A8 时间安排` 从系统层面验证。
- **自动同步**（`settings.autoSync` 为 `true` 时）：应用启动时同步一次；每天 7:00 自动同步一次
  （渲染进程里 `setInterval` 每分钟检查一次时间，配合 `lastDailyAutoSyncDateStr` 防止同一天重复触发）；
  界面任何改动（`saveData()` 被调用）之后 60 秒防抖再同步一次。每次自动同步前都会先静默
  做一遍"读取占用"再写入，保证避开的是最新安排。全程复用和手动按钮完全相同的两个 IPC handler，
  安全限制不会因为是自动触发就绕过。

## 改完代码之后怎么重新打包、部署

**这是最容易漏掉的一步**：`/Applications/时间安排.app` 是手动从 `dist/` 拷过去的一份
**独立拷贝**，跟源码文件夹之间没有任何自动同步机制。改了 `index.html`/`main.js`/`preload.js`
之后，必须走完下面全部步骤，用户才能看到变化：

1. **先彻底退出正在运行的 app**（不是关窗口，是真退出——菜单栏"退出"，或者
   `pkill -f "时间安排.app/Contents/MacOS/时间安排"`，这条命令能同时匹配 Desktop 的旧构建路径
   和 /Applications 的安装路径）。
   **这一步不能省**：如果只是把窗口关掉（隐藏到托盘），渲染进程其实还在后台跑着，
   它内存里的旧 `state` 之后只要触发一次 `saveData()`（哪怕是自动同步的防抖定时器），
   就会把 `schedule-data.json` 覆盖回旧内容，之前手动改的数据文件会被冲掉。
2. 重新打包：
   ```
   cd ~/Desktop/时间安排App
   npx electron-packager . 时间安排 --platform=darwin --arch=arm64 --out=dist --overwrite
   ```
   输出在 `dist/时间安排-darwin-arm64/时间安排.app`。
3. 用新的覆盖掉已安装的那份：
   ```
   rm -rf "/Applications/时间安排.app"
   mv "dist/时间安排-darwin-arm64/时间安排.app" "/Applications/时间安排.app"
   ```
   （用 `mv` 而不是 `cp`，避免 `dist/` 里留一份没用的重复拷贝；`dist/` 本来就是可以随时重新生成的构建产物）
4. 如果要马上验证，`open "/Applications/时间安排.app"`。
5. 数据文件本身（`~/Library/Application Support/时间安排/schedule-data.json`）不受打包影响，
   除非改的是 schema，需要手动迁移数据——参照第一步"确保 app 完全退出"之后再直接改 JSON 文件。
6. 本地构建的 `.app` 不会带隔离属性（不是从网上下载的），一般不会被 Gatekeeper 拦截；
   如果不放心可以 `xattr -l "/Applications/时间安排.app"` 确认是空的。
7. 首次在新装的这份上点日历相关按钮，macOS 会重新弹一次 Calendar 权限请求（TCC 按
   应用身份+路径记权限，跟之前任何一次授权都是独立的），提示用户点"允许"。

## 常用操作示例

用户很可能会直接用大白话提需求，不会说"帮我改 JSON"。下面是几种典型说法该怎么处理：

**"帮我加一个任务，XXX，截止日期几号，预计几个小时"**
→ 最简单可靠的方式是告诉用户在 App 的"任务"标签页里用"添加任务"表单操作（有输入校验，
不会出错）。如果用户明确要求由你直接改数据文件：先确认 App 已经完全退出
（`ps aux | grep 时间安排.app/Contents/MacOS`，为空才行），再读 `schedule-data.json`，
往 `tasks` 数组里 push 一条新对象（`id` 用类似 `"id-" + Date.now().toString(36) + "-" + 随机串`
保证唯一，`earliestStart` 没有就填 `""`，`done` 填 `false`），写回文件，再重新打开 App。

**"把 XXX 这个任务的预计用时改成 N 小时"**
→ 同上，退出 App → 在 `tasks` 数组里按 `name` 精确匹配找到那条 → 改 `hours` 字段 →
写回 → 重新打开。改之前最好先读一遍确认只有一条同名（如果有重名任务，要跟用户确认改哪条）。

**"把 XXX 标记完成"**
→ 同样的路径，把对应任务的 `done` 改成 `true`。标记完成的任务不会再出现在排程和日历同步里，
但不会从任务列表删除（用户还能在界面里手动删）。

**"重新同步一下日历"**
→ 两种做法都可以：
  1. 告诉用户在 App 里点"同步到日历"按钮（会弹确认框，最贴近用户预期）。
  2. 如果是你在自动化脚本里需要触发一次性同步（比如批量改完数据后要立刻生效），
     参考之前阶段用过的模式：写一个独立的 Node 脚本，把 `index.html` 里的
     `computeSchedule` / `tryAllocate` / `computeFreeGaps` / `buildCalendarEventsForSync`
     这几个纯函数原样抄过去（它们不依赖 DOM，可以直接在 Node 里跑），读
     `schedule-data.json`，算出事件列表，再把 `main.js` 里那两段硬编码日历名的
     AppleScript 模板也原样抄过去，用 `child_process.execFileSync('osascript', [tmpFile])`
     执行清空+写入。**这样做完之后必须回填 `settings.lastSyncAt`**（`Date.now()`），
     不然设置弹窗里显示的"上次同步时间"会不准。跑这类脚本前同样要先确认 App 已经完全退出，
     跑完之后再重新打开 App 让用户看结果。千万不要在脚本里重新发明一套排程算法，
     必须跟 `index.html` 里那份完全一致，否则脚本算出来的日历事件会跟 App 界面上显示的
     排程对不上。

## 日历视图的月格子 + 日详情弹窗（2026-09-23 加的）

之前日历视图（`viewMode:"calendar"`）的格子偏大（`min-height:96px`），在比较窄的窗口里会
横向溢出需要滚动。现在改成了更紧凑的网格（`min-height:68px`，并给 `main`/`section.timeline`/
`.calendar-grid` 都加了 `min-width:0`，避免 flex 子元素撑破容器导致横向滚动条）。

点开某一天弹出的详情框（`openDayDetail` / `#dayDetailModal`）现在不是只读的了：

- 固定安排、任务旁边都带"编辑""删除"按钮（`data-action="ddEditFixed"` /
  `ddDeleteFixed"` / `"ddEditTask"` / `"ddDeleteTask"`），点编辑会关掉弹窗、切到对应
  标签页、把表单填好，走的还是左边栏那套原有的、已经有校验的表单，没有单独另起一套。
  这几个动作抽成了共享函数 `toggleTaskDone` / `startEditTask` / `deleteTaskConfirm` /
  `startEditFixed` / `deleteFixedConfirm`，左边栏列表和日详情弹窗共用，改逻辑只用改一处。
- 弹窗顶部有"+ 固定安排"/"+ 任务"两个快捷按钮，点了会关掉弹窗、切标签页、把日期
  字段预填成弹窗对应的那天。
- 每个任务块下面是子任务勾选清单（见上面 `subtasks` 字段），可以直接加/勾/删，
  对应 `addSubtask` / `toggleSubtask` / `deleteSubtask`。
- 弹窗内容的所有交互都是委托事件绑在 `#dayDetailBody` 上（`initDayDetailActions`），
  重新渲染弹窗内容（`refreshDayDetail`，内部还是调 `openDayDetail`）不用重新绑定；
  `refreshDayDetail` 会先检查弹窗是不是还开着（`.show` class），不是的话什么都不做，
  避免从左边栏删任务之类的操作意外把已经关掉的弹窗又弹出来。

**"今天"这一天的逾期任务**：`computeSchedule()` 原来的分配逻辑对截止日期已经过去、
还没标记完成的任务是直接跳过不分配的（`tryAllocate` 的起止区间会失效），这些任务此前
会从日历上完全消失，用户容易以为任务丢了。现在 `computeSchedule` 在 `return` 之前单独
算了一份 `overdueTasks`（deadline < todayIso 且 !done 且剩余小时数 > 0），只挂在
`byDate[todayIso].overdueTasks` 上用来显示（月视图今天格子里的红色"逾期"chip、
日详情弹窗顶部的"已逾期"分组），**不改任务的 deadline，也不参与 day.tasks /
day.remaining 的计算**——纯展示层的东西，排程算法本身没动。`atRisk` 里的提示文案也
顺带区分了"已经过了截止日期"和"截止日期超出规划范围"这两种情况（以前共用一句话）。

改完这些别忘了走"改完代码之后怎么重新打包、部署"那一节的完整流程，`/Applications`
里装的那份不会自动更新。

## AI 功能（2026-10-13 加的）

这个 App 原本是纯规则逻辑，排程算法、日历同步都不涉及任何模型调用。现在加了三个可选的
AI 能力，**默认都是关的／需要先装好 Claude Code 命令行**，不满足条件的话整个 App 的
行为跟以前完全一样。

**不接 Anthropic API**：调用的是这台电脑上装好并登录过的 Claude Code 命令行
（`claude -p ...`，非交互模式），用的是用户自己 Claude 账号的额度（Pro/Max 订阅的话
不用另外按 token 计费），不用单独申请、管理 API Key。代价是每次调用要启动一个命令行
子进程，比直接打 API 慢；而且命令行没有 Messages API 的 tool use 那种"强制按 schema
返回"的机制，解析失败的概率比纯 API 方案略高，`main.js` 里专门写了容错解析（见下）。

### 配置和存储

- claude 命令行的自定义路径、模型名、"日历智能筛选"开关存在**单独的** `ai-config.json`
  （`~/Library/Application Support/时间安排/ai-config.json`），不跟 `schedule-data.json`
  混在一起，"导出数据文件""导入数据文件""清空数据"这几个操作都不会碰到它。这个文件里
  不存任何密钥（本来也没有密钥要存）。
- 设置弹窗（`#settingsModal`）里有专门一块：一行检测状态文字（`#aiCliStatus`，打开弹窗
  时调 `ai:getStatus` 实时探测）、claude 可执行文件路径输入框（可选，PATH 里找不到
  `claude` 的时候才需要手动填，macOS 图形界面启动的 App 经常拿不到完整 PATH，这是已知
  问题）、模型名输入框（可选，留空就用 `claude` 命令行自己的默认模型，填的话直接透传给
  `--model` 参数，比如 `sonnet`/`opus` 这种别名或者完整模型 ID）、"日历智能筛选"勾选框。
- `main.js` 里：
  - `claudeCliCandidates()` 按顺序给出几个候选路径（用户自定义路径 → 裸 `claude`
    （指望 PATH 里有）→ `~/.claude/local/claude` → 几个常见的 Homebrew/本地安装路径），
    逐个试直到找到能跑的。
  - `resolveClaudeBinary()` 只是跑一下 `claude --version` 探测有没有装好，不发真正的对话，
    不浪费额度，专门给设置弹窗显示状态用。
  - `runClaudeCli()` 是真正发一轮对话的地方：`execFile('claude', ['-p', 完整prompt,
    '--output-format', 'json'], ...)`，超时时间 `AI_CLI_TIMEOUT_MS`（3 分钟，命令行
    启动本身有开销，留了余量）。
  - `extractJsonPayload()` 做容错解析：先剥 CLI 自己的 JSON 包装（真正的模型回答在
    `.result` 字段里），再剥模型偶尔手滑多包的 ```json 代码块围栏，最后 `JSON.parse`
    剩下的部分，解析不出来就老实抛错（带上原始内容方便排查），不会硬凑一个假结果。
  - `callClaudeCli()` 是对外的统一入口：拼好"系统指示 + 明确要求只输出 JSON + 格式说明
    + 用户内容"的完整 prompt（因为命令行没法像 API 的 `tool_choice` 那样强制模型按
    schema 回答，只能靠把要求写清楚在 prompt 里），调 `runClaudeCli` 再 `extractJsonPayload`。
    没装命令行、没登录、超时、解析失败，都会在这里统一抛出，三个功能各自 catch 住转成
    "失败就降级成原来的行为"，不会让 AI 调用失败直接把功能挡死。

### 功能一：AI 智能添加任务（任务面板，"AI 智能添加"按钮，挨着"批量添加"）

把一段自然语言（可以一次写好几个任务）发给模型，要求它按 `tasks` 字段返回
`{name, deadline, hours, priority, earliestStart, note}` 的结构化数组（`index.html`
里的 `ai:parseTasksText` 调用，system prompt 里把"今天的日期"喂给模型做相对日期换算，
比如"下周三"）。拿到结果之后**不会直接写入**，会走一遍和手动添加同样的字段校验
（`validateAiTaskRow`：日期格式、小时数 >0、优先级落在 1-3），校验不过的那条标红显示
问题，用户看着预览确认没问题，点"确认添加"才真正 push 进 `state.tasks`，逻辑上
完全复用了"批量添加"原有的预览/确认模式（`renderBulkPreview`/`commitBulkImport`）。

### 功能二：日历占用智能筛选（设置里的"日历智能筛选"开关 + "从日历读取占用"按钮）

默认关闭，不影响原有行为。打开之后，`handleCalendarRead()` 读到苹果日历事件之后，
在 `splitEventsIntoBlocks` 之前多一步 `maybeAiFilterEvents()`：把事件列表（去掉全天事件之后
的那些，AppleScript 那层已经过滤过）发给模型，让它判断哪些不像是真实会占用时间的安排
（比如事件标题就是"提醒"之类的备忘），返回 `{index, keep, reason}` 的逐条判断
（`ai:classifyBusyEvents`）。**system prompt 里明确要求"拿不准就 keep:true"**，
偏保守，宁可多保留几条可疑的，也不要漏掉真实占用——漏判的后果（该挡的时间没挡住，
任务排到冲突的时间段）比多判的后果（多了条没用的固定安排，用户自己能看出来删掉）严重。
被排除的条目会在导入结果弹窗里列出来并附上理由，是透明可审查的，不是静默过滤。
AI 调用失败（命令行没装、没登录、超时）会在 console 打警告，然后自动退回成
"不筛选，所有事件都保留"，不会因为 AI 掉链子就让"从日历读取占用"这个核心功能用不了。

### 功能三：排不下时 AI 建议调整（警告框里的"AI 建议调整"按钮）

`computeSchedule()` 算出 `schedule.atRisk` 之后，`buildWarningsHtml()` 在有硬警告
（`shortHours > 0`，也就是真的排不进去的那些）的时候会多渲染一个"AI 建议调整"按钮。
点击之后（`openAiReschedule`）把排不下的任务列表 + 这些任务的完整字段 + 当前的
`capacityHours`/`horizonDays` 打包发给模型（`ai:suggestReschedule`），要求它给出最多
5 条具体建议，每条必须明确是"改哪个任务的哪个字段成什么值"或者"把每日时间上限改成多少"，
不接受"去跟老师申请延期"这种程序没法直接执行的空泛建议（除非真的没有别的办法，那也要求
标成 `field:"无法自动应用"`，界面上这种建议不会显示"应用"按钮）。

**每条建议都要用户自己点"应用"才会真的改数据**（`applyAiSuggestion`），没有任何一条会
自动生效。应用的时候按任务名字匹配 `state.tasks` 里对应的未完成任务，改完立刻
`saveData()` + `render()`，用户能马上看到调整后排不排得下。这个设计是延续"逾期任务
只在日历上标记、不自动改数据"那条已经定下来的原则——AI 能提建议，但改不改、改成什么
永远是用户自己点出来的，不会有任何一步绕过确认直接写数据。

### 如果以后要加别的 AI 能力

照着现在这三个的模式来：`main.js` 里用 `callClaudeCli()` 包一个新的 `ai:xxx` handler，
写清楚 `systemPrompt` + `schemaHint`（`schemaHint` 是纯文本描述的输出格式要求，不是真的
JSON schema 对象——命令行没法强制模型遵守，只能靠在 prompt 里写清楚），`preload.js`
里挂到 `window.aiBridge` 下，渲染进程里拿到结果之后**该走原来的校验就走原来的校验，
该让用户确认就让用户确认**，不要因为是"AI 给的"就跳过校验或者静默写入——这几个功能的
信任模型是"AI 只负责降低用户的操作成本（打字、读日历、想调整方案），最终决定权和数据
校验这两件事上 AI 跟手动输入享受完全相同的待遇"。

### 如果以后想换回直接调 Anthropic API

2026-10-13 一开始是直接调 Messages API（`fetch` + `tool_choice` 强制结构化输出），后来
应用户要求改成了调本地 Claude Code 命令行，为的是不用单独申请 API Key、用账号自己的
订阅额度。如果以后想换回去（比如要稳定性更高、不想依赖本地装好命令行这件事），改动集中在
`main.js` 的 `callClaudeCli`/`runClaudeCli`/`resolveClaudeBinary`/`claudeCliCandidates`
这几个函数和对应的 `ai:getStatus`/`ai:saveConfig` handler，`index.html` 里三个功能的
调用方式（`window.aiBridge.parseTasksText`/`classifyBusyEvents`/`suggestReschedule`
这几个接口名和返回形状）不用动，只是换掉 main.js 里这几个函数的内部实现。
