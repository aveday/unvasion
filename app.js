"use strict";

var express = require("express");
var app = express();
var http = require("http").Server(app);
var io = require("socket.io")(http);
var chalk = require("chalk");
var evenChunks = require("even-chunks");
var Alea = require("alea");
var SimplexNoise = require("simplex-noise");

var noise = new SimplexNoise(new Alea(0));

var autoreload = true;
var port  = 4000;
var games = [];
var sockets = [];
var gameTimeouts = new Map();

var mapDef = {
  zGen: simplexGen,
  seed: 4,
  width: 4,
  height: 4,
};

function simplexGen(x, y, seed) {
  let z = 1.3;
  let octaves = [
    {scale: 0.20, amplitude: 0.8},
    {scale: 0.03, amplitude: 1.0},
  ];
  for (let n of octaves)
    z += n.amplitude * noise.noise3D(x * n.scale, y * n.scale, seed);
  return z;
}

function Game(mapDef, turnTime) {
  console.log("Starting new game...");
  return {
    tiles: Tiles(mapDef),
    turnTime,
    players: [],
    waitingOn: new Set(),
    commands: new Map(),
    nextId: 0,
    turnCount: 0,
  };
}

function Tile(id, x, y) {
  return {
    id,
    position: {x, y},
    units: [],
    connected: [],
    targets: [] //FIXME
  };
}

function setUnits(game, tile, player, n) {
  tile.player = player;
  tile.units = Array.from({length: n}, () => game.nextId++);
}

function Tiles(mapDef) {
  console.log("Creating tiles...");
  let tiles = [];

  for (let x = (mapDef.width % 1 + 1) / 2; x < mapDef.width; ++x)
    for (let y = (mapDef.height % 1 + 1) / 2; y < mapDef.height; ++y)
      if (mapDef.zGen(x, y, mapDef.seed) >= 0)
        tiles.push(Tile(tiles.length, x, y));

  tiles.forEach((tile, i) => {
    tiles.slice(i + 1).forEach(other => {
      if (distSq(tile.position, other.position) <= 1) {
        tile.connected.push(other.id);
        other.connected.push(tile.id);
      }
    });
  });
  return tiles;
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

  let player = newPlayer(socket);
  // start a new game session if there aren't any
  if (games.length === 0)
    games.push(Game(mapDef, 4000));
  let game = games[0];

  // add the player
  addPlayer(game, player);
  io.emit("msg", "Connected to server");

  socket.emit("sendPlayerId", player);
  io.emit("sendState", game);

  socket.on("ready", () => startGame(game, player));
  socket.on("sendCommands", cmdIds => loadCommands(game, player, cmdIds));

  socket.on("msg", msg => console.log(msg));
  socket.on("disconnect", () => removePlayer(game, player));
}

function startGame(game, player) {
  console.log(chalk.grey("Player %s ready"), player);
  game.waitingOn.delete(player);
  if (game.waitingOn.size === 0)
    startTurn(game);
}

function startTurn(game) {
  console.log(chalk.green("\nStarting turn", game.turnCount));
  io.emit("startTurn", game.turnTime);
  game.waitingOn = new Set(game.players);
  gameTimeouts.set(game, setTimeout(endTurn, game.turnTime, game));
}

function endTurn(game) {
  console.log(chalk.yellow("Ending turn", game.turnCount));
  game.waitingOn.forEach(player => sockets[player].emit("requestCommands"));
}

function loadCommands(game, player, commandIds) {
  // load the commands from the player messages
  console.log("Player %s sent %s commands", player, nCommands(commandIds));
  // TODO properly validate commands (eg: targets <= units.length)

  // ignore dupes //TODO safely allow updated commands
  if (!game.waitingOn.has(player))
    console.warn(player, chalk.bold.red("duplicate commands ignored"));
  else
    commandIds.forEach(command => {
      let [originId, targetIds] = command;
      let origin = game.tiles[originId];
      let targets = targetIds.map(id => game.tiles[id]);
      game.commands.set(origin, targets);
    });

  game.waitingOn.delete(player);
  if (!game.waitingOn.size) run(game);
}

function setDefaultTarget(tile) {
  if (tile.targets.length === 0)
    tile.targets = [tile];
}

function runInteractions(tile) {
  // TODO redo power to use evenChunk groups
  let power = Math.ceil(tile.units.length / tile.targets.length / 2);
  tile.targets.forEach(target => {
    if (target.units.length && target.player !== tile.player)
      target.next.units.splice(0, power);
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
  tile.units = Array.from(tile.next.units);
  tile.player = tile.units.length > 0 ? tile.next.player : undefined;
}

function runMovements(tile) {
  if (tile.targets.length === 0) tile.targets = [tile];
  let groups = evenChunks(tile.units, tile.targets.length);

  tile.next.units = tile.next.units.filter(u => !tile.units.includes(u));
  tile.targets.forEach((target, i) => {
    target.next.units = target.next.units.concat(groups[i]);
    target.next.player = tile.player;
  });
}

function run(game) {
  clearTimeout(gameTimeouts.get(game));
  console.log(chalk.cyan("Turn %s, running % commands",
    game.turnCount++, nCommands(game.commands)));

  // initialise the tiles for simulation
  game.commands.forEach((targets, origin) => origin.targets = targets);
  game.tiles.forEach(tile => {
    tile.next = {units: Array.from(tile.units), player: tile.player};
  });

  let occupied = game.tiles.filter(tile => tile.units.length > 0);

  // execute interactions
  occupied.forEach(setDefaultTarget);
  occupied.forEach(runInteractions);
  occupied.forEach(updateTargets);
  occupied.forEach(updateTile);

  // execute movement
  occupied.forEach(runMovements);
  game.tiles.forEach(updateTile);

  // reset commands and send the updates to all the players
  game.tiles.forEach(tile => tile.targets = []);
  game.commands.clear();
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

function findEmptyTiles(tiles) {
  return tiles.filter(tile => tile.units.length === 0);
}

function addPlayer(game, player) {
  game.players.push(player);
  game.waitingOn.add(player);
  console.log(chalk.yellow("Player %s joined game"), player);

  // start on random empty tile with 12 units (dev)
  let empty = findEmptyTiles(game.tiles);
  let emptyTile = empty[Math.floor(Math.random() * empty.length)];
  setUnits(game, emptyTile, player, 12);
  return player;
}

function newPlayer(socket) {
  let player = sockets.push(socket) - 1;
  console.log(chalk.blue("Player %s connected"), player);
  return player;
}

function removePlayer(game, player) {
  console.log(chalk.red("Player %s disconnected"), player);
  game.players = game.players.filter(p => p !== player);
  game.waitingOn.delete(player);
  deletePlayerUnits(game.tiles, player);
  io.emit("sendState", game);
}

function nCommands(commands) {
  let n = 0;
  commands.forEach(targets => n += targets.length);
  return n;
}

function distSq(p1, p2) {
  let dx = p1.x - p2.x;
  let dy = p1.y - p2.y;
  return dx*dx + dy*dy;
}

// server init
app.use(express.static(__dirname + "/public"));
app.get("/", mainPage);
io.on("connection", playerSession);

http.listen(port, () => console.log("Server started on port", port));

