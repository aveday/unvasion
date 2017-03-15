"use strict";

var express = require("express");
var app = express();
var http = require("http").Server(app);
var io = require("socket.io")(http);
var simplex = require("simplex-noise");
var Point = require("point-geometry");

var autoreload = true;
var port  = 4000;
var turnTime = 5000;
var commands = [];
var players = [];

var newId = (() => {
  let nextId = 0;
  return () => ++nextId;
})();

function Units(n) {
  return Array(n).fill(0).map(newId);
}

function genWorld(width, height) {
  let world = [];

  let noise = new simplex(Math.random);
  let offset = 0.3;
  let octaveSettings = [
    {scale: 0.20, amplitude: 0.8},
    {scale: 0.03, amplitude: 1.0},
  ];

  for (let x = 0; x < width; ++x) {
    let row = [];
    for (let y = 0;y < height; ++y) {
      let tile = {terrain: offset, units: [], player: undefined};
      for (let n of octaveSettings)
        tile.terrain += n.amplitude * noise.noise2D(x * n.scale, y * n.scale);
      row.push(tile);
    }
    world.push(row);
  }

  world[0][0].units = Units(15);
  world[0][0].player = 0;
  world[3][1].units = Units(3);
  world[3][1].player = 1;

  return world;
}

function handleError(err, html) {
  console.warn(err, html);
}

function mainPage(req, res) {
  res.render("public/index.html", handleError);
}

function loadCommands(world, playerCommands) {
  // load the commands from the player messages
  commands = commands.concat(playerCommands);
  run(world, commands); //FIXME for real time
}

function run(world, commands) {

  commands.forEach(function (command) {
    let [originPosition, targetPositions] = command;
    let origin = world[originPosition.x][originPosition.y];

    while (targetPositions.length > 0) {
      let n = Math.floor(origin.units.length / targetPositions.length);
      let targetP = targetPositions.pop();
      let target = world[targetP.x][targetP.y];
      target.units = target.units.concat(origin.units.splice(0, n));
      target.player = origin.player;
    }
  });

  commands = [];
  io.emit("sendWorld", world); // FIXME to just send update
}

function requestCommands() {
  io.emit("requestCommands");
  io.emit("startTurn", turnTime);
}

function playerSession(socket) {
  if (autoreload === true) {
    autoreload = false;
    io.emit("reload");
    return;
  }

  console.log(socket);
  console.log("Player connected.\nGenerating world...");
  let world = genWorld(4, 4);

  io.emit("msg", "Connected to server");
  io.emit("sendWorld", world);

  io.emit("startTurn", turnTime);
  setInterval(requestCommands, turnTime);

  socket.on("commands", commands => loadCommands(world, commands));
  socket.on("msg", msg => console.log(msg));
}

// server init
app.use(express.static(__dirname + "/public"));
app.get("/", mainPage);
io.on("connection", playerSession);

http.listen(port, () => console.log("listening on port", port));

