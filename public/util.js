'use strict';

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
  var context = canvas.getContext('2d');
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
}

var arrow = [[-2,1], [1,1], [1,2], [3,0], [1,-2], [1,-1], [-2,-1]];
