"use strict";

var fs = require("fs");
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
var Canvas = require('canvas');
var PNG = require('png-js');

const REGION_MAX = 36;
const UNIT_COEFFICIENT = 2;
const SPAWN_REQ = REGION_MAX / UNIT_COEFFICIENT;

const NORTHCOAST = [1, 81];
const SOUTHCOAST = [33, 113];
const WESTCOAST = [16, 96];
const EASTCOAST = [18, 98];

var autoreload = true;
var port  = 4000;
var games = [];
var sockets = [];
var gameTimeouts = new Map();

// TODO load asset directory automatically, maybe async
const sprites = {
  water: fs.readFileSync('./public/water.png'),
  grass: fs.readFileSync('./public/grass2.png'),
  tileset: fs.readFileSync('./public/tileset.png'),
};

let tileSize = 16;
let tilesetImage = new PNG(sprites.tileset);
let tileset = [];

tilesetImage.decode(data => {
  for (let i = 0; i < data.length; i += tileSize * 4) {
    let row = data.slice(i, i + tileSize * 4);
    let tx = Math.floor(i/4 % tilesetImage.width / tileSize);
    let ty = Math.floor(i/4 / tilesetImage.width / tileSize);
    let ti = tx + ty * tilesetImage.width / tileSize;
    if (ti === tileset.length) {
      let tile = {width: tileSize, height: tileSize, data: []};
      tileset.push(tile);
    }
    tileset[ti].data.push(...row);
  }
});


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
  mapGen: poissonVoronoiMap,
  terrainGen: simplexTerrain,
  width: 16,
  height: 16,
  appu: 16,
  seed: 3213,
};

/**************
 Map Generation
 **************/

function Region(points, id) {
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

function simplexTerrain(regions, rng) {
  let offset = 0.1;
  let octaves = [
    {scale: 0.20, amp: 0.8},
    {scale: 0.03, amp: 1.0},
  ];

  let simplex = new SimplexNoise(rng);
  regions.forEach(t => {
    t.terrain = offset;
    for (let n of octaves)
      t.terrain += n.amp * simplex.noise2D(t.x * n.scale, t.y * n.scale);
  });
}

function poissonVoronoiMap(width, height, rng) {
  let size = [width, height];

  // generate poisson disk distribution
  let points = new Poisson(size, 1, 1, 30, rng).fill();
  points.forEach((point, i) => point.id = i);

  // find voronoi diagram of points
  return voronoi().size(size)(points);
}

/*********
 Pixel Map
 *********/

function buildMapImageURL(map, regions, edges, frame) {
  let {width, height, appu} = map;

  // create land
  let land = new Canvas(width * appu, height * appu).getContext('2d');
  let grass = new Canvas.Image;
  grass.src = sprites.grass;
  land.fillStyle = land.createPattern(grass, 'repeat');
  regions.filter(t => t.terrain >= 0).forEach(t => {
    let points = t.points.map(p => p.map(c => c*appu));
    fillShape(land, 0, 0, points, 1, 0);
  });

  // construct region borders
  let landData = land.getImageData(0, 0, land.canvas.width, land.canvas.height);

  edges
  .filter(edge => edge.left && edge.right)
  .forEach(edge => {
    let t1 = regions[edge.left.data.id];
    let t2 = regions[edge.right.data.id];

    let mEdge = [...edge[0], ...edge[1]]
      .map(c => Math.floor(c * appu));
    let mQuad = [[t1.x, t1.y], edge[0], [t2.x, t2.y], edge[1]]
      .map(p => p.map(c => Math.floor(c * appu)));

    if (t1.terrain >= 0 && t2.terrain >= 0)
      bline(landData, 1, ...mEdge, 90, 128, 44, 225);
    
    let slope = Math.abs((edge[0][1]-edge[1][1]) / (edge[0][0]-edge[1][0]));
    let coast = Math.sign(t1.terrain) !== Math.sign(t2.terrain);

    let NS = [t1, t2].sort((t1, t2) => t1.y > t2.y);
    let EW = [t1, t2].sort((t1, t2) => t1.x > t2.x);

    // East-West coastline
    if (coast && slope < 1) {
      let tileIds = NS[0].terrain < 0 ? NORTHCOAST : SOUTHCOAST;
      let tile = tileset[tileIds[(frame+edge.left.index) % tileIds.length]];
      blinePoints(...mEdge).forEach(point => {
        for (let y = 0; y < tile.height; ++y) {
          let dest = [point[0], point[1] + y - tileSize / 2];
          if (pointInQuad(dest, mQuad)) {
            let sample = getPixel(tile, point[0] % tile.width, y);
            drawPixel(landData, ...dest, ...sample);
          }
        }
      });
    }

    // North-South coastlines
    if (coast && slope >= 1) {
      let tileIds = EW[0].terrain < 0 ? WESTCOAST : EASTCOAST;
      let tile = tileset[tileIds[(frame+edge.left.index) % tileIds.length]];
      blinePoints(...mEdge).forEach(point => {
        for (let x = 0; x < tile.width; ++x) {
          let dest = [point[0] + x - tileSize / 2, point[1]];
          if (pointInQuad(dest, mQuad)) {
            let sample = getPixel(tile, x, point[1] % tile.height);
            putPixel(landData, ...dest, ...sample);
          }
        }
      });
    }
  });
  land.putImageData(landData, 0, 0);

  // create and composite map
  let context = new Canvas(width * appu, height * appu).getContext('2d');

  let water = new Canvas.Image;
  water.src = sprites.water;
  let wts = [32, 31]
  let wFrames = 15;

  for (let x = 0; x < width * appu; x += wts[0]) {
    for (let y = 0; y < width * appu; y += wts[1]) {
      let f = (x + y) % wFrames;
      context.drawImage(water, f * wts[0], frame % 2, ...wts, x, y, ...wts);
    }
  }

  context.drawImage(land.canvas, 0, 0);
  return context.canvas.toDataURL();
}

/************
 Game Control
 ************/

function Game(mapDef, turnTime) {
  console.log("Starting new game...");
  let players = [];

  let map = Object.assign({}, mapDef);
  let rng = new Alea(map.seed);

  let diagram = map.mapGen(map.width, map.height, rng);
  let regions = diagram.polygons().map(poly => Region(poly, poly.data.id));

  // find connected cells
  diagram.links().forEach(link => {
    regions[link.source.id].connected.push(link.target.id);
    regions[link.target.id].connected.push(link.source.id);
  });

  // generate region terrain
  map.terrainGen(regions, rng);

  // generate map image
  map.imageURLs = [];
  for (let i = 0; i < 2; ++i)
    map.imageURLs.push(buildMapImageURL(map, regions, diagram.edges, i));

  let game = Object.assign({
    regions,
    map,
    turnTime,
    players,
    waitingOn: new Set(),
    nextId: 0,
    turnCount: 0,
    state: {regions, players},
  });

  return game;
}

function startTurn(game) {
  console.log(chalk.green("\nStarting turn", game.turnCount));
  io.emit("startTurn", game.turnTime);
  game.regions.forEach(region => setGroups(region, [region], [false]));
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
    .filter(command => game.regions[command[0]].player === undefined)
    .map(commandId => commandId[0]);

  commandIds.forEach(command => {
    let [originId, targetIds] = command;
    let origin = game.regions[originId];
    let targets = targetIds.map(id => game.regions[id]);
    let builds = targetIds.map(id => planIds.includes(id));
    setGroups(origin, targets, builds);
  });

  game.waitingOn.delete(player);
  if (!game.waitingOn.size) run(game);
}

/**************
 Region Utilities
 **************/

function areEnemies(region1, region2) { return region1.player !== region2.player
      && region1.units.length
      && region2.units.length;
}

function findEmptyRegions(regions) {
  return regions.filter(t => t.terrain >= 0 && t.units.length === 0);
}

function setUnits(game, region, player, n) {
  region.player = player;
  region.units = Array.from({length: n}, () => game.nextId++);
}

/**********
 Simulation
 **********/

function run(game) {
  clearTimeout(gameTimeouts.get(game));
  console.log(chalk.cyan("Running turn %s"), game.turnCount++);
  let occupied = game.regions.filter(region => region.units.length > 0);

  // execute interactions
  occupied.forEach(runInteractions);
  occupied.forEach(calculateFatalities);

  // execute movement
  occupied.forEach(sendUnits);
  game.regions.forEach(receiveUnits);

  // create new units in occupied houses
  game.regions.filter(t => t.building === 1 && t.units.length >= SPAWN_REQ)
    .forEach(region => {
      region.units.push(game.nextId++);
    });

  // kill units in overpopulated regions
  game.regions.filter(t => t.units.length > REGION_MAX)
    .forEach(region => {
      let damage = (region.units.length - REGION_MAX) / UNIT_COEFFICIENT;
      region.units.splice(0, Math.ceil(damage));
    });

  // send the updates to the players and start a new turn
  io.emit("sendState", game.state); // FIXME to just send update
  startTurn(game);
}

function setGroups(region, targets, builds) {
  targets = targets || [region];
  region.groups = evenChunks(region.units, targets.length);
  region.groups.forEach((group, i) => {
    group.player = region.player;
    group.target = targets[i];
    group.build = builds[i];
  });
}

function runInteractions(region) {
  region.groups.forEach(group => {
    let move = false;

    //attack enemy regions
    if (areEnemies(region, group.target)) {
      group.target.attackedBy = group.target.attackedBy.concat(group);

    // construct buildings
    } else if (group.build) {
      group.target.building += group.length / REGION_MAX;
      group.target.building = Math.min(group.target.building, 1);

    } else {
      move = true;

    } if (!move) {
      group.target = region;
    }
  });
}

function calculateFatalities(region) {
  let damage = region.attackedBy.length / UNIT_COEFFICIENT;
  let deaths = evenChunks(Array(Math.ceil(damage)), region.groups.length);
  region.groups.forEach((group, i) => group.splice(0, deaths[i].length));
  if (region.groups.every(group => group.length === 0))
    region.player = undefined;
  region.attackedBy = [];
}

function sendUnits(region) {
  region.groups.forEach(group => group.target.inbound.push(group));
  region.groups = [];
}

function receiveUnits(region) {
  // join inbound groups of the same player
  let groups = [];
  region.inbound.forEach(group => {
    let allies = groups.find(g => g.player === group.player);
    allies && allies.push(...group) || groups.push(group);
  });
  region.inbound = [];
  // largest group wins, with losses equal to the size of second largest
  let victor = groups.reduce((v, g) => g.length > v.length ? g : v, []);
  let deaths = groups.map(g => g.length).sort((a, b) => b - a)[1] || 0;
  region.units = Array.from(victor.slice(deaths));
  region.player = region.units.length ? victor.player : undefined;
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
  io.emit("sendState", game.state);
  io.emit("sendMap", game.map);

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

  // start on random empty region with 24 units (dev)
  let empty = findEmptyRegions(game.regions);
  let startingRegion = empty[Math.floor(Math.random() * empty.length)];
  setUnits(game, startingRegion, player, 24);
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
  deletePlayerUnits(game.regions, player);
  io.emit("sendState", game.state);
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

// from http://xqt2.com/p/MoreCanvasContext.html
function fillShape(context, x,y,points,s,t){
  var px = x + s*(Math.cos(t)*points[0][0] - Math.sin(t)*points[0][1]);
  var py = y + s*(Math.sin(t)*points[0][0] + Math.cos(t)*points[0][1]);
  context.beginPath();
  context.moveTo(px, py);
  for (var i = 1; i < points.length; ++i){
    px = x + s*(Math.cos(t)*points[i][0] - Math.sin(t)*points[i][1]);
    py = y + s*(Math.sin(t)*points[i][0] + Math.cos(t)*points[i][1]);
    context.lineTo(px, py);
  }
  context.closePath();
  context.fill();
};

function drawPixel(imageData, x, y, r, g, b, a) {
  if (a === 0) return;
  if (a === undefined || a === 255) return putPixel(...arguments);

  let n = (y * imageData.width + x) * 4;
  let [r0, g0, b0, a0] = imageData.data.slice(n, n+4);

  //TODO use uint8array and uint8array.set
  imageData.data[n] =   (r*a + r0*a0 + r0*a*a0/0xff) / 0xff;
  imageData.data[n+1] = (g*a + g0*a0 + g0*a*a0/0xff) / 0xff;
  imageData.data[n+2] = (b*a + b0*a0 + b0*a*a0/0xff) / 0xff;
  imageData.data[n+3] = a0 + a - a0*a/0xff;
}

function putPixel(imageData, x, y, r, g, b, a) {
  if (a === undefined) a = 255;
  let n = (y * imageData.width + x) * 4;
  imageData.data[n] = r;
  imageData.data[n+1] = g;
  imageData.data[n+2] = b;
  imageData.data[n+3] = a;
}

function blinePoints(x0, y0, x1, y1) {
  var dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  var dy = Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1; 
  var err = (dx > dy ? dx : -dy)/2;        


  let points = []
  let attempts = 100
  while (--attempts) {
    points.push([x0, y0]);

    if (x0 === x1 && y0 === y1) break;
    var e2 = err;
    if (e2 > -dx) { err -= dy; x0 += sx; }
    if (e2 <  dy) { err += dx; y0 += sy; }
  }
  if (!attempts) console.log("bline exhausted");
  return points;
}

function bline(imageData, prob, x0, y0, x1, y1, ...color) {
  blinePoints(x0, y0, x1, y1)
    .filter(() => Math.random() < prob)
    .forEach(point => putPixel(imageData, ...point, ...color));
}

function getPixel(imageData, x, y) {
  let n = (y * imageData.width + x) * 4;
  return imageData.data.slice(n, n+4);
}

function pointInTri(px, py, p0x, p0y, p1x, p1y, p2x, p2y) {
  var A = -p1y * p2x + p0y * (-p1x + p2x) + p0x * (p1y - p2y) + p1x * p2y;
  var sign = A < 0 ? -1 : 1;
  var s = (p0y * p2x - p0x * p2y + (p2y - p0y) * px + (p0x - p2x) * py) * sign;
  var t = (p0x * p1y - p0y * p1x + (p0y - p1y) * px + (p1x - p0x) * py) * sign;
  return s > 0 && t > 0 && (s + t) < A * sign;
}

function pointInQuad(point, quad) {
  let ev = [], pv = [], cross = [];
  for (let i = 0; i < 4; ++i) {
    ev[i] = [quad[(i+1)%4][0] - quad[i][0], quad[(i+1)%4][1] - quad[i][1]];
    pv[i] = [point[0] - quad[i][0], point[1] - quad[i][1]];
    cross[i] = ev[i][0] * pv[i][1] - ev[i][1] * pv[i][0];
  }
  return cross.every(c => c >= 0)
      || cross.every(c => c < 0);
}

