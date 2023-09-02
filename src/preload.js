const { ipcRenderer } = require('electron');
// const { Titlebar } = require('custom-electron-titlebar');
//  const options = {
//     backgroundColor: "#303134",
//     icon: path.join(__dirname, "icon/stag.ico")
//   };
window.electron = {
  startDrag: (fileName) => {
    console.log('filename is: ', fileName);
    ipcRenderer.send('ondragstart', fileName);
  },
};


// window.addEventListener('DOMContentLoaded', () => {
 
//   // const tit =new Titlebar(options)

//   // Title bar implementation
//   const tit = new Titlebar({
//     backgroundColor: "#303134", // Set your desired background color
//     icon: path.join(__dirname, "icon/stag.ico"), // Set your window icon
//   });
// });

