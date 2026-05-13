/*
 * WebGL Water
 * http://madebyevan.com/webgl-water/
 *
 * Copyright 2011 Evan Wallace
 * Released under the MIT license
 */

function text2html(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function handleError(text) {
  var html = text2html(text);
  if (html == 'WebGL not supported') {
    html = 'Your browser does not support WebGL.<br>Please see\
    <a href="http://www.khronos.org/webgl/wiki/Getting_a_WebGL_Implementation">\
    Getting a WebGL Implementation</a>.';
  }
  var loading = document.getElementById('loading');
  loading.innerHTML = html;
  loading.style.zIndex = 1;
}

window.onerror = handleError;

var gl = GL.create({alpha: true});
var water;
var cubemap;
var renderer;
var angleX = -28;
var angleY = -200.5;

// Sphere physics info
var useSpherePhysics = false;
var center;
var oldCenter;
var velocity;
var gravity;
var radius;
var paused = false;

window.onload = function() {
  var ratio = window.devicePixelRatio || 1;
  var help = document.getElementById('help');

  function onresize() {
    var width = innerWidth;
    var height = innerHeight;
    gl.canvas.width = width * ratio;
    gl.canvas.height = height * ratio;
    gl.canvas.style.width = width + 'px';
    gl.canvas.style.height = height + 'px';
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.matrixMode(gl.PROJECTION);
    gl.loadIdentity();
    gl.perspective(45, gl.canvas.width / gl.canvas.height, 0.01, 100);
    gl.matrixMode(gl.MODELVIEW);
    draw();
  }

  document.body.appendChild(gl.canvas);
  gl.clearColor(0, 0, 0, 0);

  water = new Water();
  renderer = new Renderer();
  cubemap = new Cubemap({
    xneg: document.getElementById('xneg'),
    xpos: document.getElementById('xpos'),
    yneg: document.getElementById('ypos'),
    ypos: document.getElementById('ypos'),
    zneg: document.getElementById('zneg'),
    zpos: document.getElementById('zpos')
  });

  if (!water.textureA.canDrawTo() || !water.textureB.canDrawTo()) {
    throw new Error('Rendering to floating-point textures is required but not supported');
  }

  center = oldCenter = new GL.Vector(-0.4, -0.75, 0.2);
  velocity = new GL.Vector();
  gravity = new GL.Vector(0, -4, 0);
  radius = 0.25;

  for (var i = 0; i < 20; i++) {
    water.addDrop(Math.random() * 2 - 1, Math.random() * 2 - 1, 0.03, (i & 1) ? 0.01 : -0.01);
  }

  document.getElementById('loading').innerHTML = '';
  onresize();

  var requestAnimationFrame =
    window.requestAnimationFrame ||
    window.webkitRequestAnimationFrame ||
    function(callback) { setTimeout(callback, 0); };

  var prevTime = new Date().getTime();
  function animate() {
    var nextTime = new Date().getTime();
    if (!paused) {
      update((nextTime - prevTime) / 1000);
      draw();
    }
    prevTime = nextTime;
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  window.onresize = onresize;

  var prevHit;
  var planeNormal;
  var mode = -1;
  var MODE_ADD_DROPS = 0;
  var MODE_MOVE_SPHERE = 1;
  var MODE_ORBIT_CAMERA = 2;

  var oldX, oldY;

  function startDrag(x, y) {
    oldX = x;
    oldY = y;
    var tracer = new GL.Raytracer();
    var ray = tracer.getRayForPixel(x * ratio, y * ratio);
    var pointOnPlane = tracer.eye.add(ray.multiply(-tracer.eye.y / ray.y));
    var sphereHitTest = GL.Raytracer.hitTestSphere(tracer.eye, ray, center, radius);
    if (sphereHitTest) {
      mode = MODE_MOVE_SPHERE;
      prevHit = sphereHitTest.hit;
      planeNormal = tracer.getRayForPixel(gl.canvas.width / 2, gl.canvas.height / 2).negative();
    } else if (Math.abs(pointOnPlane.x) < 1 && Math.abs(pointOnPlane.z) < 1) {
      mode = MODE_ADD_DROPS;
      duringDrag(x, y);
    } else {
      mode = MODE_ORBIT_CAMERA;
    }
  }

  function duringDrag(x, y) {
    switch (mode) {
      case MODE_ADD_DROPS: {
        var tracer = new GL.Raytracer();
        var ray = tracer.getRayForPixel(x * ratio, y * ratio);
        var pointOnPlane = tracer.eye.add(ray.multiply(-tracer.eye.y / ray.y));
        water.addDrop(pointOnPlane.x, pointOnPlane.z, 0.03, 0.01);
        if (paused) {
          water.updateNormals();
          renderer.updateCaustics(water);
        }
        break;
      }
      case MODE_MOVE_SPHERE: {
        var tracer = new GL.Raytracer();
        var ray = tracer.getRayForPixel(x * ratio, y * ratio);
        var t = -planeNormal.dot(tracer.eye.subtract(prevHit)) / planeNormal.dot(ray);
        var nextHit = tracer.eye.add(ray.multiply(t));
        center = center.add(nextHit.subtract(prevHit));
        center.x = Math.max(radius - 1, Math.min(1 - radius, center.x));
        center.y = Math.max(radius - 1, Math.min(10, center.y));
        center.z = Math.max(radius - 1, Math.min(1 - radius, center.z));
        prevHit = nextHit;
        if (paused) renderer.updateCaustics(water);
        break;
      }
      case MODE_ORBIT_CAMERA: {
        angleY -= x - oldX;
        angleX -= y - oldY;
        angleX = Math.max(-89.999, Math.min(89.999, angleX));
        break;
      }
    }
    oldX = x;
    oldY = y;
    if (paused) draw();
  }

  function stopDrag() {
    mode = -1;
  }

  // ── Hover-to-ripple (no click required) ──────────────────────────────────
  var _mouseNear = false;
  var _lastDrop  = 0;

  function _tryHoverDrop(px, py) {
    try {
      var tracer = new GL.Raytracer();
      var ray = tracer.getRayForPixel(px * ratio, py * ratio);
      if (tracer.eye.y > 0 && ray.y < 0) {
        var hit = tracer.eye.add(ray.multiply(-tracer.eye.y / ray.y));
        _mouseNear = Math.abs(hit.x) < 1.4 && Math.abs(hit.z) < 1.4;
        var now = performance.now();
        if (Math.abs(hit.x) < 1 && Math.abs(hit.z) < 1 && now - _lastDrop > 55) {
          water.addDrop(hit.x, hit.z, 0.028, 0.010);
          _lastDrop = now;
        }
      } else {
        _mouseNear = false;
      }
    } catch (err) {
      _mouseNear = false;
    }
  }

  // 클릭 → 카메라 회전 or 구체 이동 (물 위는 호버가 처리하므로 항상 orbit)
  document.onmousedown = function(e) {
    e.preventDefault();
    oldX = e.pageX; oldY = e.pageY;
    try {
      var tracer = new GL.Raytracer();
      var ray    = tracer.getRayForPixel(e.pageX * ratio, e.pageY * ratio);
      var sph    = GL.Raytracer.hitTestSphere(tracer.eye, ray, center, radius);
      if (sph) {
        mode = MODE_MOVE_SPHERE;
        prevHit     = sph.hit;
        planeNormal = tracer.getRayForPixel(gl.canvas.width / 2, gl.canvas.height / 2).negative();
      } else {
        mode = MODE_ORBIT_CAMERA;
      }
    } catch (err) { mode = MODE_ORBIT_CAMERA; }
  };

  document.onmousemove = function(e) {
    if (mode === MODE_ORBIT_CAMERA) {
      angleY -= e.pageX - oldX;
      angleX -= e.pageY - oldY;
      angleX = Math.max(-89.999, Math.min(89.999, angleX));
      oldX = e.pageX; oldY = e.pageY;
      if (paused) draw();
    } else if (mode === MODE_MOVE_SPHERE) {
      duringDrag(e.pageX, e.pageY);
    } else {
      // 드래그 없음 → 호버 물결
      _tryHoverDrop(e.pageX, e.pageY);
    }
  };

  document.onmouseup    = function()  { mode = -1; };
  document.onmouseleave = function()  { mode = -1; _mouseNear = false; };

  // 터치: 한 손가락 이동 → 물결
  document.ontouchstart = function(e) {
    if (e.touches.length === 1) {
      e.preventDefault();
      _tryHoverDrop(e.touches[0].pageX, e.touches[0].pageY);
    }
  };
  document.ontouchmove = function(e) {
    if (e.touches.length === 1) {
      _tryHoverDrop(e.touches[0].pageX, e.touches[0].pageY);
    }
  };

  document.onkeydown = function(e) {
    if (e.which == ' '.charCodeAt(0)) paused = !paused;
    else if (e.which == 'G'.charCodeAt(0)) useSpherePhysics = !useSpherePhysics;
    else if (e.which == 'L'.charCodeAt(0) && paused) draw();
  };

  var frame = 0;

  function update(seconds) {
    if (seconds > 1) return;
    frame += seconds * 2;

    if (mode == MODE_MOVE_SPHERE) {
      // Start from rest when the player releases the mouse after moving the sphere
      velocity = new GL.Vector();
    } else if (useSpherePhysics) {
      // Fall down with viscosity under water
      var percentUnderWater = Math.max(0, Math.min(1, (radius - center.y) / (2 * radius)));
      velocity = velocity.add(gravity.multiply(seconds - 1.1 * seconds * percentUnderWater));
      velocity = velocity.subtract(velocity.unit().multiply(percentUnderWater * seconds * velocity.dot(velocity)));
      center = center.add(velocity.multiply(seconds));

      // Bounce off the bottom
      if (center.y < radius - 1) {
        center.y = radius - 1;
        velocity.y = Math.abs(velocity.y) * 0.7;
      }
    }

    // Displace water around the sphere
    water.moveSphere(oldCenter, center, radius);
    oldCenter = center;

    // Update the water simulation and graphics
    water.stepSimulation();
    water.stepSimulation();
    // 마우스가 멀리 있을 때 추가 감쇠 — 빠르게 잔잠
    if (!_mouseNear) {
      water.stepSimulation();
      water.stepSimulation();
    }
    water.updateNormals();
    renderer.updateCaustics(water);
  }

  function draw() {
    // Change the light direction to the camera look vector when the L key is pressed
    if (GL.keys.L) {
      renderer.lightDir = GL.Vector.fromAngles((90 - angleY) * Math.PI / 180, -angleX * Math.PI / 180);
      if (paused) renderer.updateCaustics(water);
    }

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.loadIdentity();
    gl.translate(0, 0, -4.2);
    gl.rotate(-angleX, 1, 0, 0);
    gl.rotate(-angleY, 0, 1, 0);
    gl.translate(0, 0.4, 0);

    gl.enable(gl.DEPTH_TEST);
    renderer.sphereCenter = center;
    renderer.sphereRadius = radius;
    renderer.renderCube();
    renderer.renderWater(water, cubemap);
    renderer.renderSphere();
    gl.disable(gl.DEPTH_TEST);
  }
};
