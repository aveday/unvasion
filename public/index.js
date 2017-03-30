"use strict";

window.addEventListener("resize", initCanvas, false);
let canvas = document.getElementById("canvas");

let panel = {
  header: document.getElementsByTagName("header")[0],
  progressBar: document.getElementById("progressBar"),
  progressBorder: document.getElementById("progressBorder"),
  playerCount: document.getElementById("playerCount"),
};

const BUILDING_PARTS = 7;
const UNIT_SIZE = 0.04;
const GAP_SIZE = 0.05;
const DASH_SIZE = 0.1;

let usePixelArt = true;
let blines = true;

let playerColors = ["blue", "red"];

let context = canvas.getContext("2d");
let socket = io();

let player = 0;
let commands = new Map();
let mouse = {};

let mapScale, geoScale;
let mapImages = [];
let frame = 0;
let frameInterval;

let regions, players;

function corner(region) {
  return [(region.x - 0.5) * geoScale, (region.y - 0.5) * geoScale];
}

function playerColor(player) {
  let index = players.indexOf(player);
  return playerColors[index % playerColors.length];
}

function drawRegion(region) {
  context.fillShape(0, 0, region.points, geoScale, 0);
  context.stroke();
}

function drawBuilding(region) {
  let gap = GAP_SIZE * geoScale;
  let size = geoScale - gap * 2;
  let part = size / BUILDING_PARTS;
  let [x, y] = corner(region).map(c => c + gap);

  if (region.building === 1) {
    context.fillRect(x, y, size, size);
    context.strokeRect(x, y, size, size);
  } else for (let i = 0; i < BUILDING_PARTS; ++i) {
    context.fillRect(x, y + i * part, size, part * region.building);
  }
}

function drawPlans(targets, origin) {
  targets.forEach(target => {
    if (target === origin && origin.player === undefined) {
      let gap = GAP_SIZE * geoScale / 2;
      let size = geoScale - gap * 2;
      let [x, y] = corner(origin).map(c => c + gap);
      context.strokeRect(x, y, size, size);
    }
  });
}

function drawUnits(region) {
  if (region.units.length === 0) return;
  let [x, y] = corner(region);

  context.fillStyle = playerColor(region.player);

  let e = Math.ceil(Math.sqrt(region.units.length));
  let m = Math.floor((e*e - region.units.length) / 2);

  context.beginPath();
  for (let n = m; n < region.units.length + m; ++n) {
    let ux = x + (Math.floor(n / e) + 0.5)/e *  geoScale;
    let uy = y + (n % e + 0.5)/e *  geoScale;
    context.moveTo(ux, uy);
    context.arc(ux, uy, UNIT_SIZE * geoScale, 0, 2 * Math.PI);
  }
  context.closePath();
  context.fill();
}

function drawMoves(targets, origin) {
  if (origin.player !== player)
    return;
  //TODO fill red for attacks
  targets.forEach(target =>
    context.fillShape(
      geoScale * (target.x + origin.x) / 2,
      geoScale * (target.y + origin.y) / 2,
      target === origin ? shapes.square : shapes.arrow,
      geoScale / 8 / Math.sqrt(targets.length),
      Math.atan2(target.y - origin.y, target.x - origin.x)));
}

function draw() {
  if (usePixelArt && mapImages.length) {
    context.imageSmoothingEnabled = false;
    let img = mapImages[frame % mapImages.length];
    context.drawImage(img, 0, 0, img.width * mapScale, img.height * mapScale);

    let soldier = document.getElementById("soldier");
    regions.filter(region => region.units.length).forEach(region => {
      context.drawImage(soldier,
        region.x * geoScale,
        region.y * geoScale,
        soldier.width * mapScale,
        soldier.height * mapScale);
    });

  } else {
    // water
    fillCanvas(canvas, "#3557a0");

    // regions
    context.globalAlpha = 1;
    context.lineWidth = 2;
    context.fillStyle = "#4f9627";
    context.strokeStyle = "#3f751f";
    regions.filter(t => t.terrain >= 0).forEach(drawRegion);

    // buildings
    context.strokeStyle = "#5b2000";
    context.fillStyle = "#9b500d";
    regions.filter(region => region.building).forEach(drawBuilding);

    // units
    context.lineWidth = 0;
    regions.filter(region => region.units.length).forEach(drawUnits);
  }

  // building commands
  context.setLineDash([geoScale*DASH_SIZE, geoScale*DASH_SIZE]);
  context.strokeStyle = "yellow";
  commands.forEach(drawPlans);
  context.setLineDash([]);

  // movement commands
  context.globalAlpha = 0.3;
  context.lineWidth = 0;
  context.fillStyle = "yellow";
  commands.forEach(drawMoves);
  context.globalAlpha = 1;

}

function initCanvas() {
  if (!regions) return;
  // find largest possible regionsize while still fitting entire map
  let maxHeight = window.innerHeight * 0.95 - panel.header.offsetHeight;
  let maxWidth = window.innerWidth * 0.95;

  let {width, height} = mapImages[0];

  mapScale = Math.floor(Math.min(maxHeight / height, maxWidth / width));
  geoScale = mapScale * 16; //appu FIXME

  // restrict canvas size
  canvas.width = width * mapScale;
  canvas.height = height * mapScale;

  //TODO this automatically by putting both elements in a div
  panel.progressBorder.style.width = canvas.width + "px";

  clearInterval(frameInterval);
  frameInterval = setInterval(() => {++frame; draw()}, 1000);
  draw(); 
}

function addCommand(origin, target) {
  // check the command is between connected regions
  if ( ![origin.id, ...origin.connected].includes(target.id)
    || ![player, undefined].includes(origin.player)
    || target.terrain < 0 )
    return;

  let targets = commands.get(origin) || commands.set(origin, []).get(origin);

  // remove commands
  if (targets.includes(target)) {
    targets.splice(targets.indexOf(target), 1);
    if (!targets.length)
      delete commands.delete(origin);
  }
  // building commands
  else if (origin.player === undefined) {
    // only allow plans adjacent to friendly regions
    if (origin.connected.some(id => regions[id].player === player))
      targets.push(target);
  }
  // movement commands
  else if (origin.player === player) {
    targets.push(target);
    // remove the first target if there's too many
    if (targets.length > origin.units.length)
      targets.shift();
  }

  draw();
}

function sendCommands() {
  // convert commands to regionIds and send to the server
  // TODO split up and send commands individually
  let commandIds = Array.from(commands, command => {
    let [origin, targets] = command;
    return [origin.id, targets.map(target => target.id)];
  });

  socket.emit("sendCommands", commandIds);
  commands.clear();
  mouse = {};
}

function loadState(state) {
  players = state.players;
  regions = state.regions;
  panel.playerCount.innerHTML = players.length;
  draw();
}

function loadMap(imageURLs) {
  imageURLs.forEach(url => {
    let image = new Image();
    image.src = url;
    mapImages.push(image);
  });
  mapImages[0].onload = initCanvas;
}

progressBar.start = function(turnTime) {
  this.style.width = "0%";
  this.style.transition = "width 0s";
  this.offsetLeft; // hack to split up transition properties
  this.style.transition = "width " + turnTime + "ms linear";
  this.style.width = "100%";
};

function startTurn(turnTime) {
  // place construction commands on adjacent unfinished buildings
  regions.filter(t => t.building && t.building < 1 && !t.units.length)
      .filter(t => t.connected.some(id => regions[id].player === player))
      .forEach(t => addCommand(t, t));

  progressBar.start(turnTime);
}

function pointInRegion(region, x, y) {
  context.beginPath()
  region.points.forEach(point => context.lineTo(...point));
  context.closePath();
  return context.isPointInPath(x / geoScale, y / geoScale);
}

function getClickedRegion(e) {
  let [canvasX, canvasY] = elementCoords(canvas, e.pageX, e.pageY);
  let [x, y] = [canvasX / geoScale, canvasY / geoScale];
  let closest = closestPoint(x, y, regions);
  //let region = pointInRegion(closest, x, y) ? closest : undefined; FIXME
  return closest;
}

canvas.addEventListener("mousedown", e => {
  mouse.down = getClickedRegion(e);
});

canvas.addEventListener("mouseup", e => {
  mouse.up = getClickedRegion(e);
  if (mouse.up && mouse.down)
    addCommand(mouse.down, mouse.up);
  mouse = {};
});

socket.on("reload", () => window.location.reload()); 
socket.on("msg", msg => console.log(msg)); 
socket.on("sendPlayerId", id => player = id);
socket.on("sendState", loadState);
socket.on("sendMap", loadMap);
socket.on("startTurn", startTurn);
socket.on("requestCommands", sendCommands);

