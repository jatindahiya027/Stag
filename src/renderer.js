const fs = require("fs");
const path = require("path");
const electron = require("electron");
const { topColoursHex } = require("@colour-extractor/colour-extractor");
const ipcRenderer = electron.ipcRenderer;
const url = require("url");
const sizeOf = require("image-size");



let activePopup = null;
let selectedpos = -1;
let selectedCard = null;
const folpath = fs.readFileSync(path.join(__dirname, "location.json"), "utf8");
const pathjsonn = JSON.parse(folpath);
function metadata(selectedpos, divs) {
  divs[selectedpos].classList.add("selected");
  selectedCard = divs[selectedpos];
  selectedCard.style.border = "2px solid #4d4f54";
  selectedCard.style.borderRadius = "10px";
  const patha = fs.readFileSync(path.join(pathjsonn[0].path, "path.json"), "utf8");
  const pathjson = JSON.parse(patha);
  // console.log(pathjson);
  const metadata = fs.readFileSync(pathjson[selectedpos].jsonpath, "utf8");
  const metadatajson = JSON.parse(metadata);
  // console.log(metadatajson);
  color(pathjson[selectedpos].imagepath);
  thumbnail = document.getElementById("thumbnail");
  thumbnail.src = pathjson[selectedpos].imagepath;
  imagename = document.getElementById("imgname");
  imagename.innerHTML = metadatajson.Name;
  imagepath = document.getElementById("imgpath");
  imagepath.innerHTML = metadatajson["File Location"];
  const meta = document.getElementById("metada");
  while (meta.firstChild) {
    meta.removeChild(meta.firstChild);
  }
  const p2 = document.createElement("p");
  p2.textContent =
    "Dimensions: " +
    metadatajson.Dimensions.width +
    "*" +
    metadatajson.Dimensions.height;
  const p3 = document.createElement("p");
  p3.textContent = "Type: " + metadatajson.Dimensions.type;
  const p4 = document.createElement("p");
  p4.textContent = "Size: " + metadatajson["File Size"];
  const p5 = document.createElement("p");
  p5.textContent = "Date Created: " + metadatajson["Date Created"];
  const p1 = document.createElement("p");
  p1.textContent = "Date Modified: " + metadatajson["Date Modified"];
  meta.appendChild(p2);
  meta.appendChild(p3);
  meta.appendChild(p4);
  meta.appendChild(p5);
  meta.appendChild(p1);
}
function adjustImage(image) {
  if ((image.width > image.height) & (image.width / image.height > 1.7)) {
    // console.log("found a image");
    image.style.width = "200px";
    image.style.height = "auto";
  }
}

function openImage(card) {
  if (activePopup) {
    document.body.removeChild(activePopup);
    activePopup = null;
  }


  const imgSrc = card;
  const dimensions = sizeOf(card);

        let height="95vh";
        let width="60vw";
        let imgWidth = dimensions.width;
        let imgHeight = dimensions.height;
        if (imgHeight > imgWidth || imgWidth / imgHeight < 1.7) {
          width = "60vh"
          height="95vh";
        } 
        
        else {
          // imgWidth = 150;
          width = "70vw";
        }
         if (imgHeight == imgWidth ){
          // imgWidth = 100;
          width = "70vh";
          height = "70vh";
        }
        console.log(width," ",height)
  const popupContainer = document.createElement("div");
  popupContainer.classList.add("popup-container");
  popupContainer.style.width = width;
  popupContainer.style.height = height;
  popupContainer.style.display = "flex";
  popupContainer.style.position = "fixed";
  popupContainer.style.top = "50%";
  popupContainer.style.left = "50%";
  popupContainer.style.transform = "translate(-50%, -50%)";
  popupContainer.style.backgroundColor = "rgba(36, 36, 44,0.95)";
  popupContainer.style.alignItems = "center";
  popupContainer.style.justifyContent = "center";
  popupContainer.style.borderRadius="10px";
  const img = document.createElement("img");
  img.src = imgSrc;
  img.alt = "Popup Image";
  img.style.maxWidth = "100%";
  img.style.maxHeight = "100%";
  img.style.borderRadius="10px";
  const closeButton = document.createElement("span");
  closeButton.innerHTML = "&times;";
  closeButton.style.position = "absolute";
  closeButton.style.top = "10px";
  closeButton.style.right = "10px";
  closeButton.style.cursor = "pointer";
  closeButton.style.fontSize = "24px"; // Increase font size
  closeButton.style.color = "#fff"; // Set text color to white
  closeButton.style.backgroundColor = "rgba(0, 0, 0, 0.3)"; // Add background color
  closeButton.style.padding = "10px 15px"; // Add padding
  closeButton.style.borderRadius="10px";

  popupContainer.appendChild(img);
  popupContainer.appendChild(closeButton);
  document.body.appendChild(popupContainer);

  closeButton.addEventListener("click", () => {
    document.body.removeChild(popupContainer);
    activePopup = null;
  });
  activePopup = popupContainer;
}

async function color(path) {
  const colours = await topColoursHex(path);
  const color = document.getElementById("colors");
  while (color.firstChild) {
    color.removeChild(color.firstChild);
  }
  // console.log(colours)
  const c1 = document.createElement("div");
  c1.textContent = "1";
  c1.style.borderRadius = "5px 0px 0px 5px";
  c1.style.background = colours[0];
  const c2 = document.createElement("div");
  c2.textContent = "2";
  c2.style.background = colours[1];
  const c3 = document.createElement("div");
  c3.textContent = "3";
  c3.style.background = colours[2];
  const c4 = document.createElement("div");
  c4.textContent = "4";
  c4.style.background = colours[3];
  const c5 = document.createElement("div");
  c5.textContent = "5";
  c5.style.background = colours[4];
  const c6 = document.createElement("div");
  c6.textContent = "6";
  c6.style.background = colours[5];
  c6.style.borderRadius = "0px 5px 5px 0px";
  color.appendChild(c1);
  color.appendChild(c2);
  color.appendChild(c3);
  color.appendChild(c4);
  color.appendChild(c5);
  color.appendChild(c6);
}

function renderer() {
  const rightDiv = document.getElementById("right");

  let scrollPosition = 0;
  let currentpos = 0;
  // Read the JSON data from path.json
  fs.readFile(path.join(pathjsonn[0].path, "path.json"), "utf8", (err, data) => {
    if (err) {
      console.error("Error reading JSON file:", err);
      return;
    }

    try {
      // Clear existing content
      while (rightDiv.firstChild) {
        rightDiv.removeChild(rightDiv.firstChild);
      }
      const jsonData = JSON.parse(data);
      jsonData.forEach((item) => {
        const cardDiv = document.createElement("div");
        cardDiv.classList.add("card");
        const pos = currentpos++;
        const img = document.createElement("img");
        img.classList.add("card-image");
        img.src = item.thumbpath;
        img.alt = "Card Image";
        // img.loading = "lazy"; // Set loading attribute to "lazy"
        img.onload = function () {
          adjustImage(this); // 'this' refers to the img element here
        };

        const cardText = document.createElement("div");
        const data = fs.readFileSync(item.jsonpath, "utf8");
        const imageData = JSON.parse(data);
        cardText.classList.add("card-text");
        let imgWidth = parseInt(imageData.Width);
        let imgHeight = parseInt(imageData.Height);
        if (imgHeight > imgWidth || imgWidth / imgHeight < 1.7) {
          const newWidth = (imgWidth / imgHeight) * 150;
          imgWidth = newWidth;
          imgHeight = 150; // Fix the height at 150
        } 
        
        else {
          imgWidth = 150;
        }
         if (imgHeight > imgWidth &&  imgHeight/imgWidth  > 3){
          imgWidth = 100;
        }
        cardText.style.width = imgWidth + "px";
        const paragraph = document.createElement("p");
        paragraph.textContent = imageData.Name;
        const div = document.createElement("div");
        div.textContent = imageData.Width + "*" + imageData.Height;
        cardText.appendChild(paragraph);
        cardText.appendChild(div);
        cardDiv.appendChild(img);
        cardDiv.appendChild(cardText);
        rightDiv.appendChild(cardDiv);
        img.addEventListener("dragstart", (event) => {
          event.preventDefault(); // Prevent default behavior
          const imagePath = item.imagepath; // Replace with the actual image path

          window.electron.startDrag(imagePath);
        });

        cardDiv.addEventListener("click", () => {
          color(item.thumbpath);
          if (selectedCard) {
            selectedCard.classList.remove("selected");
            selectedCard.style.border = "";
            selectedCard.style.borderRadius = "";
          }
          selectedpos = pos;
          console.log(selectedpos);
          cardDiv.classList.add("selected");
          cardDiv.style.border = "2px solid #4d4f54";
          cardDiv.style.borderRadius = "10px";
          selectedCard = cardDiv;
          thumbnail = document.getElementById("thumbnail");
          thumbnail.src = item.thumbpath;
          imagename = document.getElementById("imgname");
          imagename.innerHTML = imageData.Name;
          imagepath = document.getElementById("imgpath");
          imagepath.innerHTML = imageData["File Location"];
          const meta = document.getElementById("metada");
          while (meta.firstChild) {
            meta.removeChild(meta.firstChild);
          }
          const p2 = document.createElement("p");
          p2.textContent =
            "Dimensions: " +
            imageData.Dimensions.width +
            "*" +
            imageData.Dimensions.height;
          const p3 = document.createElement("p");
          p3.textContent = "Type: " + imageData.Dimensions.type;
          const p4 = document.createElement("p");
          p4.textContent = "Size: " + imageData["File Size"];
          const p5 = document.createElement("p");
          p5.textContent = "Date Created: " + imageData["Date Created"];
          const p1 = document.createElement("p");
          p1.textContent = "Date Modified: " + imageData["Date Modified"];
          meta.appendChild(p2);
          meta.appendChild(p3);
          meta.appendChild(p4);
          meta.appendChild(p5);
          meta.appendChild(p1);
        });
        cardDiv.addEventListener("dblclick", () => openImage(item.imagepath));
        
      });
    } catch (parseError) {
      console.error("Error parsing JSON:", parseError);
    }
  });

  // Add a keyboard event listener
  document.addEventListener("keydown", (event) => {
    // event.preventDefault();
    if (event.key === "Delete" && selectedCard) {
      selectedpos = -1;
      const selectedImg = selectedCard.querySelector(".card-image");
      const imagePath = selectedImg.src;
      const imageFolderPath = path.dirname(imagePath);
      const filePath = decodeURIComponent(url.fileURLToPath(imageFolderPath));
      scrollPosition = rightDiv.scrollTop;
      console.log(`Scroll position: ${scrollPosition}px`);
      ipcRenderer.send("delete-folder", filePath);
      rightDiv.scrollTop = scrollPosition;
      selectedCard = null;
      thumbnail = document.getElementById("thumbnail");
      thumbnail.src = "./test.png";
      color(path.join(__dirname, "test.png"));
      imagename = document.getElementById("imgname");
      imagename.innerHTML = "Name....";
      imagepath = document.getElementById("imgpath");
      imagepath.innerHTML = "Path....";
      const meta = document.getElementById("metada");
      while (meta.firstChild) {
        meta.removeChild(meta.firstChild);
      }
      const p2 = document.createElement("p");
      p2.textContent = "Dimensions: ";
      const p3 = document.createElement("p");
      p3.textContent = "Type: ";
      const p4 = document.createElement("p");
      p4.textContent = "Size: ";
      const p5 = document.createElement("p");
      p5.textContent = "Date Created: ";
      const p1 = document.createElement("p");
      p1.textContent = "Date Modified: ";
      meta.appendChild(p2);
      meta.appendChild(p3);
      meta.appendChild(p4);
      meta.appendChild(p5);
      meta.appendChild(p1);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && selectedCard) {
      const data = fs.readFileSync(path.join(pathjsonn[0].path, "path.json"), "utf8");
        const item = JSON.parse(data);
      openImage(item[selectedpos].imagepath);
    }
  });
}

document.addEventListener("keydown", (event) => {

  if (event.key === "ArrowRight") {
    // console.log(selectedpos);
    const divs = document.querySelectorAll(".card");
    if (selectedpos != -1 && divs[selectedpos]) {
      divs[selectedpos].classList.remove("selected");
      divs[selectedpos].style.border = "";
      divs[selectedpos].style.borderRadius = "";
    }
    selectedpos = selectedpos + 1;
    if (selectedpos === divs.length) {
      selectedpos = 0;
    }

    metadata(selectedpos, divs);
  }
  if (event.key === "ArrowLeft") {
    // console.log(selectedpos);
    const divs = document.querySelectorAll(".card");
    // console.log(divs.length);
    if (selectedpos != -1 && divs[selectedpos]) {
      divs[selectedpos].classList.remove("selected");
      divs[selectedpos].style.border = "";
      divs[selectedpos].style.borderRadius = "";
    }
    selectedpos = selectedpos - 1;
    if (selectedpos < 0) {
      selectedpos = divs.length - 1;
    }
    // divs[selectedpos].classList.add("selected");
    // selectedCard = divs[selectedpos];
    // selectedCard.style.border = "2px solid #4d4f54";
    // selectedCard.style.borderRadius = "10px";
    metadata(selectedpos, divs);
  }
});

module.exports = {
  rendererr: renderer,
};