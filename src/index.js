const { app, BrowserWindow, ipcMain, Tray, Menu } = require("electron");
// const { setupTitlebar, attachTitlebarToWindow } = require("custom-electron-titlebar/main");
const fs = require("fs-extra"); // We use fs-extra for extra filesystem functionality
const path = require("path");
const { execSync } = require("child_process");
const { moveImages } = require("./script/move");
const { processImagesInFolder } = require("./script/metadatacheck");
const { generatePathJson } = require("./script/pathjson");

if (require("electron-squirrel-startup")) {
  app.quit();
}

const folpath = fs.readFileSync(path.join(__dirname, "location.json"), "utf8");
const pathjson = JSON.parse(folpath);

let tray;
let mainWindow;
function datagrab(){
  moveImages(pathjson[0].from, pathjson[0].to);
  processImagesInFolder(pathjson[0].to);
  generatePathJson(pathjson[0].to, pathjson[0].path);
  mainWindow.webContents.send(
    "datareload",
    "Reloading all the images"
  );
}
// setupTitlebar();
const createWindow = () => {
  

  mainWindow = new BrowserWindow({
    width: 1366,
    height: 700,
    show: false,
    // frame: false,
    icon: path.join(__dirname, "icon/stag.ico"),
    // backgroundColor: '#353639',
    // titleBarStyle: 'hidden',
  // titleBarOverlay: {
  //   color: '#353639',
  //   symbolColor: '#89898b',
  //   height: 10
  // },

    webPreferences: {
      // sandbox: false,
      nodeIntegration: true,
      contextIsolation: false, // protect against prototype pollution
      enableRemoteModule: true, // turn off remote
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // console.log(path.join(__dirname, "icon/icon.ico"));
  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  // attachTitlebarToWindow(mainWindow);
  tray = new Tray(path.join(__dirname, "icon/stag.ico"));
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open",
      click: () => {
        datagrab();
        mainWindow.maximize(); 
        mainWindow.show();
      },
    },
    {
      label: "Exit",
      click: () => {
        app.quit();
      },
    },
  ]);
  
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    datagrab()
    mainWindow.maximize(); 
    mainWindow.show();
  });
  // Minimize to system tray instead of quitting when the close button is clicked
  mainWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  // Set a flag to prevent quitting the app on close
  datagrab();
  app.isQuiting = false;
  Menu.setApplicationMenu(null);
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

ipcMain.on("delete-folder", (event, folderPath) => {
  try {
    // Delete the folder and its contents
    execSync(`trash "${folderPath}"`);
    console.log(`File "${folderPath}" moved to recycle bin.`);
    // fs.removeSync(folderPath);
    generatePathJson(pathjson[0].to, pathjson[0].path);
    mainWindow.webContents.send(
      "ReloadPage",
      "Folder Deleated Starting Reloading process"
    );
    console.log("Folder deleted:", folderPath);
  } catch (error) {
    console.error("Error deleting folder:", error);
  }
});

app.on("before-quit", () => {
  app.isQuiting = true;
});
const iconName = path.join(__dirname, "iconForDragAndDrop.png");
ipcMain.on("ondragstart", (event, filePath) => {
  event.sender.startDrag({
    file: filePath,
    icon: iconName,
  });
});
