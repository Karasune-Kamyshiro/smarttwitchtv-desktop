/*
 * SmartTwitchTV Desktop — page-side replacement for the APK's Java "WebAppInterface".
 *
 * The SmartTwitchTV web app switches into its full TV mode when it finds a global
 * `Android` object. This file provides that object for the desktop:
 *   - HTTP goes through the Electron main process (no CORS limits, like the APK)
 *   - video uses <video> + hls.js instead of ExoPlayer, with the same player slots
 *     (0 main, 1 picture-in-picture, 0-3 multistream, 4 feed preview), layouts and
 *     retry/end callbacks as PlayerActivity.java
 *   - gamepads are translated to the key events a TV remote would send
 *
 * Licensed GPL-3.0-or-later, like SmartTwitchTV.
 */
(function () {
    'use strict';

    var D = window.__stvDesktop;
    if (!D || window.Android) return;

    var INFO = D.info();
    var LOG = '[stv-desktop]';

    // ---------------------------------------------------------------- helpers
    function callJS(name) {
        var args = Array.prototype.slice.call(arguments, 1);
        setTimeout(function () {
            var api = window.smartTwitchTV;
            if (api && typeof api[name] === 'function') {
                try {
                    api[name].apply(null, args);
                } catch (e) {
                    console.error(LOG, 'callback failed', name, e);
                }
            } else {
                console.warn(LOG, 'missing callback', name);
            }
        }, 0);
    }

    function onBody(fn) {
        if (document.body) fn();
        else document.addEventListener('DOMContentLoaded', fn, { once: true });
    }

    function el(tag, cls, parent) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (parent) parent.appendChild(e);
        return e;
    }

    function pad(v) {
        return (v < 10 ? '&nbsp;&nbsp;' : '') + v.toFixed(2);
    }
    // Tools.GetCounters / Tools.getTime
    function counters(value, sum, count) {
        return pad(value) + ' | ' + pad(count > 0 ? sum / count : 0);
    }
    function timeStr(ms) {
        return pad(ms > 0 ? ms / 1000 : 0);
    }

    function fpsOf(level) {
        var f = level && level.frameRate ? Math.round(level.frameRate) : 0;
        if (!f && level && level.attrs && level.attrs['FRAME-RATE']) f = Math.round(parseFloat(level.attrs['FRAME-RATE']));
        return f > 0 ? f : '';
    }
    function bandStr(b) {
        return b > 0 ? ' | ' + (b / 1000000).toFixed(2) + 'Mbps' : '';
    }
    function codecStr(c) {
        if (!c) return '';
        if (c.indexOf('avc') > -1) return ' | AVC';
        if (c.indexOf('vp9') > -1 || c.indexOf('vp09') > -1) return ' | VP9';
        if (c.indexOf('hvc') > -1 || c.indexOf('hev') > -1) return ' | HEVC';
        if (c.indexOf('av01') > -1) return ' | AV1';
        if (c.indexOf('mp4a') > -1) return ' | MP4';
        return '';
    }

    // ---------------------------------------------------------------- state (mirrors PlayerActivity fields)
    var S = {
        isFullScreen: true,
        fullScreenSize: 3,
        fullScreenPosition: 0,
        picturePicture: false,
        ppPosition: 0,
        ppSize: 3,
        multi: false,
        previewSize: 1,
        feedPosition: 2,
        feedBottom: null,
        sidePanelRect: null,
        screensRect: null,
        autoMode: true,
        checkSource: true,
        lowLatency: 0,
        lowLatencyVod: 0,
        buffer: [4000, 4000, 4000],
        audioEnabled: [true, false, false, false],
        previewOthersVolume: 1,
        mainCap: { bitrate: 0, resolution: 0 },
        smallCap: { bitrate: 0, resolution: 0 },
        appToken: null,
        speed: 1,
        stats: { speedSum: 0, speedCount: 0, net: 0, netSum: 0, netCount: 0, droppedTotal: 0, lastDropped: 0 }
    };

    var Z_BACK = -10; // behind the web UI (html background is black, body transparent)
    var Z_FRONT = 2147483000; // above the web UI (screen/side-panel previews)

    // ---------------------------------------------------------------- layout geometry (SetDefaultLayouts)
    var GRAVITY = ['RB', 'RC', 'RT', 'CT', 'LT', 'LC', 'LB', 'CB'];
    var SIDE_BY_SIDE = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6];
    var SMALL_DIV = [2, 2.5, 3, 3.5, 4];
    var FEED_DIV = [5, 3.77, 3.25, 2.7];

    function W() {
        return window.innerWidth;
    }
    function H() {
        return window.innerHeight;
    }

    function rect(w, h, gravity, m) {
        m = m || {};
        var x, y;
        var gx = gravity.charAt(0),
            gy = gravity.charAt(1);
        if (gx === 'L') x = m.left || 0;
        else if (gx === 'R') x = W() - w - (m.right || 0);
        else x = (W() - w) / 2;
        if (gy === 'T') y = m.top || 0;
        else if (gy === 'B') y = H() - h - (m.bottom || 0);
        else y = (H() - h) / 2;
        return { x: x, y: y, w: w, h: h };
    }

    var L = {
        full: function () {
            return { x: 0, y: 0, w: W(), h: H() };
        },
        sideBySide: function (pos, size) {
            var s = SIDE_BY_SIDE[size] || SIDE_BY_SIDE[3];
            return rect(W() * s, H() * s, pos === 1 ? 'LC' : 'RC');
        },
        small: function (pos, size) {
            var d = SMALL_DIV[size] || SMALL_DIV[3];
            return rect(W() / d, H() / d, GRAVITY[pos] || 'RB');
        },
        multi: function (i) {
            var w2 = W() / 2,
                h2 = H() / 2,
                w3 = W() / 3,
                h3 = H() / 3;
            return [
                rect(w2, h2, 'LT'),
                rect(w2, h2, 'RT'),
                rect(w2, h2, 'LB'),
                rect(w2, h2, 'RB'),
                rect(w3 * 2, h3 * 2, 'LT'),
                rect(w3, h3, 'LB'),
                rect(w3, h3, 'CB'),
                rect(w3, h3, 'RB')
            ][i];
        },
        feed: function (size, position) {
            var d = FEED_DIV[size] || FEED_DIV[1];
            var w = W() / d,
                h = H() / d;
            var bottom = S.feedBottom !== null ? S.feedBottom : W() / 11;
            var margin = (W() / 5) * 1.5 - w / 2;
            var g = ['LB', 'LB', 'CB', 'RB', 'RB'][position] || 'CB';
            return rect(w, h, g, {
                bottom: bottom,
                left: position === 1 ? margin : 0,
                right: position === 3 ? margin : 0
            });
        },
        // Tools.BasePreviewLayout
        preview: function (bottom, right, left, webHeight, bigger) {
            var scale = H() / (webHeight || H());
            var width = (right - left) * scale;
            var offset = width / 135;
            width -= offset;
            var bottomMargin = bottom * scale;
            var leftMargin = left * scale + offset / 1.8;
            if (bigger) {
                bottomMargin = H() - bottomMargin - offset / 2.2;
                var old = width;
                width = width * 1.26;
                leftMargin = leftMargin - (width - old) / 2;
                if (leftMargin < 0) leftMargin = 0;
                else if (leftMargin + width > W()) leftMargin = W() - width;
            } else {
                bottomMargin = H() - bottomMargin + offset / 1.8;
            }
            var height = (width * 9) / 16;
            return rect(width, height, 'LB', { left: leftMargin, bottom: bottomMargin });
        }
    };

    // ---------------------------------------------------------------- loading indicators & toast
    var ui = {};
    onBody(function () {
        ui.loading = el('div', 'stv-loading stv-hidden', document.body);
        el('div', 'stv-spinner', ui.loading);
        ui.loadingBottom = el('div', 'stv-loading stv-loading-bottom stv-hidden', document.body);
        el('div', 'stv-spinner', ui.loadingBottom);
        ui.toast = el('div', 'stv-toast', document.body);
    });
    function showLoading(which, show) {
        var e = ui[which];
        if (e) e.classList.toggle('stv-hidden', !show);
    }
    var toastTimer;
    function toast(text) {
        if (!ui.toast) return;
        ui.toast.textContent = text;
        ui.toast.classList.add('stv-toast-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            ui.toast.classList.remove('stv-toast-show');
        }, 3500);
    }

    // ---------------------------------------------------------------- Player (one ExoPlayer instance + PlayerView)
    function Player(id) {
        this.id = id;
        this.pos = id;
        this.type = 1;
        this.uri = null;
        this.playlist = null;
        this.resume = 0;
        this.isScreenPreview = false;
        this.checkCounter = 0;
        this.volume = 1;
        this.hls = null;
        this.blobUrl = null;
        this.active = false;
        this.wantPlay = false;
        this.rect = null;
        this.front = false;
        this.timers = {};
        this.levelCap = null;

        var self = this;
        onBody(function () {
            self.box = el('div', 'stv-player stv-hidden', document.body);
            self.video = el('video', 'stv-video', self.box);
            self.video.playsInline = true;
            self.video.preload = 'auto';
            self.spinner = el('div', 'stv-spinner stv-hidden', self.box);
            self.bind();
            self.applyRect();
        });
    }

    Player.prototype.bind = function () {
        var self = this,
            v = this.video;
        v.addEventListener('waiting', function () {
            if (!self.active) return;
            self.setBuffering(true);
        });
        v.addEventListener('playing', function () {
            if (!self.active) return;
            self.setBuffering(false);
            self.onReady();
        });
        v.addEventListener('ended', function () {
            if (!self.active) return;
            self.clearTimers();
            self.wantPlay = false;
            playerEnded(self.pos, 0, 0);
        });
        v.addEventListener('error', function () {
            if (!self.active || self.hls) return; // hls.js reports its own errors
            var code = v.error ? v.error.code : 0;
            checkCounter(self.pos, 1, code);
        });
    };

    Player.prototype.setBuffering = function (on) {
        var self = this;
        if (this.spinner) this.spinner.classList.toggle('stv-hidden', !on);
        clearTimeout(this.timers.lag);
        if (on) {
            // Same idea as the STATE_BUFFERING check in PlayerActivity: if the player stays
            // stuck in buffering for too long, run the retry/give-up logic.
            var delay = (S.buffer[this.type - 1] || 4000) + 8000 + (S.multi ? 4000 : 0);
            this.timers.lag = setTimeout(function () {
                if (self.active && self.wantPlay && self.video.readyState < 3) checkCounter(self.pos, 2, 0);
            }, delay);
        }
    };

    Player.prototype.onReady = function () {
        var self = this;
        clearTimeout(this.timers.counterReset);
        this.timers.counterReset = setTimeout(function () {
            self.checkCounter = 0;
        }, 8000);

        if (this.pos < 4) {
            if (this.type === 1) {
                // keep the other players running so they stay in sync
                for (var i = 0; i < 4; i++) {
                    if (i !== this.pos && slots[i].active && slots[i].video.paused && slots[i].wantPlay) slots[i].play();
                }
                if (this.pos < 2) callJS('ChatLive_SetLatency', this.pos, this.liveOffset());
            } else {
                callJS('Play_UpdateDuration', this.duration());
            }
            if (this.pos === 0 && this.isScreenPreview) applyAudio();
        } else {
            applyAudio();
        }
    };

    Player.prototype.clearTimers = function () {
        for (var k in this.timers) clearTimeout(this.timers[k]);
        this.timers = {};
    };

    Player.prototype.set = function (isScreenPreview, type, resume) {
        this.isScreenPreview = !!isScreenPreview;
        this.type = type || 1;
        this.checkCounter = 0;
        this.resume = resume > 0 && this.type > 1 ? resume : 0;
    };

    Player.prototype.load = function (uri, playlist) {
        this.uri = uri;
        this.playlist = playlist || null;
        this.setup();
    };

    // SetupPlayer
    Player.prototype.setup = function () {
        var self = this;
        this.release(true);
        // The APK plays straight from the playlist text; the URL is often undefined.
        if (!this.uri && !this.playlist) return;

        this.active = true;
        this.wantPlay = true;
        this.show(true);
        this.setBuffering(true);

        var v = this.video;
        v.playbackRate = S.speed;

        if (this.uri === 'undefined' || this.uri === 'null') this.uri = null;

        if (this.type === 3 || !window.Hls || !Hls.isSupported()) {
            v.src = this.uri;
            if (this.resume > 0) v.currentTime = this.resume / 1000;
        } else {
            var live = this.type === 1;
            var lowLatency = live ? S.lowLatency > 0 : S.lowLatencyVod > 0;
            var hls = new Hls({
                lowLatencyMode: lowLatency,
                liveSyncDurationCount: lowLatency ? 2 : 3,
                maxBufferLength: Math.max(10, (S.buffer[this.type - 1] || 4000) / 1000 + 6),
                backBufferLength: live ? 30 : 90,
                startPosition: this.resume > 0 ? this.resume / 1000 : -1,
                capLevelToPlayerSize: this.pos !== 0 || this.isScreenPreview,
                enableWorker: true
            });
            this.hls = hls;

            var src = this.uri;
            if (this.playlist) {
                this.blobUrl = URL.createObjectURL(new Blob([this.playlist], { type: 'application/vnd.apple.mpegurl' }));
                src = this.blobUrl;
            }

            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                self.applyCap();
                if (!S.autoMode && self.pos === 0 && self.forcedLevel !== undefined && self.forcedLevel < hls.levels.length) {
                    hls.currentLevel = self.forcedLevel;
                }
                // onTracksChanged → let the web app read the qualities
                if (self.pos === 0 && !S.picturePicture && !S.multi && self.type < 3) {
                    callJS('Play_getQualities', self.type);
                }
            });
            hls.on(Hls.Events.FRAG_LOADED, function (_e, data) {
                var st = data.frag && data.frag.stats;
                if (!st) return;
                var bytes = st.total || st.loaded || 0;
                S.stats.net += (bytes * 8) / 1000000;
                var ms = st.loading && st.loading.end && st.loading.start ? st.loading.end - st.loading.start : 0;
                if (ms > 0 && self.pos === 0) {
                    var mbps = (bytes * 8) / 1000 / ms;
                    S.stats.lastSpeed = mbps;
                    S.stats.speedSum += mbps;
                    S.stats.speedCount++;
                }
            });
            hls.on(Hls.Events.ERROR, function (_e, data) {
                if (!data.fatal) return;
                var code = data.response && data.response.code ? data.response.code : 0;
                console.warn(LOG, 'player', self.pos, 'fatal', data.type, data.details, code);
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && self.checkCounter < 1) {
                    hls.recoverMediaError();
                    return;
                }
                checkCounter(self.pos, 1, code);
            });

            hls.loadSource(src);
            hls.attachMedia(v);
        }
        this.play();
        applyAudio();
    };

    Player.prototype.applyCap = function () {
        var hls = this.hls;
        if (!hls || !hls.levels || !hls.levels.length) return;
        var cap = this.pos === 0 && !S.picturePicture && !S.multi && !this.isScreenPreview ? S.mainCap : S.smallCap;
        if (!cap.bitrate && !cap.resolution) {
            hls.autoLevelCapping = -1;
            return;
        }
        var best = -1;
        for (var i = 0; i < hls.levels.length; i++) {
            var l = hls.levels[i];
            if ((!cap.bitrate || l.bitrate <= cap.bitrate) && (!cap.resolution || l.height <= cap.resolution)) best = i;
        }
        hls.autoLevelCapping = best;
    };

    Player.prototype.play = function () {
        this.wantPlay = true;
        var p = this.video && this.video.play();
        if (p && p.catch) p.catch(function () {});
    };

    Player.prototype.pause = function () {
        this.wantPlay = false;
        if (this.video) this.video.pause();
    };

    // releasePlayer
    Player.prototype.release = function (keepConfig) {
        this.clearTimers();
        this.active = false;
        this.wantPlay = false;
        if (this.hls) {
            try {
                this.hls.destroy();
            } catch (e) {}
            this.hls = null;
        }
        if (this.blobUrl) {
            URL.revokeObjectURL(this.blobUrl);
            this.blobUrl = null;
        }
        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }
        if (this.spinner) this.spinner.classList.add('stv-hidden');
        if (!keepConfig) {
            this.uri = null;
            this.playlist = null;
            this.resume = 0;
            this.forcedLevel = undefined;
            this.show(false);
        }
    };

    Player.prototype.show = function (on) {
        if (this.box) this.box.classList.toggle('stv-hidden', !on);
    };

    Player.prototype.layout = function (r) {
        this.rect = r;
        this.applyRect();
    };

    Player.prototype.applyRect = function () {
        if (!this.box) return;
        var r = this.rect || L.full();
        var s = this.box.style;
        s.left = r.x + 'px';
        s.top = r.y + 'px';
        s.width = r.w + 'px';
        s.height = r.h + 'px';
        s.zIndex = this.id === 4 ? Z_FRONT + 10 : (this.front ? Z_FRONT : Z_BACK) + this.pos;
        this.box.classList.toggle('stv-preview', this.id === 4 || this.front);
    };

    Player.prototype.currentMs = function () {
        if (!this.active || !this.video) return 0;
        return Math.max(0, Math.round(this.video.currentTime * 1000));
    };

    Player.prototype.duration = function () {
        var v = this.video;
        if (!this.active || !v) return 0;
        if (isFinite(v.duration) && v.duration > 0) return Math.round(v.duration * 1000);
        if (v.seekable && v.seekable.length) return Math.round(v.seekable.end(v.seekable.length - 1) * 1000);
        return 0;
    };

    Player.prototype.liveOffset = function () {
        if (this.hls && typeof this.hls.latency === 'number' && isFinite(this.hls.latency)) return Math.round(this.hls.latency * 1000);
        var v = this.video;
        if (v && v.seekable && v.seekable.length) {
            return Math.max(0, Math.round((v.seekable.end(v.seekable.length - 1) - v.currentTime) * 1000));
        }
        return 0;
    };

    Player.prototype.bufferMs = function () {
        var v = this.video;
        if (!v || !v.buffered) return 0;
        for (var i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) >= v.currentTime) {
                return Math.max(0, Math.round((v.buffered.end(i) - v.currentTime) * 1000));
            }
        }
        return 0;
    };

    Player.prototype.setVolume = function (vol) {
        if (!this.video) return;
        vol = Math.max(0, Math.min(1, vol));
        this.video.volume = vol;
        this.video.muted = vol === 0;
    };

    // slots[n] is "PlayerObj[n]"; players move between slots when swapped.
    var slots = [new Player(0), new Player(1), new Player(2), new Player(3), new Player(4)];
    function setSlot(i, p) {
        slots[i] = p;
        p.pos = i;
    }
    function relayoutAll() {
        for (var i = 0; i < slots.length; i++) slots[i].applyRect();
    }

    // VideoWebHolder.bringChildToFront(VideoHolder / mWebView)
    function videoFront(on) {
        for (var i = 0; i < 4; i++) {
            slots[i].front = on;
            slots[i].applyRect();
        }
    }

    // ---------------------------------------------------------------- player management (PlayerActivity)
    function clearPlayer(pos) {
        slots[pos].release(false);
        checkKeepAwake();
    }

    function clearPreview() {
        slots[4].release(false);
        applyAudio();
        checkKeepAwake();
    }

    function anyPlaying() {
        for (var i = 0; i < 5; i++) if (slots[i].active && slots[i].wantPlay) return true;
        return false;
    }
    function checkKeepAwake() {
        D.keepAwake(anyPlaying());
    }

    function applyAudio() {
        var max = slots[4].active ? S.previewOthersVolume : 1;
        for (var i = 0; i < 4; i++) {
            slots[i].setVolume(S.audioEnabled[i] ? Math.min(slots[i].volume, max) : 0);
        }
        slots[4].setVolume(slots[4].volume);
    }

    function updateVideoSize(full) {
        S.isFullScreen = full;
        slots[0].layout(full ? L.full() : L.sideBySide(S.fullScreenPosition, S.fullScreenSize));
    }

    function updateVideoSizePP(full) {
        S.isFullScreen = full;
        if (full) {
            slots[0].layout(L.full());
            slots[1].layout(L.small(S.ppPosition, S.ppSize));
        } else {
            slots[0].layout(L.small(3, 0));
            slots[1].layout(L.small(7, 0));
        }
    }

    function fixViewPosition(pos, type) {
        showLoading('loading', false);
        slots[pos].isScreenPreview = false;
        slots[pos].type = type;
        slots[0].layout(L.full());
        if (slots[0].active) callJS('Play_UpdateDuration', slots[0].duration());
        setTimeout(function () {
            videoFront(false);
        }, 100);
    }

    // PlayerEventListenerCheckCounter
    function checkCounter(pos, failType, errorCode) {
        var p = slots[pos];
        if (!p.active) return;
        p.clearTimers();
        if (p.video) p.video.pause();
        p.checkCounter++;

        if (pos < 4) {
            if (p.checkCounter === 1) {
                restart(p);
            } else if (p.checkCounter < 4) {
                if ((p.isScreenPreview || !S.checkSource || S.autoMode || S.multi || S.picturePicture) && (p.isScreenPreview || p.type < 3)) {
                    restart(p);
                } else {
                    callJS('Play_PlayerCheck', p.type, errorCode);
                }
            } else {
                playerEnded(pos, failType, errorCode);
            }
        } else if (p.checkCounter < 4) {
            restart(p);
        } else {
            clearPreview();
            callJS('Play_CheckIfIsLiveClean', failType, errorCode);
        }
    }

    function restart(p) {
        if (p.type !== 1 && p.active) {
            var t = p.currentMs();
            if (t > 0) p.resume = t;
        }
        p.setup();
    }

    // PlayerEventListenerClear
    function playerEnded(pos, failType, errorCode) {
        var p = slots[pos];
        if (pos < 4) {
            showLoading('loading', false);
            if (p.spinner) p.spinner.classList.add('stv-hidden');
            if (S.multi) {
                clearPlayer(pos);
                callJS('Play_MultiEnd', pos, failType, errorCode);
            } else if (S.picturePicture) {
                clearPlayer(pos);
                callJS('PlayExtra_End', pos === 0, failType, errorCode);
            } else if (p.isScreenPreview) {
                clearPlayer(pos);
                callJS('Play_CheckIfIsLiveClean', failType, errorCode);
            } else {
                callJS('Play_PannelEndStart', p.type, failType, errorCode);
            }
        } else {
            clearPreview();
            callJS('Play_CheckIfIsLiveClean', failType, errorCode);
        }
    }

    function qualitiesJSON(p) {
        var hls = p.hls;
        if (!hls || !hls.levels || !hls.levels.length) return null;
        var out = [{ id: 'Auto', band: '', codec: '' }];
        for (var i = 0; i < hls.levels.length; i++) {
            var l = hls.levels[i];
            out.push({ id: l.height + 'p' + fpsOf(l), band: bandStr(l.bitrate), codec: codecStr(l.videoCodec || l.codecSet || '') });
        }
        return JSON.stringify(out);
    }

    function currentQualityString(p) {
        var hls = p.hls;
        if (!hls) {
            var v = p.video;
            return v && v.videoHeight ? v.videoHeight + 'p | Auto' : null;
        }
        var l = hls.levels && hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel];
        if (!l) return null;
        return l.height + 'p' + fpsOf(l) + ' | Auto' + bandStr(l.bitrate) + codecStr(l.videoCodec || '');
    }

    // ---------------------------------------------------------------- HTTP
    function parseHeaders(json) {
        if (!json) return [];
        try {
            var h = typeof json === 'string' ? JSON.parse(json) : json;
            return Array.isArray(h) ? h : [];
        } catch (e) {
            return [];
        }
    }
    function req(url, timeout, post, method, headers, checkResult) {
        return {
            url: String(url),
            timeout: timeout | 0,
            body: post === null || post === undefined ? null : String(post),
            method: method || null,
            headers: parseHeaders(headers),
            checkResult: checkResult || 0
        };
    }
    var EMPTY = function (checkResult) {
        return JSON.stringify({ status: 0, responseText: '', checkResult: checkResult || 0 });
    };

    // ---------------------------------------------------------------- the Android object
    var noop = function () {};
    var Android = {
        // --- app / device info
        getversion: function () {
            return INFO.version;
        },
        getdebug: function () {
            return !!INFO.debug;
        },
        getManufacturer: function () {
            return 'Linux';
        },
        getDevice: function () {
            return 'Desktop';
        },
        getSDK: function () {
            return 34;
        },
        deviceIsTV: function () {
            return true;
        },
        getWebviewVersion: function () {
            return 'Chrome ' + INFO.chrome + ' (Electron ' + INFO.electron + ')';
        },
        getInstallFromPLay: function () {
            return false;
        },
        isAccessibilitySettingsOn: function () {
            return false;
        },
        isConnected: function () {
            return navigator.onLine;
        },
        isKeyboardConnected: function () {
            return true;
        },
        getcodecCapabilities: function () {
            return '[]';
        },
        LongLog: function (log) {
            console.log(LOG, log);
        },

        // --- page / window
        mPageUrl: function () {
            return location.href;
        },
        mloadUrl: function (url) {
            if (/^https?:\/\//i.test(url) && url.indexOf('fgl27.github.io') === -1) location.href = url;
            else location.reload();
        },
        CleanAndLoadUrl: function () {
            location.reload();
        },
        mclose: function (close) {
            D.close(close);
        },
        mhideSystemUI: noop,
        mKeepScreenOn: function (on) {
            D.keepAwake(on);
        },
        showToast: function (text) {
            toast(text);
        },
        OpenExternal: function (url) {
            D.openExternal(url);
        },
        OpenURL: function (url) {
            D.openExternal(url);
        },
        clearCookie: function () {
            D.clearCookies();
        },
        UpdateAPK: function () {
            toast('Updates for the desktop app come through Flatpak (flatpak update).');
        },
        GetIntentObj: function () {
            return null;
        },
        GetLastIntentObj: function () {
            return null;
        },
        mCheckRefresh: noop,
        mCheckRefreshToast: noop,
        SetLanguage: noop,
        upDateLang: noop,

        // --- input / on-screen keyboard (Android-only concepts)
        KeyboardCheckAndHIde: noop,
        hideKeyboardFrom: noop,
        showKeyboardFrom: noop,
        WebViewKeyIsShowing: function () {
            return false;
        },
        AvoidClicks: noop,
        initbodyClickSet: noop,
        SetKeysOpacity: noop,
        SetKeysPosition: noop,
        keyEvent: noop,

        // --- notifications (Android service; not implemented on desktop yet)
        SetNotificationPosition: noop,
        SetNotificationRepeat: noop,
        SetNotificationSinceTime: noop,
        RunNotificationService: noop,
        StopNotificationService: noop,
        hasNotificationPermission: function () {
            return false;
        },
        upNotificationState: noop,
        SetNotificationLive: noop,
        SetNotificationTitle: noop,
        SetNotificationGame: noop,
        UpdateBlockedChannels: noop,
        UpdateBlockedGames: noop,
        UpdateUserId: noop,
        Settings_SetPingWarning: noop,

        // --- tokens
        setAppIds: noop,
        getAppToken: function () {
            return S.appToken;
        },
        setAppToken: function (token) {
            S.appToken = token;
        },

        // --- HTTP
        mMethodUrlHeaders: function (url, timeout, post, method, checkResult, headers) {
            try {
                return JSON.stringify(D.httpSync(req(url, timeout, post, method, headers, 0)));
            } catch (e) {
                return EMPTY(checkResult);
            }
        },
        BasexmlHttpGet: function (url, timeout, post, method, headers, callback, checkResult, key, success, error) {
            D.http(req(url, timeout, post, method, headers, checkResult))
                .catch(function () {
                    return JSON.parse(EMPTY(checkResult));
                })
                .then(function (r) {
                    callJS(callback, JSON.stringify(r), key, String(success), String(error), checkResult);
                });
        },
        XmlHttpGetFull: function (url, timeout, post, method, headers, callback, checkResult, c1, c2, c3, c4, c5, success, error) {
            D.http(req(url, timeout, post, method, headers, checkResult))
                .catch(function () {
                    return JSON.parse(EMPTY(checkResult));
                })
                .then(function (r) {
                    callJS(callback, JSON.stringify(r), checkResult, String(c1), String(c2), String(c3), String(c4), String(c5), String(success), String(error));
                });
        },

        // --- loading
        mshowLoading: function (show) {
            showLoading('loading', show);
        },
        mshowLoadingBottom: function (show) {
            showLoading('loadingBottom', show);
        },

        // --- main player
        StartAuto: function (uri, playlist, type, resume, position) {
            var startPlayer = !slots[0].active || !slots[0].isScreenPreview;
            if (startPlayer) {
                if (position === 1) S.picturePicture = true;
                videoFront(false);
                var p = slots[position];
                p.set(false, type, resume);
                if (position === 0) p.layout(S.isFullScreen ? L.full() : L.sideBySide(S.fullScreenPosition, S.fullScreenSize));
                else if (position === 1) p.layout(L.small(S.ppPosition, S.ppSize));
                p.load(uri, playlist);
            } else {
                fixViewPosition(position, type);
            }
        },
        FixViewPosition: function (position, type) {
            fixViewPosition(position, type);
        },
        RestartPlayer: function (type, resume, position) {
            var p = slots[position];
            if (p.uri || p.playlist) restart(p);
        },
        stopVideo: function () {
            S.picturePicture = false;
            for (var i = 0; i < 4; i++) slots[i].release(false);
            D.keepAwake(false);
        },
        PlayPause: function (state) {
            for (var i = 0; i < 4; i++) {
                if (!slots[i].active) continue;
                if (state) slots[i].play();
                else slots[i].pause();
            }
            D.keepAwake(state);
        },
        PlayPauseChange: function () {
            var p0 = slots[0];
            if (!p0.active) return;
            var state = p0.video.paused;
            Android.PlayPause(state);
            callJS('Play_PlayPauseChange', state, p0.type);
        },
        getPlaybackState: function () {
            return slots[0].active && !slots[0].video.paused;
        },
        setPlaybackSpeed: function (speed) {
            S.speed = speed;
            for (var i = 0; i < 5; i++) if (slots[i].video) slots[i].video.playbackRate = speed;
        },
        mseekTo: function (position) {
            var p = slots[0];
            if (!p.active) return;
            var dur = p.duration();
            var jump = position > 0 ? position : 0;
            if (dur && jump >= dur) jump = dur - 1000;
            p.play();
            p.video.currentTime = jump / 1000;
        },
        gettime: function () {
            return slots[0].currentMs();
        },
        gettimepreview: function () {
            return slots[4].currentMs();
        },
        getsavedtime: function () {
            return slots[0].resume;
        },
        getDuration: function (callback) {
            if (slots[0].active) callJS(callback, slots[0].duration());
        },
        updateScreenDuration: function (callback, key, objId) {
            if (slots[0].active) callJS(callback, String(objId), key, slots[0].duration());
        },
        SetCurrentPositionTimeout: noop,
        SetBuffer: function (type, size) {
            S.buffer[type - 1] = Math.min(size, 15000);
        },
        mSetlatency: function (v) {
            S.lowLatency = v;
        },
        mSetlatencyVod: function (v) {
            S.lowLatencyVod = v;
        },
        setSpeedAdjustment: noop,
        SetCheckSource: function (v) {
            S.checkSource = !!v;
        },
        SetReUsePlayer: noop,
        CheckReUsePlayer: noop,
        setBlackListMediaCodec: noop,
        setBlackListQualities: noop,
        msetPlayer: function (_surface, full) {
            if (full) updateVideoSizePP(true);
            else updateVideoSize(false);
            slots[1].layout(L.small(S.ppPosition, S.ppSize));
        },

        // --- quality & stats
        getQualities: function () {
            return qualitiesJSON(slots[0]);
        },
        SetQuality: function (position) {
            var p = slots[0];
            S.autoMode = position === -1;
            p.forcedLevel = S.autoMode ? undefined : position;
            if (!p.hls) return;
            if (S.autoMode) {
                p.hls.currentLevel = -1;
                p.applyCap();
            } else if (position < p.hls.levels.length) {
                p.hls.autoLevelCapping = -1;
                p.hls.currentLevel = position;
            }
        },
        SetMainPlayerBitrate: function (bitrate, resolution) {
            S.mainCap = { bitrate: bitrate, resolution: resolution };
            slots[0].applyCap();
        },
        SetSmallPlayerBitrate: function (bitrate, resolution) {
            S.smallCap = { bitrate: bitrate, resolution: resolution };
            for (var i = 1; i < 5; i++) slots[i].applyCap();
        },
        getVideoQualityString: function () {
            return currentQualityString(slots[0]);
        },
        getVideoQuality: function (type) {
            var q = currentQualityString(slots[0]);
            callJS('Play_ShowVideoQuality', type, q);
        },
        getVideoStatusString: function () {
            return Android._lastStatus || null;
        },
        getVideoStatus: function (showLatency, type) {
            var p = slots[0],
                st = S.stats;
            var dropped = 0;
            if (p.video && p.video.getVideoPlaybackQuality) {
                var total = p.video.getVideoPlaybackQuality().droppedVideoFrames || 0;
                dropped = Math.max(0, total - st.lastDropped);
                st.lastDropped = total;
                st.droppedTotal = total;
            }
            var net = st.net;
            st.netSum += net;
            st.netCount++;
            var buffer = p.active ? p.bufferMs() : 0;
            var status = JSON.stringify([
                counters(st.lastSpeed || 0, st.speedSum, st.speedCount), // 0 connection speed Mbps
                counters(net, st.netSum, st.netCount), // 1 network activity Mb
                dropped, // 2
                st.droppedTotal, // 3
                timeStr(buffer), // 4
                timeStr(p.active && p.type === 1 ? p.liveOffset() : 0), // 5
                counters(0, 0, 0), // 6 ping (not measured on desktop)
                buffer / 1000, // 7
                p.duration(), // 8
                p.currentMs() // 9
            ]);
            st.net = 0;
            Android._lastStatus = status;
            callJS('Play_ShowVideoStatus', showLatency, type, status);
        },
        getLatency: function (n) {
            if (slots[n] && slots[n].active) callJS('ChatLive_SetLatency', n, slots[n].liveOffset());
        },

        // --- sizes / positions
        SetFullScreenSize: function (v) {
            S.fullScreenSize = v;
        },
        SetFullScreenPosition: function (v) {
            S.fullScreenPosition = v;
        },
        mupdatesize: function (full) {
            updateVideoSize(full);
        },
        mupdatesizePP: function (full) {
            updateVideoSizePP(full);
        },

        // --- picture in picture
        mClearSmallPlayer: function () {
            S.picturePicture = false;
            clearPlayer(1);
        },
        mSwitchPlayer: function () {
            var t = slots[0];
            setSlot(0, slots[1]);
            setSlot(1, t);
            if (S.isFullScreen) {
                slots[0].layout(L.full());
                slots[1].layout(L.small(S.ppPosition, S.ppSize));
            } else {
                updateVideoSizePP(false);
            }
            for (var i = 0; i < 2; i++) slots[i].applyCap();
            applyAudio();
        },
        mSwitchPlayerPosition: function (v) {
            S.ppPosition = v;
            slots[1].layout(L.small(S.ppPosition, S.ppSize));
        },
        mSetPlayerPosition: function (v) {
            S.ppPosition = v;
        },
        mSwitchPlayerSize: function (v) {
            S.ppSize = v;
            slots[1].layout(L.small(S.ppPosition, S.ppSize));
        },
        mSetPlayerSize: function (v) {
            S.ppSize = v;
            slots[1].layout(L.small(S.ppPosition, S.ppSize));
        },

        // --- multistream
        EnableMultiStream: function (mainBig, offset) {
            S.multi = true;
            var i;
            if (mainBig) {
                if (offset) {
                    var n = Math.abs(offset),
                        rot = slots.slice(0, 4);
                    for (var k = 0; k < n; k++) {
                        if (offset > 0) rot.push(rot.shift());
                        else rot.unshift(rot.pop());
                    }
                    for (i = 0; i < 4; i++) setSlot(i, rot[i]);
                }
                for (i = 0; i < 4; i++) slots[i].layout(L.multi(i + 4));
            } else {
                for (i = 0; i < 4; i++) slots[i].layout(L.multi(i));
            }
            for (i = 0; i < 4; i++) slots[i].applyCap();
            applyAudio();
        },
        DisableMultiStream: function () {
            S.multi = false;
            clearPlayer(2);
            clearPlayer(3);
            if (S.picturePicture) {
                updateVideoSizePP(S.isFullScreen);
            } else {
                updateVideoSize(S.isFullScreen);
                slots[1].layout(L.small(S.ppPosition, S.ppSize));
            }
            if (!S.picturePicture || !slots[0].active || !slots[1].active) {
                S.picturePicture = false;
                clearPlayer(1);
            }
            slots[0].applyCap();
            applyAudio();
        },
        StartMultiStream: function (position, uri, playlist, restartPlayer) {
            var p = slots[position];
            if (restartPlayer) p.release(true);
            p.set(false, 1, 0);
            if (!p.rect) p.layout(L.multi(position));
            p.load(uri, playlist);
            if (slots[4].active) clearPreview();
        },

        // --- audio
        SetAudioEnabled: function (a, b, c, d) {
            S.audioEnabled = [!!a, !!b, !!c, !!d];
        },
        SetVolumes: function (a, b, c, d) {
            slots[0].volume = a;
            slots[1].volume = b;
            slots[2].volume = c;
            slots[3].volume = d;
        },
        ApplyAudio: function () {
            applyAudio();
        },
        SetPreviewOthersAudio: function (v) {
            S.previewOthersVolume = v / 100;
        },
        SetPreviewAudio: function (v) {
            slots[4].volume = v / 100;
        },
        SetPreviewSize: function (v) {
            S.previewSize = v;
        },

        // --- feed preview (player 4, always drawn above the UI)
        StartFeedPlayer: function (uri, playlist, position, resume, isVod) {
            var p = slots[4];
            S.feedPosition = position;
            p.set(false, isVod ? 2 : 1, resume);
            p.layout(L.feed(S.previewSize, position));
            p.load(uri, playlist);
        },
        SetFeedPosition: function (position) {
            S.feedPosition = position;
            slots[4].layout(L.feed(S.previewSize, position));
        },
        SetPlayerViewFeedBottom: function (bottom, webHeight) {
            S.feedBottom = Math.floor(H() - bottom * (H() / (webHeight || H())));
            if (slots[4].active) slots[4].layout(L.feed(S.previewSize, S.feedPosition));
        },
        ClearFeedPlayer: function () {
            if (slots[4].active) clearPreview();
        },
        ReuseFeedPlayerPrepare: function () {
            slots[4].show(false);
            if (slots[4].active) slots[4].pause();
        },
        ReuseFeedPlayer: function (uri, playlist, type, resume, position) {
            var preview = slots[4];
            var target = slots[position];
            target.clearTimers();
            if (target.active) target.pause();
            if (!S.multi && position === 1) S.picturePicture = true;

            setTimeout(function () {
                var canReuse = preview.active && preview.playlist && preview.playlist === playlist;
                if (canReuse) {
                    // hand the running preview over to the main slot, no re-buffering
                    target.release(false);
                    preview.id = position;
                    target.id = 4;
                    setSlot(position, preview);
                    setSlot(4, target);
                    preview.set(false, type, resume);
                    preview.front = false;
                    layoutForSlot(position);
                    preview.applyCap();
                    preview.show(true);
                    preview.play();
                    target.layout(L.feed(S.previewSize, S.feedPosition));
                    applyAudio();
                } else {
                    if (preview.active) clearPreview();
                    target.set(false, type, resume);
                    layoutForSlot(position);
                    target.load(uri, playlist);
                }
            }, 50);
        },

        // --- side panel & screen previews (player 0 drawn above the UI)
        SetPlayerViewSidePanel: function (bottom, right, left, webHeight) {
            S.sidePanelRect = L.preview(bottom, right, left, webHeight, false);
        },
        StartSidePanelPlayer: function (uri, playlist) {
            var p = slots[0];
            videoFront(true);
            p.set(true, 1, 0);
            p.layout(S.sidePanelRect || L.small(2, 3));
            p.load(uri, playlist);
        },
        StartScreensPlayer: function (uri, playlist, resume, bottom, right, left, webHeight, type, bigger) {
            var p = slots[0];
            S.screensRect = L.preview(bottom, right, left, webHeight, bigger);
            videoFront(true);
            p.set(true, type, resume);
            p.layout(S.screensRect);
            p.load(uri, playlist);
        },
        SidePanelPlayerRestore: function () {
            slots[0].isScreenPreview = true;
            videoFront(true);
            setTimeout(function () {
                slots[0].layout(S.sidePanelRect || L.small(2, 3));
            }, 100);
        },
        ScreenPlayerRestore: function (bottom, right, left, webHeight, type, bigger) {
            if (!slots[0].active) return;
            slots[0].isScreenPreview = true;
            videoFront(true);
            S.screensRect = L.preview(bottom, right, left, webHeight, bigger);
            setTimeout(function () {
                slots[0].layout(S.screensRect);
            }, 100);
        },
        ClearSidePanelPlayer: function () {
            videoFront(false);
            clearPlayer(0);
        }
    };

    function layoutForSlot(position) {
        var p = slots[position];
        if (S.multi) p.layout(L.multi(position));
        else if (position === 0) p.layout(S.isFullScreen ? L.full() : L.sideBySide(S.fullScreenPosition, S.fullScreenSize));
        else if (S.picturePicture && !S.isFullScreen) updateVideoSizePP(false);
        else p.layout(L.small(S.ppPosition, S.ppSize));
    }

    // Anything the web app calls that we did not implement: log once, do nothing.
    var warned = {};
    window.Android = new Proxy(Android, {
        get: function (target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop === 'string' && !warned[prop]) {
                warned[prop] = true;
                console.warn(LOG, 'Android.' + prop + ' is not implemented');
            }
            return noop;
        }
    });

    // Window resizes: recompute every player box. The web app re-sends preview rects itself.
    window.addEventListener('resize', function () {
        for (var i = 0; i < 4; i++) {
            var p = slots[i];
            if (!p.active || p.isScreenPreview) continue;
            if (S.multi) p.layout(L.multi(i));
            else if (i === 0) p.layout(S.isFullScreen || S.picturePicture ? L.full() : L.sideBySide(S.fullScreenPosition, S.fullScreenSize));
            else p.layout(L.small(S.ppPosition, S.ppSize));
        }
        if (slots[4].active) slots[4].layout(L.feed(S.previewSize, S.feedPosition));
        relayoutAll();
    });

    // ---------------------------------------------------------------- gamepad → remote keys
    // Standard mapping (Xbox layout names):
    //   D-pad / left stick → arrows   A → OK      B / View → back
    //   X → play/pause                Y → toggle chat (key 3)
    //   LB / RB → page up / down (switch screens, chat position/size in player)
    //   LT → key 1 (picture-in-picture / multistream)   RT → key 2 (chat side)
    //   Menu (start) → OK
    var BUTTON_KEYS = {
        0: 'Enter',
        1: 'F2',
        2: 'Space',
        3: '3',
        4: 'PageUp',
        5: 'PageDown',
        6: '1',
        7: '2',
        8: 'F2',
        9: 'Enter',
        12: 'Up',
        13: 'Down',
        14: 'Left',
        15: 'Right'
    };
    var REPEATABLE = { Up: 1, Down: 1, Left: 1, Right: 1 };
    var REPEAT_DELAY = 380,
        REPEAT_RATE = 85,
        AXIS = 0.55;
    var pads = {};

    function padKeysDown(gp) {
        var down = {};
        for (var b in BUTTON_KEYS) {
            var btn = gp.buttons[b];
            if (btn && (btn.pressed || btn.value > 0.5)) down[BUTTON_KEYS[b]] = true;
        }
        var ax = gp.axes[0] || 0,
            ay = gp.axes[1] || 0;
        if (Math.abs(ax) > AXIS || Math.abs(ay) > AXIS) {
            if (Math.abs(ax) > Math.abs(ay)) down[ax > 0 ? 'Right' : 'Left'] = true;
            else down[ay > 0 ? 'Down' : 'Up'] = true;
        }
        return down;
    }

    function pollPads(now) {
        var list = navigator.getGamepads ? navigator.getGamepads() : [];
        if (document.hasFocus()) {
            for (var i = 0; i < list.length; i++) {
                var gp = list[i];
                if (!gp || !gp.connected) continue;
                var state = pads[gp.index] || (pads[gp.index] = {});
                var down = padKeysDown(gp);
                for (var key in down) {
                    var s = state[key];
                    if (!s) {
                        state[key] = { next: now + REPEAT_DELAY };
                        D.key(key, false);
                    } else if (REPEATABLE[key] && now >= s.next) {
                        s.next = now + REPEAT_RATE;
                        D.key(key, true);
                    }
                }
                for (var k in state) if (!down[k]) delete state[k];
            }
        }
        requestAnimationFrame(pollPads);
    }
    window.addEventListener('gamepadconnected', function (e) {
        console.log(LOG, 'gamepad connected:', e.gamepad.id);
    });
    requestAnimationFrame(pollPads);

    // Mouse back button → back, like a remote.
    window.addEventListener('mouseup', function (e) {
        if (e.button === 3) D.key('F2', false);
    });

    var root = document.documentElement;
    root.classList.add('stv-desktop', 'stv-no-pointer');
    // Pointer only shows while the mouse is actually being used.
    window.addEventListener('keydown', function () {
        root.classList.add('stv-no-pointer');
    }, true);
    window.addEventListener('mousemove', function () {
        root.classList.remove('stv-no-pointer');
    }, true);
    console.log(LOG, 'bridge ready, upstream', INFO.version);
})();
