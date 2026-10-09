const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const DATA_FILE_NAME = 'schedule-data.json';

// ---------------------------------------------------------------------------
// 安全底线：日历的所有写操作（清空、删除、新建事件）只允许发生在名字叫“学习安排”
// 的这一个日历上。这个名字在下面两段 AppleScript 里是硬编码的字符串常量，
// 不接受来自 IPC 参数、渲染进程或任何外部输入的日历名——不存在把日历名当参数传进来
// 这条路径，所以不可能被上层代码（不管是不是写错了，也不管是手动触发还是自动同步
// 触发）改成操作别的日历。读取占用（direction 1）反过来排除这个日历，同样是
// 硬编码的排除条件。
// ---------------------------------------------------------------------------
const MANAGED_CALENDAR_NAME = '学习安排';

function getDataFilePath() {
  return path.join(app.getPath('userData'), DATA_FILE_NAME);
}

function readPersistedSettings() {
  try {
    const filePath = getDataFilePath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      return (data && data.settings) || {};
    }
  } catch (e) { /* ignore, fall back to defaults */ }
  return {};
}

function applyLoginItemSetting() {
  const settings = readPersistedSettings();
  const autoLaunch = settings.autoLaunch !== false; // 缺省当作 true（默认打开）
  try {
    app.setLoginItemSettings({ openAtLogin: autoLaunch, openAsHidden: true });
  } catch (e) { /* ignore on unsupported platforms */ }
}

function runAppleScript(scriptText) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `schedule-app-${Date.now()}-${Math.random().toString(36).slice(2)}.applescript`);
    fs.writeFileSync(tmpPath, scriptText, 'utf-8');
    execFile('osascript', [tmpPath], { timeout: 90000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore cleanup failure */ }
      if (err) {
        reject(new Error(stderr && stderr.trim() ? stderr.trim() : err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// 只读取，从不写入。排除条件“calName is not "学习安排""是字面量，硬编码在脚本文本里。
const READ_BUSY_SCRIPT = `
on padnum(n, w)
    set s to (n as string)
    repeat while (length of s) < w
        set s to "0" & s
    end repeat
    return s
end padnum

on isoStr(d)
    set y to (year of d) as integer
    set mo to ((month of d) as integer)
    set da to (day of d) as integer
    set hh to (hours of d)
    set mi to (minutes of d)
    set se to (seconds of d)
    return (my padnum(y, 4) & "-" & my padnum(mo, 2) & "-" & my padnum(da, 2) & "T" & my padnum(hh, 2) & ":" & my padnum(mi, 2) & ":" & my padnum(se, 2))
end isoStr

on replaceText(t, findStr, replStr)
    set prevTIDs to AppleScript's text item delimiters
    set AppleScript's text item delimiters to findStr
    set parts to text items of t
    set AppleScript's text item delimiters to replStr
    set outStr to parts as string
    set AppleScript's text item delimiters to prevTIDs
    return outStr
end replaceText

on sanitize(t)
    set t to my replaceText(t, tab, " ")
    set t to my replaceText(t, return, " ")
    set t to my replaceText(t, linefeed, " ")
    return t
end sanitize

set startD to current date
set hours of startD to 0
set minutes of startD to 0
set seconds of startD to 0
set endD to startD + (90 * days)

set outputLines to {}

tell application "Calendar"
    set allCals to every calendar
    repeat with c in allCals
        set calName to (name of c)
        if calName is not "学习安排" then
            try
                set theseEvents to (every event of c whose start date >= startD and start date < endD)
            on error
                set theseEvents to {}
            end try
            repeat with ev in theseEvents
                try
                    set isAllDay to (allday event of ev)
                on error
                    set isAllDay to false
                end try
                if isAllDay is false then
                    set evName to my sanitize(summary of ev)
                    set sIso to my isoStr(start date of ev)
                    set eIso to my isoStr(end date of ev)
                    set calNameSafe to my sanitize(calName)
                    set end of outputLines to (sIso & tab & eIso & tab & calNameSafe & tab & evName)
                end if
            end repeat
        end if
    end repeat
end tell

set prevTIDs to AppleScript's text item delimiters
set AppleScript's text item delimiters to linefeed
set outStr to outputLines as string
set AppleScript's text item delimiters to prevTIDs
return outStr
`;

function escapeAppleScriptString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// 清空 + 重写，目标日历名“学习安排”是字面量常量，不是从参数拼出来的。
function buildSyncAppleScript(events) {
  let body = `on makeDate(y, mo, d, hh, mi)
    set dt to current date
    set day of dt to 1
    set year of dt to y
    set month of dt to mo
    set day of dt to d
    set hours of dt to hh
    set minutes of dt to mi
    set seconds of dt to 0
    return dt
end makeDate

tell application "Calendar"
    if not (exists calendar "学习安排") then
        make new calendar with properties {name:"学习安排"}
    end if
    delete every event of calendar "学习安排"
end tell

tell application "Calendar"
    tell calendar "学习安排"
`;
  events.forEach((ev) => {
    const [y, mo, d] = String(ev.date).split('-').map(Number);
    const [sh, sm] = String(ev.start).split(':').map(Number);
    const [eh, em] = String(ev.end).split(':').map(Number);
    body += `        make new event with properties {summary:"${escapeAppleScriptString(ev.name)}", start date:my makeDate(${y}, ${mo}, ${d}, ${sh}, ${sm}), end date:my makeDate(${y}, ${mo}, ${d}, ${eh}, ${em})}\n`;
  });
  body += `    end tell
end tell
return "done"
`;
  return body;
}

ipcMain.handle('calendar:readBusy', async () => {
  try {
    const stdout = await runAppleScript(READ_BUSY_SCRIPT);
    const events = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        return { startIso: parts[0], endIso: parts[1], calendarName: parts[2] || '', name: parts[3] || '' };
      });
    return { ok: true, events, excludedCalendar: MANAGED_CALENDAR_NAME };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('calendar:sync', async (event, events) => {
  try {
    if (!Array.isArray(events)) throw new Error('参数不对');
    const script = buildSyncAppleScript(events);
    await runAppleScript(script);
    return { ok: true, count: events.length, calendar: MANAGED_CALENDAR_NAME };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.on('data:load', (event) => {
  const filePath = getDataFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      event.returnValue = { exists: true, data: JSON.parse(raw), path: filePath };
    } else {
      event.returnValue = { exists: false, data: null, path: filePath };
    }
  } catch (e) {
    event.returnValue = { exists: false, data: null, path: filePath, error: String(e) };
  }
});

ipcMain.on('data:save', (event, data) => {
  const filePath = getDataFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    event.returnValue = { ok: true, path: filePath };
  } catch (e) {
    event.returnValue = { ok: false, path: filePath, error: String(e) };
  }
});

ipcMain.on('data:getPath', (event) => {
  event.returnValue = getDataFilePath();
});

ipcMain.handle('app:setAutoLaunch', (event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ---------------------------------------------------------------------------
// 窗口 + 菜单栏图标：关闭窗口只是隐藏，不退出应用；只有菜单栏右键“退出”或者
// Command+Q（走 Electron 默认应用菜单里的 Quit）才会真正退出。
// ---------------------------------------------------------------------------
let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow(startHidden) {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    resizable: true,
    show: !startHidden,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow(false);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

function requestRendererSync() {
  if (mainWindow) {
    mainWindow.webContents.send('calendar:requestSync');
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMainWindow() },
    { label: '立即同步到日历', click: () => requestRendererSync() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setTitle('🗓');
  tray.setToolTip('时间安排');
  tray.on('click', () => toggleMainWindow());
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.whenReady().then(() => {
  applyLoginItemSetting();
  const loginSettings = app.getLoginItemSettings();
  createWindow(!!loginSettings.wasOpenedAtLogin);
  createTray();

  app.on('activate', () => {
    if (!mainWindow) {
      createWindow(false);
    } else {
      showMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
