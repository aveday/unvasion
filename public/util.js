"use strict";

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

  return new Point(pageX - offsetX, pageY - offsetY);
}

function iterate2D(w, h, f) {
  for (var x = 0; x < w; ++x)
    for (var y = 0; y < h; ++y)
      f(x, y);
}

function fillCanvas(canvas, color) {
  var context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
}
// from http://adripofjavascript.com/blog/drips/object-equality-in-javascript.html
function eq(a, b) {
  // Create arrays of property names
  var aProps = Object.getOwnPropertyNames(a);
  var bProps = Object.getOwnPropertyNames(b);

  // If number of properties is different,
  // objects are not equivalent
  if (aProps.length != bProps.length) {
    return false;
  }

  for (var i = 0; i < aProps.length; i++) {
    var propName = aProps[i];

    // If values of same property are not equal,
    // objects are not equivalent
    if (a[propName] !== b[propName]) {
      return false;
    }
  }

  // If we made it this far, objects
  // are considered equivalent
  return true;
}

// from http://xqt2.com/p/MoreCanvasContext.html
CanvasRenderingContext2D.prototype.shape = function (p,points,s,t){
  var px = p.x + s*(Math.cos(t)*points[0][0] - Math.sin(t)*points[0][1]);
  var py = p.y + s*(Math.sin(t)*points[0][0] + Math.cos(t)*points[0][1]);
  this.beginPath();
  this.moveTo(px, py);
  for (var i = 1; i < points.length; ++i){
    px = p.x + s*(Math.cos(t)*points[i][0] - Math.sin(t)*points[i][1]);
    py = p.y + s*(Math.sin(t)*points[i][0] + Math.cos(t)*points[i][1]);
    this.lineTo(px, py);
  }
  this.closePath();
};

var arrow = [[-2,1], [1,1], [1,2], [3,0], [1,-2], [1,-1], [-2,-1]];


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

