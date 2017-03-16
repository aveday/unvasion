"use strict";

var express = require("express");
var app = express();
var http = require("http").Server(app);
var io = require("socket.io")(http);
var simplex = require("simplex-noise");
var chalk = require("chalk");
var evenChunks = require("even-chunks");

var unitCap = 25;
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

function setUnits(world, tile, player, n) {
  tile.player = player;
  tile.units = Array.from({length: n}, () => world.nextId++);
}

function World(width, height) {
  console.log("Creating world...");
  let world = [];
  world.nextId = 0;

  let noise = new simplex(Math.random);
  let offset = 0.6;
  let octaveSettings = [
    {scale: 0.20, amplitude: 0.8},
    {scale: 0.03, amplitude: 1.0},
  ];

  for (let x = 0; x < width; ++x) {
    let row = [];
    for (let y = 0; y < height; ++y) {
      let tile = {terrain: offset, units: [], targets: [], player: undefined};
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
  console.log(player, chalk.grey("ready to start"));
  game.waitingOn.delete(player);
  if (game.waitingOn.size === 0)
    startTurn(game);
}

function startTurn(game) {
  console.log(chalk.blue("\nstarting turn", game.turnCount));
  io.emit("startTurn", game.turnTime);
  game.waitingOn = new Set(game.players);
  gameTimeouts.set(game, setTimeout(endTurn, game.turnTime, game));
}

function endTurn(game) {
  console.log(chalk.yellow("ending turn", game.turnCount));
  game.waitingOn.forEach(player => {
    io.sockets.connected[player].emit("requestCommands");
  });
}

function loadCommands(game, player, commands) {
  // TODO properly validate commadns (eg: targets <= units.length)
  // load the commands from the player messages
  console.log(player, chalk.magenta(nCommands(commands), "commands"));
  if (game.waitingOn.has(player))
    for (let [tilePos, targetsPos] of commands)
      game.world[tilePos.x][tilePos.y]
          .targets = targetsPos.map(t => game.world[t.x][t.y]);
  else
    console.warn(player, chalk.bold.red("duplicate commands ignored"));

  game.waitingOn.delete(player);
  if (game.waitingOn.size === 0)
    run(game);
}

function runInteractions(tile) {
  let p = Math.ceil(tile.units.length / tile.targets.length / 2);
  tile.targets.forEach(target => {
    if (target.units.length > 0 && target.player !== tile.player)
      target.nextUnits.splice(0, p);
  });
}

function updateTargets(tile) {
  tile.targets = tile.targets.map(target => {
    let targetInvalid =
        target.terrain < 0
     || target.units.length > 0 && target.player !== tile.player;
    return targetInvalid ? tile : target;
  });
}

function updateTile(tile) {
  tile.units = Array.from(tile.nextUnits);
  tile.player = tile.units.length > 0 ? tile.nextPlayer : undefined;
}

function runMovements(tile) {
  if (tile.targets.length === 0) tile.targets = [tile];
  let groups = evenChunks(tile.units, tile.targets.length);

  tile.nextUnits = tile.nextUnits.filter(u => !tile.units.includes(u));
  tile.targets.forEach((target, i) => {
    target.nextUnits = target.nextUnits.concat(groups[i]);
    target.nextPlayer = tile.player;
  });
}

function run(game) {
  clearTimeout(gameTimeouts.get(game));
  console.log(chalk.cyan( //FIXME differring command format (add tileIds)
    "running", //nCommands(game.commands),
    "commands for turn", game.turnCount++));

  // initialise the next game state
  let allTiles = flatten(game.world);
  let occupied = allTiles.filter(tile => tile.units.length > 0);
  allTiles.forEach(tile => tile.nextUnits = Array.from(tile.units));
  allTiles.forEach(tile => tile.nextPlayer = tile.player);

  // execute interactions
  occupied.forEach(runInteractions);
  occupied.forEach(updateTargets);
  occupied.forEach(updateTile);

  // execute movement
  occupied.forEach(runMovements);
  allTiles.forEach(updateTile);

  // reset commands and send the updates to all the players
  allTiles.forEach(tile => tile.targets = []);
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
  let emptyTiles = [];
  world.forEach(row => {
    let empty = row.filter(tile => tile.units.length === 0);
    emptyTiles = emptyTiles.concat(empty);
  });
  return emptyTiles;
}

function addPlayer(game, socket) {
  let player = socket.id;
  console.log(player, chalk.blue("player connected"));
  game.players.push(player);
  game.waitingOn.add(player);

  // start on random empty tile with 12 units (dev)
  let empty = findEmptyTiles(game.world);
  let emptyTile = empty[Math.floor(Math.random() * empty.length)];
  setUnits(game.world, emptyTile, player, 12);
  return player;
}

function removePlayer(game, player) {
  console.log(player, chalk.red("player disconnected -"));
  game.players = game.players.filter(p => p !== player);
  game.waitingOn.delete(player);
  deletePlayerUnits(game.world, player);
  io.emit("sendState", game);
}

function nCommands(commands) {
  return commands.reduce((acc, val) => acc + val[1].length, 0);
}

function flatten(array) {
  return array.reduce((acc, val) => acc.concat(val), []);
}

// server init
app.use(express.static(__dirname + "/public"));
app.get("/", mainPage);
io.on("connection", playerSession);

http.listen(port, () => console.log("Server started on port", port));

