/* =====================================================================
   Tesseract Studio: model loading
   ---------------------------------------------------------------------
   Turns whatever the user picked or dropped (one file, several files,
   a folder or a ZIP) into one three.js object. There is no size limit:
   files are read straight from disk into memory, so the only ceiling is
   the memory of the device.

   Companion files (textures, .bin buffers, .mtl materials) are matched
   by file name, wherever the model expects them to be.
   ===================================================================== */
(function () {
  "use strict";

  var T = window.TS3;
  if (!T) return;
  var THREE = T.THREE;

  /* Order matters: when several model files arrive together, the first
     match in this list is the one that is opened. */
  var MAIN = ["glb", "gltf", "fbx", "obj", "dae", "usdz", "usd", "usdc", "usda", "3mf", "3ds", "stl", "ply",
    "amf", "wrl", "vrml", "lwo", "kmz", "vtk", "vtp", "vox", "pcd", "xyz", "gcode", "gco", "nc"];
  var BLEND = ["blend", "blend1"];
  var UNSUPPORTED = ["max", "c4d", "ma", "mb", "skp", "abc", "x3d", "x3db", "step", "stp", "iges", "igs", "dwg", "dxf", "3dm", "sldprt", "f3d", "ifc", "spp", "ztl", "zpr"];
  /* Formats that are usually modelled Z-up (3D printing, CAD, scans). */
  var Z_UP = { stl: 1, "3mf": 1, amf: 1, gcode: 1, gco: 1, nc: 1, ply: 1, vox: 1, xyz: 1, pcd: 1, vtk: 1, vtp: 1 };
  var IMAGE = /\.(png|jpe?g|webp|gif|bmp|tga|tiff?|ktx2|dds|hdr|exr|avif)$/i;
  var EMPTY_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6XqJm8AAAAASUVORK5CYII=";

  function ext(name) {
    var m = /\.([^./\\]+)$/.exec(String(name || "").toLowerCase());
    return m ? m[1] : "";
  }
  function baseName(path) {
    var s = String(path || "");
    try { s = decodeURIComponent(s); } catch (e) { /* keep as is */ }
    s = s.split("?")[0].split("#")[0];
    var parts = s.split(/[\\/]/);
    return parts[parts.length - 1].toLowerCase();
  }

  function fail(code, detail) { var e = new Error(code); e.code = code; e.detail = detail || ""; return e; }

  /* ---------------------------------------------- gathering the files */

  /** Reads a dropped folder (Chrome, Edge, Safari, Firefox). */
  function readEntry(entry, out) {
    if (!entry) return Promise.resolve();
    if (entry.isFile) {
      return new Promise(function (resolve) {
        entry.file(function (f) { out.push(f); resolve(); }, function () { resolve(); });
      });
    }
    if (entry.isDirectory) {
      var reader = entry.createReader();
      return new Promise(function (resolve) {
        var all = [];
        (function next() {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              Promise.all(all.map(function (e) { return readEntry(e, out); })).then(resolve);
              return;
            }
            all = all.concat(Array.prototype.slice.call(batch));
            next();
          }, function () { resolve(); });
        })();
      });
    }
    return Promise.resolve();
  }

  function filesFromDataTransfer(dt) {
    var items = dt && dt.items ? Array.prototype.slice.call(dt.items) : [];
    var entries = items.map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
    if (entries.length && entries.some(function (e) { return e.isDirectory; })) {
      var out = [];
      return Promise.all(entries.map(function (e) { return readEntry(e, out); })).then(function () { return out; });
    }
    return Promise.resolve(Array.prototype.slice.call((dt && dt.files) || []));
  }

  /** Expands plain ZIP archives (not .usdz / .kmz / .3mf, which are models themselves). */
  function expandZips(files) {
    var hasModel = files.some(function (f) { return MAIN.indexOf(ext(f.name)) !== -1; });
    var zips = files.filter(function (f) { return ext(f.name) === "zip"; });
    if (hasModel || !zips.length) return Promise.resolve(files);
    return Promise.all(zips.map(function (z) {
      return z.arrayBuffer().then(function (buf) {
        var entries;
        try { entries = T.unzipSync(new Uint8Array(buf)); } catch (e) { throw fail("errorZip"); }
        return Object.keys(entries).filter(function (k) { return !/\/$/.test(k) && !/(^|\/)__MACOSX\//.test(k); })
          .map(function (k) { return new File([entries[k]], k.split("/").pop(), { lastModified: Date.now() }); });
      });
    })).then(function (lists) {
      return files.filter(function (f) { return ext(f.name) !== "zip"; }).concat.apply([], lists);
    });
  }

  /** Chooses the model among the files and indexes the rest by name. */
  function pick(files) {
    if (!files.length) throw fail("errorNoFile");
    var byName = {};
    files.forEach(function (f) { byName[f.name.toLowerCase()] = f; });
    var main = null, rank = Infinity;
    files.forEach(function (f) {
      var r = MAIN.indexOf(ext(f.name));
      if (r !== -1 && r < rank) { rank = r; main = f; }
    });
    if (!main) {
      if (files.some(function (f) { return BLEND.indexOf(ext(f.name)) !== -1; })) throw fail("errorBlend");
      if (files.some(function (f) { return UNSUPPORTED.indexOf(ext(f.name)) !== -1; })) throw fail("errorUnsupported", ext(files[0].name).toUpperCase());
      if (files.some(function (f) { return ext(f.name) === "mtl" || IMAGE.test(f.name) || ext(f.name) === "bin"; })) throw fail("errorOnlyParts");
      throw fail("errorUnsupported", (ext(files[0].name) || "?").toUpperCase());
    }
    return { main: main, byName: byName, files: files };
  }

  /* ------------------------------------------------------- the manager */

  function makeManager(set) {
    var urls = {}, missing = [];
    var manager = new THREE.LoadingManager();
    manager.setURLModifier(function (url) {
      if (/^(data|blob):/i.test(url)) return url;
      var name = baseName(url);
      var f = set.byName[name];
      if (f) {
        if (!urls[name]) urls[name] = URL.createObjectURL(f);
        return urls[name];
      }
      if (missing.indexOf(name) === -1 && name) missing.push(name);
      return IMAGE.test(name) ? EMPTY_PIXEL : url;
    });
    manager.dispose = function () { Object.keys(urls).forEach(function (k) { URL.revokeObjectURL(urls[k]); }); urls = {}; };
    manager.missing = missing;
    return manager;
  }

  function text(buf) { return new TextDecoder().decode(buf); }

  var draco = null, ktx2 = null;
  function gltfLoader(manager, renderer) {
    var loader = new T.GLTFLoader(manager);
    if (!draco) { draco = new T.DRACOLoader(); draco.setDecoderPath("assets/vendor/draco/"); }
    loader.setDRACOLoader(draco);
    if (renderer) {
      if (!ktx2) { ktx2 = new T.KTX2Loader(); ktx2.setTranscoderPath("assets/vendor/basis/"); ktx2.detectSupport(renderer); }
      loader.setKTX2Loader(ktx2);
    }
    loader.setMeshoptDecoder(T.MeshoptDecoder);
    return loader;
  }

  function standard(opts) {
    return new THREE.MeshStandardMaterial(Object.assign({ color: 0xb4b4ba, roughness: 0.55, metalness: 0.05 }, opts || {}));
  }

  /**
   * STL stores every triangle with its own three corners, so a mesh keeps
   * each vertex about six times. Welding identical corners into an indexed
   * mesh cuts memory to roughly a fifth, which is what lets very large
   * files run on phones. Faces stay sharp through flat shading, so no
   * normals have to be stored. Returns null when welding would not help.
   */
  function weld(geometry) {
    var pos = geometry.attributes.position;
    if (!pos || geometry.index) return null;
    var n = pos.count;
    if (n < 30000) return null;
    var src = pos.array;
    var bits = new Uint32Array(src.buffer, src.byteOffset, n * 3);
    var cap = 1;
    while (cap < n * 0.6) cap <<= 1;
    var mask = cap - 1;
    var table = new Int32Array(cap).fill(-1);
    var limit = Math.floor(cap * 0.7);
    var out = new Float32Array(Math.min(n, limit) * 3);
    var index = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    var count = 0;
    for (var i = 0; i < n; i++) {
      var a = bits[i * 3], b = bits[i * 3 + 1], c = bits[i * 3 + 2];
      var h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
      var slot;
      while ((slot = table[h]) !== -1 && !(bits[slot * 3] === a && bits[slot * 3 + 1] === b && bits[slot * 3 + 2] === c)) h = (h + 1) & mask;
      if (slot !== -1) { index[i] = index[slot]; continue; }
      if (count >= limit) return null;    // mostly unique corners: keep the original
      table[h] = i;
      index[i] = count;
      out[count * 3] = src[i * 3]; out[count * 3 + 1] = src[i * 3 + 1]; out[count * 3 + 2] = src[i * 3 + 2];
      count++;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(out.slice(0, count * 3), 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    return g;
  }

  function meshFromGeometry(geometry, kind) {
    if (!geometry.index && !geometry.attributes.normal && kind !== "points") geometry.computeVertexNormals();
    var colors = !!geometry.attributes.color;
    if (kind === "points") {
      return new THREE.Points(geometry, new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: colors, color: colors ? 0xffffff : 0xb4b4ba }));
    }
    return new THREE.Mesh(geometry, standard({ vertexColors: colors, color: colors ? 0xffffff : 0xb4b4ba, side: THREE.DoubleSide }));
  }

  /* Each parser receives the main file's bytes and returns a promise of
     { object, animations }. */
  var PARSERS = {
    glb: function (buf, ctx) {
      return new Promise(function (resolve, reject) {
        gltfLoader(ctx.manager, ctx.renderer).parse(buf, "", function (g) { resolve({ object: g.scene || g.scenes[0], animations: g.animations || [] }); }, reject);
      });
    },
    obj: function (buf, ctx) {
      var src = text(buf);
      var loader = new T.OBJLoader(ctx.manager);
      var libs = [];
      src.replace(/^\s*mtllib\s+(.+?)\s*$/gm, function (m, name) { libs.push(baseName(name)); return m; });
      var mtl = libs.map(function (n) { return ctx.set.byName[n]; }).filter(Boolean)[0] ||
        ctx.set.files.filter(function (f) { return ext(f.name) === "mtl"; })[0];
      var ready = mtl ? mtl.text().then(function (mtlText) {
        var materials = new T.MTLLoader(ctx.manager).parse(mtlText, "");
        materials.preload();
        loader.setMaterials(materials);
      }) : Promise.resolve();
      return ready.then(function () { return { object: loader.parse(src), animations: [] }; });
    },
    stl: function (buf) {
      var g = new T.STLLoader().parse(buf);
      var welded = g.attributes.color ? null : weld(g);
      if (!welded) return Promise.resolve({ object: meshFromGeometry(g), animations: [] });
      g.dispose();
      var mesh = new THREE.Mesh(welded, standard({ flatShading: true, side: THREE.DoubleSide }));
      return Promise.resolve({ object: mesh, animations: [] });
    },
    ply: function (buf) {
      var g = new T.PLYLoader().parse(buf);
      return Promise.resolve({ object: meshFromGeometry(g, g.index ? "mesh" : "points"), animations: [] });
    },
    fbx: function (buf, ctx) {
      var o = new T.FBXLoader(ctx.manager).parse(buf, "");
      return Promise.resolve({ object: o, animations: o.animations || [] });
    },
    dae: function (buf, ctx) {
      var r = new T.ColladaLoader(ctx.manager).parse(text(buf), "");
      return Promise.resolve({ object: r.scene, animations: (r.scene && r.scene.animations) || r.animations || [] });
    },
    "3mf": function (buf, ctx) { return Promise.resolve({ object: new T.ThreeMFLoader(ctx.manager).parse(buf), animations: [] }); },
    "3ds": function (buf, ctx) { return Promise.resolve({ object: new T.TDSLoader(ctx.manager).parse(buf, ""), animations: [] }); },
    usdz: function (buf, ctx) {
      return new Promise(function (resolve, reject) {
        try {
          new T.USDLoader(ctx.manager).parse(buf, "", function (g) { resolve({ object: g, animations: g.animations || [] }); }, reject);
        } catch (e) { reject(e); }
      });
    },
    amf: function (buf, ctx) { return Promise.resolve({ object: new T.AMFLoader(ctx.manager).parse(buf), animations: [] }); },
    wrl: function (buf, ctx) { return Promise.resolve({ object: new T.VRMLLoader(ctx.manager).parse(text(buf), ""), animations: [] }); },
    lwo: function (buf, ctx) {
      var r = new T.LWOLoader(ctx.manager).parse(buf, "", ctx.set.main.name);
      var g = new THREE.Group();
      (r.meshes || []).forEach(function (m) { g.add(m); });
      return Promise.resolve({ object: g, animations: [] });
    },
    kmz: function (buf, ctx) { return Promise.resolve({ object: new T.KMZLoader(ctx.manager).parse(buf).scene, animations: [] }); },
    vtk: function (buf) {
      var g = new T.VTKLoader().parse(buf);
      return Promise.resolve({ object: meshFromGeometry(g, g.index || g.attributes.position.count % 3 === 0 ? "mesh" : "points"), animations: [] });
    },
    vox: function (buf) {
      var r = new T.VOXLoader().parse(buf);
      if (!r) throw fail("errorParse");
      var object = r.scene;
      if (!object) {
        object = new THREE.Group();
        var chunks = r.chunks || r;
        for (var i = 0; i < chunks.length; i++) object.add(new T.VOXMesh(chunks[i]));
      }
      return Promise.resolve({ object: object, animations: [] });
    },
    pcd: function (buf) {
      var p = new T.PCDLoader().parse(buf);
      if (p.material) { p.material.sizeAttenuation = false; p.material.size = 1; }
      return Promise.resolve({ object: p, animations: [] });
    },
    xyz: function (buf) { return Promise.resolve({ object: meshFromGeometry(new T.XYZLoader().parse(text(buf)), "points"), animations: [] }); },
    gcode: function (buf, ctx) { return Promise.resolve({ object: new T.GCodeLoader(ctx.manager).parse(text(buf)), animations: [] }); },
  };
  PARSERS.gltf = PARSERS.glb;
  PARSERS.usd = PARSERS.usdc = PARSERS.usda = PARSERS.usdz;
  PARSERS.vrml = PARSERS.wrl;
  PARSERS.vtp = PARSERS.vtk;
  PARSERS.gco = PARSERS.nc = PARSERS.gcode;

  /* ----------------------------------------------------- post-process */

  function prepare(object) {
    var stats = { triangles: 0, vertices: 0, points: 0, meshes: 0 };
    object.traverse(function (o) {
      if (o.isMesh || o.isPoints || o.isLine) {
        var g = o.geometry;
        if (!g || !g.attributes || !g.attributes.position) return;
        var n = g.attributes.position.count;
        stats.vertices += n;
        if (o.isMesh) {
          stats.meshes++;
          stats.triangles += Math.floor((g.index ? g.index.count : n) / 3);
          if (!g.attributes.normal && !(o.material && o.material.flatShading)) g.computeVertexNormals();
          if (!o.material) o.material = standard();
          o.castShadow = true;
          o.receiveShadow = false;
        } else if (o.isPoints) {
          stats.points += n;
        }
        o.frustumCulled = !o.isSkinnedMesh;
      }
    });
    return stats;
  }

  /**
   * Loads a model from a list of files.
   * @returns Promise<{ object, animations, format, name, size, stats, zUp, missing, dispose }>
   */
  function load(fileList, opts) {
    opts = opts || {};
    var progress = opts.onProgress || function () {};
    return expandZips(Array.prototype.slice.call(fileList)).then(function (files) {
      var set = pick(files);
      var format = ext(set.main.name);
      var manager = makeManager(set);
      progress("reading");
      return set.main.arrayBuffer().then(function (buf) {
        progress("parsing");
        // Let the busy indicator paint before a long synchronous parse.
        return new Promise(function (r) { setTimeout(r, 30); }).then(function () {
          var parser = PARSERS[format];
          return Promise.resolve().then(function () { return parser(buf, { manager: manager, set: set, renderer: opts.renderer }); });
        });
      }).then(function (result) {
        if (!result || !result.object) throw fail("errorParse");
        var stats = prepare(result.object);
        if (!stats.vertices) throw fail("errorEmpty");
        var size = set.files.reduce(function (s, f) { return s + f.size; }, 0);
        return {
          object: result.object,
          animations: result.animations || [],
          format: format.toUpperCase(),
          name: set.main.name,
          size: size,
          stats: stats,
          zUp: !!Z_UP[format],
          missing: manager.missing.slice(),
          dispose: function () { manager.dispose(); },
        };
      }, function (err) {
        manager.dispose();
        if (err && err.code) throw err;
        console.error(err);
        if (err && (err.name === "RangeError" || /memory|allocation/i.test(String(err.message)))) throw fail("errorMemory");
        throw fail("errorParse");
      });
    });
  }

  /** Releases GPU memory held by an object. */
  function disposeObject(object) {
    if (!object) return;
    object.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      var mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      mats.forEach(function (m) {
        Object.keys(m).forEach(function (k) { if (m[k] && m[k].isTexture) m[k].dispose(); });
        m.dispose();
      });
    });
  }

  window.TSSModels = Object.freeze({
    MAIN: MAIN.slice(),
    ext: ext,
    filesFromDataTransfer: filesFromDataTransfer,
    load: load,
    disposeObject: disposeObject,
    standard: standard,
  });
})();
