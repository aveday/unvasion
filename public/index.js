"use strict";

window.addEventListener("resize", initCanvas, false);
let canvas = document.getElementById("canvas");
let panel = {
  header: document.getElementsByTagName("header")[0],
  progressBar: document.getElementById("progressBar"),
  progressBorder: document.getElementById("progressBorder"),
  playerCount: document.getElementById("playerCount"),
};

const HOUSE = 1, BARRACKS = 2;
let playerColors = ["blue", "red"];

let context = canvas.getContext("2d");
let socket = io();
let unitSize = 0.08;
let planGap = 0.05;
let dashSize = 0.1;

let player = 0;
let tileSize;
let commands = new Map();
let mouse = {};

let tiles, players, mapInfo;

function midTile(tile) {
  return {
    x: (tile.position.x - 0.5) * tileSize,
    y: (tile.position.y - 0.5) * tileSize,
  };
}

function playerColor(player) {
  let index = players.indexOf(player);
  return playerColors[index % playerColors.length];
}

function drawTile(tile) {
  let {x, y} = midTile(tile);
  context.fillRect(x, y, tileSize, tileSize);
  context.strokeRect(x, y, tileSize, tileSize);
}

function drawPlans(targets, origin) {
  targets.forEach(target => {
    if (target === origin && origin.player === undefined) {
      let {x, y} = midTile(origin);
      let gap = planGap * tileSize;
      context.strokeRect(x+gap, y+gap, tileSize-gap*2, tileSize-gap*2);
    }
  });
}

function drawUnits(tile) {
  if (tile.units.length === 0) return;
  let {x, y} = midTile(tile);

  context.fillStyle = playerColor(tile.player);

  let e = Math.ceil(Math.sqrt(tile.units.length));
  let m = Math.floor((e*e - tile.units.length) / 2);

  context.beginPath();
  for (let n = m; n < tile.units.length + m; ++n) {
    let ux = x + (Math.floor(n / e) + 0.5)/e *  tileSize;
    let uy = y + (n % e + 0.5)/e *  tileSize;
    context.moveTo(ux, uy);
    context.arc(ux, uy, unitSize * tileSize, 0, 2 * Math.PI);
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
      tileSize * (target.position.x + origin.position.x) / 2,
      tileSize * (target.position.y + origin.position.y) / 2,
      target === origin ? shapes.square : shapes.arrow,
      tileSize / 8 / Math.sqrt(targets.length),
      Math.atan2(target.position.y - origin.position.y,
                 target.position.x - origin.position.x)));
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

  // building plans
  context.setLineDash([tileSize*dashSize, tileSize*dashSize]);
  context.strokeStyle = "brown";
  commands.forEach(drawPlans);
  context.setLineDash([]);

  // units
  context.lineWidth = 0;
  tiles.forEach(drawUnits);

  // movement arrows
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

