"use strict";

window.addEventListener("resize", initCanvas, false);
let canvas = document.getElementById("canvas");
let mCanvas = undefined;
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
let playerColors = ["blue", "red"];

let context = canvas.getContext("2d");
let socket = io();

let player = 0;
let commands = new Map();
let mouse = {};

let appu = 16;
let sppu;

let tiles, players, gameWidth, gameHeight;

function corner(tile) {
  return [(tile.x - 0.5) * sppu, (tile.y - 0.5) * sppu];
}

function playerColor(player) {
  let index = players.indexOf(player);
  return playerColors[index % playerColors.length];
}

function drawTile(tile) {
  context.fillShape(tile.x * sppu, tile.y * sppu, tile.points, sppu, 0);
  context.stroke();
}

function drawBuilding(tile) {
  let gap = GAP_SIZE * sppu;
  let size = sppu - gap * 2;
  let part = size / BUILDING_PARTS;
  let [x, y] = corner(tile).map(c => c + gap);

  if (tile.building === 1) {
    context.fillRect(x, y, size, size);
    context.strokeRect(x, y, size, size);
  } else for (let i = 0; i < BUILDING_PARTS; ++i) {
    context.fillRect(x, y + i * part, size, part * tile.building);
  }
}

function drawPlans(targets, origin) {
  targets.forEach(target => {
    if (target === origin && origin.player === undefined) {
      let gap = GAP_SIZE * sppu / 2;
      let size = sppu - gap * 2;
      let [x, y] = corner(origin).map(c => c + gap);
      context.strokeRect(x, y, size, size);
    }
  });
}

function drawUnits(tile) {
  if (tile.units.length === 0) return;
  let [x, y] = corner(tile);

  context.fillStyle = playerColor(tile.player);

  let e = Math.ceil(Math.sqrt(tile.units.length));
  let m = Math.floor((e*e - tile.units.length) / 2);

  context.beginPath();
  for (let n = m; n < tile.units.length + m; ++n) {
    let ux = x + (Math.floor(n / e) + 0.5)/e *  sppu;
    let uy = y + (n % e + 0.5)/e *  sppu;
    context.moveTo(ux, uy);
    context.arc(ux, uy, UNIT_SIZE * sppu, 0, 2 * Math.PI);
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
      sppu * (target.x + origin.x) / 2,
      sppu * (target.y + origin.y) / 2,
      target === origin ? shapes.square : shapes.arrow,
      sppu / 8 / Math.sqrt(targets.length),
      Math.atan2(target.y - origin.y, target.x - origin.x)));
}

function draw() {
  if (usePixelArt) {
    if (!mCanvas)
      mCanvas = drawMap();

    context.imageSmoothingEnabled = false;
    context.drawImage(mCanvas, 0, 0, gameWidth * sppu, gameHeight * sppu)

    let soldier = document.getElementById("soldier");
    tiles.filter(tile => tile.units.length).forEach(tile => {
      context.drawImage(soldier,
        tile.x * sppu,
        tile.y * sppu,
        soldier.width * sppu / appu,
        soldier.height * sppu / appu);
    });

  } else {
    // water
    fillCanvas(canvas, "#3557a0");

    // tiles
    context.globalAlpha = 1;
    context.lineWidth = 2;
    context.fillStyle = "#4f9627";
    context.strokeStyle = "#3f751f";
    tiles.filter(t => t.terrain >= 0).forEach(drawTile);

    // buildings
    context.strokeStyle = "#5b2000";
    context.fillStyle = "#9b500d";
    tiles.filter(tile => tile.building).forEach(drawBuilding);

    // units
    context.lineWidth = 0;
    tiles.filter(tile => tile.units.length).forEach(drawUnits);
  }

  // building commands
  context.setLineDash([sppu*DASH_SIZE, sppu*DASH_SIZE]);
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
  if (!tiles) return;
  // find largest possible tilesize while still fitting entire map
  let maxHeight = window.innerHeight * 0.95 - panel.header.offsetHeight;
  let maxWidth = window.innerWidth * 0.95;

  sppu = Math.min(maxHeight / gameHeight, maxWidth / gameWidth);
  sppu = Math.floor(sppu / appu) * appu;

  // restrict canvas size
  canvas.width = gameWidth * sppu;
  canvas.height = gameHeight * sppu;

  //TODO this automatically by putting both elements in a div
  panel.progressBorder.style.width = canvas.width + "px";

  draw(); 
}

function addCommand(origin, target) {
  // check the command is between connected tiles
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
    // only allow plans adjacent to friendly tiles
    if (origin.connected.some(id => tiles[id].player === player))
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
  // convert commands to tileIds and send to the server
  // TODO split up and send commands individually
  let commandIds = Array.from(commands, command => {
    let [origin, targets] = command;
    return [origin.id, targets.map(target => target.id)];
  });

  socket.emit("sendCommands", commandIds);
  commands.clear();
  mouse = {};
}

function loadState(game) {
  [gameWidth, gameHeight] = [game.width, game.height];
  players = game.players;
  tiles = game.tiles;
  panel.playerCount.innerHTML = players.length;
  initCanvas(); //TODO only init only the first load, else draw
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
  tiles.filter(t => t.building && t.building < 1 && !t.units.length)
      .filter(t => t.connected.some(id => tiles[id].player === player))
      .forEach(t => addCommand(t, t));

  progressBar.start(turnTime);
}

function pointInTile(tile, x, y) {
  context.beginPath()
  tile.points.forEach(point => context.lineTo(...point));
  context.closePath();
  return context.isPointInPath(x / sppu, y / sppu);
}

function getClickedTile(e) {
  let [canvasX, canvasY] = elementCoords(canvas, e.pageX, e.pageY);
  let [x, y] = [canvasX / sppu, canvasY / sppu];
  let closest = closestPoint(x, y, tiles);
  //let tile = pointInTile(closest, x, y) ? closest : undefined; FIXME
  return closest;
}

canvas.addEventListener("mousedown", e => {
  mouse.down = getClickedTile(e);
});

canvas.addEventListener("mouseup", e => {
  mouse.up = getClickedTile(e);
  if (mouse.up && mouse.down)
    addCommand(mouse.down, mouse.up);
  mouse = {};
});

socket.on("reload", () => window.location.reload()); 
socket.on("msg", msg => console.log(msg)); 
socket.on("sendPlayerId", id => player = id);
socket.on("sendState", loadState);
socket.on("startTurn", startTurn);
socket.on("requestCommands", sendCommands);

// Dawnbringer 16
let Black = [20,12,28];
let DarkRed = [68,36,52];
let DarkBlue = [48,52,10];
let DarkGray = [78,74,78];
let Brown = [133,76,4];
let DarkGreen  = [52,101,3];
let Red = [208,70,7];
let LightGray = [117,113,97];
let LightBlue = [89,125,206];
let Orange = [210,125,44];
let BlueGray = [133,149,16];
let LightGreen = [109,170,44];
let Peach = [210,170,15];
let Cyan = [109,194,20];
let Yellow  = [218,212,94];
let White = [222,238,21];


/*********
 Pixel map
 *********/
function drawMap() {

  // create canvas
  let canvas = document.createElement("canvas");
  let mContext = canvas.getContext("2d");
  canvas.width = gameWidth * appu;
  canvas.height = gameHeight * appu;

  // water
  let water = document.getElementById("water");
  let waterPattern = mContext.createPattern(water, 'repeat');
  mContext.fillStyle = waterPattern;
  mContext.fillRect(0, 0, canvas.width, canvas.height);

  // fill grass
  let grass = document.getElementById("grass");
  let grassPattern = mContext.createPattern(grass, 'repeat');
  mContext.fillStyle = grassPattern;
  tiles.filter(t => t.terrain >= 0).forEach(t => {
    let pos = [t.x, t.y].map(c => Math.floor(c * appu));
    let points = t.points.map(p => p.map(c => Math.floor(c*appu - 0.01)));

    mContext.fillShape(...pos, points, 1, 0);
  });

  Array.prototype.getEdges = function(pos) {
    return pairs(this).map(pair =>
      [ pos[0] + pair[0][0], pos[1] + pair[0][1],
        pos[0] + pair[1][0], pos[1] + pair[1][1]]);
  }

  // construct tile borders
  let imageData = mContext.getImageData(0, 0, canvas.width, canvas.height);
  tiles
      .filter(t => t.terrain >= 0)
      .sort((t1, t2) => t1.y - t2.y)
      .forEach(t => {
    let pos = [t.x, t.y].map(c => Math.floor(c * appu));
    let points = t.points.map(p => p.map(c => Math.floor(c * appu - 0.01)));

    points
        .map(p => p.map(c => Math.floor(c*0.8)))
        .getEdges(pos)
        .forEach(edge => bline(imageData, 0.3, ...edge, ...Yellow, 255));

    points
        .map(p => [p[0], p[1] + 1])
        .getEdges(pos)
        .filter(edge => edge[0] < edge[2])
        .forEach(edge => bline(imageData, 0.9, ...edge, ...Brown, 255));

    points
        .map(p => [p[0], p[1] + 1])
        .getEdges(pos)
        .filter(edge => edge[0] > edge[2])
        .forEach(edge => bline(imageData, 1, ...edge, ...LightGreen, 255));

    points
        .getEdges(pos)
        .forEach(edge => {
      bline(imageData, 1.0, ...edge, ...Brown, 255);
      bline(imageData, 0.5, ...edge, ...Orange, 255);
      bline(imageData, 0.5, ...edge, ...DarkGreen, 255);
    });

  });
  mContext.putImageData(imageData, 0, 0);
  return canvas;
}
