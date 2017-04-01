"use strict";

window.addEventListener("resize", initCanvas, false);
let canvas = document.getElementById("canvas");

const sprites = {
  soldier: document.getElementById("soldier"),
  flagbearer: document.getElementById("flagbearer"),
  town: document.getElementById("town"),
  water: document.getElementById("water"),
}

const BUILDING_PARTS = 7;
const UNIT_SIZE = 0.04;
const GAP_SIZE = 0.05;
const DASH_SIZE = 0.1;

let usePixelArt = true;

let playerColors = ["blue", "red"];

let context = canvas.getContext("2d");
let mapCanvas = document.createElement("canvas");
let mapContext = mapCanvas.getContext("2d");

let waterContext = document.createElement("canvas").getContext("2d");
let waterPattern;

let socket = io();
let player = 0;
let commands = new Map();
let mouse = {};

let mapScale, geoScale, ppu;
let offset = [0, 0];
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

function tileDraw(context, image, position, center=true, tile) {
  tile = tile || [0, 0, image.width, image.height];
  let size = tile.slice(2,4);
  let dest = position.map((c, i) => c * ppu - (center ? size[i] / 2 : 0));
  dest = dest.map(Math.floor);
  let source = [tile[0] * tile[2], tile[1] * tile[3], tile[2], tile[3]];
  context.drawImage(image, ...source, ...dest, ...size);
}

function draw() {
  context.imageSmoothingEnabled = false;
  let mapOffset = offset.map(c => Math.floor(c * ppu));
  let geoOffset = offset.map(c => Math.floor(c * geoScale));
  let mapCanvasSize = [mapCanvas.width, mapCanvas.height];

  // draw water before translation
  if (usePixelArt && mapImages.length)
    mapContext.drawImage(waterContext.canvas,
      ...mapOffset.map(c => 32 - c % 32 + frame %2),
      ...mapCanvasSize, 0, 0, ...mapCanvasSize);
  else
    fillCanvas(canvas, "#3557a0");

  if (usePixelArt && mapImages.length) {
    mapContext.translate(...mapOffset);
    // TODO only composite on changes

    // draw map image
    let img = mapImages[frame % mapImages.length];
    mapContext.drawImage(img, 0, 0);
    // draw unit sprites
    for (const region of regions.filter(r => r.units.length))
      unitPositions(region).forEach((pos, i) =>
        tileDraw(mapContext, i ? sprites.soldier : sprites.flagbearer, pos));
    // draw buildings
    for (const region of regions.filter(r => r.building)) {
      let townFrame = Math.floor(Math.min(region.building * 4, 4));
      let tile = [townFrame, 0, 32, 32];
      tileDraw(mapContext, sprites.town, [region.x, region.y], true, tile);
    }

    mapContext.translate(...mapOffset.map(c => -c));
    if (usePixelArt)
      context.drawImage(
        mapContext.canvas,
        ...offset.map(c => c * geoScale % mapScale - mapScale),
        mapCanvas.width * mapScale, mapCanvas.height * mapScale);

  } else {
    context.translate(...geoOffset);

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

    context.translate(...geoOffset.map(c => -c));
  }

  // TODO add pixmap version, move to geo draw block above
  context.translate(...geoOffset);
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
  context.translate(...geoOffset.map(c => -c));
}

function toggleGraphics() {
  usePixelArt = !usePixelArt;
  usePixelArt && initMapCanvas();
  draw();
}

function initCanvas() {
  canvas.height = window.innerHeight;
  canvas.width = window.innerWidth;
  geoScale = 48; //FIXME
  usePixelArt && initMapCanvas();
  draw(); 
}

function initMapCanvas() {
  if (!mapImages.length) return;
  ppu = 24; //FIXME

  // scale map canvas
  mapScale = geoScale / ppu;
  let {width, height} = mapImages[0];
  mapCanvas.width = canvas.width / mapScale + 2;
  mapCanvas.height = canvas.height / mapScale + 2;

  // set up water canvas
  waterContext.canvas.width = canvas.width + sprites.water.width;
  waterContext.canvas.height = canvas.height + sprites.water.height;
  waterPattern = waterContext.createPattern(sprites.water, "repeat");
  fillCanvas(waterContext.canvas, waterPattern);

  // start frame interval
  clearInterval(frameInterval);
  frameInterval = setInterval(() => {++frame; draw()}, 1000);
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

function startTurn(turnTime) {
  // place construction commands on adjacent unfinished buildings
  regions.filter(t => t.building && t.building < 1 && !t.units.length)
      .filter(t => t.connected.some(id => regions[id].player === player))
      .forEach(t => addCommand(t, t));
}

function pointInRegion(region, x, y) {
  context.beginPath()
  region.points.forEach(point => context.lineTo(...point));
  context.closePath();
  return context.isPointInPath(x / geoScale, y / geoScale);
}

function getClickedRegion(e) {
  let canvasPoint = elementCoords(canvas, e.pageX, e.pageY);
  let mapPoint = canvasPoint.map((c, i) => c / geoScale - offset[i]);
  let closest = closestPoint(...mapPoint, regions);
  //let region = pointInRegion(closest, x, y) ? closest : undefined; FIXME
  return closest;
}

canvas.addEventListener("mousedown", e => {
  switch(e.button) {
    case 0:
      mouse.down = getClickedRegion(e);
      break;
    case 1:
      mouse.panning = true;
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
    case 1:
      mouse.panning = false;
    case 2:
      break;
  }
});

canvas.addEventListener("mousemove", e => {
  if (mouse.panning) {
    offset[0] += e.movementX / geoScale;
    offset[1] += e.movementY / geoScale;
    draw();
  }
});

canvas.addEventListener("wheel", e => {
  let ec = elementCoords(canvas, e.pageX, e.pageY);
  let gs = geoScale;
  geoScale = Math.max(geoScale - e.deltaY / 5, ppu);
  usePixelArt && initMapCanvas();
  offset = offset.map((c, i) => c - ec[i]/gs + ec[i]/geoScale);
  draw();
});

socket.on("reload", () => window.location.reload()); 
socket.on("msg", msg => console.log(msg)); 
socket.on("sendPlayerId", id => player = id);
socket.on("sendState", loadState);
socket.on("sendMap", loadMap);
socket.on("startTurn", startTurn);
socket.on("requestCommands", sendCommands);

