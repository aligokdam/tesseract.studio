## <img src="assets/icon-light.svg" alt="Tesseract Studio logo" width="44" height="44" align="center"> Tesseract Studio

Open any 3D model and place it in your room with augmented reality, directly in your browser.

Tesseract Studio is an open-source AR viewer. Open a model, check it in the 3D preview, then place it in your space. It starts small. Pinch with two fingers to make it bigger and walk around it. It works on computers, phones and tablets.

All processing happens locally in your browser. Your models are never uploaded or stored, and there is no file size limit.

🌐 **Live Demo Link :** https://aligokdam.github.io/tesseract.studio/

---

## Features

- 🧊 Real AR: WebXR on Android and Meta Quest, AR Quick Look on iPhone and iPad
- 📷 Live camera view on computers and every other device with a camera
- 🤏 Starts small, pinch to resize from 5% to 6000%, drag to turn
- 🚶 Anchored to real surfaces so you can walk around the model
- 📐 Adjustable start size (5 cm to 1 m)
- 🗂️ GLB, GLTF, OBJ+MTL, STL, FBX, 3MF, USDZ, USD, PLY, DAE, 3DS, AMF, VRML, LWO, KMZ, VTK, VOX, PCD, XYZ and G-code
- 📦 Draco, Meshopt and KTX2 compressed glTF files
- 🧩 Textures and companion files by multi-select, folder drop or ZIP
- ♾️ No file size limit, 400 MB and beyond if the device has the memory
- 🔄 Y-up / Z-up switch for CAD and 3D printing files
- 🎬 Plays the first animation of animated models
- 📂 Drag & Drop model upload
- 🌍 Multilingual interface (24 languages), including right-to-left languages
- 🌓 Light and dark themes
- 🔒 Fully client-side processing

---

## How It Works

1. Open a 3D model (add its textures, a folder or a ZIP if it has them).
2. Check it in the preview and switch the up axis if it lies on its side.
3. Choose a start size and press View in AR.
4. Tap a surface to place it, pinch to resize and walk around it.

---

## Blender

Browsers cannot read `.blend` files directly. In Blender choose **File › Export › glTF 2.0 (.glb)** (recommended), or FBX, OBJ, STL, PLY or USD, then open that file in Tesseract Studio.

---

## Project Structure

```text
tesseract.studio/
├── index.html
├── README.md
├── LICENSE
└── assets/
    ├── icon.svg
    ├── apple-touch-icon.png
    ├── css/
    ├── i18n/
    ├── js/
    └── vendor/
        ├── three/
        ├── draco/
        └── basis/
```

---

## License

MIT License

---

Created by **Ali Gökdam**
