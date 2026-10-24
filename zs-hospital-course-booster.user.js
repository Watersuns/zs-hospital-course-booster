// ==UserScript==
// @name         中山医院网课助手（后台播放 / 倍速 / 拖动进度 / 一键补完）
// @namespace    zs-hospital-course-booster
// @version      1.8.0
// @description  解决 course.zs-hospital.sh.cn 网课：切后台弹窗暂停、无法倍速、无法拖动进度条、学习时长不计
// @match        https://course.zs-hospital.sh.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var LOG = '[网课助手] ';
  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  // ---------- 全局状态 ----------
  var desiredRate = 1;      // 期望倍速
  var currentVideo = null;  // 当前视频元素
  var userPaused = false;   // 用户是否手动点了暂停
  var realHidden = false;   // 是否真实处于后台
  var courseId = null, itemId = null;
  var nativeFetch = (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;

  // 在伪装前，先把原生方法和真实可见性保存下来
  var nativePlaybackRate = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  var nativeCurrentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  var realHiddenGetter = (function () {
    var d = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    if (d && d.get) return function () { return d.get.call(document); };
    return function () { return false; };
  })();
  var origAddEventListener = EventTarget.prototype.addEventListener;
  var origRemoveEventListener = EventTarget.prototype.removeEventListener;

  // ---------- 1. 伪装页面始终可见（解决切后台弹窗/暂停） ----------
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
  } catch (e) { log('伪装可见性失败', e); }

  if (Document.prototype.hasFocus) {
    try { Document.prototype.hasFocus = function () { return true; }; } catch (e) {}
  }

  try {
    Object.defineProperty(document, 'onvisibilitychange', { configurable: true, get: function () { return null; }, set: function () {} });
  } catch (e) {}
  try {
    Object.defineProperty(window, 'onblur', { configurable: true, get: function () { return null; }, set: function () {} });
  } catch (e) {}

  // ---------- 2. 拦住网站对“切后台”事件的监听 ----------
  var blockedEvents = { visibilitychange: 1, webkitvisibilitychange: 1, blur: 1 };
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (blockedEvents[String(type)] && (this === document || this === window)) {
      log('已拦截监听事件:', type);
      return undefined;
    }
    return origAddEventListener.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (blockedEvents[String(type)] && (this === document || this === window)) {
      return undefined;
    }
    return origRemoveEventListener.call(this, type, listener, options);
  };

  origAddEventListener.call(document, 'visibilitychange', function () {
    realHidden = realHiddenGetter();
    log('真实状态:', realHidden ? '切到后台' : '回到前台');
    if (realHidden && currentVideo && currentVideo.paused && !currentVideo.ended && !userPaused) {
      try { currentVideo.play(); } catch (e) {}
    }
  });

  // ---------- 3. 倍速：接管 video.playbackRate 属性 ----------
  function setRate(video, r) {
    r = Number(r);
    if (!isFinite(r)) return;
    r = Math.max(0.1, Math.min(16, r));
    desiredRate = r;
    if (video && nativePlaybackRate && nativePlaybackRate.set) {
      try { nativePlaybackRate.set.call(video, r); } catch (e) { log('设置倍速失败', e); }
    }
    setTimeout(function () {
      if (video && nativePlaybackRate && nativePlaybackRate.set) {
        try { nativePlaybackRate.set.call(video, desiredRate); } catch (e) {}
      }
    }, 60);
  }

  function setupPlaybackRateOverride(video) {
    if (!nativePlaybackRate || !nativePlaybackRate.set) return;
    try {
      Object.defineProperty(video, 'playbackRate', {
        configurable: true,
        enumerable: false,
        get: function () { return desiredRate; },
        set: function () {}
      });
      nativePlaybackRate.set.call(video, desiredRate);
    } catch (e) { log('接管倍速属性失败', e); }
  }

  // ---------- 4. 拖动进度：接管 video.currentTime 属性 ----------
  function setupCurrentTimeOverride(video) {
    if (!nativeCurrentTime || !nativeCurrentTime.get) return;
    try {
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        enumerable: false,
        get: function () { return nativeCurrentTime.get.call(video); },
        set: function () {}
      });
    } catch (e) { log('接管进度属性失败', e); }
  }

  function seekTo(video, t) {
    if (!video || !isFinite(video.duration)) return;
    t = Math.max(0, Math.min(video.duration, t));
    if (nativeCurrentTime && nativeCurrentTime.set) {
      try { nativeCurrentTime.set.call(video, t); } catch (e) { log('拖动进度失败', e); }
    }
  }

  // ---------- 5. 自动续播：后台被暂停就恢复 ----------
  function setupAutoResume(video) {
    video.addEventListener('play', function () { userPaused = false; });
    video.addEventListener('pause', function () {
      setTimeout(function () {
        if (realHidden && !video.ended && !userPaused) {
          try { var p = video.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
        }
      }, 200);
    });
  }

  // ---------- 6. 一键补完 ----------
  function buildParams(o) {
    return Object.keys(o).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]);
    }).join('&');
  }

  function getDuration() {
    return (currentVideo && isFinite(currentVideo.duration) && currentVideo.duration > 0) ? currentVideo.duration : null;
  }

  function extractFromUrl() {
    var m;
    m = /itemId=([^&]+)/.exec(location.href); if (m) itemId = m[1];
    m = /courseId=([^&]+)/.exec(location.href); if (m) courseId = m[1];
  }

  function post(functionCode, bodyObj) {
    var body = buildParams(bodyObj);
    var f = nativeFetch || window.fetch;
    return f('/learning/student/studentDataAPI.action?functionCode=' + functionCode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body,
      credentials: 'include'
    }).then(function (r) { return r.text(); });
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function makeKey() {
    return Date.now() + '_' + Math.random().toString(36).slice(2, 12);
  }

  function finishNow() {
    extractFromUrl();
    if (!courseId || !itemId) {
      alert('还没拿到课程信息，请先正常播放一会儿视频，再点「一键补完」。');
      return;
    }

    // 1. 先查服务器要求的“达标时长”satisfied
    post('queryVideoItemDetail', { courseId: courseId, itemId: itemId }).then(function (txt) {
      var j = parseJson(txt);
      log('【一键补完】详情:', txt);
      var lo = (j && j.itemObj && j.itemObj.learnRecordObj) || {};
      var satisfied = Math.round(parseFloat(lo.satisfied) || 0);
      var studyTime = Math.round(parseFloat(lo.studyTime) || 0);
      var completeStatus = lo.completeStatus;

      if (completeStatus === '2' || (satisfied > 0 && studyTime >= satisfied)) {
        alert('这个视频已经完成了（已学 ' + studyTime + ' 秒 / 需 ' + satisfied + ' 秒），无需补完。');
        return;
      }

      var dur = Math.round(getDuration() || 0);
      var target = satisfied || dur || 3128;
      var need = Math.max(0, target - studyTime) + 30; // 多补 30 秒保险

      // 2. 补观看轨迹（整段）
      return post('saveLearnTrack', {
        courseId: courseId, itemId: itemId,
        startTime: 0, endTime: target, currentTime: target,
        createDateTime: Date.now()
      }).then(function (t2) {
        log('【一键补完】补轨迹:', t2);
        // 3. 补学习时长
        return post('sendVideoLearnRecord', {
          courseId: courseId, itemId: itemId,
          recordCount: Math.round(need), playPosition: target,
          playbackRate: 1,
          key: makeKey()
        }).then(function (t3) {
          log('【一键补完】补时长:', t3);
          // 4. 复查状态
          return post('queryVideoItemDetail', { courseId: courseId, itemId: itemId }).then(function (txt4) {
            var j4 = parseJson(txt4);
            log('【一键补完】复查:', txt4);
            var lo4 = (j4 && j4.itemObj && j4.itemObj.learnRecordObj) || {};
            var st4 = Math.round(parseFloat(lo4.studyTime) || 0);
            var cs4 = lo4.completeStatus;
            var msg = '补完结果：\n达标时长：' + satisfied + ' 秒\n当前已学：' + st4 + ' 秒\n完成状态：' + (cs4 === '2' ? '已完成 ✅' : '未完成（' + cs4 + '）');
            if (cs4 === '2') {
              msg += '\n\n此视频已完成。若课程还有其它视频，请到每个视频页各点一次「一键补完」。';
            } else {
              msg += '\n\n仍未完成，请把 F12 控制台里 [网课助手] 的日志发我。';
            }
            alert(msg);
          });
        });
      });
    }).catch(function (e) {
      log('【一键补完】失败', e);
      alert('一键补完发送失败，请按 F12 看控制台报错。');
    });
  }

  // ---------- 7. 浮动控制面板 ----------
  var panel = null, speedLabel = null, seekBar = null, timeLabel = null, playBtn = null;
  var finishBtn = null;
  var dragging = false;

  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.id = 'zsbooster-panel';
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
      'background:rgba(30,30,30,.92);color:#fff;border-radius:10px;padding:12px 14px;' +
      'font:13px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4);' +
      'min-width:280px;user-select:none;';

    var title = document.createElement('div');
    title.textContent = '网课助手（拖动这里可移动）';
    title.style.cssText = 'font-weight:bold;margin-bottom:8px;color:#7bd0ff;cursor:move;';
    panel.appendChild(title);

    // 倍速行
    var speedRow = document.createElement('div');
    speedRow.style.cssText = 'margin-bottom:8px;';
    var speedCap = document.createElement('span');
    speedCap.textContent = '倍速：';
    speedRow.appendChild(speedCap);
    speedLabel = document.createElement('span');
    speedLabel.textContent = '1.0x';
    speedLabel.style.cssText = 'color:#ffd24d;font-weight:bold;margin-right:6px;';
    speedRow.appendChild(speedLabel);
    [1, 1.25, 1.5, 1.75, 2, 2.5, 3].forEach(function (r) {
      var b = document.createElement('button');
      b.textContent = r + 'x';
      b.style.cssText = 'margin:2px 2px 0 0;padding:2px 7px;border:1px solid #666;border-radius:4px;' +
        'background:#444;color:#fff;cursor:pointer;font-size:12px;';
      b.addEventListener('click', function () { clickSpeed(r); });
      speedRow.appendChild(b);
    });
    panel.appendChild(speedRow);

    // 进度行
    var seekRow = document.createElement('div');
    seekRow.style.cssText = 'margin-bottom:8px;';
    var seekCap = document.createElement('span');
    seekCap.textContent = '进度：';
    seekRow.appendChild(seekCap);
    seekBar = document.createElement('input');
    seekBar.type = 'range';
    seekBar.min = 0; seekBar.max = 100; seekBar.value = 0; seekBar.step = 0.1;
    seekBar.style.cssText = 'width:150px;vertical-align:middle;';
    seekBar.addEventListener('input', function () { dragging = true; });
    seekBar.addEventListener('change', function () {
      dragging = false;
      if (currentVideo) seekTo(currentVideo, parseFloat(seekBar.value));
    });
    seekRow.appendChild(seekBar);
    timeLabel = document.createElement('span');
    timeLabel.textContent = ' 0:00 / 0:00';
    timeLabel.style.cssText = 'color:#aaa;font-size:12px;';
    seekRow.appendChild(timeLabel);
    panel.appendChild(seekRow);

    // 快速跳转行
    var jumpRow = document.createElement('div');
    jumpRow.style.cssText = 'margin-bottom:8px;';
    var jumpCap = document.createElement('span');
    jumpCap.textContent = '跳转：';
    jumpRow.appendChild(jumpCap);
    var jumpBtn1 = document.createElement('button');
    jumpBtn1.textContent = '答题';
    jumpBtn1.style.cssText = 'margin:2px 2px 0 0;padding:2px 7px;border:1px solid #666;border-radius:4px;' +
      'background:#444;color:#fff;cursor:pointer;font-size:12px;';
    jumpBtn1.addEventListener('click', function () {
      if (currentVideo && isFinite(currentVideo.duration)) seekTo(currentVideo, currentVideo.duration * 3 / 5);
    });
    jumpRow.appendChild(jumpBtn1);
    var jumpBtn2 = document.createElement('button');
    jumpBtn2.textContent = '评分';
    jumpBtn2.style.cssText = 'margin:2px 2px 0 0;padding:2px 7px;border:1px solid #666;border-radius:4px;' +
      'background:#444;color:#fff;cursor:pointer;font-size:12px;';
    jumpBtn2.addEventListener('click', function () {
      if (currentVideo && isFinite(currentVideo.duration)) seekTo(currentVideo, Math.max(0, currentVideo.duration - 5));
    });
    jumpRow.appendChild(jumpBtn2);
    panel.appendChild(jumpRow);

    // 按钮行
    var btnRow = document.createElement('div');
    playBtn = document.createElement('button');
    playBtn.textContent = '暂停';
    playBtn.style.cssText = 'margin-right:6px;padding:3px 10px;border:1px solid #666;border-radius:4px;' +
      'background:#444;color:#fff;cursor:pointer;font-size:12px;';
    playBtn.addEventListener('click', function () { togglePlay(); });
    btnRow.appendChild(playBtn);

    finishBtn = document.createElement('button');
    finishBtn.textContent = '一键补完';
    finishBtn.style.cssText = 'margin-right:6px;padding:3px 10px;border:1px solid #5a5;border-radius:4px;' +
      'background:#374;color:#fff;cursor:pointer;font-size:12px;';
    finishBtn.addEventListener('click', finishNow);
    btnRow.appendChild(finishBtn);

    var fold = document.createElement('button');
    fold.textContent = '收起';
    fold.style.cssText = 'padding:3px 10px;border:1px solid #666;border-radius:4px;' +
      'background:#444;color:#fff;cursor:pointer;font-size:12px;';
    btnRow.appendChild(fold);
    panel.appendChild(btnRow);

    var rows = [speedRow, seekRow, jumpRow];
    fold.addEventListener('click', function () {
      var hidden = rows[0].style.display === 'none';
      rows.forEach(function (r) { r.style.display = hidden ? '' : 'none'; });
      fold.textContent = hidden ? '收起' : '展开';
    });

    // 拖动面板
    (function () {
      var moving = false, ox, oy, px, py;
      title.addEventListener('mousedown', function (e) {
        moving = true; ox = e.clientX; oy = e.clientY;
        px = panel.offsetLeft; py = panel.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!moving) return;
        panel.style.left = (px + e.clientX - ox) + 'px';
        panel.style.top = (py + e.clientY - oy) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', function () { moving = false; });
    })();

    document.body.appendChild(panel);
  }

  function clickSpeed(r) {
    if (currentVideo) setRate(currentVideo, r);
    if (speedLabel) speedLabel.textContent = r + 'x';
  }

  function togglePlay() {
    if (!currentVideo) return;
    if (currentVideo.paused) {
      userPaused = false;
      try { var p = currentVideo.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
      if (playBtn) playBtn.textContent = '暂停';
    } else {
      userPaused = true;
      try { currentVideo.pause(); } catch (e) {}
      if (playBtn) playBtn.textContent = '播放';
    }
  }

  function fmt(s) {
    s = Math.floor(s || 0);
    var m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function syncPanel() {
    if (!panel || !currentVideo) return;
    var d = currentVideo.duration;
    if (isFinite(d) && d > 0) {
      seekBar.max = d;
      if (!dragging) seekBar.value = currentVideo.currentTime;
      timeLabel.textContent = ' ' + fmt(currentVideo.currentTime) + ' / ' + fmt(d);
    }
    if (speedLabel) speedLabel.textContent = desiredRate + 'x';
    if (playBtn) playBtn.textContent = currentVideo.paused ? '播放' : '暂停';
  }

  // ---------- 8. 发现并接管视频 ----------
  var applied = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  function applyToVideo(video) {
    if (!video) return;
    if (applied && applied.has(video)) return;
    if (applied) applied.add(video);
    currentVideo = video;
    setupPlaybackRateOverride(video);
    setupCurrentTimeOverride(video);
    setupAutoResume(video);
    buildPanel();
    extractFromUrl();
    log('已接管视频:', video.currentSrc || video.src);
    if (desiredRate !== 1) setRate(video, desiredRate);
  }

  function scan() {
    extractFromUrl();
    var v = document.querySelector('video');
    if (v) {
      if (v !== currentVideo) applyToVideo(v);
      syncPanel();
    }
  }
  setInterval(scan, 600);

  (function waitBody() {
    if (document.body) buildPanel();
    else setTimeout(waitBody, 300);
  })();

  log('脚本已启动。');
})();
