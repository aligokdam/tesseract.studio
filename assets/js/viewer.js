/* =====================================================================
   Tesseract Studio: 3D viewer
   ---------------------------------------------------------------------
   One renderer and one scene serve every mode:
     preview   orbit around the model inside the editor
     camera    the model over the live camera (any device with a camera)
     xr        WebXR immersive AR, anchored to real surfaces

   Hierarchy:  holder  (placement, turn and size in AR)
                 └ upFix   (Y-up / Z-up)
                    └ offset  (bottom-centre of the model at the origin)
                       └ model
   ===================================================================== */
(function () {
  "use strict";

  var T = window.TS3;
  if (!T) return;
  var THREE = T.THREE;

  function Viewer(host) {
    this.host = host;
    var r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.setClearColor(0x000000, 0);
    r.domElement.className = "viewer-canvas";
    host.appendChild(r.domElement);

    var scene = this.scene = new THREE.Scene();
    var pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new T.RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.75;
    pmrem.dispose();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444448, 0.35));
    var sun = this.sun = new THREE.DirectionalLight(0xffffff, 1.25);
    sun.position.set(0.6, 1.4, 0.8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);

    this.holder = new THREE.Group();
    this.upFix = new THREE.Group();
    this.offset = new THREE.Group();
    this.holder.add(this.upFix);
    this.upFix.add(this.offset);
    scene.add(this.holder);

    // Soft contact shadow; it also lands on real floors in AR.
    var ground = this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.28 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.renderOrder = -1;
    this.holder.add(ground);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.controls = new T.OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotateSpeed = 1.6;

    this.model = null;
    this.mixer = null;
    this.timer = new THREE.Timer();
    this.size = new THREE.Vector3(1, 1, 1);   // model size in its own units, after up-axis
    this.unit = 1;                              // 1 / longest side
    this.mode = "preview";
    this.frameHook = null;                      // set by AR modes
    this.needsRender = true;

    var self = this;
    r.setAnimationLoop(function (time, frame) { self._loop(time, frame); });
    this.controls.addEventListener("change", function () { self.needsRender = true; });
    if (window.ResizeObserver) new ResizeObserver(function () { self.resize(); }).observe(host);
    window.addEventListener("resize", function () { self.resize(); });
    this.resize();
  }

  Viewer.prototype.resize = function () {
    if (this.renderer.xr.isPresenting) return;
    var el = this.renderer.domElement.parentNode || this.host;
    var w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  };

  Viewer.prototype._loop = function (time, frame) {
    this.timer.update(time);
    var dt = Math.min(0.1, this.timer.getDelta());
    if (this.mixer) { this.mixer.update(dt); this.needsRender = true; }
    if (this.mode === "preview") {
      if (this.controls.autoRotate) this.needsRender = true;
      this.controls.update(dt);
    }
    if (this.frameHook) { this.frameHook(time, frame); this.needsRender = true; }
    if (!this.needsRender && !this.renderer.xr.isPresenting) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
  };

  /** Puts a freshly loaded model on stage. */
  Viewer.prototype.setModel = function (loaded, zUp) {
    this.clear();
    this.model = loaded.object;
    this.offset.add(this.model);
    if (loaded.animations && loaded.animations.length) {
      this.mixer = new THREE.AnimationMixer(this.model);
      this.mixer.clipAction(loaded.animations[0]).play();
    }
    this.setUpAxis(zUp ? "z" : "y");
  };

  Viewer.prototype.clear = function () {
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer = null; }
    if (this.model) {
      this.offset.remove(this.model);
      window.TSSModels.disposeObject(this.model);
      this.model = null;
    }
    this.needsRender = true;
  };

  /** Re-measures the model and sits its bottom-centre on the origin. */
  Viewer.prototype.setUpAxis = function (axis) {
    if (!this.model) return;
    this.upAxis = axis === "z" ? "z" : "y";
    this.upFix.rotation.set(this.upAxis === "z" ? -Math.PI / 2 : 0, 0, 0);
    this.offset.position.set(0, 0, 0);
    var keep = this.holder.matrix.clone();
    this.holder.position.set(0, 0, 0); this.holder.rotation.set(0, 0, 0); this.holder.scale.set(1, 1, 1);
    this.holder.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(this.model, true);
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
    var center = box.getCenter(new THREE.Vector3());
    this.size = box.getSize(new THREE.Vector3());
    var longest = Math.max(this.size.x, this.size.y, this.size.z) || 1;
    this.unit = 1 / longest;
    // offset lives inside upFix, so convert the world shift into upFix space.
    var shift = new THREE.Vector3(-center.x, -box.min.y, -center.z);
    var inv = new THREE.Matrix4().copy(this.upFix.matrixWorld).invert();
    var origin = new THREE.Vector3().applyMatrix4(inv);
    shift.applyMatrix4(inv).sub(origin);
    this.offset.position.copy(shift);
    this.holder.matrix.copy(keep);
    this.holder.matrix.decompose(this.holder.position, this.holder.quaternion, this.holder.scale);
    this.ground.scale.set(this.size.x * 2.2 + longest * 0.4, this.size.z * 2.2 + longest * 0.4, 1);
    this._pointSize();
    if (this.mode === "preview") this.frame();
    this.needsRender = true;
  };

  /* Points clouds use screen-space dots; keep them readable. */
  Viewer.prototype._pointSize = function () {
    var dpr = this.renderer.getPixelRatio();
    if (!this.model) return;
    this.model.traverse(function (o) {
      if (o.isPoints && o.material && o.material.isPointsMaterial) { o.material.sizeAttenuation = false; o.material.size = 1.6 * dpr; }
    });
  };

  /** Preview: model at unit size, camera framed around it. */
  Viewer.prototype.frame = function () {
    this.holder.position.set(0, 0, 0);
    this.holder.rotation.set(0, 0, 0);
    this.holder.scale.setScalar(this.unit);
    var h = this.size.y * this.unit;
    var radius = 0.5 * Math.sqrt(Math.pow(this.size.x * this.unit, 2) + Math.pow(h, 2) + Math.pow(this.size.z * this.unit, 2));
    var dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.08;
    var target = new THREE.Vector3(0, h / 2, 0);
    var dir = new THREE.Vector3(0.9, 0.55, 1.25).normalize();
    this.camera.near = Math.max(0.001, dist / 200);
    this.camera.far = dist * 200;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.controls.minDistance = radius * 0.2;
    this.controls.maxDistance = dist * 12;
    this.controls.update();
    this._sun(1);
    this.needsRender = true;
  };

  /** Moves the shadow light so it covers a model of the given world size. */
  Viewer.prototype._sun = function (scale) {
    var s = Math.max(0.05, scale);
    var cam = this.sun.shadow.camera;
    var p = this.holder.position;
    this.sun.position.set(p.x + 0.6 * s * 2, p.y + 1.6 * s * 2, p.z + 0.9 * s * 2);
    this.sun.target.position.copy(p);
    cam.left = cam.bottom = -s * 1.4;
    cam.right = cam.top = s * 1.4;
    cam.near = 0.001;
    cam.far = s * 8;
    cam.updateProjectionMatrix();
  };

  /** Size in metres of the longest side for a given AR scale. */
  Viewer.prototype.setMetricSize = function (meters) {
    this.holder.scale.setScalar(this.unit * meters);
    this._sun(meters);
    this.needsRender = true;
  };

  Viewer.prototype.setAutoRotate = function (on) { this.controls.autoRotate = !!on; this.needsRender = true; };

  /** Moves the canvas into another element (the AR layer) and back. */
  Viewer.prototype.mount = function (el, before) {
    if (before) el.insertBefore(this.renderer.domElement, before);
    else el.appendChild(this.renderer.domElement);
    this.resize();
  };

  window.TSSViewer = Viewer;
})();
