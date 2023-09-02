const fs = require("fs");
const path = require("path");



function getImageFolder(imagePath) {
  const folderPath = path.dirname(imagePath);
  return folderPath;
}
function findImages(
  directory,
  extensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff",".webp"]
) {
  const imagePaths = [];

  function walkDir(currentDir) {
    const files = fs.readdirSync(currentDir);

    for (const file of files) {
      const filePath = path.join(currentDir, file);
      const stats = fs.statSync(filePath);

      if (stats.isDirectory()) {
        walkDir(filePath);
      } else {
        const ext = path.extname(file).toLowerCase();
        const fileName = path.basename(file);
        if (extensions.includes(ext)&& !fileName.includes("__thumb")) {
          imagePaths.push(
            path.resolve(__dirname, filePath).replace(/\\/g, "/")
          );
        }
      }
    }
  }

  walkDir(directory);
  return imagePaths;
}

function savePathsToJson(imagePaths, jsonPaths, jsonFilename = "path.json") {
  const data = imagePaths.map((imgPath, index) => ({
    imagepath: imgPath,
    thumbpath: getImageFolder(imgPath)+"/__thumb.jpg",
    jsonpath: jsonPaths[index],
  }));

  fs.writeFileSync(jsonFilename, JSON.stringify(data, null, 4));
}

function getModificationTime(path) {
  const stats = fs.statSync(path);
  // return stats.mtimeMs;
  return stats.birthtime;
}

function generatePathJson(startingDirectory, desiredLocation) {
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff",".webp"];

  const imagePaths = findImages(startingDirectory, imageExtensions);
  imagePaths.sort((a, b) => getModificationTime(b) - getModificationTime(a));

  const jsonPaths = imagePaths.map((imagePath) =>
    path
      .resolve(__dirname, path.join(path.dirname(imagePath), "data.json"))
      .replace(/\\/g, "/")
  );

  const jsonFilename = path.join(desiredLocation, "path.json");
  savePathsToJson(imagePaths, jsonPaths, jsonFilename);

  console.log("Done Saving path.json");
}

module.exports = {
  generatePathJson: generatePathJson,
};
