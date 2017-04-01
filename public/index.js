"use strict";

window.addEventListener("resize", initCanvas, false);
let canvas = document.getElementById("canvas");

let panel = {
  header: document.getElementsByTagName("header")[0],
  progressBar: document.getElementById("progressBar"),
  progressBorder: document.getElementById("progressBorder"),
  playerCount: document.getElementById("playerCount"),
};

const sprites = {
  soldier: document.getElementById("soldier"),
  flagbearer: document.getElementById("flagbearer"),
  town: document.getElementById("town"),
}

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
let mapOffset = [0, 0];
let mapImages = [];
let frame = 0;
let frameInterval;

let regions, players, unitSpots;

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

function unitPositions(region) {
  //TODO calculate and parameterise unit spread
  return region.units.map((unit, i) => {
    let spot = unitSpots[i].map(c => c * (1 + 4/region.units.length));
    return [region.x + spot[0], region.y + spot[1]]
  });
}

function drawUnits(region, draw) {
  if (region.units.length === 0) return;
  context.fillStyle = playerColor(region.player);
  context.beginPath();

  for (const pos of unitPositions(region)) {
    let screenPos = pos.map(c => c*geoScale);
    context.moveTo(...screenPos);
    context.arc( ...screenPos, UNIT_SIZE * geoScale, 0, 2 * Math.PI);
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

function scaledDraw(context, image, position, center=true, tile) {
  tile = tile || [0, 0, image.width, image.height];
  let size = tile.slice(2,4).map(c => c * mapScale);
  let dest = position.map((c, i) => c * geoScale - (center ? size[i] / 2 : 0));
  let source = [tile[0] * tile[2], tile[1] * tile[3], tile[2], tile[3]];
  context.drawImage(image, ...source, ...dest, ...size);
}

function draw() {

  if (usePixelArt && mapImages.length) {
    // TODO only composite on changes

    // draw map image
    context.imageSmoothingEnabled = false;
    let img = mapImages[frame % mapImages.length];
    scaledDraw(context, img, [0, 0], false);
    // draw unit sprites
    for (const region of regions.filter(r => r.units.length))
      unitPositions(region).forEach((pos, i) =>
        scaledDraw(context, i ? sprites.soldier : sprites.flagbearer, pos));
    // draw buildings
    for (const region of regions.filter(r => r.building)) {
      let townFrame = Math.floor(Math.min(region.building * 4, 4));
      let tile = [townFrame, 0, 32, 32];
      scaledDraw(context, sprites.town, [region.x, region.y], true, tile);
    }

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
  geoScale = mapScale * 24; //appu FIXME

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
  unitSpots = state.spots; //FIXME this is static, shouldn't be updated
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

  if (turnTime)
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
  switch(e.button) {
    case 0:
      mouse.down = getClickedRegion(e);
      break;
    case 2:
      sendCommands();
      break;
  }
});

canvas.addEventListener("mouseup", e => {
  switch(e.button) {
    case 0:
      mouse.up = getClickedRegion(e);
      mouse.up && mouse.down && addCommand(mouse.down, mouse.up);
      mouse = {};
      break;
    case 2:
      break;
  }
});

canvas.addEventListener("wheel", e => {
  context.translate(...mapOffset.map(c => -c * geoScale));
  fillCanvas(canvas, "#101010");

  let cPos = elementCoords(canvas, e.pageX, e.pageY)
  let gs1 = geoScale;
  mapScale = Math.max(mapScale - e.deltaY / 100, 1);
  geoScale = mapScale * 24; //appu FIXME
  mapOffset = mapOffset.map((c, i) => c + cPos[i] * (1/geoScale - 1/gs1));

  context.translate(...mapOffset.map(c => c * geoScale));
  draw();
});

socket.on("reload", () => window.location.reload()); 
socket.on("msg", msg => console.log(msg)); 
socket.on("sendPlayerId", id => player = id);
socket.on("sendState", loadState);
socket.on("sendMap", loadMap);
socket.on("startTurn", startTurn);
socket.on("requestCommands", sendCommands);

