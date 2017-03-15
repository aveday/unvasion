"use strict";

window.addEventListener("resize", initCanvas, false);
let canvas = document.getElementById("canvas");
let heading = document.getElementById("heading");
let context = canvas.getContext("2d");
let socket = io();

let player = 0;
let cellSize;
let world = {};
let commands = [];
let mouse = {};
let time = {};

function drawTile(x, y, world) {
  context.globalAlpha = 1;
  let tile = world[x][y];
  let X = Math.floor(x*cellSize);
  let Y = Math.floor(y*cellSize);
  let E = Math.ceil(cellSize);
  if (tile.terrain > 0) {
    context.lineWidth = 2;
    context.fillStyle = "#4f9627";
    context.strokeStyle = "#3f751f";
    context.fillRect(X, Y, E, E);
    context.strokeRect(X, Y, E, E);
  }

  context.lineWidth = 0;
  if (tile.units !== undefined) {
    let e = Math.ceil(Math.sqrt(tile.units.length));
    let m = Math.floor((e*e - tile.units.length) / 2);

    let unitSize = 0.08;
    context.fillStyle = tile.player ? "#22A" : "#A22";
    for (let n = m; n < tile.units.length + m; ++n) {
      let ex = X + (Math.floor(n / e) + 0.5)/e *  cellSize;
      let ey = Y + (n % e + 0.5)/e *  cellSize;
      context.beginPath();
      context.arc(ex, ey, unitSize * cellSize, 0, 2 * Math.PI);
      context.fill();
      context.closePath();
    }
  }
}

function drawCommands(commands) {
  context.lineWidth = 0;
  context.globalAlpha = 0.3;
  context.fillStyle = "yellow";
  for (let command of commands) {
    let [origin, targets] = command;
    for (const target of targets) {
      let angle = target.angleTo(origin);
      let arrowPos = midCell(target.add(origin).div(2));
      let factor = Math.sqrt(targets.length);
      context.shape(arrowPos, arrow, cellSize/8/factor, angle);
      context.fill();
    }
  }
}

function midCell(cell) {
  return new Point(0.5, 0.5).add(cell).mult(cellSize);
}

function draw() {
  context.globalAlpha = 1;
  fillCanvas(canvas, "#3557a0");
  let width = world.length;
  let height = world[0].length;
  iterate2D(width, height, (x, y) => drawTile(x, y, world));
  drawCommands(commands);
}

function initCanvas() {
  // restrict canvas size
  let gap = 0.05;
  canvas.width = canvas.height = Math.min(
    window.innerWidth * (1 - gap * 2),
    window.innerHeight * (1 - gap) - heading.offsetHeight);

  cellSize = canvas.width / world.length;
  if (world !== undefined)
    draw(); 
}

function addCommand(originPos, targetPos) {
  let origin = world[originPos.x][originPos.y];
  let target = world[targetPos.x][targetPos.y];

  // check the move is valid
  if (origin.units.length == 0 ||
      origin.player != player ||
      originPos.dist(targetPos) !== 1)
    return;

  // give the new commands
  let commandIndex = commands.findIndex(c => eq(c[0], originPos));
  if (commandIndex === -1)
    commandIndex = commands.push([originPos, []]) - 1;

  let currentTargets = commands[commandIndex][1];
  let targetIndex = currentTargets.findIndex(t => eq(t, targetPos));

  if (targetIndex !== -1) {
    currentTargets.splice(targetIndex, 1);
  } else {
    if (currentTargets.length >= origin.units.length)
      currentTargets.splice(0, 1);
    currentTargets.push(targetPos);
  }

  // remove the commands entry if there are no targets left
  if (!currentTargets.length)
    commands.splice(commandIndex, 1);

  draw();
}

function sendCommands() {
  // send the commands to the server
  socket.emit("commands", commands);
  commands = [];
}

function drag(mouse) {
  addCommand(mouse.down.floor(), mouse.up.floor());
}

function loadWorld(newWorld) {
  world = newWorld;
  initCanvas();
}

function updateTime() {
  //FIXME math progress bar continuous path
  time.passed = new Date().getTime() - time.start;
  context.lineWidth = 5;
  context.strokeStyle = "yellow";
  context.beginPath();
  context.moveTo(0,0);
  context.lineTo(time.passed / time.turn * canvas.width, 0);
  context.stroke();
  context.closePath();
}

function startTurn(turnTime) {
  clearInterval(time.interval);
  time.turn = turnTime;
  time.start = new Date().getTime();
  time.interval = setInterval(updateTime, 100);
}


canvas.addEventListener("mousedown", function mouseDown(e) {
  mouse.down = elementCoords(canvas, e.pageX, e.pageY).div(cellSize);
});

canvas.addEventListener("mouseup", function mouseUp(e) {
  mouse.up = elementCoords(canvas, e.pageX, e.pageY).div(cellSize);
  if (mouse.down !== undefined) {
    drag(mouse);
    mouse = {};
  }
});

socket.on("reload", () => window.location.reload()); 
socket.on("msg", msg => console.log(msg)); 
socket.on("sendWorld", loadWorld);
socket.on("startTurn", startTurn);
socket.on("getCommands", sendCommands);
