"use strict";

var DefaultMap = require('default-map');
var express = require("express");
var app = express();
var http = require("http").Server(app);
var io = require("socket.io")(http);
var simplex = require("simplex-noise");
var Point = require("point-geometry");
var autoreload = true;
var port  = 4000;

var newId = (() => {
  let nextId = 0;
  return () => ++nextId;
})();

function Unit() {
  return {id: newId()};
}

function Group(world, position, n, player) {
  let group = {
    position, player,
    id: newId(),
    units: Array(n).map(Unit)
  };

  world.groups.push(group);
  world.groupMap.set(group.id, group);
  world.positionMap.set(position, group);
  return group;
}

function genWorld(w, h) {
  let world = {
    width: w,
    height: h,
    map: [],
    groups: [],
    groupMap: new Map(),
    positionMap: new Map(),
  };

  let noise = new simplex(Math.random);
  let offset = 0.3;
  let octaveSettings = [
    {scale: 0.20, amplitude: 0.8},
    {scale: 0.03, amplitude: 1.0},
  ];

  for (let x = 0; x < world.width; ++x) {
    let row = [];
    for (let y = 0;y < world.height; ++y) {
      let tileValue = offset;
      for (let n of octaveSettings)
        tileValue += n.amplitude * noise.noise2D(x * n.scale, y * n.scale);
      row.push(tileValue);
    }
    world.map.push(row);
  }

  Group(world, new Point(0, 0), 12, 0);
  Group(world, new Point(0, 3), 3, 1);

  return world;
}

function handleError(err, html) {
  console.warn(err, html);
}

function mainPage(req, res) {
  res.render("public/index.html", handleError);
}


function loadCommands(world, playerCommands) {
  let commands = []
  // load the commands from the player messages
  for (let pair of playerCommands) {
    commands.push({id: pair[0], targets: pair[1], index: 0});
  }
  run(world, commands); //FIXME for real time
}

function run(world, commands) {
  commands.forEach(function (command) {
    let {targets, id} = command;
    console.log(command);

    let group = world.groupMap.get(id);

    // create groups splitting from initial group
    while (targets.length > 1) {
      let n = Math.floor(group.units.length / targets.length);
      let newGroup = Group(world, targets.pop(), 0, group.player);
      newGroup.units = group.units.splice(0, n);
    }
    group.position = targets.pop();
  });

  io.emit("worldSend", world); // FIXME to just send update
}

function playerSession(socket) {
  if (autoreload === true) {
    autoreload = false;
    io.emit("reload");
    return;
  }

  console.log("Player connected.\nGenerating world...");
  let world = genWorld(16, 16);
  io.emit("msg", "Connected to server");
  io.emit("worldSend", world);
  socket.on("commands", commands => loadCommands(world, commands));
  socket.on("msg", msg => console.log(msg));
}

// server init
app.use(express.static(__dirname + "/public"));
app.get("/", mainPage);
io.on("connection", playerSession);

http.listen(port, () => console.log("listening on port", port));

