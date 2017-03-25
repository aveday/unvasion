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

let playerColors = ["blue", "red"];

let context = canvas.getContext("2d");
let socket = io();

let player = 0;
let tileSize;
let commands = new Map();
let mouse = {};

let tiles, players, mapInfo;

function corner(tile) {
  return [(tile.x - 0.5) * tileSize, (tile.y - 0.5) * tileSize];
}

function playerColor(player) {
  let index = players.indexOf(player);
  return playerColors[index % playerColors.length];
}

function drawTile(tile) {
  let [x, y] = [tile.x * tileSize, tile.y * tileSize];
  context.fillShape(x, y, tile.points, tileSize, 0);
  context.stroke();
}

function drawBuilding(tile) {
  let gap = GAP_SIZE * tileSize;
  let size = tileSize - gap * 2;
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
      let gap = GAP_SIZE * tileSize / 2;
      let size = tileSize - gap * 2;
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
    let ux = x + (Math.floor(n / e) + 0.5)/e *  tileSize;
    let uy = y + (n % e + 0.5)/e *  tileSize;
    context.moveTo(ux, uy);
    context.arc(ux, uy, UNIT_SIZE * tileSize, 0, 2 * Math.PI);
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
      tileSize * (target.x + origin.x) / 2,
      tileSize * (target.y + origin.y) / 2,
      target === origin ? shapes.square : shapes.arrow,
      tileSize / 8 / Math.sqrt(targets.length),
      Math.atan2(target.y - origin.y, target.x - origin.x)));
}

function draw() {
  // water
  fillCanvas(canvas, "#3557a0");

  // tiles
  context.globalAlpha = 1;
  context.lineWidth = 2;
  context.fillStyle = "#4f9627";
  context.strokeStyle = "#3f751f";
  tiles.forEach(drawTile);

  // buildings
  context.strokeStyle = "#5b2000";
  context.fillStyle = "#9b500d";
  tiles.filter(tile => tile.building).forEach(drawBuilding);

  // units
  context.lineWidth = 0;
  tiles.filter(tile => tile.units.length).forEach(drawUnits);

  // building commands
  context.setLineDash([tileSize*DASH_SIZE, tileSize*DASH_SIZE]);
  context.strokeStyle = "yellow";
  commands.forEach(drawPlans);
  context.setLineDash([]);

  // movement commands
  context.globalAlpha = 0.3;
  context.lineWidth = 0;
  context.fillStyle = "yellow";
  commands.forEach(drawMoves);

}

function initCanvas() {
  if (!tiles || !mapInfo) return;
  // find largest possible tilesize while still fitting entire map
  let maxHeight = window.innerHeight * 0.95 - panel.header.offsetHeight;
  let maxWidth = window.innerWidth * 0.95;
  tileSize = Math.min(maxHeight / mapInfo.height, maxWidth / mapInfo.width);

  // restrict canvas size
  canvas.width = mapInfo.width * tileSize;
  canvas.height = mapInfo.height * tileSize;

  //TODO this automatically by putting both elements in a div
  panel.progressBorder.style.width = canvas.width + "px";

  draw(); 
}

function addCommand(origin, target) {
  // check the command is between connected tiles
  if ( ![origin.id, ...origin.connected].includes(target.id)
    || ![player, undefined].includes(origin.player) )
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
  mapInfo = game.mapInfo;
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
  return Math.abs(x - tile.x) < 0.5 && Math.abs(y - tile.y) < 0.5;
  context.beginPath()
  tile.points.forEach(point => context.moveTo(point[0], point[1]));
  context.closePath();
  return context.isPointInPath(x, y);
}

function getClickedTile(e) {
  let [canvasX, canvasY] = elementCoords(canvas, e.pageX, e.pageY);
  let [x, y] = [canvasX / tileSize, canvasY / tileSize];
  let closest = closestPoint(x, y, tiles);
  return pointInTile(closest, x, y) ? closest : undefined;
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

