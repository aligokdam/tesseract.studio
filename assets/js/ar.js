/* =====================================================================
   Tesseract Studio: augmented reality
   ---------------------------------------------------------------------
   Picks the best AR the device offers, in this order:
     webxr      Android Chrome (ARCore), Meta Quest, other WebXR browsers.
                The model is anchored to a real surface; walk around it.
     quicklook  iPhone and iPad. The model is exported to USDZ on the
                device and handed to Apple's AR Quick Look.
     camera     Everything else with a camera (computers, tablets): the
                model floats over the live camera picture.
   In every mode the model starts small (the start size) and grows or
   shrinks with a two-finger pinch.
   ===================================================================== */
(function () {
  "use strict";

  var T = window.TS3;
  if (!T) return;
  var THREE = T.THREE;

  var MIN_SCALE = 0.05, MAX_SCALE = 60;

  function AR(viewer, ui) {
    this.viewer = viewer;
    this.ui = ui;            // { layer, video, status, scale, close, reset, t, toast, onExit }
    this.mode = "none";
    this.active = null;      // "webxr" | "camera" | null
    this.startSize = 0.2;    // metres
    this.userScale = 1;
    this.turn = 0;
    this.placed = false;
    this.quickLook = { url: null, key: "", busy: null };
    this._bindGestures();
    var self = this;
    ui.close.addEventListener("click", function () { self.stop(); });
    ui.reset.addEventListener("click", function () { self.resetTransform(); });
    // Keep taps on the overlay buttons from also reaching WebXR as "select".
    ui.layer.addEventListener("beforexrselect", function (e) { e.preventDefault(); });
  }

  /** Resolves to "webxr", "quicklook", "camera" or "none". */
  AR.prototype.detect = function () {
    var self = this;
    var a = document.createElement("a");
    var ql = !!(a.relList && a.relList.supports && a.relList.supports("ar"));
    var cam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    var xr = navigator.xr && navigator.xr.isSessionSupported
      ? navigator.xr.isSessionSupported("immersive-ar").catch(function () { return false; })
      : Promise.resolve(false);
    return xr.then(function (ok) {
      self.mode = ok && window.isSecureContext ? "webxr" : ql ? "quicklook" : cam ? "camera" : "none";
      return self.mode;
    });
  };

  AR.prototype.setStartSize = function (meters) {
    this.startSize = meters;
    if (this.active) this._applyScale();
  };

  AR.prototype.start = function () {
    if (!this.viewer.model) return Promise.resolve(false);
    if (this.mode === "webxr") return this._startXR();
    if (this.mode === "quicklook") return this._openQuickLook();
    if (this.mode === "camera") return this._startCamera();
    return Promise.resolve(false);
  };

  AR.prototype.stop = function () {
    if (this.active === "webxr" && this.session) { this.session.end().catch(function () {}); return; }
    if (this.active === "camera") this._endCamera();
  };

  /* ------------------------------------------------------ shared bits */

  AR.prototype._status = function (key) {
    this.statusKey = key;
    this.ui.status.textContent = key ? this.ui.t(key) : "";
    this.ui.status.hidden = !key;
  };

  AR.prototype._applyScale = function () {
    var meters = this.startSize * this.userScale;
    this.viewer.setMetricSize(meters);
    this.viewer.holder.rotation.set(0, this.baseYaw + this.turn, 0);
    var label = meters >= 1 ? (Math.round(meters * 100) / 100).toLocaleString(this.ui.lang()) + " m"
      : Math.max(1, Math.round(meters * 100)) + " cm";
    this.ui.scale.textContent = label + " · " + Math.round(this.userScale * 100) + "%";
  };

  AR.prototype.resetTransform = function () {
    this.userScale = 1;
    this.turn = 0;
    if (this.active === "camera") this.viewer.holder.position.copy(this._home || new THREE.Vector3());
    this._applyScale();
  };

  AR.prototype._enterLayer = function (kind) {
    this.active = kind;
    this.userScale = 1;
    this.turn = 0;
    this.baseYaw = 0;
    this.placed = false;
    var ui = this.ui;
    ui.layer.hidden = false;
    ui.layer.setAttribute("data-mode", kind);
    document.documentElement.setAttribute("data-ar", kind);
    this.viewer.mode = kind;
    this.viewer.controls.enabled = false;
    this.viewer.controls.autoRotate = false;
  };

  AR.prototype._leaveLayer = function () {
    var ui = this.ui;
    this.active = null;
    this.viewer.frameHook = null;
    ui.layer.hidden = true;
    ui.layer.removeAttribute("data-mode");
    document.documentElement.removeAttribute("data-ar");
    this.viewer.mode = "preview";
    this.viewer.controls.enabled = true;
    this.viewer.holder.visible = true;
    this.viewer.mount(this.viewer.host);
    this.viewer.frame();
    if (ui.onExit) ui.onExit();
  };

  /* --------------------------------------------------------- gestures
     One finger turns the model, two fingers pinch its size. In camera
     mode two fingers also move it; in WebXR a tap places it. */
  AR.prototype._bindGestures = function () {
    var self = this, layer = this.ui.layer;
    var pts = new Map();
    var g = null;

    function isUi(e) { return e.target.closest && e.target.closest("button, a"); }
    function list() { return Array.from(pts.values()); }
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) || 1; }
    function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

    function begin() {
      var p = list();
      g = { n: p.length, scale: self.userScale, turn: self.turn, pos: self.viewer.holder.position.clone(), moved: 0, t0: performance.now() };
      if (p.length === 1) g.start = { x: p[0].x, y: p[0].y };
      if (p.length >= 2) { g.d0 = dist(p[0], p[1]); g.m0 = mid(p[0], p[1]); }
    }

    layer.addEventListener("pointerdown", function (e) {
      if (!self.active || isUi(e)) return;
      e.preventDefault();
      try { layer.setPointerCapture(e.pointerId); } catch (err) { /* WebXR overlay */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      begin();
    });
    layer.addEventListener("pointermove", function (e) {
      if (!self.active || !pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var p = list();
      if (p.length === 1 && g.start) {
        var dx = p[0].x - g.start.x, dy = p[0].y - g.start.y;
        g.moved = Math.max(g.moved, Math.hypot(dx, dy));
        if (g.moved > 8) { self.turn = g.turn + dx * 0.012; self._applyScale(); }
      } else if (p.length >= 2 && g.d0) {
        g.moved = 99;
        self.userScale = THREE.MathUtils.clamp(g.scale * dist(p[0], p[1]) / g.d0, MIN_SCALE, MAX_SCALE);
        if (self.active === "camera") {
          var m = mid(p[0], p[1]);
          var k = self._metersPerPixel();
          var cm = self.viewer.camera.matrixWorld;
          var right = new THREE.Vector3().setFromMatrixColumn(cm, 0);
          var up = new THREE.Vector3().setFromMatrixColumn(cm, 1);
          self.viewer.holder.position.copy(g.pos).addScaledVector(right, (m.x - g.m0.x) * k).addScaledVector(up, -(m.y - g.m0.y) * k);
        }
        self._applyScale();
      }
    });
    function end(e) {
      if (!pts.has(e.pointerId)) return;
      var wasTap = g && g.n === 1 && pts.size === 1 && g.moved < 10 && performance.now() - g.t0 < 350;
      pts.delete(e.pointerId);
      if (wasTap && self.active === "webxr") self._place();
      if (pts.size) begin(); else g = null;
    }
    layer.addEventListener("pointerup", end);
    layer.addEventListener("pointercancel", end);
    layer.addEventListener("wheel", function (e) {
      if (!self.active) return;
      e.preventDefault();
      self.userScale = THREE.MathUtils.clamp(self.userScale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
      self._applyScale();
    }, { passive: false });
    layer.addEventListener("keydown", function (e) {
      if (!self.active) return;
      if (e.key === "Escape") { e.preventDefault(); self.stop(); }
      else if (e.key === "+" || e.key === "=") { self.userScale = Math.min(MAX_SCALE, self.userScale * 1.15); self._applyScale(); }
      else if (e.key === "-") { self.userScale = Math.max(MIN_SCALE, self.userScale / 1.15); self._applyScale(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { self.turn += e.key === "ArrowLeft" ? -0.15 : 0.15; self._applyScale(); }
    });
  };

  /* Camera mode: how many metres one screen pixel covers at the model. */
  AR.prototype._metersPerPixel = function () {
    var cam = this.viewer.camera;
    var d = cam.position.distanceTo(this.viewer.holder.position);
    var h = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    return h / (this.viewer.renderer.domElement.clientHeight || 1);
  };

  /* ---------------------------------------------------------- WebXR */

  AR.prototype._startXR = function () {
    var self = this, v = this.viewer, ui = this.ui;
    var opts = { requiredFeatures: ["hit-test"], optionalFeatures: ["dom-overlay"], domOverlay: { root: ui.layer } };
    this._enterLayer("webxr");
    return navigator.xr.requestSession("immersive-ar", opts).then(function (session) {
      self.session = session;
      v.renderer.xr.enabled = true;
      v.renderer.xr.setReferenceSpaceType("local");
      return v.renderer.xr.setSession(session).then(function () {
        return session.requestReferenceSpace("viewer");
      }).then(function (viewerSpace) {
        return session.requestHitTestSource({ space: viewerSpace });
      }).then(function (source) {
        self.hitSource = source;
        self._reticle();
        v.holder.visible = false;
        v.ground.material.opacity = 0.32;
        self._status("arFindSurface");
        self._applyScale();
        session.addEventListener("end", function () { self._endXR(); });
        v.frameHook = function (time, frame) { self._xrFrame(frame); };
        return true;
      });
    }).catch(function (err) {
      console.error(err);
      if (self.session) { try { self.session.end(); } catch (e) { /* already over */ } }
      self.session = null;
      v.renderer.xr.enabled = false;
      self._leaveLayer();
      ui.toast(ui.t("errorAr"), "error");
      return false;
    });
  };

  AR.prototype._reticle = function () {
    if (this.reticle) { this.reticle.visible = false; return; }
    var ring = new THREE.RingGeometry(0.07, 0.085, 48).rotateX(-Math.PI / 2);
    var dot = new THREE.CircleGeometry(0.012, 24).rotateX(-Math.PI / 2);
    var mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
    var r = new THREE.Group();
    r.add(new THREE.Mesh(ring, mat), new THREE.Mesh(dot, mat));
    r.matrixAutoUpdate = false;
    r.visible = false;
    r.renderOrder = 10;
    this.reticle = r;
    this.viewer.scene.add(r);
  };

  AR.prototype._xrFrame = function (frame) {
    if (!frame || !this.hitSource) return;
    var space = this.viewer.renderer.xr.getReferenceSpace();
    var hits = frame.getHitTestResults(this.hitSource);
    if (hits.length) {
      var pose = hits[0].getPose(space);
      this.reticle.visible = true;
      this.reticle.matrix.fromArray(pose.transform.matrix);
      if (!this.placed && this.statusKey === "arFindSurface") this._status("arTapToPlace");
    } else {
      this.reticle.visible = false;
    }
    if (this.placed) this.reticle.visible = this.reticle.visible && this.statusKey === "arTapToMove";
  };

  AR.prototype._place = function () {
    if (!this.reticle || !this.reticle.visible) return;
    var v = this.viewer;
    var p = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
    v.holder.position.copy(p);
    // Face the person holding the phone.
    var cam = v.renderer.xr.getCamera();
    var cp = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    this.baseYaw = Math.atan2(cp.x - p.x, cp.z - p.z);
    v.holder.visible = true;
    this.placed = true;
    this._applyScale();
    this._status("arGestures");
    var self = this;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(function () { if (self.active === "webxr") self._status("arTapToMove"); }, 4000);
  };

  AR.prototype._endXR = function () {
    var v = this.viewer;
    clearTimeout(this._statusTimer);
    if (this.hitSource) { try { this.hitSource.cancel(); } catch (e) { /* gone */ } }
    this.hitSource = null;
    this.session = null;
    if (this.reticle) this.reticle.visible = false;
    v.renderer.xr.enabled = false;
    v.ground.material.opacity = 0.28;
    this._leaveLayer();
  };

  /* --------------------------------------------------------- camera */

  AR.prototype._startCamera = function () {
    var self = this, v = this.viewer, ui = this.ui;
    this._enterLayer("camera");
    v.mount(ui.layer, ui.layer.querySelector(".ar-top"));
    var cam = v.camera;
    this._savedCam = { fov: cam.fov, near: cam.near, far: cam.far, pos: cam.position.clone(), target: v.controls.target.clone() };
    cam.fov = 50; cam.near = 0.01; cam.far = 100;
    cam.position.set(0, 0.42, 1.25);
    cam.lookAt(0, 0.08, 0);
    cam.updateProjectionMatrix();
    this._home = new THREE.Vector3(0, 0, 0);
    v.holder.position.copy(this._home);
    this._applyScale();
    this._startGyro();
    v.resize();
    this._status(null);
    try { ui.layer.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }

    var constraints = { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      if (self.active !== "camera") { stream.getTracks().forEach(function (t) { t.stop(); }); return false; }
      self.stream = stream;
      ui.video.srcObject = stream;
      var track = stream.getVideoTracks()[0];
      var facing = track && track.getSettings ? track.getSettings().facingMode : "";
      ui.layer.toggleAttribute("data-mirror", facing === "user" || (!facing && !/Android|iPhone|iPad/i.test(navigator.userAgent)));
      return ui.video.play().then(function () { return true; }, function () { return true; });
    }).catch(function (err) {
      console.warn(err);
      if (self.active === "camera") ui.toast(ui.t("errorCamera"), "error");
      return true;  // the layer stays usable without the picture
    });
  };

  /* Phones and tablets: the gyroscope turns the view, so the model keeps
     its place in the room while the device turns around it (3 DoF).
     Walking around a model needs WebXR or AR Quick Look. */
  var isTouch = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  AR.prototype._startGyro = function () {
    var self = this, v = this.viewer;
    this._gyro = null;
    if (!isTouch || typeof window.DeviceOrientationEvent === "undefined") return;
    var euler = new THREE.Euler(), q0 = new THREE.Quaternion(), zee = new THREE.Vector3(0, 0, 1);
    var q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    var gyro = { ev: null, placed: false };
    gyro.onEvent = function (e) { if (e.alpha != null) gyro.ev = e; };
    function screenAngle() {
      var o = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      return THREE.MathUtils.degToRad(o);
    }
    function listen() {
      window.addEventListener("deviceorientation", gyro.onEvent);
      self._gyro = gyro;
      v.frameHook = function () {
        var e = gyro.ev;
        if (!e) return;
        var d = THREE.MathUtils.degToRad;
        euler.set(d(e.beta || 0), d(e.alpha || 0), -d(e.gamma || 0), "YXZ");
        v.camera.position.set(0, 0, 0);
        v.camera.quaternion.setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee, -screenAngle()));
        if (!gyro.placed) {
          // First reading: put the model where the phone points, under a metre away.
          var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion);
          self._home = fwd.clone().multiplyScalar(0.9);
          self._home.y -= self.startSize * 0.5;
          v.holder.position.copy(self._home);
          self.baseYaw = Math.atan2(-fwd.x, -fwd.z);
          gyro.placed = true;
          self._applyScale();
        }
      };
    }
    var ask = window.DeviceOrientationEvent.requestPermission;
    if (typeof ask === "function") {
      // iOS asks once; this runs inside the tap that opened AR.
      ask.call(window.DeviceOrientationEvent).then(function (r) { if (r === "granted" && self.active === "camera") listen(); }, function () {});
    } else {
      listen();
    }
  };

  AR.prototype._stopGyro = function () {
    if (this._gyro) window.removeEventListener("deviceorientation", this._gyro.onEvent);
    this._gyro = null;
    this.viewer.frameHook = null;
  };

  AR.prototype._endCamera = function () {
    var v = this.viewer, ui = this.ui;
    clearTimeout(this._statusTimer);
    if (this.stream) { this.stream.getTracks().forEach(function (t) { t.stop(); }); this.stream = null; }
    this._stopGyro();
    ui.video.srcObject = null;
    ui.layer.removeAttribute("data-mirror");
    var s = this._savedCam;
    if (s) { v.camera.fov = s.fov; v.camera.near = s.near; v.camera.far = s.far; v.camera.updateProjectionMatrix(); }
    this._leaveLayer();
  };

  /* ------------------------------------------------------ Quick Look */

  function toStandard(m) {
    if (!m || m.isMeshStandardMaterial) return m;
    var s = window.TSSModels.standard({
      color: m.color ? m.color.clone() : 0xffffff,
      map: m.map || null,
      normalMap: m.normalMap || null,
      emissive: m.emissive ? m.emissive.clone() : 0x000000,
      emissiveMap: m.emissiveMap || null,
      alphaMap: m.alphaMap || null,
      transparent: !!m.transparent,
      opacity: m.opacity != null ? m.opacity : 1,
      side: m.side,
      vertexColors: !!m.vertexColors,
      roughness: m.shininess != null ? THREE.MathUtils.clamp(1 - m.shininess / 120, 0.08, 1) : 0.7,
      metalness: 0,
    });
    s.userData.tssTemp = true;
    return s;
  }

  /*
   * AR Quick Look loads slowly (black screen) or not at all when a model has
   * millions of triangles. Untextured meshes over the budget are simplified
   * by vertex clustering for the USDZ only: the space is cut into a grid,
   * corners in one cell merge into one, and collapsed triangles drop out.
   * The preview and the original file keep every triangle.
   */
  var QL_TRIANGLES = 250000;

  function triCount(g) { return Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3); }

  function clusterOnce(g, res) {
    var pos = g.attributes.position.array, idx = g.index ? g.index.array : null;
    var n = g.attributes.position.count;
    var bb = g.boundingBox;
    var size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
    var step = size / res, minx = bb.min.x, miny = bb.min.y, minz = bb.min.z;
    var cap = 1;
    while (cap < n * 2) cap <<= 1;
    var mask = cap - 1;
    var keys = new Float64Array(cap).fill(-1);
    var slots = new Int32Array(cap);
    var cellOf = new Int32Array(n);
    var sums = new Float64Array(n * 3), counts = new Uint32Array(n);
    var cells = 0;
    for (var i = 0; i < n; i++) {
      var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      var key = Math.floor((x - minx) / step) * (res + 1) * (res + 1) + Math.floor((y - miny) / step) * (res + 1) + Math.floor((z - minz) / step);
      var h = (Math.imul(key | 0, 2654435761) ^ Math.imul((key / 4294967296) | 0, 40503)) & mask;
      while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & mask;
      if (keys[h] === -1) { keys[h] = key; slots[h] = cells++; }
      var c = slots[h];
      cellOf[i] = c;
      sums[c * 3] += x; sums[c * 3 + 1] += y; sums[c * 3 + 2] += z; counts[c]++;
    }
    var tris = triCount(g), out = new Uint32Array(tris * 3), t = 0;
    for (var f = 0; f < tris; f++) {
      var a = cellOf[idx ? idx[f * 3] : f * 3], b = cellOf[idx ? idx[f * 3 + 1] : f * 3 + 1], c2 = cellOf[idx ? idx[f * 3 + 2] : f * 3 + 2];
      if (a === b || b === c2 || a === c2) continue;
      out[t++] = a; out[t++] = b; out[t++] = c2;
    }
    var p = new Float32Array(cells * 3);
    for (var k = 0; k < cells; k++) {
      p[k * 3] = sums[k * 3] / counts[k]; p[k * 3 + 1] = sums[k * 3 + 1] / counts[k]; p[k * 3 + 2] = sums[k * 3 + 2] / counts[k];
    }
    var r = new THREE.BufferGeometry();
    r.setAttribute("position", new THREE.BufferAttribute(p, 3));
    r.setIndex(new THREE.BufferAttribute(out.slice(0, t), 1));
    return r;
  }

  function simplify(g, maxTris) {
    if (triCount(g) <= maxTris || g.attributes.uv || g.morphAttributes.position) return null;
    if (!g.boundingBox) g.computeBoundingBox();
    var res = Math.round(Math.sqrt(maxTris) * 1.3), best = null;
    for (var tries = 0; tries < 6; tries++) {
      var r = clusterOnce(g, res);
      if (best) best.dispose();
      best = r;
      if (triCount(r) <= maxTris) break;
      res = Math.round(res * Math.sqrt(maxTris / triCount(r)) * 0.95);
    }
    best.computeVertexNormals();
    return best;
  }

  /** Builds the USDZ for Quick Look at the chosen start size. */
  AR.prototype.prepareQuickLook = function () {
    var v = this.viewer;
    if (this.mode !== "quicklook" || !v.model) return Promise.resolve(null);
    var key = v.model.uuid + "|" + this.startSize + "|" + v.upAxis;
    var ql = this.quickLook;
    if (ql.key === key && ql.url) return Promise.resolve(ql.url);
    if (ql.key === key && ql.busy) return ql.busy;
    if (ql.url) { URL.revokeObjectURL(ql.url); ql.url = null; }
    ql.key = key;

    var root = new THREE.Scene();
    var sizer = new THREE.Group();
    sizer.scale.setScalar(v.unit * this.startSize);
    root.add(sizer);
    var swapped = [], tempNormals = [], tempGeo = [];
    var total = 0;
    v.model.traverse(function (o) { if (o.isMesh && o.geometry && o.geometry.attributes.position) total += triCount(o.geometry); });
    v.model.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      if (total > QL_TRIANGLES && !o.isSkinnedMesh) {
        var lite = simplify(o.geometry, Math.max(2000, Math.floor(QL_TRIANGLES * triCount(o.geometry) / total)));
        if (lite) { tempGeo.push([o, o.geometry]); o.geometry = lite; }
      }
      // Welded meshes draw flat without stored normals; Quick Look needs them.
      if (o.geometry && !o.geometry.attributes.normal) { o.geometry.computeVertexNormals(); tempNormals.push(o.geometry); }
      var list = Array.isArray(o.material) ? o.material : [o.material];
      if (list.every(function (m) { return m.isMeshStandardMaterial; })) return;
      swapped.push([o, o.material]);
      o.material = Array.isArray(o.material) ? list.map(toStandard) : toStandard(o.material);
    });
    var upFix = v.upFix;
    v.holder.remove(upFix);
    sizer.add(upFix);
    function restore() {
      sizer.remove(upFix);
      v.holder.add(upFix);
      swapped.forEach(function (pair) {
        var temp = pair[0].material;
        (Array.isArray(temp) ? temp : [temp]).forEach(function (m) { if (m.userData && m.userData.tssTemp) m.dispose(); });
        pair[0].material = pair[1];
      });
      tempNormals.forEach(function (g) { if (g.attributes.normal) g.deleteAttribute("normal"); });
      tempGeo.forEach(function (pair) { pair[0].geometry.dispose(); pair[0].geometry = pair[1]; });
      v.needsRender = true;
    }
    root.updateMatrixWorld(true);   // the exporter reads each node's local matrix: the size must be in it
    var exporter = new T.USDZExporter();
    ql.busy = exporter.parseAsync(root, { quickLookCompatible: true, maxTextureSize: 1024 }).then(function (buf) {
      restore();
      if (ql.key !== key) return null;
      ql.url = URL.createObjectURL(new Blob([buf], { type: "model/vnd.usdz+zip" }));
      ql.busy = null;
      return ql.url;
    }, function (err) {
      restore();
      console.error(err);
      ql.busy = null;
      ql.key = "";
      throw err;
    });
    return ql.busy;
  };

  AR.prototype._openQuickLook = function () {
    var self = this, ui = this.ui;
    function open(url) {
      var a = document.createElement("a");
      a.rel = "ar";
      a.href = url;
      a.appendChild(document.createElement("img"));
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); }, 1000);
      return true;
    }
    if (this.quickLook.url && this.quickLook.key.indexOf(this.viewer.model.uuid + "|" + this.startSize + "|") === 0) {
      return Promise.resolve(open(this.quickLook.url));
    }
    ui.busy("preparingAr");
    return this.prepareQuickLook().then(function (url) {
      ui.busy(null);
      if (!url) return false;
      return open(url);
    }, function () {
      ui.busy(null);
      ui.toast(ui.t("errorQuickLook"), "error");
      return false;
    });
  };

  window.TSSAR = AR;
})();
