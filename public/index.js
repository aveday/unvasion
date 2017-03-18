"use strict";

window.addEventListener("resize", initCanvas, false);
let canvas = document.getElementById("canvas");
let panel = {
  header: document.getElementsByTagName("header")[0],
  progressBar: document.getElementById("progressBar"),
  progressBorder: document.getElementById("progressBorder"),
  playerCount: document.getElementById("playerCount"),
};

let playerColors = ["blue", "red"];

let context = canvas.getContext("2d");
let socket = io();
let unitSize = 0.08;

let player = 0;
let tileSize;
let commands = new Map();
let mouse = {};

let tiles, players, mapInfo;

function drawTile(tile) {
  let x = (tile.position.x - 0.5) * tileSize;
  let y = (tile.position.y - 0.5) * tileSize;
  let edge = Math.ceil(tileSize);

  context.fillRect(x, y, edge, edge);
  context.strokeRect(x, y, edge, edge);
}

function drawUnits(tile) {
  if (tile.units.length === 0) return;

  let x = (tile.position.x - 0.5) * tileSize;
  let y = (tile.position.y - 0.5) * tileSize;

  let playerIndex = players.indexOf(tile.player);
  let playerColor = playerColors[playerIndex % playerColors.length];
  context.fillStyle = playerColor;

  let e = Math.ceil(Math.sqrt(tile.units.length));
  let m = Math.floor((e*e - tile.units.length) / 2);
  for (let n = m; n < tile.units.length + m; ++n) {
    let ux = x + (Math.floor(n / e) + 0.5)/e *  tileSize;
    let uy = y + (n % e + 0.5)/e *  tileSize;
    context.beginPath();
    context.arc(ux, uy, unitSize * tileSize, 0, 2 * Math.PI);
    context.fill();
    context.closePath();
  }
}

function drawCommand(targets, origin) {
  let oPos = origin.position;
  let arrowSize = tileSize / 8 / Math.sqrt(targets.length);
  targets.forEach(target => {
    let tPos = target.position;
    let arrowX = tileSize * (tPos.x + oPos.x) / 2;
    let arrowY = tileSize * (tPos.y + oPos.y) / 2;
    let arrowAngle = Math.atan2(tPos.y-oPos.y, tPos.x-oPos.x);
    context.shape(arrowX, arrowY, shapes.arrow, arrowSize, arrowAngle);
    context.fill();
  });
}

function draw() {
  // draw water
  fillCanvas(canvas, "#3557a0");

  // set style and draw tiles
  context.globalAlpha = 1;
  context.lineWidth = 2;
  context.fillStyle = "#4f9627";
  context.strokeStyle = "#3f751f";
  tiles.forEach(drawTile);

  // set style and draw units
  context.lineWidth = 0;
  tiles.forEach(drawUnits);

  // set style and draw commands
  context.globalAlpha = 0.3;
  context.lineWidth = 0;
  context.fillStyle = "yellow";
  commands.forEach(drawCommand);

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
  // check the move is valid
  if (origin.units.length == 0 ||
      origin.player != player ||
      !origin.connected.includes(target.id))
    return;

  if (!commands.has(origin)) commands.set(origin, []);
  let targets = commands.get(origin); //TODO maybe use defaultmap

  // check against existing commands
  if (targets.includes(target))
    targets.splice(targets.indexOf(target), 1);
  else if (targets.length >= origin.units.length)
    targets = targets.splice(0, 1, target);
  else
    targets.push(target);

  // remove the commands entry if there are no targets left
  if (!targets.length)
    delete commands.delete(origin);

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
}

function loadState(game) {
  mapInfo = game.mapInfo;
  players = game.players;
  tiles = game.tiles;
  panel.playerCount.innerHTML = players.length;
  initCanvas();
}

progressBar.start = function(turnTime) {
  this.style.width = "0%";
  this.style.transition = "width 0s";
  this.offsetLeft; // hack to split up transition properties
  this.style.transition = "width " + turnTime + "ms linear";
  this.style.width = "100%";
};

function startTurn(turnTime) {
  progressBar.start(turnTime);
}

function pointInTile(tile, point) {
  let diff = point.sub(tile.position);
  return Math.abs(diff.x) < 0.5 && Math.abs(diff.y) < 0.5;
}

function getClickedTile(e) {
  let point = elementCoords(canvas, e.pageX, e.pageY).div(tileSize);
  let tile = tiles.find(tile => pointInTile(tile, point));
  return tile;
}

canvas.addEventListener("mousedown", e => mouse.down = getClickedTile(e));
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

