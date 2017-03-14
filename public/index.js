"use strict";

window.addEventListener("resize", initCanvas, false);
let canvas = document.getElementById("canvas");
let heading = document.getElementById("heading");
let context = canvas.getContext("2d");
let socket = io();

let player = 0;
let cellSize;
let world = {};
let commands = new Map();
let mouse = {};

function drawTile(x, y, map) {
  if (map[x][y] > 0) {
    context.lineWidth = 2;
    context.fillStyle = "#4f9627";
    context.strokeStyle = "#3f751f";
    let X = Math.floor(x*cellSize);
    let Y = Math.floor(y*cellSize);
    let E = Math.ceil(cellSize);
    context.fillRect(X, Y, E, E);
    context.strokeRect(X, Y, E, E);
  }
}

function drawGroup(group) {
  let radius = 0.3;
  let unitSize = 0.08;
  context.fillStyle = group.player ? "#22A" : "#A22";
  for (let n = 0; n  < group.units.length; ++n) {
    let point = new Point(cellSize * radius, 0)
      .rotate(n / group.units.length * 2 * Math.PI)
      .add(midCell(group.position));
    context.beginPath();
    context.arc(point.x, point.y, unitSize * cellSize, 0, 2 * Math.PI);
    context.fill();
    context.closePath();
  }
}

function drawGroupTargets(group) {
  context.globalAlpha = 0.3;
  context.fillStyle = "yellow";
  let groupTargets = commands.get(group.id);
  if (!groupTargets)
    return;
  for (const target of groupTargets) {
    let angle = target.angleTo(group.position);
    let arrowPos = midCell(target.add(group.position).div(2));
    context.shape(arrowPos, arrow, cellSize/8, angle);
    context.fill();
  }
}

function midCell(cell) {
  return new Point(0.5, 0.5).add(cell).mult(cellSize);
}

function draw() {
  context.globalAlpha = 1;
  fillCanvas(canvas, "#3557a0");
  iterate2D(world.width, world.height, (x, y) => drawTile(x, y, world.map));
  world.groups.forEach(drawGroup);
  world.groups.forEach(drawGroupTargets);
}

function initCanvas() {
  // restrict canvas size
  let gap = 0.05;
  canvas.width = canvas.height = Math.min(
    window.innerWidth * (1 - gap * 2),
    window.innerHeight * (1 - gap) - heading.offsetHeight);

  cellSize = canvas.width / world.width;
  if (world !== undefined)
    draw(); 
}

function addCommand(group, target) {
  // check the move is valid
  if (group.player !== player || target.dist(group.position) !== 1)
    return;

  // give the new commands
  if (!commands.has(group.id))
    commands.set(group.id, []);

  let groupTargets = commands.get(group.id);
  let targetIndex = groupTargets.findIndex(t => eq(t, target));
  if (targetIndex !== -1) {
    groupTargets.splice(targetIndex, 1);
  } else {
    if (groupTargets.length >= group.units.length)
      groupTargets.splice(0, 1);
    groupTargets.push(target);
  }

  // remove the commands entry if there are no targets left
  if (!groupTargets.length)
    commands.delete(group);

  draw();
}

function sendCommands() {
  // send the commands to the server
  socket.emit("commands", Array.from(commands));

  // reset the groups commands and update list
  commands = new Map();
}

function drag(mouse) {
  let group = world.groups.find(g => mouse.down.floor().equals(g.position));
  if (group !== undefined)
    addCommand(group, mouse.up.floor());
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
socket.on("worldSend", newWorld => {
  world = newWorld;
  initCanvas();
});

