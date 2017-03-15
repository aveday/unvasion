"use strict";

var express = require("express");
var app = express();
var http = require("http").Server(app);
var io = require("socket.io")(http);
var simplex = require("simplex-noise");
var Point = require("point-geometry");
require('colors');

var autoreload = true;
var port  = 4000;
var games = [];
var gameTimeouts = new Map();

function Game(w, h, turnTime) {
  console.log("Starting new game...");
  return {
    world: World(w, h),
    turnTime,
    players: [],
    waitingOn: new Set(),
    commands: [],
    nextId: 0,
    turnCount: 0,
  };
}

function World(width, height) {
  console.log("Creating world...");
  let world = [];
  world.nextId = 0;

  world.addUnits = function(tile, player, n) {
    tile.player = player;
    for (let i = 0; i < n; i++)
      tile.units.push(world.nextId++);
    return tile.units;
  }

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

  return world;
}

function handleError(err, html) {
  console.warn(err, html);
}

function mainPage(req, res) {
  res.render("public/index.html", handleError);
}

function playerSession(socket) {
  // tell client to refresh on file changes (dev)
  if (autoreload === true) {
    autoreload = false;
    io.emit("reload");
    return;
  }
  // start a new game session if there aren't any
  if (games.length === 0)
    games.push(Game(4, 4, 4000));
  let game = games[0];

  // add the player
  let player = addPlayer(game, socket);
  io.emit("msg", "Connected to server");

  socket.emit("sendPlayerId", player);
  io.emit("sendState", game);

  socket.on("ready", () => startGame(game, player));
  socket.on("sendCommands", commands => loadCommands(game, player, commands));

  socket.on("msg", msg => console.log(msg));
  socket.on("disconnect", () => removePlayer(game, player));
}

function startGame(game, player) {
  console.log(player, "ready to start".grey);
  game.waitingOn.delete(player);
  if (game.waitingOn.size === 0)
    startTurn(game);
}

function startTurn(game) {
  console.log(("\nstarting turn " + game.turnCount).italic.blue);
  io.emit("startTurn", game.turnTime);
  game.waitingOn = new Set(game.players);
  gameTimeouts.set(game, setTimeout(endTurn, game.turnTime, game));
}

function endTurn(game) {
  console.log(("ending turn "+game.turnCount).yellow);
  game.waitingOn.forEach(player => {
    io.sockets.connected[player].emit("requestCommands");
  });
}

function loadCommands(game, player, commands) {
  // load the commands from the player messages
  if (game.waitingOn.has(player)) {
    console.log(player, (nCommands(commands) + " commands").magenta);
    game.commands = game.commands.concat(commands);
  } else {
    console.warn(player, "duplicate commands ignored".bold.red);
  }

  game.waitingOn.delete(player);
  if (game.waitingOn.size === 0) {
    run(game);
  }
}

function run(game) {
  clearTimeout(gameTimeouts.get(game));
  console.log(("running "+nCommands(game.commands)
              +" commands for turn " + game.turnCount++).cyan);
  game.commands.forEach(command => {
    let [originPosition, targetPositions] = command;
    let origin = game.world[originPosition.x][originPosition.y];

    while (targetPositions.length > 0) {
      let n = Math.floor(origin.units.length / targetPositions.length);
      let targetP = targetPositions.pop();
      let target = game.world[targetP.x][targetP.y];
      target.units = target.units.concat(origin.units.splice(0, n));
      target.player = origin.player;
    }
  });

  // reset commands and send the updates to all the players
  game.commands = [];
  io.emit("sendState", game); // FIXME to just send update

  startTurn(game);
}

function deletePlayerUnits(region, player) {
  if (region.hasOwnProperty("length")) {
    region.forEach(r => deletePlayerUnits(r, player));
  } else if (region.player === player) {
    region.units = [];
    region.player = undefined;
  }
}

function findEmptyTiles(world) {
  let emptyTiles = []
  world.forEach(row => {
    let empty = row.filter(tile => tile.units.length === 0)
    emptyTiles = emptyTiles.concat(empty)
  });
  return emptyTiles;
}

function addPlayer(game, socket) {
  let player = socket.id;
  console.log(player, "player connected".blue);
  game.players.push(player);
  game.waitingOn.add(player);
  // start on random empty tile with 12 units (dev)
  let empty = findEmptyTiles(game.world);
  let emptyTile = empty[Math.floor(Math.random() * empty.length)];
  game.world.addUnits(emptyTile, player, 12);
  return player;
}

function removePlayer(game, player) {
  console.log(player, "player disconnected".red);
  game.players = game.players.filter(p => p !== player);
  game.waitingOn.delete(player);
  deletePlayerUnits(game.world, player);
  io.emit("sendState", game);
}

function nCommands(commands) {
    return commands.reduce((acc, val) => acc + val[1].length, 0);
}

// server init
app.use(express.static(__dirname + "/public"));
app.get("/", mainPage);
io.on("connection", playerSession);

http.listen(port, () => console.log("Server started on port", port));

