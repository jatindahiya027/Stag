const fs = require("fs");
const path = require("path");

function moveImages(sourceDirectory, destinationDirectory) {
  try {
    // List all files in the source directory
    const filesToMove = fs.readdirSync(sourceDirectory);

    // List of common image file extensions
    const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff",".webp"];

    for (const fileName of filesToMove) {
      // Check if the file has a valid image extension
      if (imageExtensions.some((ext) => fileName.toLowerCase().endsWith(ext))) {
        const sourcePath = path.join(sourceDirectory, fileName);
        const destinationPath = path.join(destinationDirectory, fileName);

        try {
          fs.renameSync(sourcePath, destinationPath);
          // console.log(`Moved '${fileName}' to '${destinationDirectory}'`);
        } catch (error) {
          console.error(
            `An error occurred while moving '${fileName}': ${error.message}`
          );
        }
      }
    }
    console.log("Done Moving Images");
  } catch (error) {
    console.error(`An error occurred: ${error.message}`);
  }
  return "done fuck";
}

module.exports = {
  moveImages: moveImages,
};
