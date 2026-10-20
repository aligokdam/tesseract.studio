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
    if (this.active === "camera") this.viewer.holder.position.set(0, 0, 0);
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
          self.viewer.holder.position.set(g.pos.x + (m.x - g.m0.x) * k, g.pos.y - (m.y - g.m0.y) * k, g.pos.z);
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
    v.holder.position.set(0, 0, 0);
    this._applyScale();
    v.resize();
    this._status("arCameraHint");
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(function () { if (self.active === "camera") self._status(null); }, 5000);
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

  AR.prototype._endCamera = function () {
    var v = this.viewer, ui = this.ui;
    clearTimeout(this._statusTimer);
    if (this.stream) { this.stream.getTracks().forEach(function (t) { t.stop(); }); this.stream = null; }
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
    var swapped = [];
    v.model.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
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
      v.needsRender = true;
    }
    var exporter = new T.USDZExporter();
    ql.busy = exporter.parseAsync(root, { quickLookCompatible: true, maxTextureSize: 2048 }).then(function (buf) {
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
