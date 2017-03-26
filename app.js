"use strict";

var express = require("express");
var app = express();
var http = require("http").Server(app);
var io = require("socket.io")(http);
var chalk = require("chalk");
var evenChunks = require("even-chunks");
var Alea = require("alea");
var SimplexNoise = require("simplex-noise");
var Poisson = require("poisson-disk-sampling");
var voronoi = require("d3-voronoi").voronoi;

const TILE_MAX = 36;
const UNIT_COEFFICIENT = 2;
const SPAWN_REQ = TILE_MAX / UNIT_COEFFICIENT;

var autoreload = true;
var port  = 4000;
var games = [];
var sockets = [];
var gameTimeouts = new Map();

/***********
 Server Init
 ***********/

app.use(express.static(__dirname + "/public"));
app.get("/", (req, res) => res.render("public/index.html"));
io.on("connection", playerSession);
http.listen(port, () => console.log("Server started on port", port));

/***************
 Map Definitions
 ***************/

var poissonVoronoi = {
  tileGen: poissonTiles,
  terrainGen: simplexTerrain,
  width: 20,
  height: 20,
  seed: 1121,
};

var smallSimplexGrid = {
  tileGen: gridTiles,
  terrainGen: simplexTerrain,
  width: 6,
  height: 6,
  seed: 212,
};

/**************
 Map Generation
 **************/

function Tile(points, id) {
  let x = average(...points.map(p => p[0]));
  let y = average(...points.map(p => p[1]));
  return {
    id, x, y, points,
    units: [],
    connected: [],
    attackedBy: [],
    inbound: [],
    building: 0,
  };
}

function simplexTerrain(tiles, rng) {
  let offset = 0.3;
  let octaves = [
    {scale: 0.20, amp: 0.8},
    {scale: 0.03, amp: 1.0},
  ];

  let simplex = new SimplexNoise(rng);
  tiles.forEach(t => {
    t.terrain = offset;
    for (let n of octaves)
      t.terrain += n.amp * simplex.noise2D(t.x * n.scale, t.y * n.scale);
  });
}

function poissonTiles(width, height, rng) {
  let size = [width, height];
  // generate poisson disk distribution
  let pds = new Poisson(size, 1, 1, 30, rng);
  let points = pds.fill();
  points.forEach((point, i) => point.id = i);

  // find voronoi diagram of points
  let diagram = voronoi().size(size)(points);
  let tiles = diagram.polygons().map(Tile);

  // find connected cells
  diagram.links().forEach(link => {
    tiles[link.source.id].connected.push(link.target.id);
    tiles[link.target.id].connected.push(link.source.id);
  });

  return tiles;
}

function gridTiles(width, height) {
  console.log("Creating tiles...");
  let tiles = [];

  // create grid of tiles
  for (let x = 0; x < width; ++x)
    for (let y = 0; y < height; ++y)
      tiles.push(Tile([[x,y], [x+1,y], [x+1,y+1], [x,y+1]], tiles.length));

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

/************
 Game Control
 ************/

function Game(mapDef, turnTime) {
  console.log("Starting new game...");

  let rng = new Alea(mapDef.seed);
  let tiles = mapDef.tileGen(mapDef.width, mapDef.height, rng);
  mapDef.terrainGen(tiles, rng);

  return Object.assign({
    tiles,
    turnTime,
    players: [],
    waitingOn: new Set(),
    nextId: 0,
    turnCount: 0,
  }, mapDef);
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
  let nCommands = commandIds.reduce((a, v) => a + v[1].length, 0);
  console.log("Player %s sent %s commands", player, nCommands);
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

/**************
 Tile Utilities
 **************/

function areEnemies(tile1, tile2) {
  return tile1.player !== tile2.player
      && tile1.units.length
      && tile2.units.length;
}

function findEmptyTiles(tiles) {
  return tiles.filter(t => t.terrain >= 0 && t.units.length === 0);
}

function setUnits(game, tile, player, n) {
  tile.player = player;
  tile.units = Array.from({length: n}, () => game.nextId++);
}

/**********
 Simulation
 **********/

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

function setGroups(tile, targets, builds) {
  targets = targets || [tile];
  tile.groups = evenChunks(tile.units, targets.length);
  tile.groups.forEach((group, i) => {
    group.player = tile.player;
    group.target = targets[i];
    group.build = builds[i];
  });
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

/*****************
 Player Management
 *****************/

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
    games.push(Game(poissonVoronoi, 4000));
  let game = games[0];

  // add the player
  addPlayer(game, player);
  io.emit("msg", "Connected to server");

  socket.emit("sendPlayerId", player);
  io.emit("sendState", game);

  socket.on("ready", () => readyPlayer(game, player));
  socket.on("sendCommands", cmdIds => loadCommands(game, player, cmdIds));

  socket.on("msg", msg => console.log(msg));
  socket.on("disconnect", () => removePlayer(game, player));
}

function newPlayer(socket) {
  let player = sockets.push(socket) - 1;
  console.log(chalk.blue("Player %s connected"), player);
  return player;
}

function addPlayer(game, player) {
  game.players.push(player);
  game.waitingOn.add(player);
  console.log(chalk.yellow("Player %s joined game"), player);

  // start on random empty tile with 24 units (dev)
  let empty = findEmptyTiles(game.tiles);
  let startingTile = empty[Math.floor(Math.random() * empty.length)];
  setUnits(game, startingTile, player, 24);
  return player;
}

function readyPlayer(game, player) {
  console.log(chalk.grey("Player %s ready"), player);
  game.waitingOn.delete(player);
  if (game.waitingOn.size === 0)
    startTurn(game);
}

function removePlayer(game, player) {
  console.log(chalk.red("Player %s disconnected"), player);
  game.players = game.players.filter(p => p !== player);
  game.waitingOn.delete(player);
  deletePlayerUnits(game.tiles, player);
  io.emit("sendState", game);
}

function deletePlayerUnits(region, player) {
  if (region.hasOwnProperty("length")) {
    region.forEach(r => deletePlayerUnits(r, player));
  } else if (region.player === player) {
    region.units = [];
    region.player = undefined;
  }
}

/*****************
 Utility Functions
 *****************/

function distSq(x1, y1, x2, y2) {
  let dx = x1 - x2;
  let dy = y1 - y2;
  return dx*dx + dy*dy;
}

function average(...values) {
  return values.reduce((acc, val) => acc + val) / values.length;
}

