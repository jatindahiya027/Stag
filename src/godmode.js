const { rendererr } = require("./renderer");
const { ipcRenderer } = require("electron");
rendererr();

// Receive a message from the main process
ipcRenderer.on("ReloadPage", (event, message) => {
  console.log("Message from main:", message);
  rendererr();
});

ipcRenderer.on("datareload", (event, message) => {
  console.log("Message from main:", message);
  rendererr();
});


