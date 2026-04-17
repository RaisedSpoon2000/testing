const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const enemyImg = document.getElementById("enemySprite");
let gameWon = false;
let bobTime = 0;

function createSeededRandom(seed) {
  // Simple LCG: deterministic, fast, good enough for subtle texture variation.
  let s = seed >>> 0;
  return function rand() {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rand = createSeededRandom(
  ((Date.now() & 0xffffffff) ^ ((performance.now() * 1000) | 0)) >>> 0
);

function generateWallTexture() {
  const texSize = 64;
  const c = document.createElement("canvas");
  c.width = texSize;
  c.height = texSize;
  const tctx = c.getContext("2d");

  const base = { r: 0x5a, g: 0x2d, b: 0x0c }; // #5a2d0c
  const mortar = "#3a1a06";

  // Mortar background first.
  tctx.fillStyle = mortar;
  tctx.fillRect(0, 0, texSize, texSize);

  const brickW = 16;
  const brickH = 8;
  const mortarPx = 1;

  for (let row = 0; row < Math.ceil(texSize / brickH); row++) {
    const y = row * brickH;
    const offset = row % 2 === 0 ? 0 : brickW / 2;

    for (let col = -1; col < Math.ceil(texSize / brickW) + 1; col++) {
      const x = Math.floor(col * brickW + offset);

      // Slight per-brick brightness variation.
      const v = 0.82 + rand() * 0.36; // ~[0.82..1.18]
      const r = Math.max(0, Math.min(255, Math.round(base.r * v)));
      const g = Math.max(0, Math.min(255, Math.round(base.g * v)));
      const b = Math.max(0, Math.min(255, Math.round(base.b * v)));

      tctx.fillStyle = `rgb(${r},${g},${b})`;
      tctx.fillRect(
        x + mortarPx,
        y + mortarPx,
        brickW - mortarPx * 2,
        brickH - mortarPx * 2
      );
    }
  }

  // Mortar grid lines on top (helps keep definition after scaling).
  tctx.strokeStyle = mortar;
  tctx.lineWidth = 1;
  tctx.beginPath();
  for (let y = 0; y <= texSize; y += brickH) {
    tctx.moveTo(0, y + 0.5);
    tctx.lineTo(texSize, y + 0.5);
  }
  for (let x = 0; x <= texSize; x += brickW / 2) {
    tctx.moveTo(x + 0.5, 0);
    tctx.lineTo(x + 0.5, texSize);
  }
  tctx.stroke();

  return c;
}

const wallTexture = generateWallTexture();
ctx.imageSmoothingEnabled = false;

// --- Raycasting (basic 3D wall slices; flat colors only) ---
const RAYCAST = {
  fov: (70 * Math.PI) / 180, // radians (natural feel: ~60–75)
  rayCount: 90, // overwritten on resize (one ray per screen column)
  step: 0.02, // tiles per step (smaller = more accurate, slower)
  maxDist: 30, // tiles
};

function resizeCanvas() {
  // Match the canvas drawing buffer to the element's displayed size.
  // This keeps rendering crisp and avoids stretched pixels.
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));

  // One ray per screen column eliminates visible slice seams.
  RAYCAST.rayCount = canvas.width;

  // Resizing the canvas resets context state (including smoothing).
  ctx.imageSmoothingEnabled = false;
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// --- Basic 2D map + player (top-down minimap only; no 3D yet) ---
// Map legend: 0 = empty, 1 = wall
const map = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1],
  [1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1],
  [1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1],
  [1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1],
  [1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1],
  [1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

const mapHeight = map.length;
const mapWidth = map[0].length;

const player = {
  // Spawn in an empty tile (starting inside a wall prevents movement due to collision).
  x: 1.5, // in "map units" (tiles)
  y: 1.5,
  dir: 0, // radians
  moveSpeed: 3.2, // tiles per second (top speed)
  radius: 0.18, // collision radius in tiles
  // Smoothing (simple acceleration model; keeps controls responsive but less "digital")
  moveVel: 0, // tiles/sec (signed, forward/back)
  moveAccel: 18, // tiles/sec^2
  strafeVel: 0, // tiles/sec (signed, left/right)
};

const keys = {
  forward: false,
  backward: false,
  left: false,
  right: false,
};

function setKeyState(e, isDown) {
  const k = e.key.toLowerCase();

  // Move forward/back: W/S or ArrowUp/ArrowDown
  if (k === "w" || e.key === "ArrowUp") keys.forward = isDown;
  if (k === "s" || e.key === "ArrowDown") keys.backward = isDown;

  // Strafe left/right: A/D or ArrowLeft/ArrowRight
  if (k === "a" || e.key === "ArrowLeft") keys.left = isDown;
  if (k === "d" || e.key === "ArrowRight") keys.right = isDown;
}

window.addEventListener("keydown", (e) => setKeyState(e, true));
window.addEventListener("keyup", (e) => setKeyState(e, false));

function isWallAt(x, y) {
  // Treat out-of-bounds as solid walls.
  const mx = Math.floor(x);
  const my = Math.floor(y);
  if (mx < 0 || my < 0 || mx >= mapWidth || my >= mapHeight) return true;
  return map[my][mx] === 1;
}

function canStandAt(x, y, radius) {
  // Simple "circle vs grid" approximation: check the four corner points
  // around the player's bounding box.
  return (
    !isWallAt(x - radius, y - radius) &&
    !isWallAt(x + radius, y - radius) &&
    !isWallAt(x - radius, y + radius) &&
    !isWallAt(x + radius, y + radius)
  );
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

let lastShot = null; // { x, y, angle, timeMs }
let lastShootTimeMs = -Infinity;
let score = 0;

const ENEMY_START_POSITIONS = [
  // Placed in open corridors (tile centers). Keep static for now.
  { x: 6.5, y: 1.5 },
  { x: 9.5, y: 1.5 },
  { x: 5.5, y: 3.5 },
  { x: 8.5, y: 3.5 },
  { x: 2.5, y: 5.5 },
  { x: 9.5, y: 5.5 },
  { x: 4.5, y: 7.5 },
  { x: 7.5, y: 9.5 },
];

const enemies = ENEMY_START_POSITIONS.map((p) => ({ x: p.x, y: p.y }));

function restartGame() {
  score = 0;
  gameWon = false;

  player.x = 1.5;
  player.y = 1.5;
  player.dir = 0;
  player.moveVel = 0;
  player.strafeVel = 0;

  enemies.length = 0;
  for (let i = 0; i < ENEMY_START_POSITIONS.length; i++) {
    const p = ENEMY_START_POSITIONS[i];
    enemies.push({ x: p.x, y: p.y });
  }
}

// Mouse-look (pointer lock)
let mouseDeltaX = 0;
const MOUSE_SENSITIVITY = 0.0024; // radians per pixel

function wrapAngle(rad) {
  let a = rad;
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

function castSingleRay(angle) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  let dist = 0;
  let hitX = player.x;
  let hitY = player.y;
  let hitSide = 0;
  let hit = false;

  while (dist < RAYCAST.maxDist) {
    const x = player.x + dx * dist;
    const y = player.y + dy * dist;
    if (isWallAt(x, y)) {
      hit = true;
      hitX = x;
      hitY = y;
      hitSide = Math.abs(dx) > Math.abs(dy) ? 1 : 2;
      break;
    }
    dist += RAYCAST.step;
  }

  const correctedDist = Math.max(0.0001, dist * Math.cos(angle - player.dir));
  return { angle, dist, correctedDist, hitX, hitY, hitSide, hit };
}

function shoot(nowMs) {
  const t = nowMs ?? performance.now();
  const ray = castSingleRay(player.dir); // center of screen == facing direction
  lastShootTimeMs = t;

  if (ray.hit) lastShot = { x: ray.hitX, y: ray.hitY, angle: ray.angle, timeMs: t };

  // Score only increments when a shot hits an enemy (not walls).
  const rdx = Math.cos(player.dir);
  const rdy = Math.sin(player.dir);
  const maxT = ray.hit ? ray.dist : RAYCAST.maxDist;

  let bestIdx = -1;
  let bestT = Infinity;
  for (let i = 0; i < enemies.length; i++) {
    const ex = enemies[i].x;
    const ey = enemies[i].y;
    const vx = ex - player.x;
    const vy = ey - player.y;
    const along = vx * rdx + vy * rdy; // projection onto ray direction
    if (along <= 0 || along > maxT) continue;
    const perp = Math.abs(vx * rdy - vy * rdx); // perpendicular distance (dir is unit)
    if (perp <= 0.4 && along < bestT) {
      bestT = along;
      bestIdx = i;
    }
  }

  if (bestIdx !== -1) {
    enemies.splice(bestIdx, 1);
    score += 5;
    if (enemies.length === 0) gameWon = true;
  }

  console.log(
    ray.hit
      ? `Shot hit at (${ray.hitX.toFixed(2)}, ${ray.hitY.toFixed(2)}) dist=${ray.dist.toFixed(2)}`
      : "Shot: no hit"
  );
}

function castRays() {
  const rays = [];
  const halfFov = RAYCAST.fov / 2;

  for (let i = 0; i < RAYCAST.rayCount; i++) {
    const t = RAYCAST.rayCount === 1 ? 0.5 : i / (RAYCAST.rayCount - 1);
    const angle = player.dir - halfFov + t * RAYCAST.fov;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    let dist = 0;
    let hitX = player.x;
    let hitY = player.y;
    let hitSide = 0; // 0 = unknown, 1 = more "vertical" (x), 2 = more "horizontal" (y)

    while (dist < RAYCAST.maxDist) {
      const x = player.x + dx * dist;
      const y = player.y + dy * dist;
      if (isWallAt(x, y)) {
        hitX = x;
        hitY = y;
        // Which face did we likely hit? Use the larger component as a cheap proxy.
        hitSide = Math.abs(dx) > Math.abs(dy) ? 1 : 2;
        break;
      }
      dist += RAYCAST.step;
    }

    // Fish-eye correction: project the ray length onto the view direction.
    const correctedDist = Math.max(0.0001, dist * Math.cos(angle - player.dir));

    rays.push({ angle, dist, correctedDist, hitX, hitY, hitSide });
  }

  return rays;
}

function draw3D(rays) {
  // Ceiling + floor gradients (darker at edges, slightly lighter at horizon)
  const halfH = canvas.height / 2;

  const ceilGrad = ctx.createLinearGradient(0, 0, 0, halfH);
  ceilGrad.addColorStop(0, "#050505");
  ceilGrad.addColorStop(1, "#141414");
  ctx.fillStyle = ceilGrad;
  ctx.fillRect(0, 0, canvas.width, halfH);

  const floorGrad = ctx.createLinearGradient(0, halfH, 0, canvas.height);
  floorGrad.addColorStop(0, "#141414");
  floorGrad.addColorStop(1, "#050505");
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, halfH, canvas.width, halfH);

  const projPlaneDist = canvas.width / 2 / Math.tan(RAYCAST.fov / 2);
  const sliceW = canvas.width / rays.length;

  for (let i = 0; i < rays.length; i++) {
    const d = rays[i].correctedDist;

    // Tile size is 1.0 in map units, so height is proportional to 1/d.
    const wallH = Math.min(canvas.height, (1 / d) * projPlaneDist);
    const top = (canvas.height - wallH) / 2;

    const x = i * sliceW;
    const destW = sliceW + 1;

    // Texture X coordinate from fractional hit position.
    const frac =
      rays[i].hitSide === 1
        ? rays[i].hitY - Math.floor(rays[i].hitY)
        : rays[i].hitX - Math.floor(rays[i].hitX);
    const texX = Math.max(0, Math.min(63, Math.floor(frac * 64)));

    ctx.drawImage(wallTexture, texX, 0, 1, 64, x, top, destW, wallH);

    // Keep distance shading with a dark overlay (plus a tiny side cue).
    let shadeAlpha = clamp01(d / 12) * 0.75;
    if (rays[i].hitSide === 2) shadeAlpha = Math.min(0.88, shadeAlpha + 0.08);
    ctx.fillStyle = `rgba(0,0,0,${shadeAlpha})`;
    ctx.fillRect(x, top, destW, wallH);
  }
}

function drawEnemies3D(rays) {
  if (!enemies.length) return;
  if (!enemyImg || !enemyImg.complete || enemyImg.naturalWidth === 0) return;

  const halfFov = RAYCAST.fov / 2;
  const projPlaneDist = canvas.width / 2 / Math.tan(RAYCAST.fov / 2);
  const sliceW = canvas.width / rays.length;
  const halfH = canvas.height / 2;

  // Draw far-to-near so closer enemies overwrite farther ones (still clipped by walls).
  const ordered = enemies
    .map((e) => {
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      const dist = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const rel = wrapAngle(ang - player.dir);
      return { e, dist, rel };
    })
    .filter((o) => Math.abs(o.rel) <= halfFov && o.dist > 0.001)
    .sort((a, b) => b.dist - a.dist);

  for (const o of ordered) {
    const correctedDist = o.dist * Math.cos(o.rel);
    if (correctedDist <= 0.0001) continue;

    const screenX = (0.5 + o.rel / RAYCAST.fov) * canvas.width;
    const spriteH = Math.min(canvas.height, (1 / correctedDist) * projPlaneDist);
    const spriteW = Math.max(sliceW * 2, spriteH * 0.22);
    const left = screenX - spriteW / 2;
    const top = halfH - spriteH / 2;

    const startCol = Math.max(0, Math.floor(left / sliceW));
    const endCol = Math.min(rays.length - 1, Math.floor((left + spriteW) / sliceW));

    let startVisibleCol = -1;
    let endVisibleCol = -1;
    for (let col = startCol; col <= endCol; col++) {
      // Hide behind walls using the ray depth buffer.
      if (correctedDist >= rays[col].correctedDist) continue;
      if (startVisibleCol === -1) startVisibleCol = col;
      endVisibleCol = col;
    }

    if (startVisibleCol === -1) continue;

    const clipX = startVisibleCol * sliceW;
    const visibleWidth = (endVisibleCol - startVisibleCol + 1) * sliceW;

    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, top, visibleWidth, spriteH);
    ctx.clip();
    ctx.drawImage(enemyImg, left, top, spriteW, spriteH);
    ctx.restore();
  }
}

function getShootFlashAlpha(nowMs) {
  return 1 - clamp01((nowMs - lastShootTimeMs) / 150);
}

function drawShootVignette(nowMs) {
  const a = getShootFlashAlpha(nowMs);
  if (a <= 0) return;

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const maxR = Math.max(canvas.width, canvas.height) * 0.75;
  const g = ctx.createRadialGradient(cx, cy, maxR * 0.2, cx, cy, maxR);
  g.addColorStop(0, "rgba(255,0,0,0)");
  g.addColorStop(0.7, "rgba(255,0,0,0)");
  g.addColorStop(1, `rgba(255,0,0,${0.45 * a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawCrosshair(nowMs) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const size = Math.max(6, Math.min(12, Math.floor(canvas.width * 0.012)));

  const a = getShootFlashAlpha(nowMs);
  ctx.strokeStyle = a > 0 ? `rgba(255,70,70,${0.9 * a})` : "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - size, cy);
  ctx.lineTo(cx + size, cy);
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx, cy + size);
  ctx.stroke();

  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawHud() {
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "18px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`SCORE: ${score}`, canvas.width / 2, canvas.height - 10);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function updatePlayer(dt) {
  // Smooth movement using a tiny acceleration model.
  const forwardInput = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
  const strafeInput = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);

  const targetForwardVel = forwardInput * player.moveSpeed;
  const targetStrafeVel = strafeInput * player.moveSpeed;

  const moveMaxStep = player.moveAccel * dt;
  player.moveVel += Math.max(
    -moveMaxStep,
    Math.min(moveMaxStep, targetForwardVel - player.moveVel)
  );
  player.strafeVel += Math.max(
    -moveMaxStep,
    Math.min(moveMaxStep, targetStrafeVel - player.strafeVel)
  );

  // Mouse look (pointer lock) is the only camera control.
  if (mouseDeltaX !== 0) {
    player.dir += mouseDeltaX * MOUSE_SENSITIVITY;
    mouseDeltaX = 0;
  }

  if (Math.abs(player.moveVel) > 0.05 || Math.abs(player.strafeVel) > 0.05) {
    bobTime += dt * 8;
  }

  if (Math.abs(player.moveVel) < 0.0001 && Math.abs(player.strafeVel) < 0.0001) return;

  const forwardStep = player.moveVel * dt;
  const strafeStep = player.strafeVel * dt;

  const forwardDx = Math.cos(player.dir) * forwardStep;
  const forwardDy = Math.sin(player.dir) * forwardStep;

  const strafeDx = Math.cos(player.dir + Math.PI / 2) * strafeStep;
  const strafeDy = Math.sin(player.dir + Math.PI / 2) * strafeStep;

  const dx = forwardDx + strafeDx;
  const dy = forwardDy + strafeDy;

  // Resolve collisions by axis (simple and stable).
  const nextX = player.x + dx;
  if (canStandAt(nextX, player.y, player.radius)) player.x = nextX;

  const nextY = player.y + dy;
  if (canStandAt(player.x, nextY, player.radius)) player.y = nextY;
}

function drawMinimap(rays) {
  const padding = 12;
  const availableW = canvas.width - padding * 2;
  const availableH = canvas.height - padding * 2;

  // Fit the whole map into the corner.
  const tileSize = Math.floor(
    Math.max(6, Math.min(32, Math.min(availableW / mapWidth, availableH / mapHeight)))
  );

  const mapPixelW = tileSize * mapWidth;
  const mapPixelH = tileSize * mapHeight;

  const originX = padding;
  const originY = padding;

  // Minimap background
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(originX - 6, originY - 6, mapPixelW + 12, mapPixelH + 12);

  // Walls / floor grid
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      const cell = map[y][x];
      if (cell === 1) {
        ctx.fillStyle = "#bdbdbd";
        ctx.fillRect(originX + x * tileSize, originY + y * tileSize, tileSize, tileSize);
      } else {
        ctx.fillStyle = "#141414";
        ctx.fillRect(originX + x * tileSize, originY + y * tileSize, tileSize, tileSize);
      }
    }
  }

  // Optional subtle grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= mapWidth; x++) {
    const px = originX + x * tileSize;
    ctx.beginPath();
    ctx.moveTo(px, originY);
    ctx.lineTo(px, originY + mapPixelH);
    ctx.stroke();
  }
  for (let y = 0; y <= mapHeight; y++) {
    const py = originY + y * tileSize;
    ctx.beginPath();
    ctx.moveTo(originX, py);
    ctx.lineTo(originX + mapPixelW, py);
    ctx.stroke();
  }

  // Player
  const px = originX + player.x * tileSize;
  const py = originY + player.y * tileSize;
  const dirLen = tileSize * 0.7;

  // Enemies
  if (enemies.length) {
    ctx.fillStyle = "rgb(255, 40, 40)";
    for (let i = 0; i < enemies.length; i++) {
      const ex = originX + enemies[i].x * tileSize;
      const ey = originY + enemies[i].y * tileSize;
      ctx.beginPath();
      ctx.arc(ex, ey, Math.max(2, tileSize * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.fillStyle = "#35c7ff";
  ctx.beginPath();
  ctx.arc(px, py, Math.max(2, tileSize * 0.18), 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#35c7ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + Math.cos(player.dir) * dirLen, py + Math.sin(player.dir) * dirLen);
  ctx.stroke();

  // Rays (debug)
  if (rays && rays.length) {
    ctx.strokeStyle = "rgba(53,199,255,0.25)";
    ctx.lineWidth = 1;
    for (let i = 0; i < rays.length; i++) {
      const rx = originX + rays[i].hitX * tileSize;
      const ry = originY + rays[i].hitY * tileSize;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(rx, ry);
      ctx.stroke();
    }
  }

  // Last shot hit marker (simple visual feedback)
  if (lastShot) {
    const ageMs = performance.now() - lastShot.timeMs;
    if (ageMs < 700) {
      const alpha = 1 - clamp01(ageMs / 700);
      const sx = originX + lastShot.x * tileSize;
      const sy = originY + lastShot.y * tileSize;

      ctx.strokeStyle = `rgba(255, 70, 70, ${0.9 * alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(sx, sy);
      ctx.stroke();

      ctx.fillStyle = `rgba(255, 70, 70, ${0.95 * alpha})`;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2, tileSize * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

let lastTimeMs = performance.now();

function frame(nowMs) {
  if (gameWon) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font = "bold 72px system-ui, sans-serif";
    ctx.fillText("YOU WIN!", canvas.width / 2, canvas.height / 2 - 30);

    ctx.font = "28px system-ui, sans-serif";
    ctx.fillText(`FINAL SCORE: ${score}`, canvas.width / 2, canvas.height / 2 + 35);

    ctx.fillStyle = "#8a8a8a";
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText("Press R to play again", canvas.width / 2, canvas.height / 2 + 75);

    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    return;
  }

  // Clamp dt to avoid huge jumps after tab-switching / lag spikes.
  const dt = Math.min(0.05, (nowMs - lastTimeMs) / 1000);
  lastTimeMs = nowMs;

  updatePlayer(dt);

  // Clear screen each frame.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const rays = castRays();
  const isMoving = Math.abs(player.moveVel) > 0.05 || Math.abs(player.strafeVel) > 0.05;
  const bobY = isMoving ? Math.sin(bobTime) * 3 : 0;
  ctx.save();
  ctx.translate(0, bobY);
  draw3D(rays);
  drawEnemies3D(rays);
  ctx.restore();
  drawShootVignette(nowMs);
  drawCrosshair(nowMs);
  drawMinimap(rays);
  drawHud();

  // Tiny debug HUD
  ctx.fillStyle = "#7a7a7a";
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillText(
    `W/S or ↑/↓: move | A/D or ←/→: strafe | pos: (${player.x.toFixed(2)}, ${player.y.toFixed(
      2
    )})`,
    12,
    canvas.height - 14
  );

  requestAnimationFrame(frame);
}

function requestMouseLook() {
  if (document.pointerLockElement === canvas) return;
  canvas.requestPointerLock?.();
}

document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  mouseDeltaX += e.movementX || 0;
});

canvas.addEventListener("mousedown", (e) => {
  // Only shoot on left click.
  if (e.button !== 0) return;
  requestMouseLook();
  shoot();
});

window.addEventListener("keydown", (e) => {
  if (!gameWon) return;
  if (e.key !== "r" && e.key !== "R") return;
  restartGame();
  requestAnimationFrame(frame);
});

requestAnimationFrame(frame);
