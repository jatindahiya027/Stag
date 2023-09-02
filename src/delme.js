// import pkg from "./script/move";
const { moveImages } = require("./script/move");
const { processImagesInFolder } = require("./script/metadatacheck");
const { generatePathJson } = require("./script/pathjson");
const fs = require("fs");
const path = require("path");

let pythonScriptRunning = false; // Flag to track whether the Python script is running
const folpath = fs.readFileSync(path.join(__dirname, "location.json"), "utf8");
const pathjson = JSON.parse(folpath);

function checkFolderEmpty() {
  if (pythonScriptRunning) {
    // If the Python script is still running, skip this iteration
    return;
  }

  fs.readdir(pathjson[0].from, (err, files) => {
    if (err) {
      console.error("Error reading folder:", err);
      return;
    }

    if (files.length === 0) {
      //   console.log("No files Found");
    } else {
      console.log(`Folder contains ${files.length} file(s)`);
      try {
        pythonScriptRunning = true; // Set the flag to indicate Python script is running

        moveImages(pathjson[0].from, pathjson[0].to);
        processImagesInFolder(pathjson[0].to);
       

        generatePathJson(pathjson[0].to, pathjson[0].path);
        setTimeout(function() {
          // console.log("Delayed execution after 2000 milliseconds");
          rendererr();
        }, 2000);
       
        

        pythonScriptRunning = false; // Reset the flag since the script is finished
      } catch (err) {
        console.error("Error:", err);
        pythonScriptRunning = false; // Reset the flag in case of an exception
      }
    }
  });
}

// Call the function initially
checkFolderEmpty();
rendererr();
// Set up interval to check every 2 seconds
const interval = setInterval(checkFolderEmpty, 2000);

const dropTarget = document.getElementById('right');

    // Prevent the default behavior for the dragover event
    dropTarget.addEventListener('dragover', (event) => {
      event.preventDefault();
    });

    // Add drop event listener to the drop target
    dropTarget.addEventListener('drop', (event) => {
      event.preventDefault();

      const files = event.dataTransfer.files;
      const filePaths = Array.from(files).map((file) => file.path);
      // console.log(filePaths);
      for(file in filePaths){
        // console.log(filePaths[file].replace(/\\/g, "/"));
        const fileName =pathjson[0].to+ "/"+ path.basename(filePaths[file].replace(/\\/g, "/"));
        console.log(fileName);
        try{
          fs.renameSync(filePaths[file].replace(/\\/g, "/"), fileName);
          processImagesInFolder(pathjson[0].to);
       

          generatePathJson(pathjson[0].to, pathjson[0].path);
          setTimeout(function() {
            // console.log("Delayed execution after 2000 milliseconds");
            rendererr();
          }, 2000);
        }
        catch (error) {
          console.error(
            `An error occurred while moving '${filePaths[file]}': ${error.message}`
          );
      }
 
    }

 
  });