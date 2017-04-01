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

const tilesetImage = PNG.load('./public/tileset_water.png');

const WATER_GRASS = [
  [[1,  0], [1,  5]],
  [[1,  2], [1,  7]],
  [[0,  1], [0,  6]],
  [[2,  1], [2,  6]],
];

const WATER      = [[0, 21], [2, 21]];
const TREES      = [[12,20], [13,20]];
const GRASS      = [[ 1, 1]];

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
  width: 16,
  height: 19,
  appu: 24,
  seed: 3273,
};

/**************
 Map Generation
 **************/

function Island(mapDef) {
  let map = Object.create(mapDef);
  let rng = new Alea(map.seed);

  // generate poisson disk distribution of sites
  let size = [map.width, map.height];
  map.sites = new Poisson(size, 1, 1, 30, rng).fill();
  map.sites = map.sites.deepMap(c => c + 0.5);

  // generate site terrain
  map.zGen = simplexTerrain(rng);
  map.sites.forEach(s => s.terrain = map.zGen(...s));

  // find voronoi diagram of sites
  let diagram = voronoi().size(size)(map.sites);
  map.polygons = diagram.polygons();
  map.edges = diagram.edges;

  //sink border regions
  map.edges
    .filter(edge => !edge.left || !edge.right)
    .forEach(edge => {
      map.sites[(edge.left || edge.right).index].terrain = -1;
    });

  // seperate corners too close together
  let minDist = 0.15;
  map.edges.forEach(edge => {
    let dist = Math.sqrt(distSq(...edge[0], ...edge[1]));
    if (dist < minDist) {
      let diffence = edge[0].map((c, i) => c - edge[1][i]);
      let adjustment = diffence.map(c => c * (minDist - dist) / dist);
      edge[0][0] += adjustment[0]
      edge[0][1] += adjustment[1]
      edge[1][0] -= adjustment[0]
      edge[1][1] -= adjustment[1]
      edge.adjusted = true;
    }
  });

  return map;
}

function Region(points, id) {
  let [x, y] = points.data;
  return {
    x, y, points, id,
    terrain: points.data.terrain,
    units: [],
    connected: [],
    attackedBy: [],
    inbound: [],
    building: 0,
  };
}

function simplexTerrain(rng) {
  let terrain = {
    offset: 0.1,
    octaves: [
      {scale: 0.20, amp: 0.8},
      {scale: 0.03, amp: 1.0}],
  };
  let simplex = new SimplexNoise(rng);
  return function (x, y) {
    return terrain.octaves.reduce((z, n) => {
      return z + n.amp * simplex.noise2D(x * n.scale, y * n.scale);
    }, terrain.offset);
  }
}

/*********
 Map Image
 *********/

function LoadTileset(image, width, height, callback) {
  let context = new Canvas(image.width, image.height).getContext("2d");
  image.decode(data => {
    data = new Uint8ClampedArray(data);
    let imageData = new Canvas.ImageData(data, image.width, image.height);
    context.putImageData(imageData, 0, 0);
    callback({
      width, height,
      frame: (set, number) => {
        if (!set) return undefined;
        let [x, y, w = 1, h = 1] = set[number % set.length];
        return context.getImageData(x*width, y*height, w*width, h*height);
      }
    });
  });
}

function renderMap(map, frames, callback) {
  map.imageURLs = [];
  LoadTileset(tilesetImage, 16, 16, tileset => {
    //TODO send frames immediately as generated
    for (let i = 0; i < frames; ++i)
      map.imageURLs.push(buildMapImageURL(map, tileset, i));
    callback(map.imageURLs);
  });
}

function getBorderType(edge, s1, s2) {
  let slope = Math.abs((edge[0][1]-edge[1][1]) / (edge[0][0]-edge[1][0]));
  let [N, S] = [s1, s2].sort((s1, s2) => s1[1] > s2[1]);
  let [W, E] = [s1, s2].sort((s1, s2) => s1[0] > s2[0]);
  [N, S, W, E] = [N, S, W, E].map(d => Math.floor(d.terrain));

  let type = slope < 1
    ? "H." + N + '.' + S
    : "V." + W + '.' + E;

  switch (type) {
    case 'H.-1.0': return WATER_GRASS[0]; // North coast
    case 'H.0.-1': return WATER_GRASS[1]; // South coast
    case 'V.-1.0': return WATER_GRASS[2]; // West coast
    case 'V.0.-1': return WATER_GRASS[3]; // East coast
    default: return undefined;
  }
}

function buildMapImageURL(map, tileset, frame) {
  let {width, height, appu, edges, polygons} = map;

  let land = new Canvas(width * appu, height * appu).getContext('2d');

  // create pattern buffer
  let pattern = new Canvas(tileset.width, tileset.height).getContext('2d');
  land.fillStyle = land.createPattern(pattern.canvas, 'repeat');

  // grass
  pattern.putImageData(tileset.frame(GRASS, frame), 0, 0);
  polygons
    .filter(poly => poly.data.terrain >= 0)
    .forEach(poly => fillShape(land, 0, 0, poly.deepMap(c => c * appu), 1, 0));

  // construct region borders
  let landData = land.getImageData(0, 0, land.canvas.width, land.canvas.height);

  edges
  .filter(edge => edge.left && edge.right)
  .forEach(edge => {
    let s1 = map.sites[edge.left.index];
    let s2 = map.sites[edge.right.index];

    let mEdge = edge.deepMap(c => c * appu);
    let mQuad = [s1, edge[0], s2, edge[1]].deepMap(c => c * appu);

    if (s1.terrain >= 0 && s2.terrain >= 0)
      bline(landData, 1, ...mEdge, 90, 128, 44, 225);
    
    let slope = Math.abs((edge[0][1]-edge[1][1]) / (edge[0][0]-edge[1][0]));
    let borderType = getBorderType(edge, s1, s2);
    let tile = tileset.frame(borderType, frame);

    // East-West borders
    if (slope < 1 && tile) {
      blinePoints(...mEdge).forEach(point => {
        for (let y = 0; y < tile.height; ++y) {
          let dest = [point[0], point[1] + y - tile.height / 2];
          if (pointInQuad(dest, mQuad)) {
            let sample = getPixel(tile, point[0] % tile.width, y);
            putPixel(landData, ...dest, ...sample);
          }
        }
      });
    }

    // North-South borders
    if (slope >= 1 && tile) {
      blinePoints(...mEdge).forEach(point => {
        for (let x = 0; x < tile.width; ++x) {
          let dest = [point[0] + x - tile.width / 2, point[1]];
          if (pointInQuad(dest, mQuad)) {
            let sample = getPixel(tile, x, point[1] % tile.height);
            putPixel(landData, ...dest, ...sample);
          }
        }
      });
    }
  });

  // draw trees
  let treeTile = tileset.frame(TREES, frame);
  edges.filter(edge => edge.left).forEach(edge => {
    if (edge.left.index % 4 === 0 && map.sites[edge.left.index].terrain >= 0)
      for (let x=0; x<treeTile.width; ++x)
        for(let y=0; y<treeTile.height; ++y)
          drawPixel(landData,
            ...[x, y].map((c, i) => Math.floor(c + edge.left[i] * appu)),
            ...getPixel(treeTile, x, y));
  });

  land.putImageData(landData, 0, 0);

  // create and composite map
  let context = new Canvas(width * appu, height * appu).getContext('2d');

  let waterTile = tileset.frame(WATER, frame);
  for (let x = 0; x < width * appu; x += waterTile.width)
    for (let y = 0; y < height * appu; y += waterTile.height)
      context.putImageData(waterTile, x, y);

  context.drawImage(land.canvas, 0, 0);
  return context.canvas.toDataURL();
}

/************
 Game Control
 ************/

function Game(mapDef, turnTime) {
  console.log("Starting new game...");
  let players = [];

  // create map
  let map = Island(mapDef);

  // initialize regions
  let regions = map.polygons.map((poly, i) => Region(poly, i));

  // find connected regions
  map.edges.forEach(edge => {
    if (edge.left && edge.right) {
      regions[edge.left.index].connected.push(edge.right.index);
      regions[edge.right.index].connected.push(edge.left.index);
    }
  });

  // find spots for units in regions
  let n = 10; // TODO adapt n to map/game
  let spots = new Poisson([n, n], 1).fill().deepMap(c => c/n - 1/2);
  spots.sort((a, b) => distSq(...a, 0, 0) - distSq(...b, 0, 0));

  let game = Object.assign({
    regions,
    map,
    turnTime,
    players,
    spots,
    waitingOn: new Set(),
    nextId: 0,
    turnCount: 0,
    state: {regions, players, spots},
    imageURLs: [],
  });

  return game;
}

function startTurn(game) {
  console.log(chalk.green("\nStarting turn", game.turnCount));
  io.emit("startTurn", game.turnTime);
  game.regions.forEach(region => setGroups(region, [region], [false]));
  game.waitingOn = new Set(game.players);
  if (game.turnTime)
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

function areEnemies(region1, region2) {
  return region1.player !== region2.player
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
    games.push(Game(poissonVoronoi, 0));

  let game = games[0];

  // add the player
  addPlayer(game, player);
  socket.emit("msg", "Connected to server");

  // render map if unrendered
  let frames = 2;
  if (game.map.imageURLs === undefined)
    renderMap(game.map, frames, imageURLs => io.emit("sendMap", imageURLs));
  else if (game.map.imageURLs.length === frames)
    socket.emit("sendMap", game.map.imageURLs);

  socket.emit("sendPlayerId", player);
  socket.emit("sendState", game.state);

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

function blinePoints(p0, p1) {
  let [x0, y0] = p0.map(Math.floor);
  let [x1, y1] = p1.map(Math.floor);
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

function bline(imageData, prob, p0, p1, ...color) {
  blinePoints(p0, p1)
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

function deepMap(array, callback) {
  return Array.isArray(array)
    ? array.map(element => deepMap(element, callback))
    : callback(array);
}

Array.prototype.deepMap = function(callback) {
  return deepMap(this, callback);
}

