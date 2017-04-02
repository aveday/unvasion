"use strict";

window.addEventListener("resize", updateCanvas, false);
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

let map = {
  img: { frames: [] },
};

let movement = {
  moves: new Map(),
  duration: 1200,
  fps: 30,
  progress: 1,
}

let waterctx = document.createElement("canvas").getContext("2d");
let waterPattern;

let socket = io();
let player = 0;
let commands = new Map();
let mouse = {};

let scale, ppu;
let offset = [0, 0];
let frame = 0;
let frameInterval;

let regions, players, unitSpots;

let ctx = canvas.getContext("2d");
updateCanvas();

function corner(region) {
  return region.position.map(c => (c - 0.5) * scale);
}

function playerColor(player) {
  let index = players.indexOf(player);
  return playerColors[index % playerColors.length];
}

function drawRegion(region) {
  ctx.fillShape(0, 0, region.polygon, scale, 0);
  ctx.stroke();
}

function drawBuilding(region) {
  let gap = GAP_SIZE * scale;
  let size = scale - gap * 2;
  let part = size / BUILDING_PARTS;
  let [x, y] = corner(region).map(c => c + gap);

  if (region.building === 1) {
    ctx.fillRect(x, y, size, size);
    ctx.strokeRect(x, y, size, size);
  } else for (let i = 0; i < BUILDING_PARTS; ++i) {
    ctx.fillRect(x, y + i * part, size, part * region.building);
  }
}

function drawPlans(targets, origin) {
  targets.forEach(target => {
    if (target === origin && origin.player === null) {
      let gap = GAP_SIZE * scale / 2;
      let size = scale - gap * 2;
      let [x, y] = corner(origin).map(c => c + gap);
      ctx.strokeRect(x, y, size, size);
    }
  });
}

function getUnitPositions(region) {
  //TODO calculate and parameterise unit spread
  return region.units.map((unit, i) => {
    let spot = unitSpots[i].map(c => c * (1 + 4/region.units.length));
    return region.position.map((c, i) => c + spot[i]);
  });
}

function drawUnits(region, draw) {
  ctx.fillStyle = playerColor(region.player);
  ctx.beginPath();

  let positions = getUnitPositions(region);
  region.units.forEach((unit, i) => {
    let pos = positions[i].map(c => c * scale);
    if (movement.moves.has(unit)) {
      let origin = movement.moves.get(unit)
        .map(c => c * scale * (1 - movement.progress));
      pos = pos.map((c, i) => c * movement.progress + origin[i]);
    }
    ctx.moveTo(...pos);
    ctx.arc( ...pos, UNIT_SIZE * scale, 0, 2 * Math.PI);
  });

  ctx.closePath();
  ctx.fill();
}

function drawMoves(targets, origin) {
  if (origin.player !== player) return;
  //TODO fill red for attacks
  targets.forEach(t => {
    let dest = t.position.map((c, i) => (c+origin.position[i])/2 * scale);
    let shape = t === origin ? shapes.square : shapes.arrow;
    let size = scale / 8 / Math.sqrt(targets.length);
    let a = Math.atan2(...[1,0].map(i => t.position[i] - origin.position[i]));
    ctx.fillShape(...dest, shape, size, a);
  });
}

function tileDraw(ctx, image, position, center=true, tile) {
  tile = tile || [0, 0, image.width, image.height];
  let size = tile.slice(2,4);
  let dest = position.map((c, i) => c * ppu - (center ? size[i] / 2 : 0));
  dest = dest.map(Math.floor);
  let source = [tile[0] * tile[2], tile[1] * tile[3], tile[2], tile[3]];
  ctx.drawImage(image, ...source, ...dest, ...size);
}

function draw() {
  if (!regions) return //FIXME
  ctx.imageSmoothingEnabled = false;
  let mapOffset = offset.map(c => Math.floor(c * scale));
  let mapImgOffset = offset.map(c => Math.floor(c * ppu));

  // draw water before translation
  if (usePixelArt && map.img.loaded)
    map.img.ctx.drawImage(waterctx.canvas,
      ...mapImgOffset.map(c => 32 - c % 32 + frame %2),
      ...map.img.size, 0, 0, ...map.img.size);
  else
    fillCanvas(canvas, "#3557a0");

  if (usePixelArt && map.img.loaded) {
    map.img.ctx.translate(...mapImgOffset);
    // TODO only composite on changes

    // draw map image
    let img = map.img.frames[frame % map.img.frames.length];
    map.img.ctx.drawImage(img, 0, 0);

    // draw unit sprites
    for (const region of regions.filter(r => r.units.length)) {
      let positions = getUnitPositions(region);
      region.units.forEach((unit, i) => {
        let pos = positions[i];
        if (movement.moves.has(unit)) {
          let origin = movement.moves.get(unit)
            .map(c => c * (1 - movement.progress));
          pos = pos.map((c, i) => c * movement.progress + origin[i]);
        }
        tileDraw(map.img.ctx, i ? sprites.soldier : sprites.flagbearer, pos);
      });
    }

    // draw buildings
    for (const region of regions.filter(r => r.building)) {
      let townFrame = Math.floor(Math.min(region.building * 4, 4));
      let tile = [townFrame, 0, 32, 32];
      tileDraw(map.img.ctx, sprites.town, region.position, true, tile);
    }

    map.img.ctx.translate(...mapImgOffset.map(c => -c));
    if (usePixelArt)
      ctx.drawImage(
        map.img.ctx.canvas,
        ...offset.map(c => c * scale % (scale / ppu) - (scale / ppu)),
        ...map.img.size.map(c => c * (scale / ppu)));

  } else {
    ctx.translate(...mapOffset);

    // regions
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.fillStyle = "#4f9627";
    ctx.strokeStyle = "#3f751f";
    regions.filter(t => t.terrain >= 0).forEach(drawRegion);

    // buildings
    ctx.strokeStyle = "#5b2000";
    ctx.fillStyle = "#9b500d";
    regions.filter(region => region.building).forEach(drawBuilding);

    // units
    ctx.lineWidth = 0;
    regions.filter(region => region.units.length).forEach(drawUnits);

    ctx.translate(...mapOffset.map(c => -c));
  }

  // TODO add pixmap version, move to geo draw block above
  ctx.translate(...mapOffset);
  // building commands
  ctx.setLineDash([scale*DASH_SIZE, scale*DASH_SIZE]);
  ctx.strokeStyle = "yellow";
  commands.forEach(drawPlans);
  ctx.setLineDash([]);
  // movement commands
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 0;
  ctx.fillStyle = "yellow";
  commands.forEach(drawMoves);
  ctx.globalAlpha = 1;
  ctx.translate(...mapOffset.map(c => -c));
}

function toggleGraphics() {
  usePixelArt = !usePixelArt;
  usePixelArt && updateMapCanvas();
  draw();
}

function updateCanvas() {
  canvas.height = window.innerHeight;
  canvas.width = window.innerWidth;
  scale = 48; //FIXME
  draw(); 
}

function initMapCanvas() {
  ppu = 24; //FIXME
  map.img.loaded = true;

  // set up water canvas
  waterctx.canvas.width = canvas.width + sprites.water.width;
  waterctx.canvas.height = canvas.height + sprites.water.height;
  waterPattern = waterctx.createPattern(sprites.water, "repeat");
  fillCanvas(waterctx.canvas, waterPattern);

  // start frame interval
  clearInterval(frameInterval);
  frameInterval = setInterval(() => {++frame; draw()}, 1000);

  updateMapCanvas()
}

function updateMapCanvas() {
  map.img.ctx.canvas.width = canvas.width * ppu / scale + 2;
  map.img.ctx.canvas.height = canvas.height * ppu / scale + 2;
  map.img.size = [map.img.ctx.canvas.width, map.img.ctx.canvas.height];
  draw();
}

function addCommand(origin, target) {
  // check the command is between connected regions
  if ( ![origin.id, ...origin.connected].includes(target.id)
    || ![player, null].includes(origin.player)
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
  else if (origin.player === null) {
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

function ImageFromSource(src) {
  let image = new Image();
  image.src = src;
  return image;
}

function loadMapImage(imageURLs) {
  map.img = {
    loaded: false,
    ctx: document.createElement("canvas").getContext("2d"),
    frames: imageURLs.map(ImageFromSource),
  };
  map.img.frames[0].onload = initMapCanvas;
}

function loadRegions(newRegions) {
  if (regions === undefined) {
    regions = newRegions;
    return;
  }

  let unitOrigins = new Map();

  regions.filter(region => region.units.length).forEach(region => {
    let positions = getUnitPositions(region);
    region.units.forEach((unit, i) => unitOrigins.set(unit, positions[i]));
  });

  regions = newRegions;

  regions.filter(region => region.units.length).forEach(region => {
    region.units.forEach(unit => {
      let origin = unitOrigins.get(unit);
      if (origin) movement.moves.set(unit, origin);
    });
  });

  movement.start = new Date().getTime();
  movement.interval = setInterval(updateMovement, 1000/movement.fps);
}

function updateMovement() {
  let time = new Date().getTime();
  movement.progress = Math.min((time - movement.start) / movement.duration, 1);

  if (movement.progress === 1) {
    movement.moves.clear();
    clearInterval(movement.interval);
  }

  draw();
}

function startTurn(turnTime) {
  // place construction commands on adjacent unfinished buildings
  regions.filter(t => t.building && t.building < 1 && !t.units.length)
      .filter(t => t.connected.some(id => regions[id].player === player))
      .forEach(t => addCommand(t, t));
}

function pointInRegion(region, x, y) {
  ctx.beginPath()
  ctx.moveTo(...region.polygon[0]);
  region.polygon.slice(1).forEach(point => ctx.lineTo(...point));
  ctx.closePath();
  return ctx.isPointInPath(x, y);
}

function getClickedRegion(e) {
  let canvasPoint = elementCoords(canvas, e.pageX, e.pageY);
  let mapPoint = canvasPoint.map((c, i) => c / scale - offset[i]);
  return regions.find(region => pointInRegion(region, ...mapPoint));
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
    offset[0] += e.movementX / scale;
    offset[1] += e.movementY / scale;
    draw();
  }
});

canvas.addEventListener("wheel", e => {
  let ec = elementCoords(canvas, e.pageX, e.pageY);
  let gs = scale;
  scale = Math.max(scale - e.deltaY / 5, ppu);
  usePixelArt && updateMapCanvas();
  offset = offset.map((c, i) => c - ec[i]/gs + ec[i]/scale);
  draw();
});

socket.on("reload", () => window.location.reload()); 
socket.on("msg", msg => console.log(msg)); 

socket.on("sendId", id => player = id);
socket.on("sendRegions", loadRegions);
socket.on("sendPlayers", p => players = p);
socket.on("sendSpots", s => unitSpots = s);

socket.on("sendMapImage", loadMapImage);
socket.on("startTurn", startTurn);
socket.on("requestCommands", sendCommands);

