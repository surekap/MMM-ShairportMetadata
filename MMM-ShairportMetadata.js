/* global Log, Module */

/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By Prateek Sureka <surekap@gmail.com>  — MIT Licensed.
 * Progress bar forked by ChielChiel.
 * Smooth rendering: GPU compositor drives both the progress fill (one CSS
 * transition over the remaining song) and the enter/leave animations.
 * JS only handles state changes + cheap label text.
 */

Module.register("MMM-ShairportMetadata", {

  defaults: {
    mqttUrl: "mqtt://localhost:1883",
    mqttTopic: "shairport",  // shairport-sync's mqtt "topic" setting
    alignment: "center",
    hideAfter: 0,        // seconds paused before hiding; 0 = hide only on disconnect
    leaveDurationMs: 470
  },

  start: function () {
    Log.info("Starting module: " + this.name);
    this.metadata = {};
    this.albumart = null;
    this.playing = false;
    this.stopped = true;
    this.baseSec = 0;
    this.anchor = this.now();
    this.rate = 1;
    this.songLenSec = 0;
    this.lastUpdate = this.now();
    this.glowColor = "rgba(140,80,200,0.28)";

    this.cardEl = null;
    this.artWrap = null;
    this.artImg = null;
    this.refs = {};
    this.visible = false;
    this.appearing = false;
    this.leaving = false;
    this.leaveTimer = null;

    this.sendSocketNotification("CONFIG", this.config);

    // Cheap timer: updates only the time-label TEXT and the inactivity check.
    // The bar itself is NOT driven here — the GPU animates it. 1s is plenty.
    setInterval(() => { this.tick(); }, 1000);
  },

  now: function () { return new Date().getTime() / 1000; },

  elapsedNow: function () {
    var e = this.playing ? this.baseSec + (this.now() - this.anchor) * this.rate : this.baseSec;
    if (e < 0) { e = 0; }
    if (this.songLenSec > 0 && e > this.songLenSec) { e = this.songLenSec; }
    return e;
  },

  secToTime: function (sec) {
    sec = Math.max(0, Math.floor(sec));
    var min = Math.floor(sec / 60);
    var remain = sec % 60;
    return min + ":" + (remain < 10 ? "0" : "") + remain;
  },

  shouldHide: function () {
    // While playing there are no updates between tracks, so only time out pauses.
    if (!this.config.hideAfter || this.playing) { return false; }
    return (this.now() > this.lastUpdate + this.config.hideAfter);
  },

  getHeader: function () { return ""; },

  // payload: { state: "stopped" } or
  // { state: "playing"|"paused", title, artist, album, duration, position, rate,
  //   artwork? }  — times in seconds; artwork (data URL or null) only when it changed.
  socketNotificationReceived: function (notification, payload) {
    if (notification !== "STATE") { return; }
    this.lastUpdate = this.now();

    if (payload.hasOwnProperty("artwork")) {
      this.albumart = payload.artwork || null;
      if (this.albumart) { this.extractGlow(this.albumart); }
      else { this.setGlow("rgba(140,80,200,0.28)"); }
      if (this.visible && this.artImg) { this.applyArt(); }
    }

    if (payload.state === "stopped") {
      this.metadata = {};
      this.beginLeave();
      return;
    }

    if (this.leaving) { this.cancelLeave(); }
    this.stopped = false;

    this.metadata = payload;
    this.playing = payload.state === "playing";
    this.rate = payload.rate > 0 ? payload.rate : 1;
    this.baseSec = payload.position || 0;
    this.songLenSec = payload.duration || 0;
    this.anchor = this.now();

    if (!this.visible) {
      this.appearing = true;
      this.updateDom(0);
    } else {
      this.updateCardContent();
    }
  },

  beginLeave: function () {
    if (!this.visible || !this.cardEl) {
      this.stopped = true; this.playing = false; this.updateDom(0); return;
    }
    if (this.leaving) { return; }
    this.leaving = true;
    this.cardEl.classList.remove("anim-in");
    this.cardEl.classList.add("anim-out");
    var self = this;
    this.leaveTimer = setTimeout(function () {
      self.leaving = false; self.leaveTimer = null;
      self.stopped = true; self.playing = false;
      self.updateDom(0);
    }, this.config.leaveDurationMs);
  },

  cancelLeave: function () {
    this.leaving = false;
    if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
    if (this.cardEl) { this.cardEl.classList.remove("anim-out"); }
  },

  tick: function () {
    if (this.visible && !this.leaving && this.shouldHide()) {
      this.metadata = {}; this.beginLeave(); return;
    }
    if (!this.visible || this.leaving || this.stopped) { return; }
    this.renderLabels();
  },

  // Text only — never touches the bar.
  renderLabels: function () {
    if (!this.refs.elapsedSpan) { return; }
    var total = this.songLenSec;
    var elapsed = this.elapsedNow();
    this.refs.elapsedSpan.textContent = this.secToTime(elapsed);
    if (!this.playing) {
      this.refs.rightSpan.className = "paused-badge";
      this.refs.rightSpan.textContent = "paused";
    } else {
      this.refs.rightSpan.className = "";
      this.refs.rightSpan.textContent = total > 0 ? "-" + this.secToTime(Math.max(0, total - elapsed)) : "";
    }
  },

  // The smooth bit: one compositor transition from the current position to the
  // end over the remaining duration. No per-frame JS.
  syncBar: function () {
    var fill = this.refs.fillEl;
    if (!fill || this.songLenSec <= 0) { return; }
    var total = this.songLenSec;
    var elapsed = this.elapsedNow();
    var f = Math.max(0, Math.min(1, elapsed / total));

    // Freeze at the current position (no transition), and force the browser to
    // commit it before we arm the long transition.
    fill.style.transition = "none";
    fill.style.transform = "scaleX(" + f + ")";
    void fill.offsetWidth;  // reflow

    if (this.playing) {
      var remaining = Math.max(0, total - elapsed);
      var self = this;
      // Two rAFs so the frozen state paints first; otherwise the transition
      // won't run (this also covers the just-built-not-yet-inserted case).
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (!self.playing || !self.refs.fillEl) { return; }
          self.refs.fillEl.style.transition = "transform " + (remaining / self.rate) + "s linear";
          self.refs.fillEl.style.transform = "scaleX(1)";
        });
      });
    }
  },

  applyArt: function () {
    if (this.albumart) {
      this.artImg.src = this.albumart;
      this.artImg.style.display = "";
      this.artWrap.classList.remove("no-art");
    } else {
      this.artImg.removeAttribute("src");
      this.artImg.style.display = "none";
      this.artWrap.classList.add("no-art");
    }
  },

  updateCardContent: function () {
    if (!this.cardEl) { return; }
    this.refs.titleEl.textContent = this.metadata.title || "";
    this.refs.artistEl.textContent = this.metadata.artist || "";
    var album = this.metadata.album || "";
    this.refs.albumEl.textContent = album;
    this.refs.albumEl.style.display = album ? "" : "none";
    this.applyArt();
    this.setGlow(this.glowColor);
    // No bar for live streams or senders that give no duration.
    this.refs.progWrap.style.display = this.songLenSec > 0 ? "" : "none";
    this.renderLabels();
    this.syncBar();
  },

  setGlow: function (c) {
    this.glowColor = c;
    if (this.cardEl) { this.cardEl.style.setProperty("--art-glow", c); }
  },

  extractGlow: function (dataUrl) {
    var self = this;
    var img = new Image();
    img.onload = function () {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = 16; canvas.height = 16;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 16, 16);
        var d = ctx.getImageData(0, 0, 16, 16).data;
        var r = 0, g = 0, b = 0, count = 0;
        for (var i = 0; i < d.length; i += 4) {
          var brightness = (d[i] + d[i + 1] + d[i + 2]) / 3;
          var max = Math.max(d[i], d[i + 1], d[i + 2]);
          var sat = max > 0 ? (max - Math.min(d[i], d[i + 1], d[i + 2])) / max : 0;
          if (brightness > 20 && sat > 0.15) { r += d[i]; g += d[i + 1]; b += d[i + 2]; count++; }
        }
        if (count > 0) {
          r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
          self.setGlow("rgba(" + r + "," + g + "," + b + ",0.35)");
        } else {
          self.setGlow("rgba(140,80,200,0.28)");
        }
      } catch (e) { /* tainted canvas — ignore */ }
    };
    img.src = dataUrl;
  },

  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.style.textAlign =
      this.config.alignment === "left" ? "left"
        : this.config.alignment === "right" ? "right" : "center";

    if (this.stopped && !this.leaving) {
      this.cardEl = null; this.artWrap = null; this.artImg = null;
      this.refs = {}; this.visible = false;
      wrapper.style.display = "none";
      return wrapper;
    }

    var card = document.createElement("div");
    card.className = "airplay-card";
    card.style.display = "inline-flex";

    var artWrap = document.createElement("div");
    artWrap.className = "albumart-wrap";
    var img = document.createElement("img");
    artWrap.appendChild(img);
    card.appendChild(artWrap);

    var info = document.createElement("div");
    info.className = "track-info";
    var titleEl = document.createElement("div"); titleEl.className = "track-title";
    var artistEl = document.createElement("div"); artistEl.className = "track-artist";
    var albumEl = document.createElement("div"); albumEl.className = "track-album";
    info.appendChild(titleEl); info.appendChild(artistEl); info.appendChild(albumEl);
    card.appendChild(info);

    var progWrap = document.createElement("div"); progWrap.className = "progress-wrap";
    var track = document.createElement("div"); track.className = "progress-track";
    var fillEl = document.createElement("div"); fillEl.className = "progress-fill";
    track.appendChild(fillEl);
    progWrap.appendChild(track);
    card.appendChild(progWrap);

    var times = document.createElement("div"); times.className = "progress-times";
    var elapsedSpan = document.createElement("span");
    var rightSpan = document.createElement("span");
    times.appendChild(elapsedSpan); times.appendChild(rightSpan);
    card.appendChild(times);

    this.cardEl = card;
    this.artWrap = artWrap;
    this.artImg = img;
    this.refs = { titleEl, artistEl, albumEl, progWrap, fillEl, elapsedSpan, rightSpan };

    this.updateCardContent();

    if (this.appearing) { card.classList.add("anim-in"); this.appearing = false; }

    this.visible = true;
    wrapper.appendChild(card);
    return wrapper;
  },

  getStyles: function () {
    return ["MMM-ShairportMetadata.css"];
  }

});
