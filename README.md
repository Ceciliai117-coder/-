# 时间安排

个人任务排程 + 苹果日历同步的 macOS 桌面小工具。管理一堆有截止日期的任务，设定每天能
投入的时间上限和固定占用（课程、写论文等），自动算出每天该做哪几项任务、各几个小时，
排不下的会标红提醒。支持把排好的日程写进苹果日历，也能反过来从日历读回真实占用时间来
避让冲突。

A personal task-scheduling desktop app for macOS, built with Electron. Give it tasks with
deadlines and estimated hours, plus fixed commitments (classes, writing blocks), and it
figures out what to work on each day within your daily time budget — flagging anything that
won't fit. Can sync the plan to Apple Calendar and read busy time back from it.

## 功能

- 任务管理：名称、截止日期、预计用时、优先级、最早开始日期，支持子任务清单
- 固定安排：单次 / 每周固定 / 连续多天，也能从 .ics 文件批量导入
- 自动排程：按截止日期和优先级贪心分配每天的任务，尽量在截止日前留出缓冲
- 列表视图 + 月历视图，月历上可以直接编辑、删除、勾选完成、加子任务
- 逾期未完成的任务会在今天单独标红提醒，不会悄悄从日历上消失
- 双向同步苹果日历：把排好的日程写成日历事件，也能读取日历里的真实占用来避让
- 菜单栏常驻、开机自启、每天自动同步

## 技术栈

纯 Electron + 原生 JS，没有任何前端框架，没有构建步骤。数据存成本地 JSON 文件
（`app.getPath('userData')` 目录下），日历相关操作通过 AppleScript 调用苹果日历，
没有用任何日历相关的第三方包。

```
index.html    渲染进程：全部界面和业务逻辑（排程算法、日历读写、任务/固定安排增删改）
main.js       主进程：窗口/托盘/开机自启、IPC handler、AppleScript 调用
preload.js    渲染进程和主进程之间的桥接
```

## 运行

```
npm install
npm start
```

## 打包成 macOS App

```
npm run pack
```

输出在 `dist/时间安排-darwin-arm64/时间安排.app`，可以直接拖到 Applications 里用。

## 开发细节

`CLAUDE.md` 里写了排程算法、数据格式、日历同步的安全限制等详细说明，改代码之前建议先看一下。
