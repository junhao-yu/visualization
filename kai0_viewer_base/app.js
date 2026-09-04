const state = {
  data: null,
  frames: [],
  filteredFrames: [],
  losses: [],
  lossesLeft: [],
  lossesRight: [],
  eeErrors: [],
  eeErrorsLeft: [],
  eeErrorsRight: [],
  selected: 0,
  episodeFilter: "all",
  detailCache: new Map(),
  currentDetail: null,
  lossLayout: null,
  isLive: false,
  lastId: -1,
  autoFollow: true,
  pollTimer: null,
};

let trajectory3D = null;
let liveThreeViewer = null;
let threeLoadFailed = false;
let threeModulesPromise = null;

const ACTION_GROUPS = [
  { label: "Left Arm (7)", count: 7 },
  { label: "Right Arm (7)", count: 7 },
  { label: "Left Hand (6)", count: 6 },
  { label: "Right Hand (6)", count: 6 },
  { label: "Waist (2) yaw/roll", count: 2 },
  { label: "Head (2) yaw/pitch", count: 2 },
];

const el = {
  metaTask: document.getElementById("metaTask"),
  metaCkpt: document.getElementById("metaCkpt"),
  metaFrames: document.getElementById("metaFrames"),
  metaMode: document.getElementById("metaMode"),
  metaActionIdx: document.getElementById("metaActionIdx"),
  lossChart: document.getElementById("lossChart"),
  stateChart: document.getElementById("stateChart"),
  actionChart: document.getElementById("actionChart"),
  episodeSelect: document.getElementById("episodeSelect"),
  frameSlider: document.getElementById("frameSlider"),
  frameInput: document.getElementById("frameInput"),
  jumpButton: document.getElementById("jumpButton"),
  kpiFrame: document.getElementById("kpiFrame"),
  kpiLoss: document.getElementById("kpiLoss"),
  kpiLossLR: document.getElementById("kpiLossLR"),
  kpiEeError: document.getElementById("kpiEeError"),
  kpiEeErrorLR: document.getElementById("kpiEeErrorLR"),
  detailEpisode: document.getElementById("detailEpisode"),
  detailFrame: document.getElementById("detailFrame"),
  detailGlobal: document.getElementById("detailGlobal"),
  detailTimestamp: document.getElementById("detailTimestamp"),
  detailLoss: document.getElementById("detailLoss"),
  detailLossLeft: document.getElementById("detailLossLeft"),
  detailLossRight: document.getElementById("detailLossRight"),
  detailLossGlobal: document.getElementById("detailLossGlobal"),
  detailEeError: document.getElementById("detailEeError"),
  detailEeLeft: document.getElementById("detailEeLeft"),
  detailEeRight: document.getElementById("detailEeRight"),
  frameImage: document.getElementById("frameImage"),
  frameImageGrid: document.getElementById("frameImageGrid"),
  imageCaption: document.getElementById("imageCaption"),
  trajectoryFrame: document.getElementById("trajectoryFrame"),
  trajectoryPlaceholder: document.getElementById("trajectoryPlaceholder"),
  trajectoryCanvas: document.getElementById("trajectoryCanvas"),
};

const urlParams = new URLSearchParams(window.location.search);
state.isLive = urlParams.get("mode") === "live" || urlParams.get("live") === "1";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toFiniteOrNull(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function meanFromNumericObject(value) {
  if (!value || typeof value !== "object") return null;
  const vals = Object.values(value)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((acc, cur) => acc + cur, 0) / vals.length;
}

function getFrameEeError(frame) {
  if (!frame || typeof frame !== "object") return null;
  const direct = toFiniteOrNull(frame.ee_error_mean);
  if (direct !== null) return direct;

  const detailMean = meanFromNumericObject(frame.detail?.ee_error_by_link);
  if (detailMean !== null) return detailMean;

  const legacy = toFiniteOrNull(frame.loss_ee_global ?? frame.loss_ee);
  if (legacy !== null) return legacy;
  return null;
}

function inferSideFromName(name) {
  if (!name) return null;
  const text = String(name).trim().toLowerCase();
  if (!text) return null;
  const sideAliases = {
    hand_link: "left",
    hand_link_l: "left",
    hand_link_r: "right",
    fl_link8: "left",
    fr_link8: "right",
  };
  if (sideAliases[text]) {
    return sideAliases[text];
  }
  if (text.startsWith("fr_")) {
    return "right";
  }
  if (text.startsWith("fl_")) {
    return "left";
  }
  if (text.includes("right") || text.endsWith("_r") || text.startsWith("r_") || text.includes("_r_")) {
    return "right";
  }
  if (text.includes("left") || text.endsWith("_l") || text.startsWith("l_") || text.includes("_l_")) {
    return "left";
  }
  return null;
}

function meanFromNumericObjectBySide(value, side) {
  if (!value || typeof value !== "object") return null;
  const vals = Object.entries(value)
    .filter(([name]) => inferSideFromName(name) === side)
    .map(([, v]) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((acc, cur) => acc + cur, 0) / vals.length;
}

function computeL1OnIndices(pred, target, indices) {
  if (!Array.isArray(pred) || !Array.isArray(target)) return null;
  if (pred.length !== target.length) return null;
  if (!indices.length) return null;
  const diffs = indices
    .filter((idx) => idx >= 0 && idx < pred.length && idx < target.length)
    .map((idx) => Math.abs(Number(pred[idx]) - Number(target[idx])))
    .filter((v) => Number.isFinite(v));
  if (!diffs.length) return null;
  return diffs.reduce((acc, cur) => acc + cur, 0) / diffs.length;
}

function getFallbackL1ByMagicLayout(frame, side) {
  const pred = frame?.detail?.action_pred;
  const target = frame?.detail?.action_target;
  if (!Array.isArray(pred) || !Array.isArray(target) || pred.length !== target.length) return null;
  if (pred.length < 26) return null;
  const leftIndices = [0, 1, 2, 3, 4, 5, 6, 14, 15, 16, 17, 18, 19];
  const rightIndices = [7, 8, 9, 10, 11, 12, 13, 20, 21, 22, 23, 24, 25];
  return computeL1OnIndices(pred, target, side === "left" ? leftIndices : rightIndices);
}

function getFrameLossSide(frame, side) {
  if (!frame || typeof frame !== "object") return null;
  const direct = toFiniteOrNull(side === "left" ? frame.loss_l1_left : frame.loss_l1_right);
  if (direct !== null) return direct;
  return getFallbackL1ByMagicLayout(frame, side);
}

function getFrameEeErrorSide(frame, side) {
  if (!frame || typeof frame !== "object") return null;
  const direct = toFiniteOrNull(side === "left" ? frame.ee_error_left : frame.ee_error_right);
  if (direct !== null) return direct;
  const byLink = meanFromNumericObjectBySide(frame.detail?.ee_error_by_link, side);
  if (byLink !== null) return byLink;
  return null;
}

function formatMetric(value, digits = 6) {
  return value === null ? "-" : Number(value).toFixed(digits);
}

function refreshMetricSeries() {
  state.losses = state.filteredFrames.map((frame) => toFiniteOrNull(frame.loss_l1) ?? 0);
  state.lossesLeft = state.filteredFrames.map((frame) => getFrameLossSide(frame, "left"));
  state.lossesRight = state.filteredFrames.map((frame) => getFrameLossSide(frame, "right"));
  state.eeErrors = state.filteredFrames.map((frame) => getFrameEeError(frame));
  state.eeErrorsLeft = state.filteredFrames.map((frame) => getFrameEeErrorSide(frame, "left"));
  state.eeErrorsRight = state.filteredFrames.map((frame) => getFrameEeErrorSide(frame, "right"));
}

function sizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { width: rect.width, height: rect.height };
}

function drawLossChart() {
  if (!state.losses.length) {
    const ctx = el.lossChart.getContext("2d");
    const { width, height } = sizeCanvas(el.lossChart);
    ctx.clearRect(0, 0, width, height);
    state.lossLayout = null;
    return;
  }
  const { width, height } = sizeCanvas(el.lossChart);
  const ctx = el.lossChart.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const pad = 32;
  const xSpan = Math.max(1, state.losses.length - 1);

  const hasLossSplit =
    state.lossesLeft.some((val) => val !== null) || state.lossesRight.some((val) => val !== null);
  const hasEeSplit =
    state.eeErrorsLeft.some((val) => val !== null) || state.eeErrorsRight.some((val) => val !== null);

  const lossSeries = hasLossSplit
    ? [
        { name: "L1-L", data: state.lossesLeft, color: "#0ea5e9" },
        { name: "L1-R", data: state.lossesRight, color: "#14b8a6" },
      ].filter((item) => item.data.some((v) => v !== null))
    : [{ name: "L1", data: state.losses, color: "#0ea5e9" }];

  const eeSeries = hasEeSplit
    ? [
        { name: "EE-L", data: state.eeErrorsLeft, color: "#f97316" },
        { name: "EE-R", data: state.eeErrorsRight, color: "#ef4444" },
      ].filter((item) => item.data.some((v) => v !== null))
    : state.eeErrors.some((v) => v !== null)
      ? [{ name: "EE", data: state.eeErrors, color: "#f97316" }]
      : [];

  const lossValues = lossSeries.flatMap((item) => item.data).filter((v) => v !== null);
  const eeValues = eeSeries.flatMap((item) => item.data).filter((v) => v !== null);

  const minLoss = lossValues.length ? Math.min(...lossValues) : 0;
  const maxLoss = lossValues.length ? Math.max(...lossValues) : 1;
  const spanLoss = maxLoss - minLoss || 1;
  const hasEe = eeValues.length > 0;
  const minEe = hasEe ? Math.min(...eeValues) : 0;
  const maxEe = hasEe ? Math.max(...eeValues) : 1;
  const spanEe = maxEe - minEe || 1;

  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(15, 118, 110, 0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, height - pad);
  ctx.lineTo(width - pad, height - pad);
  ctx.stroke();

  ctx.strokeStyle = "rgba(15, 118, 110, 0.25)";
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, height - pad);
  ctx.stroke();

  function drawSeries(data, minVal, spanVal, color, lineWidth) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    let drawing = false;
    data.forEach((val, idx) => {
      if (val === null) {
        drawing = false;
        return;
      }
      const x = pad + ((width - pad * 2) * idx) / xSpan;
      const y = pad + (height - pad * 2) * (1 - (val - minVal) / spanVal);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }

  lossSeries.forEach((item) => drawSeries(item.data, minLoss, spanLoss, item.color, 2));
  eeSeries.forEach((item) => drawSeries(item.data, minEe, spanEe, item.color, 1.6));

  const selected = clamp(state.selected, 0, state.losses.length - 1);
  const selX = pad + ((width - pad * 2) * selected) / xSpan;
  ctx.strokeStyle = "rgba(249, 115, 22, 0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(selX, pad);
  ctx.lineTo(selX, height - pad);
  ctx.stroke();

  function drawSelectedMarker(value, minVal, spanVal, color, style) {
    if (value === null) return;
    const y = pad + (height - pad * 2) * (1 - (value - minVal) / spanVal);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (style === "square") {
      ctx.rect(selX - 3, y - 3, 6, 6);
    } else {
      ctx.arc(selX, y, 4, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  lossSeries.forEach((item) =>
    drawSelectedMarker(item.data[selected] ?? null, minLoss, spanLoss, item.color, "circle")
  );
  eeSeries.forEach((item) =>
    drawSelectedMarker(item.data[selected] ?? null, minEe, spanEe, item.color, "square")
  );

  const legendItems = [...lossSeries, ...eeSeries];
  if (legendItems.length) {
    let legendX = pad;
    const legendY = 26;
    ctx.font = "11px 'Space Grotesk', sans-serif";
    legendItems.forEach((item) => {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(legendX, legendY - 3);
      ctx.lineTo(legendX + 12, legendY - 3);
      ctx.stroke();
      legendX += 16;
      ctx.fillStyle = "#6b7280";
      ctx.fillText(item.name, legendX, legendY);
      legendX += ctx.measureText(item.name).width + 12;
    });
  }

  ctx.fillStyle = "#6b7280";
  ctx.font = "12px 'Space Grotesk', sans-serif";
  ctx.fillText(`L1 max ${maxLoss.toFixed(4)}`, pad, 16);
  ctx.fillText(`L1 min ${minLoss.toFixed(4)}`, pad, height - 8);
  if (hasEe) {
    ctx.fillStyle = "#ea580c";
    ctx.textAlign = "right";
    ctx.fillText(`EoE max ${maxEe.toFixed(4)}`, width - pad, 16);
    ctx.fillText(`EoE min ${minEe.toFixed(4)}`, width - pad, height - 8);
    ctx.textAlign = "left";
  }

  state.lossLayout = { pad, width, height, xSpan };
}

function drawTrajectory(points, color) {
  const canvas = el.trajectoryCanvas;
  if (!canvas || !points || points.length < 2) {
    return;
  }
  const { width, height } = sizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  return { ctx, width, height };
}

function drawTrajectorySeries(canvas, series) {
  if (!canvas || !series.length) {
    return;
  }
  const { width, height } = sizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillRect(0, 0, width, height);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  series.forEach(({ points }) => {
    points.forEach(([x, y]) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    });
  });
  const pad = 20;
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  series.forEach(({ points, color }) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach(([x, y], idx) => {
      const px = pad + ((x - minX) / spanX) * (width - pad * 2);
      const py = height - pad - ((y - minY) / spanY) * (height - pad * 2);
      if (idx === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    });
    ctx.stroke();
  });
}

async function loadThreeModules() {
  if (threeModulesPromise) return threeModulesPromise;
  threeModulesPromise = Promise.all([
    import("https://cdn.jsdelivr.net/npm/three@0.158.0/build/three.module.js"),
    import("https://cdn.jsdelivr.net/npm/three@0.158.0/examples/jsm/controls/OrbitControls.js"),
  ]).then(([threeMod, controlsMod]) => ({
    THREE: threeMod,
    OrbitControls: controlsMod.OrbitControls,
  }));
  return threeModulesPromise;
}

class LiveTrajectory3DViewer {
  constructor(canvas, THREE, OrbitControls) {
    this.canvas = canvas;
    this.THREE = THREE;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);
    this.camera = new THREE.PerspectiveCamera(45, 2, 0.01, 50);
    this.camera.position.set(1.6, 1.2, 1.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.6, 0);
    this.controls.update();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const light = new THREE.DirectionalLight(0xffffff, 0.8);
    light.position.set(2, 3, 2);
    this.scene.add(light);
    this.scene.add(new THREE.GridHelper(2, 20, 0xe5e7eb, 0xf3f4f6));
    this.lines = new Map();
    this.trajRotation = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    this._resize();
    this.controls.addEventListener("change", () => this.render());
    window.addEventListener("resize", () => this._resize());
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.renderer.setSize(rect.width, rect.height, false);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  _buildGeometry(points) {
    const { THREE } = this;
    const vecs = points.map((p) =>
      new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(this.trajRotation)
    );
    return new THREE.BufferGeometry().setFromPoints(vecs);
  }

  update(series) {
    const { THREE } = this;
    const keep = new Set();
    series.forEach((item) => {
      const id = item.id;
      keep.add(id);
      const color = item.color;
      const points = item.points;
      if (!points.length) return;
      const geometry = this._buildGeometry(points);
      if (this.lines.has(id)) {
        const line = this.lines.get(id);
        line.geometry.dispose();
        line.geometry = geometry;
        line.material.color = new THREE.Color(color);
      } else {
        const material = new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(geometry, material);
        this.scene.add(line);
        this.lines.set(id, line);
      }
    });

    for (const [id, line] of this.lines.entries()) {
      if (!keep.has(id)) {
        this.scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
        this.lines.delete(id);
      }
    }
    this.render();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

function createTrajectory3DRenderer(canvas) {
  const state3d = {
    yaw: -0.8,
    pitch: 0.5,
    zoom: 1.0,
    center: [0, 0, 0],
    radius: 1,
    series: [],
    dragging: false,
    lastX: 0,
    lastY: 0,
  };

  function computeBounds(series) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    series.forEach(({ points }) => {
      points.forEach(([x, y, z]) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      });
    });
    if (!Number.isFinite(minX)) {
      return { center: [0, 0, 0], radius: 1 };
    }
    const center = [
      (minX + maxX) * 0.5,
      (minY + maxY) * 0.5,
      (minZ + maxZ) * 0.5,
    ];
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const spanZ = maxZ - minZ;
    const radius = Math.max(spanX, spanY, spanZ) * 0.5 || 1;
    return { center, radius };
  }

  function projectPoint(point, width, height) {
    const [cx, cy, cz] = state3d.center;
    let x = point[0] - cx;
    let y = point[1] - cy;
    let z = point[2] - cz;
    const cosY = Math.cos(state3d.yaw);
    const sinY = Math.sin(state3d.yaw);
    const x1 = cosY * x + sinY * z;
    const z1 = -sinY * x + cosY * z;
    const cosX = Math.cos(state3d.pitch);
    const sinX = Math.sin(state3d.pitch);
    const y2 = cosX * y - sinX * z1;
    const z2 = sinX * y + cosX * z1;
    const scale = (Math.min(width, height) / (state3d.radius * 2.2)) * state3d.zoom;
    return {
      x: width * 0.5 + x1 * scale,
      y: height * 0.5 - y2 * scale,
      z: z2,
    };
  }

  function drawAxes(ctx, width, height) {
    const axisLen = state3d.radius * 1.2;
    const origin = projectPoint([state3d.center[0], state3d.center[1], state3d.center[2]], width, height);
    const axes = [
      { dir: [axisLen, 0, 0], color: "#ef4444" },
      { dir: [0, axisLen, 0], color: "#22c55e" },
      { dir: [0, 0, axisLen], color: "#3b82f6" },
    ];
    axes.forEach(({ dir, color }) => {
      const end = projectPoint(
        [state3d.center[0] + dir[0], state3d.center[1] + dir[1], state3d.center[2] + dir[2]],
        width,
        height
      );
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    });
  }

  function draw() {
    if (!state3d.series.length) {
      return;
    }
    const { width, height } = sizeCanvas(canvas);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(0, 0, width, height);
    drawAxes(ctx, width, height);

    state3d.series.forEach(({ points, color }) => {
      if (!points.length) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      points.forEach((p, idx) => {
        const proj = projectPoint(p, width, height);
        if (idx === 0) {
          ctx.moveTo(proj.x, proj.y);
        } else {
          ctx.lineTo(proj.x, proj.y);
        }
      });
      ctx.stroke();
      const last = projectPoint(points[points.length - 1], width, height);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function update(series) {
    state3d.series = series;
    const bounds = computeBounds(series);
    state3d.center = bounds.center;
    state3d.radius = bounds.radius;
    draw();
  }

  function onPointerDown(event) {
    state3d.dragging = true;
    state3d.lastX = event.clientX;
    state3d.lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!state3d.dragging) return;
    const dx = event.clientX - state3d.lastX;
    const dy = event.clientY - state3d.lastY;
    state3d.lastX = event.clientX;
    state3d.lastY = event.clientY;
    state3d.yaw += dx * 0.005;
    state3d.pitch = clamp(state3d.pitch + dy * 0.005, -1.4, 1.4);
    draw();
  }

  function onPointerUp(event) {
    state3d.dragging = false;
    canvas.releasePointerCapture(event.pointerId);
  }

  function onWheel(event) {
    event.preventDefault();
    const delta = Math.sign(event.deltaY);
    state3d.zoom = clamp(state3d.zoom * (1 - delta * 0.08), 0.3, 4.0);
    draw();
  }

  function onDoubleClick() {
    state3d.yaw = -0.8;
    state3d.pitch = 0.5;
    state3d.zoom = 1.0;
    draw();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", () => {
    state3d.dragging = false;
  });
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);

  window.addEventListener("resize", () => draw());

  return { update, draw };
}

async function setupTrajectoryViewer() {
  if (!el.trajectoryFrame || !el.trajectoryPlaceholder) {
    return;
  }
  if (state.isLive) {
    el.trajectoryFrame.style.display = "none";
    el.trajectoryCanvas.style.display = "none";
    el.trajectoryPlaceholder.style.display = "none";
    window.setInterval(async () => {
      try {
        const response = await fetch("/api/trajectory");
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        const pred = payload.trajectory_pred || payload.trajectory || [];
        const gt = payload.trajectory_gt || [];
        if (!pred.length && !gt.length) {
          el.trajectoryCanvas.style.display = "none";
          el.trajectoryPlaceholder.style.display = "none";
          return;
        }
        const normalizePoints = (traj) => {
          const points = [];
          let hasZ = false;
          if (!Array.isArray(traj)) {
            return { points, hasZ };
          }
          traj.forEach((p) => {
            let x;
            let y;
            let z;
            if (Array.isArray(p)) {
              x = p[0];
              y = p[1];
              z = p[2];
            } else if (p && typeof p === "object") {
              x = p.x ?? p[0];
              y = p.y ?? p[1];
              z = p.z ?? p[2];
            }
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              return;
            }
            if (Number.isFinite(z)) {
              hasZ = true;
              points.push([x, y, z]);
            } else {
              points.push([x, y, 0]);
            }
          });
          return { points, hasZ };
        };

        const predPalette = ["#0ea5e9", "#38bdf8", "#7dd3fc", "#0ea5e9"];
        const gtPalette = ["#f97316", "#fb923c", "#fdba74", "#f97316"];
        const collectSeries = (traj, palette, prefix) => {
          const series = [];
          if (Array.isArray(traj)) {
            const info = normalizePoints(traj);
            if (info.points.length) {
              series.push({ id: `${prefix}:default`, points: info.points, color: palette[0], hasZ: info.hasZ });
            }
            return series;
          }
          if (traj && typeof traj === "object") {
            Object.entries(traj).forEach(([name, points], idx) => {
              const info = normalizePoints(points);
              if (info.points.length) {
                series.push({
                  id: `${prefix}:${name}`,
                  points: info.points,
                  color: palette[idx % palette.length],
                  hasZ: info.hasZ,
                });
              }
            });
          }
          return series;
        };

        const predSeries = collectSeries(pred, predPalette, "pred");
        const gtSeries = collectSeries(gt, gtPalette, "gt");
        const allSeries = [...gtSeries, ...predSeries];
        if (!allSeries.length) {
          el.trajectoryCanvas.style.display = "none";
          el.trajectoryPlaceholder.style.display = "none";
          return;
        }
        el.trajectoryPlaceholder.style.display = "none";
        el.trajectoryCanvas.style.display = "block";
        const has3D = allSeries.some((item) => item.hasZ);
        if (has3D) {
          if (liveThreeViewer === null && !threeLoadFailed) {
            try {
              const { THREE, OrbitControls } = await loadThreeModules();
              liveThreeViewer = new LiveTrajectory3DViewer(el.trajectoryCanvas, THREE, OrbitControls);
            } catch (err) {
              console.warn("Three.js viewer failed, falling back to 2D", err);
              threeLoadFailed = true;
            }
          }
          if (liveThreeViewer) {
            liveThreeViewer.update(allSeries);
          } else {
            const series2d = allSeries.map((item) => ({
              points: item.points.map((p) => [p[0], p[1]]),
              color: item.color,
            }));
            drawTrajectorySeries(el.trajectoryCanvas, series2d);
          }
        } else {
          const series2d = allSeries.map((item) => ({
            points: item.points.map((p) => [p[0], p[1]]),
            color: item.color,
          }));
          drawTrajectorySeries(el.trajectoryCanvas, series2d);
        }
      } catch (error) {
        console.warn("Trajectory poll failed", error);
      }
    }, 1000);
    return;
  }
  try {
    const response = await fetch("ee_viewer/index.html", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Trajectory viewer not found");
    }
    el.trajectoryFrame.src = "ee_viewer/index.html";
    el.trajectoryFrame.style.display = "block";
    el.trajectoryCanvas.style.display = "none";
    el.trajectoryPlaceholder.style.display = "none";
  } catch (error) {
    el.trajectoryPlaceholder.textContent = "Trajectory viewer not available.";
    el.trajectoryFrame.style.display = "none";
    el.trajectoryCanvas.style.display = "none";
  }
}

function renderImages(frame) {
  if (!frame) {
    return;
  }
  const grid = el.frameImageGrid;
  const single = el.frameImage;

  if (frame.image_data && typeof frame.image_data === "object") {
    const entries = Object.entries(frame.image_data);
    grid.innerHTML = "";
    entries.forEach(([key, data]) => {
      if (!data) {
        return;
      }
      const item = document.createElement("div");
      item.className = "image-item";
      const img = document.createElement("img");
      img.src = data;
      img.alt = key;
      const label = document.createElement("span");
      label.textContent = key;
      item.appendChild(img);
      item.appendChild(label);
      grid.appendChild(item);
    });
    grid.style.display = entries.length ? "grid" : "none";
    single.style.display = "none";
    return;
  }

  grid.innerHTML = "";
  grid.style.display = "none";
  single.style.display = "block";
  if (frame.image_data) {
    single.src = frame.image_data;
  } else if (frame.image_path) {
    single.src = frame.image_path;
  } else {
    single.removeAttribute("src");
  }
}

function drawBarChart(canvas, series, options) {
  if (!series || !series.length || !series[0].length) {
    return;
  }
  const { width, height } = sizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const padX = 18;
  const padY = options.padY ?? 22;
  const extraBottom = options.extraBottom ?? 0;
  const chartHeight = height - padY * 2 - extraBottom;
  const count = series[0].length;
  const seriesCount = series.length;
  const colors = options.colors || ["#0f766e", "#f97316"];
  const minLabelAbs = options.minLabelAbs ?? 0.02;

  let maxAbs = 0;
  series.forEach((arr) => {
    arr.forEach((val) => {
      maxAbs = Math.max(maxAbs, Math.abs(val));
    });
  });
  maxAbs = maxAbs || 1;
  const baseline = padY + chartHeight * 0.5;
  const barGroup = (width - padX * 2) / count;
  const rawBarWidth = (barGroup * 0.92) / seriesCount;
  const barWidth = Math.min(18, Math.max(6, rawBarWidth));
  const autoEvery = Math.max(1, Math.ceil(count / 10));
  const labelEvery =
    options.labelEvery ??
    (barWidth < 16 ? Math.max(autoEvery, Math.ceil(16 / barWidth)) : autoEvery);

  ctx.strokeStyle = "rgba(31, 41, 51, 0.1)";
  ctx.beginPath();
  ctx.moveTo(padX, baseline);
  ctx.lineTo(width - padX, baseline);
  ctx.stroke();

  series.forEach((arr, sIdx) => {
    ctx.fillStyle = colors[sIdx % colors.length];
    arr.forEach((val, idx) => {
      const xStart = padX + idx * barGroup + barWidth * sIdx + barGroup * 0.1;
      const barHeight = (Math.abs(val) / maxAbs) * (chartHeight / 2);
      const yStart = val >= 0 ? baseline - barHeight : baseline;
      ctx.fillRect(xStart, yStart, barWidth, barHeight);

      if (idx % labelEvery === 0 && Math.abs(val) >= minLabelAbs) {
        const label = val.toFixed(2);
        ctx.font = "5px 'Space Grotesk', sans-serif";
        const metrics = ctx.measureText(label);
        const labelX = xStart;
        const labelY = val >= 0 ? yStart - 6 : yStart + barHeight + 14;
        const bgX = labelX - 2;
        const bgY = val >= 0 ? labelY - 10 : labelY - 8;
        ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
        ctx.fillRect(bgX, bgY, metrics.width + 4, 12);
        ctx.fillStyle = "#1f2933";
        ctx.fillText(label, labelX, labelY);
        ctx.fillStyle = colors[sIdx % colors.length];
      }
    });
  });

  if (options.groups && options.groups.length) {
    let cursor = 0;
    const labelY1 = padY + chartHeight + 14;
    const labelY2 = padY + chartHeight + 28;
    ctx.font = "10px 'Space Grotesk', sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.strokeStyle = "rgba(31, 41, 51, 0.12)";
    options.groups.forEach((group) => {
      const startX = padX + cursor * barGroup;
      const endX = padX + (cursor + group.count) * barGroup;
      const midX = (startX + endX) / 2;
      const available = Math.max(0, endX - startX - 6);
      let label = group.label;
      if (ctx.measureText(label).width > available) {
        label = label
          .replace(/\s*\(.*\)/, "")
          .replace("Left", "L")
          .replace("Right", "R")
          .replace("Hand", "Hand")
          .replace("Arm", "Arm")
          .replace("Waist", "Waist")
          .replace("Head", "Head");
      }
      if (ctx.measureText(label).width > available) {
        label = label.slice(0, Math.max(3, Math.floor(available / 6))) + "…";
      }
      ctx.beginPath();
      ctx.moveTo(startX, padY + chartHeight + 4);
      ctx.lineTo(startX, padY + chartHeight + 12);
      ctx.stroke();
      const row = cursor % 2;
      const labelY = row === 0 ? labelY1 : labelY2;
      ctx.fillText(label, midX - ctx.measureText(label).width / 2, labelY);
      cursor += group.count;
    });
    const endX = padX + cursor * barGroup;
    ctx.beginPath();
    ctx.moveTo(endX, padY + chartHeight + 4);
    ctx.lineTo(endX, padY + chartHeight + 12);
    ctx.stroke();
  }
}

async function loadIndexOffline() {
  const response = await fetch("index.json");
  state.data = await response.json();
  state.frames = state.data.frames || [];

  const meta = state.data.meta || {};
  el.metaTask.textContent = meta.task_name || "-";
  el.metaCkpt.textContent = (meta.ckpt_path || "-").split("/").slice(-2).join("/");
  el.metaFrames.textContent = meta.num_frames ?? state.frames.length;
  el.metaActionIdx.textContent = meta.action_index ?? 0;
  if (el.metaMode) {
    el.metaMode.textContent = "Offline";
  }

  bindEvents();
  buildEpisodeOptions();
  applyEpisodeFilter("all");
  await setupTrajectoryViewer();
}

function updateMeta(meta) {
  if (!meta) {
    return;
  }
  if (meta.task_name !== undefined) {
    el.metaTask.textContent = meta.task_name || "-";
  }
  if (meta.ckpt_path !== undefined) {
    el.metaCkpt.textContent = (meta.ckpt_path || "-").split("/").slice(-2).join("/");
  }
  if (meta.action_index !== undefined) {
    el.metaActionIdx.textContent = meta.action_index ?? 0;
  }
}

function appendFrames(frames) {
  if (!frames || !frames.length) {
    return;
  }
  const shouldFollow =
    state.isLive || (state.autoFollow && state.selected >= state.filteredFrames.length - 1);
  state.frames = state.frames.concat(frames);
  if (state.episodeFilter === "all") {
    state.filteredFrames = state.frames;
  } else {
    const target = Number(state.episodeFilter);
    state.filteredFrames = state.frames.filter((frame) => frame.episode_index === target);
  }
  refreshMetricSeries();
  el.metaFrames.textContent = `${state.filteredFrames.length} / ${state.frames.length}`;
  el.frameSlider.max = Math.max(0, state.filteredFrames.length - 1);
  el.frameInput.max = Math.max(0, state.filteredFrames.length - 1);
  if (shouldFollow) {
    selectFrame(state.filteredFrames.length - 1);
  } else {
    drawLossChart();
  }
}

async function loadIndexLive() {
  const response = await fetch("/api/index");
  state.data = await response.json();
  state.frames = state.data.frames || [];
  state.lastId = state.data.last_id ?? -1;

  updateMeta(state.data.meta || {});
  if (el.metaMode) {
    el.metaMode.textContent = "Live";
  }

  bindEvents();
  buildEpisodeOptions();
  applyEpisodeFilter("all");
  if (state.isLive && state.filteredFrames.length) {
    selectFrame(state.filteredFrames.length - 1);
  }
  await setupTrajectoryViewer();

  state.pollTimer = window.setInterval(async () => {
    try {
      const streamResp = await fetch(`/api/stream?since=${state.lastId}`);
      const stream = await streamResp.json();
      if (stream.meta) {
        updateMeta(stream.meta);
      }
      if (stream.frames && stream.frames.length) {
        state.lastId = stream.last_id ?? state.lastId;
        appendFrames(stream.frames);
      }
    } catch (error) {
      console.warn("Live poll failed", error);
    }
  }, 500);
}

function bindEvents() {
  el.lossChart.addEventListener("click", (event) => {
    if (!state.lossLayout) {
      return;
    }
    const rect = el.lossChart.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const { pad, width, xSpan } = state.lossLayout;
    const ratio = clamp((x - pad) / (width - pad * 2), 0, 1);
    const index = Math.round(ratio * xSpan);
    selectFrame(index);
  });

  el.frameSlider.addEventListener("input", (event) => {
    selectFrame(Number(event.target.value));
  });

  el.jumpButton.addEventListener("click", () => {
    selectFrame(Number(el.frameInput.value));
  });

  if (el.episodeSelect) {
    el.episodeSelect.addEventListener("change", (event) => {
      applyEpisodeFilter(event.target.value);
    });
  }

  window.addEventListener("resize", () => {
    drawLossChart();
    if (state.currentDetail) {
      drawCharts(state.currentDetail);
    }
  });
}

async function selectFrame(index) {
  if (!state.data) {
    return;
  }
  if (!state.filteredFrames.length) {
    el.kpiFrame.textContent = "-";
    el.kpiLoss.textContent = "-";
    el.kpiLossLR.textContent = "-";
    el.kpiEeError.textContent = "-";
    el.kpiEeErrorLR.textContent = "-";
    el.detailLoss.textContent = "-";
    el.detailLossLeft.textContent = "-";
    el.detailLossRight.textContent = "-";
    el.detailLossGlobal.textContent = "-";
    el.detailEeError.textContent = "-";
    el.detailEeLeft.textContent = "-";
    el.detailEeRight.textContent = "-";
    el.detailEpisode.textContent = "-";
    el.detailFrame.textContent = "-";
    el.detailGlobal.textContent = "-";
    el.detailTimestamp.textContent = "-";
    el.imageCaption.textContent = "-";
    el.frameImage.removeAttribute("src");
    state.currentDetail = null;
    drawLossChart();
    return;
  }
  const safeIndex = clamp(index, 0, state.filteredFrames.length - 1);
  state.selected = safeIndex;
  el.frameSlider.value = safeIndex;
  el.frameInput.value = safeIndex;

  const frame = state.filteredFrames[safeIndex];
  el.kpiFrame.textContent = safeIndex;
  const lossVal = frame.loss_l1 ?? 0;
  const lossLeftVal = getFrameLossSide(frame, "left");
  const lossRightVal = getFrameLossSide(frame, "right");
  el.kpiLoss.textContent = formatMetric(lossVal);
  el.kpiLossLR.textContent = `${formatMetric(lossLeftVal)} / ${formatMetric(lossRightVal)}`;
  el.detailLoss.textContent = formatMetric(lossVal);
  el.detailLossLeft.textContent = formatMetric(lossLeftVal);
  el.detailLossRight.textContent = formatMetric(lossRightVal);
  const eeErrorVal = getFrameEeError(frame);
  const eeLeftVal = getFrameEeErrorSide(frame, "left");
  const eeRightVal = getFrameEeErrorSide(frame, "right");
  el.kpiEeError.textContent = formatMetric(eeErrorVal);
  el.kpiEeErrorLR.textContent = `${formatMetric(eeLeftVal)} / ${formatMetric(eeRightVal)}`;
  el.detailEeError.textContent = formatMetric(eeErrorVal);
  el.detailEeLeft.textContent = formatMetric(eeLeftVal);
  el.detailEeRight.textContent = formatMetric(eeRightVal);
  if (frame.loss_l1_global !== undefined && frame.loss_l1_global !== null) {
    el.detailLossGlobal.textContent = Number(frame.loss_l1_global).toFixed(6);
  } else {
    el.detailLossGlobal.textContent = "-";
  }
  el.detailEpisode.textContent =
    frame.episode_index === null ? "-" : frame.episode_index;
  el.detailFrame.textContent = frame.frame_index === null ? "-" : frame.frame_index;
  el.detailGlobal.textContent = frame.global_index;
  el.detailTimestamp.textContent =
    frame.timestamp === null ? "-" : frame.timestamp.toFixed(3);
  if (frame.image_data && typeof frame.image_data === "object") {
    el.imageCaption.textContent = `frame ${safeIndex} · ${Object.keys(frame.image_data).join(", ")}`;
  } else {
    el.imageCaption.textContent = `frame ${safeIndex}`;
  }
  renderImages(frame);

  drawLossChart();
  if (frame.detail) {
    state.currentDetail = frame.detail;
    drawCharts(frame.detail);
  } else {
    await loadDetail(frame.detail_path);
  }
}

function buildEpisodeOptions() {
  if (!el.episodeSelect) {
    return;
  }
  const counts = new Map();
  state.frames.forEach((frame) => {
    if (frame.episode_index === null || frame.episode_index === undefined) {
      return;
    }
    counts.set(frame.episode_index, (counts.get(frame.episode_index) || 0) + 1);
  });
  el.episodeSelect.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = `All (${state.frames.length})`;
  el.episodeSelect.appendChild(allOption);
  if (counts.size === 0) {
    el.episodeSelect.disabled = true;
    return;
  }
  el.episodeSelect.disabled = false;
  [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([episode, count]) => {
      const option = document.createElement("option");
      option.value = String(episode);
      option.textContent = `Episode ${episode} (${count})`;
      el.episodeSelect.appendChild(option);
    });
}

function applyEpisodeFilter(value) {
  if (!state.data) {
    return;
  }
  state.episodeFilter = value || "all";
  if (state.episodeFilter === "all") {
    state.filteredFrames = state.frames;
  } else {
    const target = Number(state.episodeFilter);
    state.filteredFrames = state.frames.filter(
      (frame) => frame.episode_index === target
    );
  }
  refreshMetricSeries();
  el.metaFrames.textContent = `${state.filteredFrames.length} / ${state.frames.length}`;
  el.frameSlider.max = Math.max(0, state.filteredFrames.length - 1);
  el.frameInput.max = Math.max(0, state.filteredFrames.length - 1);
  selectFrame(0);
}

async function loadDetail(path) {
  if (!path) {
    return;
  }
  if (state.detailCache.has(path)) {
    const cached = state.detailCache.get(path);
    state.currentDetail = cached;
    drawCharts(cached);
    return;
  }
  const response = await fetch(path);
  const detail = await response.json();
  state.detailCache.set(path, detail);
  state.currentDetail = detail;
  drawCharts(detail);
}

function drawCharts(detail) {
  if (!detail) {
    return;
  }
  const qpos = detail.qpos || [];
  const actionPred = detail.action_pred || [];
  const actionTarget = detail.action_target || [];
  drawBarChart(el.stateChart, [qpos], {
    colors: ["#0f766e"],
    labelEvery: 1,
    minLabelAbs: 0.0,
    groups: qpos.length === 30 ? ACTION_GROUPS : null,
    extraBottom: qpos.length === 30 ? 26 : 0,
  });
  drawBarChart(el.actionChart, [actionPred, actionTarget], {
    colors: ["#0ea5e9", "#f97316"],
    labelEvery: 1,
    minLabelAbs: 0.0,
    groups: actionPred.length === 30 ? ACTION_GROUPS : null,
    extraBottom: actionPred.length === 30 ? 26 : 0,
  });
}

const loader = state.isLive ? loadIndexLive : loadIndexOffline;
loader().catch((error) => {
  console.error("Failed to load loss viewer data", error);
});
