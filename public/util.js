"use strict";

function distSq(x1, y1, x2, y2) {
  let dx = x1 - x2;
  let dy = y1 - y2;
  return dx*dx + dy*dy;
}

function closestPoint(x, y, points) {
  let minDist = Infinity;
  return points.reduce((a, v) => {
    let dist = distSq(x, y, v.x, v.y);
    minDist = Math.min(dist, minDist);
    return dist === minDist ? v : a;
  }, points[0]);
}

function elementCoords(baseElement, pageX, pageY) {
  var element = baseElement;
  var offsetX = 0;
  var offsetY = 0;

  if (element.offsetParent) {
    do {
      offsetX += element.offsetLeft;
      offsetY += element.offsetTop;
    } while ((element = element.offsetParent));
  }

  return [pageX - offsetX, pageY - offsetY];
}

function fillCanvas(canvas, color) {
  var context = canvas.getContext("2d");
  context.globalAlpha = 1;
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
}

// from http://xqt2.com/p/MoreCanvasContext.html
CanvasRenderingContext2D.prototype.fillShape = function (x,y,points,s,t){
  var px = x + s*(Math.cos(t)*points[0][0] - Math.sin(t)*points[0][1]);
  var py = y + s*(Math.sin(t)*points[0][0] + Math.cos(t)*points[0][1]);
  this.beginPath();
  this.moveTo(px, py);
  for (var i = 1; i < points.length; ++i){
    px = x + s*(Math.cos(t)*points[i][0] - Math.sin(t)*points[i][1]);
    py = y + s*(Math.sin(t)*points[i][0] + Math.cos(t)*points[i][1]);
    this.lineTo(px, py);
  }
  this.closePath();
  this.fill();
};

var shapes = {
  arrow: [[-2,1], [1,1], [1,2], [3,0], [1,-2], [1,-1], [-2,-1]],
  square: [[-1,1],  [1,1], [1, -1], [-1,-1]],
};

// https://github.com/micro-js/hsv-to-rgb/blob/master/lib/index.js
function hsvToRgb (h, s, v) {
  h /= 360;
  v = Math.round(v * 255);

  var i = Math.floor(h * 6);
  var f = h * 6 - i;
  var p = Math.round(v * (1 - s));
  var q = Math.round(v * (1 - f * s));
  var t = Math.round(v * (1 - (1 - f) * s));

  switch (i % 6) {
  case 0:
    return [v, t, p];
  case 1:
    return [q, v, p];
  case 2:
    return [p, v, t];
  case 3:
    return [p, q, v];
  case 4:
    return [t, p, b];
  case 5:
    return [v, p, q];
  }
}

// http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
String.prototype.hashCode = function() {
  var hash = 0, i, chr, len;
  if (this.length === 0) return hash;
  for (i = 0, len = this.length; i < len; i++) {
    chr   = this.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
};

function putPixel(imageData, x, y, r, g, b, a) {
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

function pairs(arr) {
  return arr.map((v, i) => [v, arr[(i+1) % arr.length]]);
}

