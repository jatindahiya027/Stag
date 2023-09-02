const fs = require("fs");
const path = require("path");
const sizeOf = require("image-size");
const { spawn } = require('child_process');

const maxWidth = 256;
const maxHeight=256;

function resize(ImagePath,outpath){

  const resizeDimensions = '256x256';
  
  const gm = spawn('gm', ['convert', ImagePath, '-resize', resizeDimensions, '>', outpath]);

  
  }
function getImageMetadata(imagePath) {
  try {
    const stats = fs.statSync(imagePath);
    const dimensions = getImageDimensions(imagePath);

    const metadata = {
      Dimensions: dimensions,
      Width: dimensions.width,
      Height: dimensions.height,
      // 'Bit Depth': getImageBitDepth(imagePath),
      "File Location": path.resolve(__dirname, imagePath).replace(/\\/g, "/"), // Replace backslashes with forward slashes
      "Date Created": stats.birthtime.toUTCString(),
      "Date Modified": stats.mtime.toUTCString(),
      Name: path.basename(imagePath),
      "Item Type": path.extname(imagePath),
      "File Size": `${(stats.size / (1024 * 1024)).toFixed(4)} MB`,
    };
    return metadata;
  } catch (error) {
    console.error(`Error processing ${imagePath}: ${error}`);
    return null;
  }
}
function getImageDimensions(imagePath) {
  try {
    const dimensions = sizeOf(imagePath);
    return dimensions;
  } catch (error) {
    console.error(`Error getting dimensions for ${imagePath}: ${error}`);
    return { width: 0, height: 0 };
  }
}

// Rest of the code remains the same...

function processImagesInFolder(folderPath) {
  
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff",".webp"];
  const imageFiles = fs
    .readdirSync(folderPath)
    .filter((file) =>
      imageExtensions.some((ext) => file.toLowerCase().endsWith(ext))
    );

  for (const imageFile of imageFiles) {
    const imagePath = path.join(folderPath, imageFile);
    const folderName = generateUniqueFolderName(folderPath);
    const folderPathNew = path.join(folderPath, folderName);
    
    fs.mkdirSync(folderPathNew, { recursive: true });

    const newImagePath = path.join(folderPathNew, imageFile);
    fs.renameSync(imagePath, newImagePath);
    console.log("here");
    resize(newImagePath,folderPathNew+"/__thumb.jpg")
    console.log("theere");
    const metadata = getImageMetadata(newImagePath);
    if (metadata) {
      const metadataPath = path.join(folderPathNew, "data.json");
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 4));
    }
   
  }
  console.log("Done Arranging Images and Metadata");
}

function generateUniqueFolderName(folderPath) {
  while (true) {
    const folderName = Array.from(
      { length: 13 },
      () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]
    ).join("");
    if (!fs.existsSync(path.join(folderPath, folderName))) {
      
      return folderName;
    }
  }
}

module.exports = {
  processImagesInFolder: processImagesInFolder,
};
