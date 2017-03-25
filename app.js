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

const TILE_MAX = 36;
const UNIT_COEFFICIENT = 2;
const SPAWN_REQ = TILE_MAX / UNIT_COEFFICIENT;

var autoreload = true;
var port  = 4000;
var games = [];
var sockets = [];
var gameTimeouts = new Map();

var smallSimplexGrid = {
  tileGen: gridTiles,
  zGen: simplexGen,
  seed: 4,
  width: 6,
  height: 6,
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
  return Object.assign({
    tiles: mapDef.tileGen(mapDef),
    turnTime,
    players: [],
    waitingOn: new Set(),
    nextId: 0,
    turnCount: 0,
  }, mapDef);
}

function Tile(id, points) {
  let x = points.map(p => p[0]).reduce((a, v) => a + v, 0) / points.length;
  let y = points.map(p => p[1]).reduce((a, v) => a + v, 0) / points.length;
  points.forEach(point => { point[0] -= x; point[1] -= y });
  return {
    id, x, y, points,
    units: [],
    connected: [],
    attackedBy: [], //TODO consolidate attackedBy and inbound?
    inbound: [],
    building: 0,
  };
}

function setUnits(game, tile, player, n) {
  tile.player = player;
  tile.units = Array.from({length: n}, () => game.nextId++);
}

function gridTiles(mapDef) {
  console.log("Creating tiles...");
  let tiles = [];

  // create grid of tiles
  for (let x = 0; x < mapDef.width; ++x)
    for (let y = 0; y < mapDef.height; ++y)
      if (mapDef.zGen(x, y, mapDef.seed) >= 0)
        tiles.push(Tile(tiles.length, [[x,y], [x+1,y], [x+1,y+1], [x,y+1]]));

  // find connected tiles
  tiles.forEach((tile, i) => {
    tiles.slice(i + 1).forEach(other => {
      if (distSq(tile.x, tile.y, other.x, other.y) <= 1) {
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
    games.push(Game(smallSimplexGrid, 4000));
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
  game.tiles.forEach(tile => setGroups(tile, [tile], [false]));
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
  if (!game.waitingOn.has(player)) {
    console.warn(player, chalk.bold.red("duplicate commands ignored"));
    return;
  }

  // determine which commands are for construction
  let planIds = commandIds
    .filter(command => game.tiles[command[0]].player === undefined)
    .map(commandId => commandId[0]);

  commandIds.forEach(command => {
    let [originId, targetIds] = command;
    let origin = game.tiles[originId];
    let targets = targetIds.map(id => game.tiles[id]);
    let builds = targetIds.map(id => planIds.includes(id));
    setGroups(origin, targets, builds);
  });

  game.waitingOn.delete(player);
  if (!game.waitingOn.size) run(game);
}

function setGroups(tile, targets, builds) {
  targets = targets || [tile];
  tile.groups = evenChunks(tile.units, targets.length);
  tile.groups.forEach((group, i) => {
    group.player = tile.player;
    group.target = targets[i];
    group.build = builds[i];
  });
}

function areEnemies(tile1, tile2) {
  return tile1.player !== tile2.player
      && tile1.units.length
      && tile2.units.length;
}

function runInteractions(tile) {
  tile.groups.forEach(group => {
    let move = false;

    //attack enemy tiles
    if (areEnemies(tile, group.target)) {
      group.target.attackedBy = group.target.attackedBy.concat(group);

    // construct buildings
    } else if (group.build) {
      group.target.building += group.length / TILE_MAX;
      group.target.building = Math.min(group.target.building, 1);

    } else {
      move = true;

    } if (!move) {
      group.target = tile;
    }
  });
}

function calculateFatalities(tile) {
  let damage = tile.attackedBy.length / UNIT_COEFFICIENT;
  let deaths = evenChunks(Array(Math.ceil(damage)), tile.groups.length);
  tile.groups.forEach((group, i) => group.splice(0, deaths[i].length));
  if (tile.groups.every(group => group.length === 0))
    tile.player = undefined;
  tile.attackedBy = [];
}

function sendUnits(tile) {
  tile.groups.forEach(group => group.target.inbound.push(group));
  tile.groups = [];
}

function receiveUnits(tile) {
  // join inbound groups of the same player
  let groups = [];
  tile.inbound.forEach(group => {
    let allies = groups.find(g => g.player === group.player);
    allies && allies.push(...group) || groups.push(group);
  });
  tile.inbound = [];
  // largest group wins, with losses equal to the size of second largest
  let victor = groups.reduce((v, g) => g.length > v.length ? g : v, []);
  let deaths = groups.map(g => g.length).sort((a, b) => b - a)[1] || 0;
  tile.units = Array.from(victor.slice(deaths));
  tile.player = tile.units.length ? victor.player : undefined;
}

function run(game) {
  clearTimeout(gameTimeouts.get(game));
  console.log(chalk.cyan("Running turn %s"), game.turnCount++);
  let occupied = game.tiles.filter(tile => tile.units.length > 0);

  // execute interactions
  occupied.forEach(runInteractions);
  occupied.forEach(calculateFatalities);

  // execute movement
  occupied.forEach(sendUnits);
  game.tiles.forEach(receiveUnits);

  // create new units in occupied houses
  game.tiles.filter(t => t.building === 1 && t.units.length >= SPAWN_REQ)
    .forEach(tile => {
      tile.units.push(game.nextId++);
    });

  // kill units in overpopulated tiles
  game.tiles.filter(t => t.units.length > TILE_MAX)
    .forEach(tile => {
      let damage = (tile.units.length - TILE_MAX) / UNIT_COEFFICIENT;
      tile.units.splice(0, Math.ceil(damage));
    });

  // send the updates to the players and start a new turn
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

  // start on random empty tile with 24 units (dev)
  let empty = findEmptyTiles(game.tiles);
  let emptyTile = empty[Math.floor(Math.random() * empty.length)];
  setUnits(game, emptyTile, player, 24);
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

function distSq(x1, y1, x2, y2) {
  let dx = x1 - x2;
  let dy = y1 - y2;
  return dx*dx + dy*dy;
}

// server init
app.use(express.static(__dirname + "/public"));
app.get("/", mainPage);
io.on("connection", playerSession);

http.listen(port, () => console.log("Server started on port", port));

