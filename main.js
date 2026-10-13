const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const DATA_FILE_NAME = 'schedule-data.json';

// AI 功能用的配置（claude 命令行路径、模型名、日历智能筛选开关）单独存一个文件，
// 跟 schedule-data.json 彻底分开：导出数据文件 / 导入数据文件 / 清空数据
// 这几个操作都只碰 schedule-data.json。
const AI_CONFIG_FILE_NAME = 'ai-config.json';

// 调用一次 claude 命令行给的超时时间：结构化任务这种单轮对话一般不需要太久，
// 但命令行本身有启动开销，留足一点余量。
const AI_CLI_TIMEOUT_MS = 180000;

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

function getAiConfigPath() {
  return path.join(app.getPath('userData'), AI_CONFIG_FILE_NAME);
}

function readAiConfig() {
  try {
    const filePath = getAiConfigPath();
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) { /* ignore, fall back to empty config */ }
  return {};
}

function writeAiConfig(cfg) {
  const filePath = getAiConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), 'utf-8');
}

// 不接 API，改成在后台调用本机装的 Claude Code 命令行（`claude -p ...`）。
// 用的是用户自己 claude 账号登录状态下的额度（Pro/Max 订阅的话不另外计 token 费），
// 前提是这台电脑上已经装好 Claude Code 并且登录过（跑过一次 `claude login`）。
//
// 代价：每次调用要启动一个命令行进程，比直接调 API 慢；而且命令行没有 API 的
// tool use 那种"强制按 schema 返回"的机制，只能在 prompt 里明确要求"只输出 JSON，
// 不要别的"，解析失败的概率比 API 版本高一点，所以下面特意写了比较宽容的解析逻辑
// （剥代码块围栏、剥 CLI 外层 JSON 包装），解析不出来就老老实实报错，不会硬凑结果。

// macOS 图形界面启动的 App 经常拿不到用户 shell 里配置的完整 PATH（有名的
// "GUI app PATH 问题"），所以 'claude' 很可能在 PATH 里找不到。这里按顺序试几个
// 常见安装位置，用户也可以在设置里填一个确切路径覆盖掉。
function claudeCliCandidates(cfg) {
  const list = [];
  if (cfg.cliPath && cfg.cliPath.trim()) list.push(cfg.cliPath.trim());
  list.push('claude');
  list.push(path.join(os.homedir(), '.claude', 'local', 'claude'));
  list.push('/opt/homebrew/bin/claude');
  list.push('/usr/local/bin/claude');
  return list;
}

// 只探测哪个候选路径能跑通（`claude --version`），不真的发一轮对话，用于设置弹窗
// 里显示"有没有检测到命令行"，不浪费额度。
function resolveClaudeBinary(cfg) {
  return new Promise((resolve) => {
    const candidates = claudeCliCandidates(cfg);
    function tryNext(i) {
      if (i >= candidates.length) { resolve(null); return; }
      execFile(candidates[i], ['--version'], { timeout: 8000 }, (err) => {
        if (err) { tryNext(i + 1); return; }
        resolve(candidates[i]);
      });
    }
    tryNext(0);
  });
}

function runClaudeCli(promptText, cfg) {
  return new Promise((resolve, reject) => {
    const candidates = claudeCliCandidates(cfg);
    function tryNext(i) {
      if (i >= candidates.length) {
        reject(new Error('找不到 claude 命令行。确认电脑上装了 Claude Code 并且登录过（终端里跑一次 claude login），或者在设置里填一下 claude 可执行文件的完整路径'));
        return;
      }
      const args = ['-p', promptText, '--output-format', 'json'];
      if (cfg.model && cfg.model.trim()) {
        args.push('--model', cfg.model.trim());
      }
      execFile(candidates[i], args, { timeout: AI_CLI_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') { tryNext(i + 1); return; }
          reject(new Error('调用 claude 命令行失败：' + (stderr && stderr.trim() ? stderr.trim() : err.message)));
          return;
        }
        resolve(stdout);
      });
    }
    tryNext(0);
  });
}

// `claude -p --output-format json` 返回的是一层 CLI 自己的 JSON 包装（带 result/
// session_id/cost 这些字段），真正的模型回答在 .result 里；模型回答本身又应该是
// 我们要的那个 JSON，但模型偶尔会手滑包一层 ```json 代码块围栏，这里都剥掉。
function extractJsonPayload(cliStdout) {
  const raw = String(cliStdout || '').trim();
  let outer = null;
  try { outer = JSON.parse(raw); } catch (e) { /* CLI 这次没按 json 格式输出，当纯文本处理 */ }
  let inner = (outer && typeof outer.result === 'string') ? outer.result : raw;
  inner = inner.trim();
  const fenceMatch = inner.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) inner = fenceMatch[1].trim();
  try {
    return JSON.parse(inner);
  } catch (e) {
    throw new Error('AI 没有返回合法的 JSON，换个说法再试一次。原始内容：' + inner.slice(0, 300));
  }
}

// 统一的调用封装：拼好完整 prompt（系统指示 + 输出格式要求 + 用户内容）交给
// claude 命令行，拿到结构化结果。调用方传进来的 schemaHint 是一段纯文本描述，
// 不是真的 JSON schema 对象——命令行没法强制模型遵守 schema，只能靠把要求写
// 清楚在 prompt 里尽量提高命中率。
async function callClaudeCli({ systemPrompt, userText, schemaHint }) {
  const cfg = readAiConfig();
  const promptText =
    systemPrompt + '\n\n' +
    '只能输出一个 JSON 对象，不要任何其他文字、不要开场白、不要代码块围栏、不要解释，' +
    '格式必须严格是：' + schemaHint + '\n\n' +
    '这是要处理的内容：\n' + userText;
  const stdout = await runClaudeCli(promptText, cfg);
  return extractJsonPayload(stdout);
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
// AI 功能：自然语言录入任务 / 日历占用智能筛选 / 排不下时的调整建议。
// 三个都是"模型给建议、人点确认才生效"，没有一条会跳过渲染进程里的用户确认
// 直接写数据——这些 IPC handler 只负责调用模型拿结构化结果，不碰 schedule-data.json。
// ---------------------------------------------------------------------------

ipcMain.handle('ai:getStatus', async () => {
  const cfg = readAiConfig();
  const resolvedBin = await resolveClaudeBinary(cfg);
  return {
    hasCli: !!resolvedBin,
    resolvedBin: resolvedBin || '',
    cliPath: cfg.cliPath || '',
    model: cfg.model || '',
    calendarAiFilter: !!cfg.calendarAiFilter,
  };
});

ipcMain.handle('ai:saveConfig', (event, patch) => {
  try {
    const cfg = readAiConfig();
    if (patch && typeof patch.cliPath === 'string') {
      cfg.cliPath = patch.cliPath.trim();
    }
    if (patch && typeof patch.model === 'string') {
      cfg.model = patch.model.trim();
    }
    if (patch && typeof patch.calendarAiFilter === 'boolean') {
      cfg.calendarAiFilter = patch.calendarAiFilter;
    }
    writeAiConfig(cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('ai:parseTasksText', async (event, payload) => {
  try {
    const text = (payload && payload.text) || '';
    const todayIso = (payload && payload.todayIso) || '';
    const input = await callClaudeCli({
      systemPrompt:
        '你是时间管理助手，帮用户把一段自然语言描述拆解成结构化的任务列表。今天的日期是 ' + todayIso + '。' +
        '用户可能用相对日期（比如"下周三"、"这周末"、"月底"），你需要据此算出具体的 YYYY-MM-DD 日期。' +
        '如果用户没说预计用时，给一个合理的估计，并在 note 字段里说明这是你估的，不是用户说的。' +
        '如果没说优先级，priority 填 2（中）。如果提到了"不早于""先别开始"之类的最早开始日期，' +
        '填 earliestStart，没提到就填空字符串。一句话里可能包含多个任务，要全部拆出来，不要漏。',
      userText: text,
      schemaHint: '{"tasks":[{"name":"string","deadline":"YYYY-MM-DD","hours":number,"priority":1或2或3（3=高 2=中 1=低）,"earliestStart":"YYYY-MM-DD 或空字符串","note":"string，可选，说明哪些字段是你猜的"}]}',
    });
    return { ok: true, tasks: Array.isArray(input.tasks) ? input.tasks : [] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('ai:classifyBusyEvents', async (event, events) => {
  try {
    if (!Array.isArray(events) || events.length === 0) return { ok: true, decisions: [] };
    const listText = events
      .map((e, i) => i + '. [' + (e.calendarName || '') + '] ' + (e.name || '(无标题)') + '  ' + e.startIso + ' ~ ' + e.endIso)
      .join('\n');
    const input = await callClaudeCli({
      systemPrompt:
        '这些是从用户苹果日历读出来的事件，会被当成"占用时间"挡掉当天可以排任务的空档。' +
        '请判断每一条是不是真的代表一段会占用用户时间、没法同时做别的事的安排（比如上课、开会、面试、看牙医、' +
        '集中写论文的时间块）。如果看起来不是（比如名字就是"提醒"之类的备忘、模糊的个人笔记、' +
        '不代表真实时间占用的标记），就判 keep:false，并在 reason 里说明。拿不准的时候默认 keep:true，' +
        '不要轻易判定忽略——漏掉一个真实占用，比多保留一个可疑的，对用户的影响更大。',
      userText: listText,
      schemaHint: '{"decisions":[{"index":number（对应输入列表里的序号，从 0 开始）,"keep":boolean,"reason":"string"}]}',
    });
    return { ok: true, decisions: Array.isArray(input.decisions) ? input.decisions : [] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('ai:suggestReschedule', async (event, context) => {
  try {
    const input = await callClaudeCli({
      systemPrompt:
        '用户的任务排程排不下了，你需要给出具体、可以直接在程序里应用的调整建议，帮助缓解冲突。' +
        '每条建议必须明确指出改哪个任务（taskName 要和输入里的任务名完全一致）的哪个字段' +
        '（deadline / hours / priority / earliestStart）改成什么值，或者是把 capacityHours' +
        '（每日可用时间上限，这种情况 taskName 填"（全局设置）"）改成多少，并在 reasoning 里说明理由。' +
        '不要给"建议你跟老师申请延期"这种没法在程序里直接应用的空泛建议，除非确实没有别的办法，' +
        '那也要把 field 填成"无法自动应用"。最多给 5 条，按优先级从高到低排。',
      userText: JSON.stringify(context || {}, null, 2),
      schemaHint: '{"suggestions":[{"taskName":"string","field":"deadline 或 hours 或 priority 或 earliestStart 或 capacityHours 或 无法自动应用","currentValue":"string","suggestedValue":"string","reasoning":"string"}]}',
    });
    return { ok: true, suggestions: Array.isArray(input.suggestions) ? input.suggestions : [] };
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
