const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dataFile', {
  load: () => ipcRenderer.sendSync('data:load'),
  save: (data) => ipcRenderer.sendSync('data:save', data),
  getPath: () => ipcRenderer.sendSync('data:getPath'),
});

contextBridge.exposeInMainWorld('calendarBridge', {
  readBusy: () => ipcRenderer.invoke('calendar:readBusy'),
  syncToCalendar: (events) => ipcRenderer.invoke('calendar:sync', events),
  onRequestSync: (cb) => ipcRenderer.on('calendar:requestSync', () => cb()),
});

contextBridge.exposeInMainWorld('appBridge', {
  setAutoLaunch: (enabled) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
});
