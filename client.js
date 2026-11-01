/* 冰冰冰 · 审批提醒 — right-sidebar panel.
 * Plain browser module, no build step.
 *
 * Detection is deliberately DOM-based: the approval UI is the only place that
 * renders `[data-approval-key]`, so we can watch for the card appearing and
 * disappearing without touching the approval waterfall itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ice-approval-alert',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ID = 'dsh-ice-approval-alert';
    const STORAGE_KEY = 'dsh.ice-approval-alert.v1';
    const APPROVAL_SELECTOR = '[data-approval-key]';
    const STAGES = [
      { at: 0, title: '现在', desc: '审批一出现，先冰一下' },
      { at: 5 * 60 * 1000, title: '5 分钟', desc: '还没动？再冰一下' },
      { at: 10 * 60 * 1000, title: '10 分钟', desc: '继续冰，别装没看见' },
      { at: 15 * 60 * 1000, title: '15 分钟', desc: '最后一声，然后闭嘴' },
    ];

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function readSettings() {
      const fallback = { enabled: true, volume: 0.72 };
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return {
          enabled: parsed.enabled !== false,
          volume: typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
            ? clamp(parsed.volume, 0, 1)
            : fallback.volume,
        };
      } catch (error) {
        return fallback;
      }
    }

    const settings = readSettings();
    let active = new Map();
    let events = [];
    let eventSeq = 0;
    let pulse = 0;
    let audioError = false;
    let snapshot = null;
    const listeners = new Set();

    let started = false;
    let observer = null;
    let scanTimer = 0;
    let audioCtx = null;
    let master = null;
    let noiseBuffer = null;
    let nextPhraseAt = 0;
    let unlockInstalled = false;
    let unlockHandler = null;

    function saveSettings() {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          enabled: settings.enabled,
          volume: settings.volume,
        }));
      } catch (error) {
        /* localStorage can be unavailable; the in-memory setting still works. */
      }
    }

    function publicActive() {
      return Array.from(active.values())
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((record) => ({
          key: record.key,
          label: record.label,
          startedAt: record.startedAt,
          plays: record.plays,
          nextAt: record.nextAt,
          expired: record.expired,
          paused: record.paused,
        }));
    }

    function publish() {
      snapshot = {
        settings: { enabled: settings.enabled, volume: settings.volume },
        active: publicActive(),
        events: events.slice(0, 8),
        pulse,
        audioError,
      };
      for (const listener of listeners) {
        try {
          listener(snapshot);
        } catch (error) {
          /* A broken subscriber must not take down the alert engine. */
        }
      }
    }

    function pushEvent(kind, stage, label, detail) {
      eventSeq += 1;
      events.unshift({
        id: eventSeq,
        at: Date.now(),
        kind,
        stage,
        label,
        detail,
      });
      if (events.length > 8) events.length = 8;
    }

    function clearRecordTimer(record) {
      if (record.timer) {
        window.clearTimeout(record.timer);
        record.timer = 0;
      }
    }

    function describeApproval(node) {
      try {
        const raw = String(node.innerText || node.textContent || '');
        const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
        const skip = /^(等待审批|拒绝|允许一次|waiting for approval|reject|allow once)$/i;
        const detail = lines.find((line) => !skip.test(line));
        const text = String(detail || '审批请求').replace(/\s+/g, ' ').trim();
        return text.slice(0, 88) || '审批请求';
      } catch (error) {
        return '审批请求';
      }
    }

    function isAttached(node) {
      return Boolean(node && node.isConnected);
    }

    function scheduleRecord(record) {
      clearRecordTimer(record);
      if (!settings.enabled || record.paused || record.expired || !active.has(record.key)) return;
      const delay = Math.max(0, record.nextAt - Date.now());
      record.timer = window.setTimeout(() => {
        record.timer = 0;
        tickRecord(record);
      }, Math.min(delay + 20, 2147483647));
    }

    function playStage(record, stageIndex) {
      clearRecordTimer(record);
      record.paused = false;
      record.plays = stageIndex + 1;
      record.lastStage = stageIndex;

      if (settings.enabled) {
        triggerSound();
        pushEvent('stage', stageIndex, STAGES[stageIndex].title, record.label);
      }

      if (stageIndex >= STAGES.length - 1) {
        record.expired = true;
        record.nextAt = 0;
      } else {
        record.nextStage = stageIndex + 1;
        record.nextAt = record.startedAt + STAGES[record.nextStage].at;
        scheduleRecord(record);
      }
      publish();
    }

    function tickRecord(record) {
      if (!started || !settings.enabled || record.paused || record.expired || !active.has(record.key)) return;
      const elapsed = Date.now() - record.startedAt;
      let due = record.nextStage;
      while (due < STAGES.length && elapsed >= STAGES[due].at) due += 1;

      if (due === record.nextStage) {
        scheduleRecord(record);
        return;
      }

      /* If the machine slept through two or three slots, play once, not a
       * burst of overlapping catch-up sounds. */
      playStage(record, Math.min(due - 1, STAGES.length - 1));
    }

    function addApproval(key, node) {
      if (!key || active.has(key)) return;
      const now = Date.now();
      const record = {
        key,
        label: describeApproval(node),
        startedAt: now,
        plays: 0,
        nextStage: 1,
        nextAt: now + STAGES[1].at,
        expired: false,
        paused: false,
        timer: 0,
      };
      active.set(key, record);

      if (settings.enabled) {
        playStage(record, 0);
      } else {
        record.paused = true;
        record.nextAt = 0;
        publish();
      }
    }

    function removeApproval(key) {
      const record = active.get(key);
      if (!record) return;
      clearRecordTimer(record);
      active.delete(key);
      publish();
    }

    function scanApprovals() {
      if (!started || typeof document === 'undefined') return;
      const seen = new Set();
      const nodes = document.querySelectorAll(APPROVAL_SELECTOR);
      for (const node of nodes) {
        if (!isAttached(node)) continue;
        const key = node.getAttribute('data-approval-key');
        if (!key) continue;
        seen.add(key);
        if (!active.has(key)) addApproval(key, node);
      }
      for (const key of Array.from(active.keys())) {
        if (!seen.has(key)) removeApproval(key);
      }
    }

    function queueScan() {
      if (scanTimer) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = 0;
        scanApprovals();
      }, 45);
    }

    function resync() {
      if (!started) return;
      scanApprovals();
      if (!settings.enabled) return;
      const now = Date.now();
      for (const record of Array.from(active.values())) {
        if (record.paused || record.expired) continue;
        if (record.nextAt > 0 && now >= record.nextAt) tickRecord(record);
      }
    }

    function ensureAudio() {
      if (audioCtx) return audioCtx;
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) {
        audioError = true;
        return null;
      }
      try {
        audioCtx = new AudioCtor();
        master = audioCtx.createGain();
        master.gain.value = settings.volume * 0.62;
        const compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -20;
        compressor.knee.value = 18;
        compressor.ratio.value = 6;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.18;
        master.connect(compressor);
        compressor.connect(audioCtx.destination);

        const length = Math.floor(audioCtx.sampleRate * 0.45);
        noiseBuffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
        nextPhraseAt = 0;
        audioError = false;
        return audioCtx;
      } catch (error) {
        audioCtx = null;
        master = null;
        audioError = true;
        return null;
      }
    }

    function scheduleBing(ctx, when, freq, pan, level) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(master);

      const body = ctx.createOscillator();
      body.type = 'sine';
      body.detune.value = (Math.random() - 0.5) * 9;
      body.frequency.setValueAtTime(freq * 1.52, when);
      body.frequency.exponentialRampToValueAtTime(freq, when + 0.018);
      body.frequency.exponentialRampToValueAtTime(freq * 0.88, when + 0.3);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, when);
      bodyGain.gain.exponentialRampToValueAtTime(0.92, when + 0.006);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.33);
      body.connect(bodyGain);
      bodyGain.connect(panner);
      body.start(when);
      body.stop(when + 0.35);

      const glass = ctx.createOscillator();
      glass.type = 'triangle';
      glass.frequency.setValueAtTime(freq * 2.01, when);
      glass.frequency.exponentialRampToValueAtTime(freq * 1.84, when + 0.22);
      const glassGain = ctx.createGain();
      glassGain.gain.setValueAtTime(0.0001, when);
      glassGain.gain.exponentialRampToValueAtTime(0.24, when + 0.004);
      glassGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
      glass.connect(glassGain);
      glassGain.connect(panner);
      glass.start(when);
      glass.stop(when + 0.22);

      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.setValueAtTime(freq, when);
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = freq * 3.17;
      const modGain = ctx.createGain();
      modGain.gain.setValueAtTime(freq * 1.35, when);
      modGain.gain.exponentialRampToValueAtTime(freq * 0.04, when + 0.14);
      mod.connect(modGain);
      modGain.connect(carrier.frequency);
      const carrierGain = ctx.createGain();
      carrierGain.gain.setValueAtTime(0.0001, when);
      carrierGain.gain.exponentialRampToValueAtTime(0.3, when + 0.004);
      carrierGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.26);
      carrier.connect(carrierGain);
      carrierGain.connect(panner);
      carrier.start(when);
      carrier.stop(when + 0.28);
      mod.start(when);
      mod.stop(when + 0.28);

      if (noiseBuffer) {
        const crack = ctx.createBufferSource();
        crack.buffer = noiseBuffer;
        const high = ctx.createBiquadFilter();
        high.type = 'highpass';
        high.frequency.value = 4200;
        high.Q.value = 0.7;
        const crackGain = ctx.createGain();
        crackGain.gain.setValueAtTime(0.22, when);
        crackGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.065);
        crack.connect(high);
        high.connect(crackGain);
        crackGain.connect(panner);
        crack.start(when);
        crack.stop(when + 0.08);
      }

      const bonk = ctx.createOscillator();
      bonk.type = 'sine';
      bonk.frequency.setValueAtTime(235, when);
      bonk.frequency.exponentialRampToValueAtTime(92, when + 0.08);
      const bonkGain = ctx.createGain();
      bonkGain.gain.setValueAtTime(0.16, when);
      bonkGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.11);
      bonk.connect(bonkGain);
      bonkGain.connect(panner);
      bonk.start(when);
      bonk.stop(when + 0.12);
    }

    function schedulePhrase(ctx) {
      const base = Math.max(ctx.currentTime + 0.025, nextPhraseAt);
      nextPhraseAt = base + 0.68;
      scheduleBing(ctx, base, 1760, -0.3, 0.62);
      scheduleBing(ctx, base + 0.155, 1760, 0.24, 0.58);
      scheduleBing(ctx, base + 0.315, 2093, -0.06, 0.56);

      const shimmer = ctx.createBufferSource();
      shimmer.buffer = noiseBuffer;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 7200;
      band.Q.value = 1.4;
      const shimmerGain = ctx.createGain();
      shimmerGain.gain.setValueAtTime(0.0001, base + 0.3);
      shimmerGain.gain.exponentialRampToValueAtTime(0.045, base + 0.32);
      shimmerGain.gain.exponentialRampToValueAtTime(0.0001, base + 0.72);
      shimmer.connect(band);
      band.connect(shimmerGain);
      shimmerGain.connect(master);
      shimmer.start(base + 0.3);
      shimmer.stop(base + 0.74);
    }

    function triggerSound() {
      pulse += 1;
      const ctx = ensureAudio();
      if (!ctx) {
        audioError = true;
        return;
      }
      if (ctx.state === 'running') {
        audioError = false;
        schedulePhrase(ctx);
        return;
      }
      ctx.resume().then(() => {
        if (ctx.state === 'running') {
          audioError = false;
          schedulePhrase(ctx);
        } else {
          audioError = true;
          publish();
        }
      }).catch(() => {
        audioError = true;
        publish();
      });
    }

    function installUnlock() {
      if (unlockInstalled) return;
      unlockInstalled = true;
      const unlock = () => {
        const ctx = ensureAudio();
        if (!ctx) return;
        if (ctx.state === 'suspended') {
          ctx.resume().then(() => {
            if (ctx.state === 'running') {
              audioError = false;
              publish();
            }
          }).catch(() => {});
        }
      };
      unlockHandler = unlock;
      window.addEventListener('pointerdown', unlock, true);
      window.addEventListener('keydown', unlock, true);
    }

    function removeUnlock() {
      if (!unlockInstalled) return;
      if (unlockHandler) {
        window.removeEventListener('pointerdown', unlockHandler, true);
        window.removeEventListener('keydown', unlockHandler, true);
        unlockHandler = null;
      }
      unlockInstalled = false;
    }

    function onStorage(event) {
      if (event.key !== STORAGE_KEY) return;
      const next = readSettings();
      const wasEnabled = settings.enabled;
      settings.enabled = next.enabled;
      settings.volume = next.volume;
      if (!settings.enabled) {
        for (const record of active.values()) {
          clearRecordTimer(record);
          record.paused = true;
        }
      } else if (!wasEnabled) {
        for (const record of active.values()) {
          if (!record.expired) restartRecord(record);
        }
      }
      if (master && audioCtx) {
        master.gain.setTargetAtTime(settings.volume * 0.62, audioCtx.currentTime, 0.02);
      }
      publish();
    }

    const engine = {
      getSnapshot() {
        return snapshot;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start() {
        if (started) return;
        started = true;
        installUnlock();
        if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
          observer = new MutationObserver(queueScan);
          const root = document.documentElement || document.body;
          if (root) {
            observer.observe(root, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['data-approval-key'],
            });
          }
        }
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', resync);
        }
        window.addEventListener('focus', resync);
        window.addEventListener('storage', onStorage);
        scanApprovals();
      },
      stop() {
        if (!started) return;
        started = false;
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (scanTimer) {
          window.clearTimeout(scanTimer);
          scanTimer = 0;
        }
        for (const record of active.values()) clearRecordTimer(record);
        active = new Map();
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', resync);
        }
        window.removeEventListener('focus', resync);
        window.removeEventListener('storage', onStorage);
        removeUnlock();
        nextPhraseAt = 0;
        if (audioCtx) {
          const ctx = audioCtx;
          audioCtx = null;
          master = null;
          noiseBuffer = null;
          try {
            ctx.close().catch(() => {});
          } catch (error) {
            /* ignore */
          }
        }
        publish();
      },
      setEnabled(value) {
        const next = Boolean(value);
        if (settings.enabled === next) return;
        settings.enabled = next;
        saveSettings();
        if (!next) {
          for (const record of active.values()) {
            clearRecordTimer(record);
            record.paused = true;
          }
        } else {
          for (const record of active.values()) {
            if (!record.expired) restartRecord(record);
          }
          scanApprovals();
        }
        publish();
      },
      setVolume(value) {
        settings.volume = clamp(Number(value) || 0, 0, 1);
        saveSettings();
        if (master && audioCtx) {
          master.gain.setTargetAtTime(settings.volume * 0.62, audioCtx.currentTime, 0.02);
        }
        publish();
      },
      test() {
        triggerSound();
        pushEvent('test', null, '手动试听', '侧边栏试听按钮');
        publish();
      },
    };

    function restartRecord(record) {
      clearRecordTimer(record);
      record.startedAt = Date.now();
      record.plays = 0;
      record.nextStage = 1;
      record.nextAt = 0;
      record.expired = false;
      record.paused = false;
      playStage(record, 0);
    }

    /* Seed the store before React asks for it; the engine may legitimately be
     * idle with no approval on screen. */
    publish();

    /* ------------------------------------------------------------------ */
    /* Panel                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
.ice-root{height:100%;overflow:auto;padding:14px 14px 26px;font-size:12.5px;line-height:1.58;color:inherit;
  font-family:inherit;-webkit-font-smoothing:antialiased;box-sizing:border-box}
.ice-root *{box-sizing:border-box}
.ice-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.ice-mark{flex:0 0 auto;width:42px;height:42px;border-radius:12px;display:grid;place-items:center;
  background:linear-gradient(145deg,rgba(89,213,255,.28),rgba(17,137,201,.1));
  border:1px solid rgba(89,213,255,.36);box-shadow:0 8px 22px rgba(17,137,201,.14);position:relative;overflow:hidden}
.ice-mark:before{content:"";position:absolute;inset:-40% -20% auto;height:80%;background:linear-gradient(180deg,rgba(255,255,255,.22),transparent);
  transform:rotate(-18deg)}
.ice-mark svg{width:30px;height:30px;position:relative;display:block}
.ice-mark[data-pulse="1"]{animation:ice-pop .48s cubic-bezier(.2,1.6,.4,1)}
@keyframes ice-pop{0%{transform:scale(.82) rotate(-5deg)}45%{transform:scale(1.12) rotate(4deg)}100%{transform:scale(1) rotate(0)}}
.ice-heading{min-width:0;flex:1}
.ice-title{font-size:15px;font-weight:750;letter-spacing:.02em;line-height:1.25;display:flex;align-items:center;gap:6px}
.ice-title i{font-style:normal;font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;
  color:#0d6f91;background:rgba(89,213,255,.18);border:1px solid rgba(89,213,255,.28)}
.ice-sub{font-size:10.5px;opacity:.58;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ice-switch{flex:0 0 auto;width:40px;height:23px;border-radius:999px;border:1px solid rgba(127,127,127,.3);
  background:rgba(127,127,127,.16);position:relative;cursor:pointer;padding:0;transition:background .18s,border-color .18s}
.ice-switch span{position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;
  box-shadow:0 1px 4px rgba(0,0,0,.25);transition:transform .18s cubic-bezier(.2,.8,.2,1)}
.ice-switch.on{background:linear-gradient(135deg,#25b8ef,#0b82b8);border-color:rgba(37,184,239,.7)}
.ice-switch.on span{transform:translateX(17px)}
.ice-switch:focus-visible{outline:2px solid #47c7ff;outline-offset:2px}
.ice-status{border:1px solid rgba(127,127,127,.26);border-radius:14px;padding:13px 13px 11px;margin-bottom:10px;
  background:linear-gradient(160deg,rgba(89,213,255,.1),rgba(127,127,127,.035));position:relative;overflow:hidden}
.ice-status:after{content:"";position:absolute;width:130px;height:130px;right:-52px;top:-64px;border-radius:50%;
  background:radial-gradient(circle,rgba(89,213,255,.22),transparent 68%);pointer-events:none}
.ice-status.is-active{border-color:rgba(89,213,255,.38);background:linear-gradient(160deg,rgba(89,213,255,.17),rgba(127,127,127,.04))}
.ice-status.is-expired{border-color:rgba(127,127,127,.2);background:rgba(127,127,127,.045)}
.ice-status-row{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:650;letter-spacing:.02em;opacity:.85}
.ice-live{width:7px;height:7px;border-radius:50%;background:#8a8a8a;box-shadow:0 0 0 3px rgba(127,127,127,.12)}
.ice-status.is-active .ice-live{background:#34c9ff;box-shadow:0 0 0 3px rgba(52,201,255,.16);animation:ice-blink 1.7s ease-in-out infinite}
@keyframes ice-blink{0%,100%{opacity:1}50%{opacity:.45}}
.ice-big{font-size:29px;font-weight:760;line-height:1.15;margin-top:7px;letter-spacing:.02em;
  font-variant-numeric:tabular-nums;color:#1d9bd1}
.ice-status.is-expired .ice-big{color:inherit;opacity:.55;font-size:25px}
.ice-note{font-size:11.5px;opacity:.72;margin-top:3px;min-height:18px}
.ice-extra{margin-top:7px;font-size:10.5px;padding:4px 7px;border-radius:6px;color:#0d6f91;
  background:rgba(89,213,255,.12);border:1px solid rgba(89,213,255,.18);display:inline-block}
.ice-progress{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:11px}
.ice-seg{height:4px;border-radius:99px;background:rgba(127,127,127,.2);overflow:hidden}
.ice-seg.done{background:linear-gradient(90deg,#5fd3ff,#179fd6)}
.ice-seg.next{background:rgba(95,211,255,.26);position:relative}
.ice-seg.next:after{content:"";position:absolute;inset:0;width:45%;border-radius:99px;background:#5fd3ff;animation:ice-sweep 1.7s ease-in-out infinite}
@keyframes ice-sweep{0%{transform:translateX(-100%)}60%,100%{transform:translateX(240%)}}
.ice-card{border:1px solid rgba(127,127,127,.24);border-radius:12px;padding:10px 11px;margin-bottom:8px;
  background:rgba(127,127,127,.045)}
.ice-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.ice-card-head b{font-size:11.5px;font-weight:720;letter-spacing:.03em}
.ice-chip{font-size:9.5px;padding:1px 6px;border-radius:999px;background:rgba(127,127,127,.13);
  border:1px solid rgba(127,127,127,.18);opacity:.7;white-space:nowrap}
.ice-timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.ice-tl{display:flex;align-items:flex-start;gap:8px;padding:5px 3px;border-radius:7px;position:relative}
.ice-tl + .ice-tl:before{content:"";position:absolute;left:12px;top:-7px;width:1px;height:9px;background:rgba(127,127,127,.22)}
.ice-tl-dot{flex:0 0 auto;width:19px;height:19px;border-radius:50%;display:grid;place-items:center;font-size:9.5px;
  font-weight:700;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.08);margin-top:1px}
.ice-tl.done .ice-tl-dot{background:rgba(89,213,255,.2);border-color:rgba(89,213,255,.48);color:#0d7ea9}
.ice-tl.next .ice-tl-dot{background:#e8faff;border-color:#39bff2;color:#087aa5;box-shadow:0 0 0 3px rgba(57,191,242,.14)}
.ice-tl-body{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.3}
.ice-tl-body b{font-size:11.5px;font-weight:680}
.ice-tl-body small{font-size:10px;opacity:.55;margin-top:1px}
.ice-tl-tag{flex:0 0 auto;font-size:9.5px;opacity:.48;margin-top:3px;white-space:nowrap}
.ice-tl.done .ice-tl-tag{color:#0d8ab7;opacity:.9}
.ice-tl.next .ice-tl-tag{opacity:.85;font-weight:650}
.ice-volume{display:flex;align-items:center;gap:8px;padding:0 1px}
.ice-volume span{font-size:11px;opacity:.5;line-height:1}
.ice-volume input{flex:1;min-width:0;height:4px;accent-color:#2bbdf0;cursor:pointer}
.ice-test{width:100%;margin-top:9px;border:1px solid rgba(89,213,255,.34);border-radius:8px;padding:7px 10px;
  font:inherit;font-size:11.5px;font-weight:650;color:#0b719b;background:rgba(89,213,255,.11);cursor:pointer;
  display:flex;align-items:center;justify-content:center;gap:6px;transition:background .15s,transform .1s}
.ice-test:hover{background:rgba(89,213,255,.18)}
.ice-test:active{transform:scale(.985)}
.ice-log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.ice-log li{display:grid;grid-template-columns:52px 1fr;gap:2px 8px;padding:4px 2px;border-bottom:1px dashed rgba(127,127,127,.15);font-size:10.5px}
.ice-log li:last-child{border-bottom:0}
.ice-log time{opacity:.48;font-variant-numeric:tabular-nums;grid-row:1}
.ice-log b{font-weight:650;font-size:10.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ice-log small{grid-column:2;opacity:.48;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9.5px}
.ice-empty{font-size:10.5px;opacity:.48;padding:5px 2px 3px;line-height:1.5}
.ice-warn{margin:0 0 8px;padding:7px 9px;border-radius:8px;font-size:10.5px;line-height:1.45;
  color:#8a5a00;background:rgba(255,190,45,.12);border:1px solid rgba(255,190,45,.28)}
.ice-foot{margin-top:12px;font-size:9.5px;opacity:.38;text-align:center;line-height:1.6}
@media (max-width:460px){.ice-root{padding:10px 10px 20px}.ice-big{font-size:25px}}
`;

    function useEngineSnapshot() {
      const [value, setValue] = React.useState(engine.getSnapshot());
      React.useEffect(() => engine.subscribe(setValue), []);
      return value;
    }

    function useNow(active) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!active) return undefined;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
      }, [active]);
      return now;
    }

    function formatElapsed(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    function formatCountdown(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    function formatTime(timestamp) {
      try {
        return new Date(timestamp).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
      } catch (error) {
        return '--:--:--';
      }
    }

    function IceCubeIcon({ size = 18 }) {
      const font = "'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif";
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { overflow: 'visible' },
      },
        h('path', {
          d: 'M12 2.6 14 8l5.4 2-5.4 2-2 5.4-2-5.4-5.4-2L10 8Z',
          fill: 'rgba(95,211,255,.18)',
        }),
        h('g', {
          fontFamily: font,
          fontSize: 10.5,
          textAnchor: 'middle',
          style: { filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.35))' },
        },
          h('text', { x: 4.4, y: 16.4, transform: 'rotate(-18 4.4 12)' }, '🧊'),
          h('text', { x: 12, y: 14.8, transform: 'rotate(7 12 10)' }, '🧊'),
          h('text', { x: 19.6, y: 16.4, transform: 'rotate(164 19.6 12)' }, '🧊')));
    }

    function SpeakerIcon() {
      return h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M3 6.2h2.2L8 3.6v8.8L5.2 9.8H3z', fill: 'currentColor', opacity: 0.85 }),
        h('path', { d: 'M10.2 5.6c.9.7 1.4 1.4 1.4 2.4s-.5 1.7-1.4 2.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('path', { d: 'M12.2 4c1.2 1 1.8 2.3 1.8 4s-.6 3-1.8 4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', opacity: 0.55 }));
    }

    function PlayIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M5 3.6 12 8l-7 4.4z', fill: 'currentColor' }));
    }

    function CheckIcon() {
      return h('svg', { width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'm3.2 8.4 3 3L12.8 4.8', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function Panel() {
      const snap = useEngineSnapshot();
      const active = snap.active;
      const current = active.find((record) => !record.expired) || active[0];
      const enabled = snap.settings.enabled;
      const now = useNow(active.length > 0);
      const expired = Boolean(current && current.expired);
      const remaining = current && !expired && current.nextAt > 0 ? current.nextAt - now : 0;
      const nextStage = current && !expired ? current.plays + 1 : 0;

      let statusNote;
      if (!enabled) {
        statusNote = '提醒已关闭，点右上角开关可以重新开启。';
      } else if (!current) {
        statusNote = '审批一出现，先冰你一下；5 / 10 / 15 分钟再各补一下。';
      } else if (expired) {
        statusNote = '15 分钟内没动静，它已经闭嘴了。下次审批再来。';
      } else {
        statusNote = '第 ' + Math.min(4, current.plays + 1) + ' 声 · ' + formatCountdown(remaining) + ' 后';
      }

      const statusBig = current && !expired ? formatElapsed(now - current.startedAt) : (expired ? '已停止' : '安静如冰');

      const statusClass = 'ice-status' + (current && !expired && enabled ? ' is-active' : '') + (expired ? ' is-expired' : '');

      return h('div', { className: 'ice-root' },
        h('style', null, CSS),
        h('div', { className: 'ice-head' },
          h('div', {
            className: 'ice-mark',
            key: 'ice-mark-' + snap.pulse,
            'data-pulse': snap.pulse ? '1' : '0',
            'aria-hidden': true,
          }, h(IceCubeIcon, { size: 30 })),
          h('div', { className: 'ice-heading' },
            h('div', { className: 'ice-title' }, '冰冰冰', h('i', null, '审批提醒')),
            h('div', { className: 'ice-sub' }, '每次审批，冰你一下；15 分钟后自动停')),
          h('button', {
            type: 'button',
            className: 'ice-switch' + (enabled ? ' on' : ''),
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': enabled ? '关闭审批提醒' : '开启审批提醒',
            title: enabled ? '关闭提醒' : '开启提醒',
            onClick: () => engine.setEnabled(!enabled),
          }, h('span', null))),

        snap.audioError ? h('div', { className: 'ice-warn' },
          '浏览器还没允许播放。点一下页面任意位置，或点下面的“试听”解锁声音。') : null,

        h('section', { className: statusClass },
          h('div', { className: 'ice-status-row' },
            h('span', { className: 'ice-live', 'aria-hidden': true }),
            h('span', null, !enabled
              ? '提醒已关闭'
              : current
                ? (expired ? '15 分钟到，已停止' : '正在等你审批')
                : '现在没有待审批')),
          h('div', { className: 'ice-big' }, statusBig),
          h('div', { className: 'ice-note' }, statusNote),
          active.length > 1 ? h('div', { className: 'ice-extra' },
            '另外 ' + (active.length - 1) + ' 个审批也在排队') : null,
          h('div', { className: 'ice-progress', 'aria-hidden': true },
            STAGES.map((stage, index) => {
              const done = Boolean(current && current.plays > index);
              const isNext = Boolean(current && !expired && current.plays === index && enabled);
              return h('span', {
                key: 'seg-' + index,
                className: 'ice-seg' + (done ? ' done' : '') + (isNext ? ' next' : ''),
              });
            }))),

        h('section', { className: 'ice-card' },
          h('div', { className: 'ice-card-head' },
            h('b', null, '提醒节奏'),
            h('span', { className: 'ice-chip' }, '4 声封顶')),
          h('ol', { className: 'ice-timeline' },
            STAGES.map((stage, index) => {
              const played = Boolean(current && current.plays > index);
              const isNext = Boolean(current && !expired && current.plays === index && enabled);
              const paused = Boolean(current && current.paused);
              const tag = played ? '已响' : isNext ? '下一次' : paused ? '暂停' : '等待';
              return h('li', {
                key: 'stage-' + index,
                className: 'ice-tl' + (played ? ' done' : '') + (isNext ? ' next' : ''),
              },
                h('span', { className: 'ice-tl-dot' }, played ? h(CheckIcon) : String(index + 1)),
                h('span', { className: 'ice-tl-body' },
                  h('b', null, stage.title),
                  h('small', null, stage.desc)),
                h('span', { className: 'ice-tl-tag' }, tag));
            }))),

        h('section', { className: 'ice-card' },
          h('div', { className: 'ice-card-head' },
            h('b', null, '音量'),
            h('span', { className: 'ice-chip' }, Math.round(snap.settings.volume * 100) + '%')),
          h('div', { className: 'ice-volume' },
            h('span', null, h(SpeakerIcon)),
            h('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: Math.round(snap.settings.volume * 100),
              'aria-label': '冰冰冰音量',
              onChange: (event) => engine.setVolume(Number(event.target.value) / 100),
            }),
            h('span', null, h(SpeakerIcon))),
          h('button', {
            type: 'button',
            className: 'ice-test',
            onClick: () => engine.test(),
          }, h(PlayIcon), '试听“冰冰冰”')),

        h('section', { className: 'ice-card' },
          h('div', { className: 'ice-card-head' },
            h('b', null, '最近提醒'),
            h('span', { className: 'ice-chip' }, snap.events.length ? snap.events.length + ' 条' : '还没有')),
          snap.events.length
            ? h('ul', { className: 'ice-log' },
                snap.events.slice(0, 6).map((event) => h('li', { key: event.id },
                  h('time', null, formatTime(event.at)),
                  h('b', null, event.kind === 'test' ? '试听' : '第 ' + ((event.stage || 0) + 1) + ' 声 · ' + event.label),
                  h('small', null, event.detail))))
            : h('div', { className: 'ice-empty' }, '还没响过。点上面的“试听”先听听看。')),

        h('div', { className: 'ice-foot' },
          '只在审批出现时响 · 最多 4 声 · 只在你的电脑上播放'));
    }

    const tab = {
      id: ID,
      kind: 'ice-approval-alert',
      title: () => '冰冰冰',
      guide: [{
        id: 'open',
        order: 26,
        title: () => '冰冰冰 · 审批提醒',
        description: () => '审批一出现就冰你一下，5 / 10 / 15 分钟再补',
        icon: IceCubeIcon,
      }],
    };

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => {
          engine.start();
          return () => engine.stop();
        }, 'ice-approval-alert/engine');

        try {
          ctx.effect(() => ctx.sidebarRightTabs.register(tab), 'ice-approval-alert/tab');
        } catch (error) {
          console.warn('[ice-approval-alert] tab registration failed', error);
        }

        try {
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: ID,
          }, Panel)), 'ice-approval-alert/panel');
        } catch (error) {
          console.warn('[ice-approval-alert] panel registration failed', error);
        }
      },
    };
  },
});
