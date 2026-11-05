(function () {
  "use strict";

  /* -----------------------------------------------------------------------
     Utilities & DOM
     ----------------------------------------------------------------------- */

  const $ = (selector, root = document) => root.querySelector(selector);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (t) => {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const damp = (current, target, lambda, dt) =>
    lerp(current, target, 1 - Math.exp(-lambda * Math.max(0.0001, dt)));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const body = document.body;
  const canvas = $("#albumCanvas");
  const supportsAuraTranslate =
    !!window.CSS &&
    typeof window.CSS.supports === "function" &&
    window.CSS.supports("translate", "1px 1px");
  const loader = $("#loader");
  const fallback = $("#fallback");
  const statusText = $("#statusText");
  const replayButton = $("#replayButton");
  const flipButton = $("#flipButton");
  const closeCaseButton = $("#closeCaseButton");

  const lyricPanel = $(".lyric-panel");
  const lyricStage = $("#lyricStage");
  const lyricPrev = $("#lyricPrev");
  const lyricCurrent = $("#lyricCurrent");
  const lyricNext = $("#lyricNext");
  const lyricAura = $("#lyricAura");
  const lyricGlints = $("#lyricGlints");
  const lyricNote = $("#lyricNote");
  const audioElement = $("#styleAudio");
  const audioToggle = $("#audioToggle");
  const audioStateEl = $("#audioState");
  const audioCurrentEl = $("#audioCurrent");
  const audioDurationEl = $("#audioDuration");
  const audioProgress = $("#audioProgress");
  const audioFill = $("#audioFill");
  const audioThumb = $("#audioThumb");

  const params = new URLSearchParams(window.location.search);
  const debugTimeParam = params.get("t");
  const debugTime =
    debugTimeParam !== null && Number.isFinite(Number(debugTimeParam))
      ? Math.max(0, Number(debugTimeParam))
      : null;
  const debugFlip = params.get("flip") === "1";
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const mobileMedia = window.matchMedia("(max-width: 900px), (max-aspect-ratio: 6/5)");
  const compactLandscapeMedia = window.matchMedia("(max-height: 560px) and (min-aspect-ratio: 6/5)");
  const compactMedia = window.matchMedia("(max-width: 600px)");

  // Timeline: a slow, hand-made kind of time.
  const TIMING = {
    introDuration: 1.55,
    writeStart: 1.8,
    writeDuration: 7.85,
    developHold: 0.32,
    developDuration: 2.65,
  };
  TIMING.writeEnd = TIMING.writeStart + TIMING.writeDuration;
  TIMING.developStart = TIMING.writeEnd + TIMING.developHold;
  TIMING.complete = TIMING.developStart + TIMING.developDuration;

  const lyricData =
    window.STYLE_LYRICS && Array.isArray(window.STYLE_LYRICS.lines)
      ? window.STYLE_LYRICS
      : null;
  const lyricLines = lyricData
    ? lyricData.lines.filter((line) => line && Array.isArray(line.words) && line.words.length)
    : [];
  const lyricFallbackDuration =
    lyricData && Number.isFinite(Number(lyricData.duration)) && Number(lyricData.duration) > 0
      ? Number(lyricData.duration)
      : 231;

  // Colours borrowed from the cover: faded peach, powder blue, dusty mauve,
  // warm paper, and the lipstick red.
  const LYRIC_HALOS = [
    { strong: "rgba(220, 148, 116, 0.82)", soft: "rgba(249, 221, 197, 0.52)" },
    { strong: "rgba(143, 181, 210, 0.78)", soft: "rgba(218, 235, 244, 0.5)" },
    { strong: "rgba(187, 145, 182, 0.74)", soft: "rgba(237, 214, 230, 0.48)" },
    { strong: "rgba(218, 175, 120, 0.72)", soft: "rgba(250, 234, 205, 0.5)" },
    { strong: "rgba(190, 91, 72, 0.56)", soft: "rgba(238, 189, 170, 0.42)" },
  ];

  const lyricPlayback = {
    audio: null,
    duration: lyricFallbackDuration,
    started: false,
    playing: false,
    ended: false,
    lineIndex: -1,
    preview: true,
    wordEls: [],
    wordGeometry: null,
    liveTimers: new Set(),
    seeking: false,
    pendingSeek: null,
    lastTenth: -1,
    lastAuraEl: null,
    rafId: 0,
  };

  const state = {
    ready: false,
    started: false,
    clock: prefersReducedMotion ? TIMING.complete + 0.1 : 0,
    lastFrame: 0,
    forcedTime: debugTime,
    phase: "",
    tempStatusTimer: 0,
    reduced: prefersReducedMotion,
    coarse: coarsePointer,
    compact: compactMedia.matches,
  };

  const interaction = {
    dragging: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    lastTime: 0,
    targetX: 0,
    targetY: 0,
    currentX: 0,
    currentY: 0,
    velocityX: 0,
    velocityY: 0,
    pointerX: 0,
    pointerY: 0,
    smoothPointerX: 0,
    smoothPointerY: 0,
    hasMoved: false,
    lastTapTime: 0,
    lastTapX: 0,
    lastTapY: 0,
  };

  let viewer = null;
  let loopId = 0;
  let caseUiOpen = false;

  /* -----------------------------------------------------------------------
     Status copy
     ----------------------------------------------------------------------- */

  function phaseLabel(phase) {
    switch (phase) {
      case "intro":
        return state.compact ? "A MEMORY, DEVELOPING" : "A MEMORY, DEVELOPING";
      case "writing":
        return "INKING 1989";
      case "developing":
        return state.compact ? "DEVELOPING THE POLAROID" : "DEVELOPING THE POLAROID";
      case "complete":
        if (caseUiOpen) {
          return state.compact ? "CASE OPEN · DRAG TO TURN" : "CASE OPEN · DRAG TO TURN";
        }
        return state.compact
          ? "TAP THE SEAL TO OPEN"
          : "CLICK THE SEAL TO OPEN · DRAG TO TURN";
      default:
        return "DEVELOPING THE POLAROID";
    }
  }

  function setPhase(phase) {
    if (state.phase === phase) return;
    state.phase = phase;

    body.classList.toggle("is-writing", phase === "writing");
    body.classList.toggle("is-developing", phase === "developing");
    body.classList.toggle("is-complete", phase === "complete");

    if (!state.tempStatusTimer) {
      statusText.textContent = phaseLabel(phase);
    }
  }

  function setTemporaryStatus(message, duration = 1300) {
    if (state.tempStatusTimer) {
      window.clearTimeout(state.tempStatusTimer);
    }
    statusText.textContent = message;
    state.tempStatusTimer = window.setTimeout(() => {
      state.tempStatusTimer = 0;
      statusText.textContent = phaseLabel(state.phase || "intro");
    }, duration);
  }

  function flashInteractionStatus() {
    if (state.phase === "complete") {
      setTemporaryStatus("TURNING THE CASE", 900);
    }
  }

  function startSoundForCase() {
    if (!lyricPlayback.audio || lyricPlayback.error || lyricPlayback.playing) return;
    // The seal is clicked by a person, so this also satisfies the browser's
    // gesture requirement for audio playback.
    togglePlayback();
  }

  function setCaseInterface(open) {
    caseUiOpen = open;
    body.classList.toggle("is-case-open", open);
    if (closeCaseButton) closeCaseButton.setAttribute("aria-expanded", String(open));
    if (!state.tempStatusTimer) {
      statusText.textContent = phaseLabel(state.phase || "intro");
    }
  }

  function openAlbumCase() {
    if (!viewer || !state.ready) return;
    viewer.openCase();
    setCaseInterface(true);
    setTemporaryStatus("OPENING THE CASE", 1500);
    startSoundForCase();
  }

  function closeAlbumCase() {
    if (!viewer || !state.ready) return;
    if (!viewer.closeCase()) {
      setCaseInterface(false);
      return;
    }
    setCaseInterface(false);
    setTemporaryStatus("CLOSING THE CASE", 1100);
  }

  /* -----------------------------------------------------------------------
     Input: the sleeve is yours to turn
     ----------------------------------------------------------------------- */

  function readPointer(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    };
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (!state.ready) return;

    interaction.dragging = true;
    interaction.pointerId = e.pointerId;
    interaction.lastX = e.clientX;
    interaction.lastY = e.clientY;
    interaction.lastTime = performance.now();
    interaction.velocityX = 0;
    interaction.velocityY = 0;
    interaction.hasMoved = false;
    canvas.style.cursor = "";

    body.classList.add("is-dragging");
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {
        /* Pointer capture is a nicety, not a requirement. */
      }
    }
    if (canvas.focus) canvas.focus({ preventScroll: true });
    if (e.cancelable) e.preventDefault();
  }

  function onPointerMove(e) {
    if (!state.ready) return;

    const p = readPointer(e);
    interaction.pointerX = p.x;
    interaction.pointerY = p.y;

    if (!interaction.dragging) {
      if (state.ready && viewer && !caseUiOpen) {
        canvas.style.cursor = viewer.hitSeal(e.clientX, e.clientY) ? "pointer" : "";
      } else if (canvas.style.cursor) {
        canvas.style.cursor = "";
      }
      return;
    }

    const now = performance.now();
    const dx = e.clientX - interaction.lastX;
    const dy = e.clientY - interaction.lastY;
    const dt = Math.max(0.008, (now - interaction.lastTime) / 1000);
    const deltaYaw = dx * 0.0062;
    const deltaPitch = dy * 0.0046;

    interaction.targetY += deltaYaw;
    interaction.targetX = clamp(interaction.targetX + deltaPitch, -0.52, 0.52);
    interaction.velocityY = lerp(interaction.velocityY, deltaYaw / dt, 0.55);
    interaction.velocityX = lerp(interaction.velocityX, deltaPitch / dt, 0.5);
    interaction.hasMoved = interaction.hasMoved || Math.abs(dx) + Math.abs(dy) > 2;

    interaction.lastX = e.clientX;
    interaction.lastY = e.clientY;
    interaction.lastTime = now;

    if (e.cancelable) e.preventDefault();
  }

  function stopDragging(e) {
    if (!interaction.dragging) return;
    interaction.dragging = false;
    body.classList.remove("is-dragging");

    if (canvas.releasePointerCapture && interaction.pointerId !== null) {
      try {
        canvas.releasePointerCapture(interaction.pointerId);
      } catch (_) {
        /* It is fine if the browser already released it. */
      }
    }
    interaction.pointerId = null;

    // A small amount of inertia. Cap it so the sleeve does not fly away.
    interaction.velocityY = clamp(interaction.velocityY, -5.2, 5.2);
    interaction.velocityX = clamp(interaction.velocityX, -3.2, 3.2);

    const tapX = e && typeof e.clientX === "number" ? e.clientX : interaction.lastX;
    const tapY = e && typeof e.clientY === "number" ? e.clientY : interaction.lastY;
    const now = performance.now();

    if (
      !interaction.hasMoved &&
      viewer &&
      viewer.hitSeal &&
      viewer.hitSeal(tapX, tapY)
    ) {
      interaction.lastTapTime = 0;
      interaction.velocityX = 0;
      interaction.velocityY = 0;
      openAlbumCase();
      if (e && e.cancelable) e.preventDefault();
      return;
    }

    if (!interaction.hasMoved) {
      const isSecondTap =
        now - interaction.lastTapTime < 340 &&
        Math.hypot(tapX - interaction.lastTapX, tapY - interaction.lastTapY) < 28;
      if (isSecondTap) {
        interaction.lastTapTime = 0;
        flipSleeve();
      } else {
        interaction.lastTapTime = now;
        interaction.lastTapX = tapX;
        interaction.lastTapY = tapY;
      }
    } else {
      flashInteractionStatus();
    }

    if (!interaction.hasMoved) {
      interaction.velocityX = 0;
      interaction.velocityY = 0;
    }
    if (e && e.cancelable) e.preventDefault();
  }

  function flipSleeve(announce = true) {
    if (!state.ready) return;
    if (caseUiOpen) {
      setTemporaryStatus("CLOSE THE CASE TO FLIP", 1200);
      return;
    }
    interaction.targetY += Math.PI;
    interaction.velocityY = 0;
    if (announce) setTemporaryStatus("TURNING THE CASE", 1200);
  }

  function resetPointerParallax() {
    interaction.pointerX = 0;
    interaction.pointerY = 0;
  }

  function setupInput() {
    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", stopDragging, { passive: false });
    canvas.addEventListener("pointercancel", stopDragging, { passive: false });
    canvas.addEventListener("lostpointercapture", stopDragging);
    canvas.addEventListener("pointerleave", () => {
      if (!interaction.dragging) {
        resetPointerParallax();
        canvas.style.cursor = "";
      }
    });
    window.addEventListener("pointerleave", resetPointerParallax);
    window.addEventListener("blur", resetPointerParallax);

    canvas.addEventListener("keydown", (e) => {
      const step = Math.PI / 12;
      if (e.key === "Escape" && caseUiOpen) {
        closeAlbumCase();
        e.preventDefault();
      } else if ((e.key === "o" || e.key === "O") && !caseUiOpen) {
        openAlbumCase();
        e.preventDefault();
      } else if (e.key === "ArrowLeft") {
        interaction.targetY -= step;
        interaction.velocityY = 0;
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        interaction.targetY += step;
        interaction.velocityY = 0;
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        interaction.targetX = clamp(interaction.targetX - 0.07, -0.52, 0.52);
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        interaction.targetX = clamp(interaction.targetX + 0.07, -0.52, 0.52);
        e.preventDefault();
      } else if (e.key === " " || e.key === "Enter") {
        flipSleeve();
        e.preventDefault();
      }
    });

    flipButton.addEventListener("click", () => flipSleeve());
    replayButton.addEventListener("click", () => replayExperience());
    if (closeCaseButton) {
      closeCaseButton.addEventListener("click", () => closeAlbumCase());
    }

    mobileMedia.addEventListener?.("change", () => {
      state.compact = compactMedia.matches;
      if (state.phase === "complete" && !state.tempStatusTimer) {
        statusText.textContent = phaseLabel(state.phase);
      }
    });
    compactMedia.addEventListener?.("change", () => {
      state.compact = compactMedia.matches;
      if (!state.tempStatusTimer) statusText.textContent = phaseLabel(state.phase || "intro");
    });
  }

  /* -----------------------------------------------------------------------
     Replay
     ----------------------------------------------------------------------- */

  function replayExperience() {
    if (!state.ready || !viewer || state.reduced) return;
    if (state.tempStatusTimer) {
      window.clearTimeout(state.tempStatusTimer);
      state.tempStatusTimer = 0;
    }

    state.clock = 0;
    state.phase = "";
    body.classList.remove("is-complete", "is-writing", "is-developing");
    statusText.textContent = phaseLabel("intro");

    // Return the sleeve to a readable front-facing position.
    if (viewer && viewer.resetWriting) viewer.resetWriting();

    interaction.targetX = 0;
    interaction.targetY = Math.round(interaction.targetY / (Math.PI * 2)) * (Math.PI * 2);
    interaction.velocityX = 0;
    interaction.velocityY = 0;
    interaction.pointerX = 0;
    interaction.pointerY = 0;

    setPhase("intro");
    setTemporaryStatus("THE INK IS BEING PREPARED", 1000);
  }

  /* -----------------------------------------------------------------------
     Lyrics & soundtrack
     ----------------------------------------------------------------------- */

  function formatSongTime(value) {
    const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
    const whole = Math.floor(safe);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }

  function lyricLineText(line) {
    return line.words.map((word) => word.text).join(" ");
  }

  function getLineIndexAt(time) {
    if (!lyricLines.length) return -1;
    if (time < lyricLines[0].time) return -1;
    let low = 0;
    let high = lyricLines.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (time >= lyricLines[mid].time) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  function clearLiveTimers() {
    for (const timer of lyricPlayback.liveTimers) {
      window.clearTimeout(timer);
    }
    lyricPlayback.liveTimers.clear();
  }

  function setLyricPalette(index) {
    if (!lyricStage) return;
    const halo = LYRIC_HALOS[index % LYRIC_HALOS.length];
    lyricStage.style.setProperty("--line-halo", halo.strong);
    lyricStage.style.setProperty("--line-halo-soft", halo.soft);
  }

  function setAuraPosition(x, y) {
    if (!lyricAura) return;
    if (supportsAuraTranslate) {
      lyricAura.style.translate = `${x}px ${y}px`;
    } else {
      lyricAura.style.left = `${x}px`;
      lyricAura.style.top = `${y}px`;
    }
  }

  function setDefaultAura() {
    if (!lyricStage || !lyricAura) return;
    const width = lyricStage.clientWidth || 1;
    const height = lyricStage.clientHeight || 1;
    setAuraPosition(width * 0.32, height * 0.5);
    lyricPlayback.lastAuraEl = null;
  }

  function cacheWordGeometry() {
    if (!lyricCurrent || !lyricStage || !lyricPlayback.wordEls.length) return;
    const stageHeight = lyricStage.clientHeight || 1;
    const lineHeight = lyricCurrent.offsetHeight;
    const lineTop = stageHeight * 0.5 - lineHeight * 0.5;
    const positions = new Map();
    for (const wordEl of lyricPlayback.wordEls) {
      const width = wordEl.offsetWidth;
      const height = wordEl.offsetHeight;
      positions.set(wordEl, {
        x: wordEl.offsetLeft + width * 0.5,
        y: lineTop + wordEl.offsetTop + height * 0.5,
        width,
        height,
      });
    }
    lyricPlayback.wordGeometry = positions;
  }

  function getWordSpot(wordEl) {
    if (!wordEl) return null;
    let geometry = lyricPlayback.wordGeometry;
    let spot = geometry && geometry.get(wordEl);
    if (!spot) {
      cacheWordGeometry();
      geometry = lyricPlayback.wordGeometry;
      spot = geometry && geometry.get(wordEl);
    }
    return spot || null;
  }

  function moveAuraToWord(wordEl) {
    const spot = getWordSpot(wordEl);
    if (!spot) return;
    setAuraPosition(spot.x, spot.y);
    lyricPlayback.lastAuraEl = wordEl;
  }

  function emitWordGlints(spot) {
    if (!spot || !lyricGlints || prefersReducedMotion) return;

    // Keep the sparkle layer tidy even if a browser throttles timers in a
    // background tab.
    while (lyricGlints.childElementCount > 12) {
      lyricGlints.firstElementChild.remove();
    }

    const count = 3;
    for (let i = 0; i < count; i += 1) {
      const glint = document.createElement("span");
      glint.className = "lyric-glint";
      const x = spot.x - spot.width * 0.5 + spot.width * (0.12 + Math.random() * 0.76);
      const y = spot.y - spot.height * 0.5 + spot.height * (0.22 + Math.random() * 0.55);
      glint.style.left = `${x}px`;
      glint.style.top = `${y}px`;
      glint.style.setProperty("--gx", `${(Math.random() - 0.5) * 38}px`);
      glint.style.setProperty("--gy", `${-16 - Math.random() * 30}px`);
      glint.style.animationDelay = `${i * 38}ms`;
      lyricGlints.appendChild(glint);
      const removeGlint = () => glint.remove();
      glint.addEventListener("animationend", removeGlint, { once: true });
      window.setTimeout(removeGlint, 2200);
    }
  }

  function spotlightWord(wordEl) {
    const spot = getWordSpot(wordEl);
    if (!spot) return;
    setAuraPosition(spot.x, spot.y);
    lyricPlayback.lastAuraEl = wordEl;
    emitWordGlints(spot);
  }

  function buildLyricLine(index, preview) {
    const line = lyricLines[index];
    if (!line || !lyricCurrent) return;
    clearLiveTimers();
    lyricPlayback.lineIndex = index;
    lyricPlayback.preview = preview;
    lyricPlayback.lastAuraEl = null;
    lyricPlayback.wordGeometry = null;
    setLyricPalette(index);

    const fullText = lyricLineText(line);
    lyricCurrent.className = "lyric-line lyric-line--current";
    if (preview) lyricCurrent.classList.add("is-preview");
    if (fullText.length > 34) lyricCurrent.classList.add("is-long");
    if (fullText.length > 43) lyricCurrent.classList.add("is-xlong");
    lyricCurrent.setAttribute("data-line", String(index));

    const fragment = document.createDocumentFragment();
    const wordEls = [];
    line.words.forEach((word, wordIndex) => {
      const span = document.createElement("span");
      span.className = "lyric-word";
      span.dataset.time = String(word.time);
      span.textContent = word.text;
      fragment.appendChild(span);
      wordEls.push(span);
      if (wordIndex < line.words.length - 1) {
        fragment.appendChild(document.createTextNode(" "));
      }
    });
    lyricCurrent.replaceChildren(fragment);
    lyricPlayback.wordEls = wordEls;
    cacheWordGeometry();

    const previous = index > 0 ? lyricLines[index - 1] : null;
    const next = index + 1 < lyricLines.length ? lyricLines[index + 1] : null;
    lyricPrev.textContent = preview ? "" : previous ? lyricLineText(previous) : "";
    lyricNext.textContent = next ? lyricLineText(next) : "";

    if (!prefersReducedMotion && typeof lyricCurrent.animate === "function") {
      lyricCurrent.animate(
        [
          {
            opacity: 0,
            transform: "translateY(calc(-50% + 14px))",
          },
          {
            opacity: 1,
            transform: "translateY(-50%)",
          },
        ],
        {
          duration: 650,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        }
      );
    }

    setDefaultAura();
  }

  function revealLyricWords(time, allowReveal) {
    if (!lyricPlayback.wordEls.length) return;

    let newest = null;
    let lastLit = null;
    for (const wordEl of lyricPlayback.wordEls) {
      const wordTime = Number(wordEl.dataset.time);
      const shouldBeLit = allowReveal && Number.isFinite(wordTime) && time + 0.014 >= wordTime;
      const isLit = wordEl.classList.contains("is-lit");

      if (shouldBeLit) {
        if (!isLit) {
          wordEl.classList.add("is-lit");
          newest = wordEl;
        }
        lastLit = wordEl;
      } else if (isLit) {
        wordEl.classList.remove("is-lit", "is-live");
      }
    }

    if (newest) {
      newest.classList.add("is-live");
      const timer = window.setTimeout(() => {
        newest.classList.remove("is-live");
        lyricPlayback.liveTimers.delete(timer);
      }, 1200);
      lyricPlayback.liveTimers.add(timer);
      spotlightWord(newest);
    } else if (lastLit && lastLit !== lyricPlayback.lastAuraEl) {
      moveAuraToWord(lastLit);
    } else if (!lastLit && lyricPlayback.lastAuraEl) {
      setDefaultAura();
    }
  }

  function updateLyricsTimeline(time) {
    if (!lyricLines.length || !lyricCurrent) return;
    const index = getLineIndexAt(time);
    const preview = index < 0;
    const displayIndex = preview ? 0 : index;

    if (displayIndex !== lyricPlayback.lineIndex) {
      buildLyricLine(displayIndex, preview);
    } else if (preview !== lyricPlayback.preview) {
      lyricPlayback.preview = preview;
      lyricCurrent.classList.toggle("is-preview", preview);
      if (preview) {
        setDefaultAura();
      }
    }

    revealLyricWords(time, !preview);
  }

  function updateProgress(time) {
    const duration = lyricPlayback.duration || lyricFallbackDuration;
    const safeTime = Number.isFinite(time) ? clamp(time, 0, duration) : 0;
    const ratio = duration > 0 ? safeTime / duration : 0;
    if (audioFill) audioFill.style.width = `${ratio * 100}%`;
    if (audioThumb) audioThumb.style.left = `${ratio * 100}%`;
    const second = Math.floor(safeTime);
    if (audioCurrentEl && second !== lyricPlayback.lastTenth) {
      lyricPlayback.lastTenth = second;
      audioCurrentEl.textContent = formatSongTime(safeTime);
      if (audioProgress) {
        audioProgress.setAttribute("aria-valuenow", String(second));
        audioProgress.setAttribute(
          "aria-valuetext",
          `${formatSongTime(safeTime)} of ${formatSongTime(duration)}`
        );
      }
    }
  }

  function setPlayerLabel(state, note) {
    if (audioStateEl) audioStateEl.textContent = state;
    if (lyricNote) {
      lyricNote.innerHTML = note;
    }
  }

  function updatePlayerState() {
    if (!lyricPanel || !audioToggle) return;
    const playing = lyricPlayback.playing;
    lyricPanel.classList.toggle("is-playing", playing);

    if (lyricPlayback.error) {
      audioToggle.setAttribute("aria-label", "Audio unavailable");
      audioToggle.setAttribute("aria-pressed", "false");
      audioToggle.disabled = true;
      setPlayerLabel("TRACK OFFLINE", 'THE SONG COULD NOT BE LOADED <span>·</span> CHECK THE AUDIO FILE');
      return;
    }

    if (playing) {
      lyricPanel.classList.add("is-started");
      audioToggle.setAttribute("aria-label", "Pause Style");
      audioToggle.setAttribute("aria-pressed", "true");
      setPlayerLabel("NOW PLAYING", 'LIVE LYRICS <span>·</span> TAYLOR SWIFT');
    } else if (lyricPlayback.ended) {
      audioToggle.setAttribute("aria-label", "Replay Style");
      audioToggle.setAttribute("aria-pressed", "false");
      setPlayerLabel("END OF SONG", 'STYLE <span>·</span> PRESS PLAY TO HEAR IT AGAIN');
    } else if (lyricPlayback.started) {
      audioToggle.setAttribute("aria-label", "Play Style");
      audioToggle.setAttribute("aria-pressed", "false");
      setPlayerLabel("PAUSED", 'LYRICS PAUSED <span>·</span> PRESS PLAY TO CONTINUE');
    } else {
      audioToggle.setAttribute("aria-label", "Play Style");
      audioToggle.setAttribute("aria-pressed", "false");
      setPlayerLabel("PLAY STYLE", 'LYRICS <span>·</span> TAYLOR SWIFT <span>·</span> PRESS PLAY TO BEGIN');
    }
  }

  function setLogDuration(duration) {
    if (!Number.isFinite(duration) || duration <= 0) return;
    lyricPlayback.duration = duration;
    if (audioDurationEl) audioDurationEl.textContent = formatSongTime(duration);
    if (audioProgress) {
      audioProgress.setAttribute("aria-valuemax", String(Math.ceil(duration)));
    }
    updateProgress(lyricPlayback.audio ? lyricPlayback.audio.currentTime : 0);
  }

  function safeSeek(target) {
    const audio = lyricPlayback.audio;
    if (!audio) return;
    const duration = lyricPlayback.duration || lyricFallbackDuration;
    const safeTarget = clamp(target, 0, Math.max(0, duration - 0.06));
    try {
      audio.currentTime = safeTarget;
      lyricPlayback.pendingSeek = null;
    } catch (_) {
      lyricPlayback.pendingSeek = safeTarget;
    }
    lyricPlayback.ended = false;
    updateLyricsTimeline(safeTarget);
    updateProgress(safeTarget);
    if (!lyricPlayback.playing) updatePlayerState();
  }

  function togglePlayback() {
    const audio = lyricPlayback.audio;
    if (!audio || lyricPlayback.error) return;

    if (!audio.paused && !audio.ended) {
      audio.pause();
      return;
    }

    if (audio.ended || audio.currentTime >= lyricPlayback.duration - 0.2) {
      safeSeek(0);
      lyricPlayback.ended = false;
    }

    if (audioStateEl) audioStateEl.textContent = "CUEING";
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((error) => {
        console.warn("[1989] Audio playback could not start:", error);
        lyricPlayback.playing = false;
        if (audioStateEl) audioStateEl.textContent = "TAP TO PLAY";
      });
    }
  }

  function setSeekFromEvent(e) {
    if (!audioProgress) return;
    const rect = audioProgress.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    safeSeek(ratio * lyricPlayback.duration);
  }

  function onSeekPointerDown(e) {
    if (!lyricPlayback.audio) return;
    lyricPlayback.seeking = true;
    if (audioProgress.setPointerCapture) {
      try {
        audioProgress.setPointerCapture(e.pointerId);
      } catch (_) {
        /* no-op */
      }
    }
    setSeekFromEvent(e);
    if (e.cancelable) e.preventDefault();
  }

  function onSeekPointerMove(e) {
    if (!lyricPlayback.seeking) return;
    setSeekFromEvent(e);
    if (e.cancelable) e.preventDefault();
  }

  function onSeekPointerUp(e) {
    if (!lyricPlayback.seeking) return;
    lyricPlayback.seeking = false;
    if (audioProgress.releasePointerCapture) {
      try {
        audioProgress.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* no-op */
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  function setupLyricsExperience() {
    if (!lyricStage || !lyricCurrent || !audioElement || !audioToggle) return;
    if (!lyricLines.length) {
      if (audioStateEl) audioStateEl.textContent = "LYRICS OFFLINE";
      audioToggle.disabled = true;
      return;
    }

    lyricPlayback.audio = audioElement;
    lyricPlayback.duration = lyricFallbackDuration;
    if (audioDurationEl) audioDurationEl.textContent = formatSongTime(lyricFallbackDuration);
    setLogDuration(lyricFallbackDuration);
    buildLyricLine(0, true);
    updateLyricsTimeline(0);
    updateProgress(0);
    updatePlayerState();

    audioToggle.addEventListener("click", togglePlayback);

    audioElement.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(audioElement.duration) && audioElement.duration > 0) {
        setLogDuration(audioElement.duration);
      }
      if (lyricPlayback.pendingSeek !== null) {
        safeSeek(lyricPlayback.pendingSeek);
      }
    });

    audioElement.addEventListener("play", () => {
      lyricPlayback.started = true;
      lyricPlayback.playing = true;
      lyricPlayback.ended = false;
      if (lyricPanel) lyricPanel.classList.add("is-started");
      updatePlayerState();
      updateLyricsTimeline(audioElement.currentTime);
    });

    audioElement.addEventListener("pause", () => {
      if (audioElement.ended) return;
      lyricPlayback.playing = false;
      updatePlayerState();
    });

    audioElement.addEventListener("ended", () => {
      lyricPlayback.playing = false;
      lyricPlayback.ended = true;
      updatePlayerState();
      updateLyricsTimeline(audioElement.currentTime);
    });

    audioElement.addEventListener("error", () => {
      lyricPlayback.error = true;
      lyricPlayback.playing = false;
      updatePlayerState();
    });

    audioElement.addEventListener("timeupdate", () => {
      updateLyricsTimeline(audioElement.currentTime);
      updateProgress(audioElement.currentTime);
    });

    audioProgress.addEventListener("pointerdown", onSeekPointerDown);
    audioProgress.addEventListener("pointermove", onSeekPointerMove);
    audioProgress.addEventListener("pointerup", onSeekPointerUp);
    audioProgress.addEventListener("pointercancel", onSeekPointerUp);

    window.addEventListener("resize", () => {
      cacheWordGeometry();
      if (lyricPlayback.lastAuraEl) {
        moveAuraToWord(lyricPlayback.lastAuraEl);
      } else {
        setDefaultAura();
      }
    });

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        cacheWordGeometry();
        if (lyricPlayback.lastAuraEl) {
          moveAuraToWord(lyricPlayback.lastAuraEl);
        } else {
          setDefaultAura();
        }
      });
    }

    audioProgress.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 5;
      if (e.key === "ArrowLeft") {
        safeSeek(audioElement.currentTime - step);
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        safeSeek(audioElement.currentTime + step);
        e.preventDefault();
      } else if (e.key === "Home") {
        safeSeek(0);
        e.preventDefault();
      } else if (e.key === "End") {
        safeSeek(lyricPlayback.duration - 0.1);
        e.preventDefault();
      } else if (e.key === " " || e.key === "Enter") {
        togglePlayback();
        e.preventDefault();
      }
    });

    let lastLyricsTick = 0;
    let lastProgressTick = 0;

    function lyricTick(now) {
      const audio = lyricPlayback.audio;
      if (!audio) return;
      const stamp = typeof now === "number" ? now : performance.now();
      const time = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      // The words only need to move at display speed; decoupling the DOM
      // updates from the 3D render loop leaves headroom for the album.
      if (stamp - lastLyricsTick >= 28) {
        updateLyricsTimeline(time);
        lastLyricsTick = stamp;
      }
      if (stamp - lastProgressTick >= 100) {
        updateProgress(time);
        lastProgressTick = stamp;
      }
      lyricPlayback.rafId = window.requestAnimationFrame(lyricTick);
    }

    lyricPlayback.rafId = window.requestAnimationFrame(lyricTick);
    window.__STYLE_AUDIO__ = audioElement;
    window.__LYRIC_STATE__ = lyricPlayback;
    window.__LYRIC_SEEK__ = safeSeek;
  }


  function loadTexture(loader, url, { srgb = false, mipmaps = true } = {}) {
    return new Promise((resolve, reject) => {
      const texture = loader.load(
        url,
        () => resolve(texture),
        undefined,
        (error) => reject(error)
      );
      texture.encoding = srgb ? window.THREE.sRGBEncoding : window.THREE.LinearEncoding;
      texture.wrapS = window.THREE.ClampToEdgeWrapping;
      texture.wrapT = window.THREE.ClampToEdgeWrapping;
      texture.flipY = true;
      if (!mipmaps) {
        texture.generateMipmaps = false;
        texture.minFilter = window.THREE.LinearFilter;
      }
    });
  }

  async function loadAllTextures() {
    const data = window.ALBUM_TEXTURES;
    if (!data || !data.cover || !data.ink || !data.writeMap) {
      throw new Error("The embedded cover textures could not be found.");
    }
    const loader = new window.THREE.TextureLoader();
    const [cover, clean, ink, writeMap] = await Promise.all([
      loadTexture(loader, data.cover, { srgb: true }),
      loadTexture(loader, data.clean || data.cover, { srgb: true }),
      loadTexture(loader, data.ink, { srgb: false }),
      loadTexture(loader, data.writeMap, { srgb: false, mipmaps: false }),
    ]);
    return { cover, clean, ink, writeMap };
  }

  /* -----------------------------------------------------------------------
     The 3D stage
     ----------------------------------------------------------------------- */

  function createVeilTexture() {
    const size = 512;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");

    const base = ctx.createLinearGradient(0, 0, size, size);
    base.addColorStop(0, "#f7f1e7");
    base.addColorStop(0.48, "#f1ebe0");
    base.addColorStop(1, "#eae2d6");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    // Soft, uneven light that keeps the veil from looking like flat fog.
    const clouds = [
      [size * 0.23, size * 0.17, size * 0.54, "rgba(255,252,245,0.56)"],
      [size * 0.84, size * 0.28, size * 0.38, "rgba(255,245,232,0.45)"],
      [size * 0.58, size * 0.87, size * 0.5, "rgba(214,202,188,0.14)"],
      [size * 0.18, size * 0.72, size * 0.3, "rgba(255,250,242,0.33)"],
    ];
    for (const [x, y, radius, color] of clouds) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, color);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }

    const image = ctx.getImageData(0, 0, size, size);
    const pixels = image.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const n = (Math.random() - 0.5) * 7;
      pixels[i] = clamp(pixels[i] + n, 0, 255);
      pixels[i + 1] = clamp(pixels[i + 1] + n, 0, 255);
      pixels[i + 2] = clamp(pixels[i + 2] + n, 0, 255);
    }
    ctx.putImageData(image, 0, 0);

    const texture = new window.THREE.CanvasTexture(c);
    texture.encoding = window.THREE.sRGBEncoding;
    texture.wrapS = window.THREE.ClampToEdgeWrapping;
    texture.wrapT = window.THREE.ClampToEdgeWrapping;
    return texture;
  }

  function makeInkMaterial(inkTexture, writeMapTexture) {
    return new window.THREE.ShaderMaterial({
      uniforms: {
        uInk: { value: inkTexture },
        uMap: { value: writeMapTexture },
        uWrite: { value: 0 },
        uOpacity: { value: 1 },
        uLightDir: { value: new window.THREE.Vector3(0.35, 0.55, 0.76).normalize() },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldNormal;

        void main() {
          vUv = uv;
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D uInk;
        uniform sampler2D uMap;
        uniform float uWrite;
        uniform float uOpacity;
        uniform vec3 uLightDir;

        varying vec2 vUv;
        varying vec3 vWorldNormal;

        void main() {
          vec4 ink = texture2D(uInk, vUv);
          float order = texture2D(uMap, vUv).r;

          if (ink.a < 0.003 || order < 0.001) discard;

          // The map stores the moment the brush should reach each pixel.
          // A little screen-space feathering keeps the paper edge soft.
          float feather = max(fwidth(order) * 0.9, 0.0018);
          float revealed = smoothstep(order, order + feather + 0.004, uWrite);

          // A very restrained wet-edge highlight, visible only right at the
          // moving front of the brush.
          float head = (1.0 - smoothstep(0.0, 0.034, uWrite - order)) * step(order, uWrite);
          float glintFade = 1.0 - smoothstep(0.92, 1.0, uWrite);
          head *= glintFade;

          float light = 0.91 + 0.09 * max(dot(normalize(vWorldNormal), uLightDir), 0.0);
          vec3 color = ink.rgb * 0.94 * light;
          color += vec3(0.15, 0.13, 0.09) * head * 0.24;

          float alpha = ink.a * revealed * uOpacity;
          if (alpha < 0.003) discard;

          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: window.THREE.FrontSide,
      toneMapped: false,
      extensions: { derivatives: true },
    });
  }

  function makeGhostMaterial(inkTexture, writeMapTexture) {
    // The projection is cropped to the actual painted 1989, not the entire
    // square sleeve. The crop's UVs are kept as constants so the page-level
    // ghost and the sleeve are driven by exactly the same stroke-order map.
    return new window.THREE.ShaderMaterial({
      uniforms: {
        uInk: { value: inkTexture },
        uMap: { value: writeMapTexture },
        uWrite: { value: 0 },
        uOpacity: { value: 0.075 },
        uColor: { value: new window.THREE.Color(0x2b2a33) },
        uUvMin: { value: new window.THREE.Vector2(120 / 2048, 1 - 1500 / 2048) },
        uUvMax: { value: new window.THREE.Vector2(1978 / 2048, 1 - 560 / 2048) },
      },
      vertexShader: `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uInk;
        uniform sampler2D uMap;
        uniform vec2 uUvMin;
        uniform vec2 uUvMax;
        uniform float uWrite;
        uniform float uOpacity;
        uniform vec3 uColor;

        varying vec2 vUv;

        void main() {
          vec2 uv = mix(uUvMin, uUvMax, vUv);
          float order = texture2D(uMap, uv).r;
          vec4 ink = texture2D(uInk, uv);

          if (ink.a < 0.002 || order < 0.001) discard;

          float feather = max(fwidth(order) * 1.1, 0.0024);
          float revealed = smoothstep(order, order + feather + 0.004, uWrite);

          // A tiny multi-tap blur makes the giant projection read as a soft
          // shadow rather than a second printed cover.
          vec2 px = vec2(1.0 / 2048.0);
          float softAlpha =
            ink.a * 0.58 +
            texture2D(uInk, uv + vec2(px.x, 0.0)).a * 0.1 +
            texture2D(uInk, uv - vec2(px.x, 0.0)).a * 0.1 +
            texture2D(uInk, uv + vec2(0.0, px.y)).a * 0.11 +
            texture2D(uInk, uv - vec2(0.0, px.y)).a * 0.11;

          float alpha = softAlpha * revealed * uOpacity;
          if (alpha < 0.0015) discard;

          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: window.THREE.FrontSide,
      toneMapped: false,
      extensions: { derivatives: true },
    });
  }

  function makeCanvasTexture(canvas) {
    const texture = new window.THREE.CanvasTexture(canvas);
    texture.encoding = window.THREE.sRGBEncoding;
    texture.wrapS = window.THREE.ClampToEdgeWrapping;
    texture.wrapT = window.THREE.ClampToEdgeWrapping;
    return texture;
  }

  function makeDiscTexture(coverImage) {
    const size = 1024;
    const center = size / 2;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    if (!ctx) return makeCanvasTexture(c);

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(center, center, 505, 0, Math.PI * 2);
    ctx.clip();

    // A picture disc: the actual supplied cover wraps the whole playing face.
    ctx.fillStyle = "#efe7dc";
    ctx.fillRect(0, 0, size, size);
    if (coverImage) {
      try {
        const iw = coverImage.width || coverImage.naturalWidth || 2048;
        const ih = coverImage.height || coverImage.naturalHeight || 2048;
        // Use the printed photograph inside the white Polaroid border, then
        // fill the circle edge-to-edge so no square border appears on the disc.
        const sourceX = iw * 0.08;
        const sourceY = ih * 0.08;
        const sourceW = iw * 0.84;
        const sourceH = ih * 0.73;
        const sourceAspect = sourceW / sourceH;
        const maxSize = size - 16;
        let drawH = maxSize;
        let drawW = drawH * sourceAspect;
        if (drawW < maxSize) {
          drawW = maxSize;
          drawH = drawW / sourceAspect;
        }
        ctx.filter = "saturate(1.08) contrast(1.03)";
        ctx.drawImage(
          coverImage,
          sourceX,
          sourceY,
          sourceW,
          sourceH,
          8 + (maxSize - drawW) / 2,
          8 + (maxSize - drawH) / 2,
          drawW,
          drawH
        );
        ctx.filter = "none";
      } catch (_) {
        /* The fallback paper colour is enough if the image is unavailable. */
      }
    }

    // Milky iridescence and a soft top-left studio reflection.
    const sheen = ctx.createLinearGradient(70, 30, 970, 1000);
    sheen.addColorStop(0, "rgba(255, 242, 220, 0.17)");
    sheen.addColorStop(0.24, "rgba(255, 255, 255, 0.025)");
    sheen.addColorStop(0.47, "rgba(174, 205, 233, 0.12)");
    sheen.addColorStop(0.7, "rgba(224, 191, 220, 0.1)");
    sheen.addColorStop(0.86, "rgba(255, 255, 255, 0.035)");
    sheen.addColorStop(1, "rgba(255, 246, 232, 0.1)");
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, size, size);

    ctx.globalCompositeOperation = "screen";
    const reflection = ctx.createRadialGradient(355, 290, 20, 355, 290, 590);
    reflection.addColorStop(0, "rgba(255, 255, 255, 0.15)");
    reflection.addColorStop(0.36, "rgba(255, 250, 241, 0.035)");
    reflection.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = reflection;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = "source-over";

    // Very fine pressing grooves; just enough to catch the eye when it turns.
    for (let radius = 84; radius < 472; radius += 13) {
      ctx.beginPath();
      ctx.arc(center, center, radius, 0, Math.PI * 2);
      ctx.strokeStyle = radius % 26 === 0 ? "rgba(255, 252, 245, 0.075)" : "rgba(35, 31, 29, 0.038)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // A pale rim against the tray.
    ctx.beginPath();
    ctx.arc(center, center, 492, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 250, 240, 0.68)";
    ctx.lineWidth = 15;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(center, center, 503, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(34, 32, 32, 0.42)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // The clear hub and the real hole in the middle.
    const hub = ctx.createRadialGradient(center - 12, center - 12, 4, center, center, 92);
    hub.addColorStop(0, "rgba(255, 253, 247, 0.94)");
    hub.addColorStop(0.32, "rgba(206, 203, 195, 0.82)");
    hub.addColorStop(0.62, "rgba(245, 242, 234, 0.62)");
    hub.addColorStop(1, "rgba(255, 255, 255, 0.08)");
    ctx.fillStyle = hub;
    ctx.beginPath();
    ctx.arc(center, center, 91, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(center, center, 83, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.66)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(center, center, 53, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(54, 50, 47, 0.3)";
    ctx.stroke();

    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(center, center, 27, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.arc(center, center, 30, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(231, 226, 216, 0.92)";
    ctx.lineWidth = 5;
    ctx.stroke();

    // A tiny printed catalogue mark near the edge.
    ctx.save();
    ctx.translate(center, 940);
    ctx.fillStyle = "rgba(247, 241, 231, 0.9)";
    ctx.font = "500 15px Jost, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("STYLE · TAYLOR SWIFT · 1989 (DELUXE) · 33⅓", 0, 0);
    ctx.restore();
    ctx.restore();

    return makeCanvasTexture(c);
  }

  function makeBookletTexture(cleanImage, fallbackImage) {
    const size = 1024;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    if (!ctx) return makeCanvasTexture(c);

    const paper = ctx.createLinearGradient(0, 0, size, size);
    paper.addColorStop(0, "#f6f0e7");
    paper.addColorStop(0.62, "#efe7dc");
    paper.addColorStop(1, "#e5dccf");
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, size, size);

    // A soft hinge shadow down the left side of the booklet page.
    const hinge = ctx.createLinearGradient(0, 0, 145, 0);
    hinge.addColorStop(0, "rgba(47, 41, 35, 0.2)");
    hinge.addColorStop(0.34, "rgba(47, 41, 35, 0.07)");
    hinge.addColorStop(1, "rgba(47, 41, 35, 0)");
    ctx.fillStyle = hinge;
    ctx.fillRect(0, 0, 150, size);

    // A tiny amount of paper grain keeps the inner page from feeling digital.
    for (let i = 0; i < 340; i += 1) {
      ctx.fillStyle =
        i % 3 === 0 ? "rgba(88, 76, 62, 0.025)" : "rgba(255, 255, 255, 0.045)";
      ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
    }

    const image = cleanImage || fallbackImage;
    const iw = image ? image.width || image.naturalWidth || 2048 : 0;
    const ih = image ? image.height || image.naturalHeight || 2048 : 0;
    const frameX = 146;
    const frameY = 96;
    const frameSize = 744;
    ctx.save();
    ctx.shadowColor = "rgba(46, 38, 31, 0.24)";
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 13;
    ctx.fillStyle = "#fffdf8";
    ctx.fillRect(frameX - 17, frameY - 17, frameSize + 34, frameSize + 34);
    ctx.restore();

    if (image && iw > 0 && ih > 0) {
      const crop = Math.min(iw, ih) * 0.76;
      const sx = (iw - crop) / 2;
      const sy = Math.max(0, ih * 0.045);
      try {
        ctx.drawImage(image, sx, sy, crop, crop, frameX, frameY, frameSize, frameSize);
      } catch (_) {
        /* Leave the matte empty if the image cannot be drawn. */
      }
    }

    ctx.strokeStyle = "rgba(42, 36, 32, 0.15)";
    ctx.lineWidth = 2;
    ctx.strokeRect(frameX, frameY, frameSize, frameSize);

    ctx.textAlign = "center";
    ctx.fillStyle = "#1c2535";
    ctx.font = "52px Italiana, Georgia, serif";
    ctx.fillText("STYLE", size / 2, 905);
    ctx.fillStyle = "rgba(36, 39, 47, 0.7)";
    ctx.font = "500 16px Jost, sans-serif";
    ctx.fillText("TAYLOR SWIFT  ·  1989 (DELUXE)  ·  SIDE A", size / 2, 938);
    ctx.strokeStyle = "rgba(36, 39, 47, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(318, 963);
    ctx.lineTo(706, 963);
    ctx.stroke();
    ctx.fillStyle = "rgba(36, 39, 47, 0.48)";
    ctx.font = "14px Jost, sans-serif";
    ctx.fillText("YOU GOT THAT JAMES DEAN DAY DREAM LOOK IN YOUR EYE", size / 2, 991);

    return makeCanvasTexture(c);
  }

  function makeTrayTexture() {
    const size = 1024;
    const center = size / 2;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    if (!ctx) return makeCanvasTexture(c);

    const paper = ctx.createRadialGradient(center - 40, center - 110, 20, center, center, 680);
    paper.addColorStop(0, "#f6f0e6");
    paper.addColorStop(0.62, "#ebe3d8");
    paper.addColorStop(1, "#d9d0c4");
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, size, size);

    ctx.save();
    ctx.beginPath();
    ctx.arc(center, center, 477, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(118, 108, 97, 0.08)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.52)";
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(center, center, 468, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(57, 51, 46, 0.16)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // The little retention bumps in the tray.
    for (let i = 0; i < 4; i += 1) {
      const angle = -0.7 + i * (Math.PI / 2);
      const x = center + Math.cos(angle) * 388;
      const y = center + Math.sin(angle) * 388;
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 252, 245, 0.58)";
      ctx.fill();
      ctx.strokeStyle = "rgba(40, 35, 31, 0.08)";
      ctx.stroke();
    }

    // The spindle that peeks through the centre hole of the disc.
    const spindle = ctx.createRadialGradient(center, center, 1, center, center, 58);
    spindle.addColorStop(0, "#faf7f0");
    spindle.addColorStop(0.38, "#d6d0c6");
    spindle.addColorStop(1, "rgba(217, 210, 199, 0)");
    ctx.fillStyle = spindle;
    ctx.beginPath();
    ctx.arc(center, center, 58, 0, Math.PI * 2);
    ctx.fill();

    // Faint print on the tray, mostly covered by the disc.
    ctx.fillStyle = "rgba(67, 56, 48, 0.28)";
    ctx.font = "500 15px Jost, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("CDV · 1989 · D.L.X.", center, 910);

    return makeCanvasTexture(c);
  }

  function makeSealTexture() {
    const w = 256;
    const h = 2048;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return makeCanvasTexture(c);

    const paper = ctx.createLinearGradient(0, 0, w, 0);
    paper.addColorStop(0, "#efe7da");
    paper.addColorStop(0.36, "#fbf6ed");
    paper.addColorStop(1, "#e5dacb");
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, w, h);

    // Fine vertical fibres.
    for (let i = 0; i < 420; i += 1) {
      ctx.fillStyle =
        i % 4 === 0 ? "rgba(85, 65, 47, 0.035)" : "rgba(255, 255, 255, 0.085)";
      ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1 + Math.random() * 4);
    }

    ctx.strokeStyle = "rgba(33, 42, 58, 0.2)";
    ctx.lineWidth = 3;
    ctx.strokeRect(12, 12, w - 24, h - 24);

    // A little printed de luxe stamp at the top.
    ctx.textAlign = "center";
    ctx.fillStyle = "#253044";
    ctx.font = "600 31px Jost, sans-serif";
    ctx.fillText("T.S.", w / 2, 82);
    ctx.fillStyle = "rgba(35, 44, 59, 0.5)";
    ctx.font = "500 15px Jost, sans-serif";
    ctx.fillText("D.L.X.", w / 2, 110);

    // The rust-red wax/foil dot.
    const stampY = 265;
    ctx.beginPath();
    ctx.arc(w / 2, stampY, 75, 0, Math.PI * 2);
    ctx.fillStyle = "#b5604b";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w / 2, stampY, 65, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(248, 235, 217, 0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(w / 2, stampY, 17, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(247, 235, 217, 0.88)";
    ctx.fill();
    ctx.fillStyle = "rgba(247, 235, 217, 0.92)";
    ctx.font = "600 16px Jost, sans-serif";
    ctx.fillText("1989", w / 2, stampY + 44);

    // The actual instruction, reading down the seal.
    ctx.save();
    ctx.translate(w / 2, 1040);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#202b3e";
    ctx.font = "700 92px Jost, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("OPEN", 0, 0);
    ctx.fillStyle = "rgba(35, 45, 61, 0.54)";
    ctx.font = "500 19px Jost, sans-serif";
    ctx.fillText("PRESS THE SEAL", 0, 48);
    ctx.restore();

    ctx.strokeStyle = "rgba(35, 44, 59, 0.25)";
    ctx.setLineDash([5, 10]);
    ctx.beginPath();
    ctx.moveTo(30, 1510);
    ctx.lineTo(w - 30, 1510);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(35, 44, 59, 0.58)";
    ctx.font = "500 14px Jost, sans-serif";
    ctx.fillText("STYLE", w / 2, 1580);
    ctx.fillStyle = "rgba(35, 44, 59, 0.34)";
    ctx.font = "500 12px Jost, sans-serif";
    ctx.fillText("33⅓ RPM · STEREO", w / 2, 1604);

    ctx.save();
    ctx.translate(w / 2, 1810);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "rgba(35, 44, 59, 0.36)";
    ctx.font = "500 16px Jost, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("OPEN CAREFULLY", 0, 0);
    ctx.restore();

    return makeCanvasTexture(c);
  }

  function createViewer(textures) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const THREE = window.THREE;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, width < 900 ? 1.4 : 1.6)
    );
    renderer.setSize(width, height, false);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 80);
    camera.position.set(0, 0, 3.0);
    camera.lookAt(0, 0, 0);

    const maxAnisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    textures.cover.anisotropy = maxAnisotropy;
    textures.clean.anisotropy = maxAnisotropy;
    textures.ink.anisotropy = maxAnisotropy;
    textures.writeMap.anisotropy = 1;

    const discTexture = makeDiscTexture(textures.cover.image);
    const trayTexture = makeTrayTexture();
    const bookletTexture = makeBookletTexture(textures.clean.image, textures.cover.image);
    const sealTexture = makeSealTexture();
    [discTexture, trayTexture, bookletTexture, sealTexture].forEach((texture) => {
      texture.anisotropy = maxAnisotropy;
    });

    // Lights are soft, warm and directional: the feeling of late-afternoon
    // light crawling across a paper sleeve.
    scene.add(new THREE.HemisphereLight(0xfff7ea, 0x6f7b89, 0.55));
    scene.add(new THREE.AmbientLight(0xfff8ee, 0.1));

    const keyLight = new THREE.DirectionalLight(0xfff1df, 1.45);
    keyLight.position.set(3.1, 3.8, 4.8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 14;
    keyLight.shadow.camera.left = -3.2;
    keyLight.shadow.camera.right = 3.2;
    keyLight.shadow.camera.top = 3.2;
    keyLight.shadow.camera.bottom = -3.2;
    keyLight.shadow.bias = -0.00025;
    keyLight.shadow.normalBias = 0.012;
    scene.add(keyLight);
    scene.add(keyLight.target);

    const fillLight = new THREE.DirectionalLight(0xbfd1e3, 0.34);
    fillLight.position.set(-4.2, 1.6, 2.8);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffd8b8, 0.55);
    rimLight.position.set(-1.4, 2.2, -4.2);
    scene.add(rimLight);

    // An invisible wall only exists to catch a quiet shadow behind the object.
    const shadowWall = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 8),
      new THREE.ShadowMaterial({ color: 0x29303c, opacity: 0.13 })
    );
    shadowWall.position.z = -0.82;
    shadowWall.receiveShadow = true;
    scene.add(shadowWall);

    // A giant, very quiet echo of the painted year sits behind the physical
    // sleeve. It uses the exact same ink and stroke-order map as the cover,
    // and is driven by the same writing progress.
    const GHOST_ASPECT = (1978 - 120) / (1500 - 560);
    const ghostMaterial = makeGhostMaterial(textures.ink, textures.writeMap);
    const ghostMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ghostMaterial);
    ghostMesh.position.z = -0.62;
    ghostMesh.renderOrder = -1;
    ghostMesh.frustumCulled = false;
    scene.add(ghostMesh);

    const albumRoot = new THREE.Group();
    scene.add(albumRoot);

    const swivel = new THREE.Group();
    albumRoot.add(swivel);

    const BASE_DEPTH = 0.05;
    const LID_DEPTH = 0.016;
    const LID_PIVOT_Z = 0.037;
    const OPEN_ANGLE = -2.02;
    const caseMaterial = new window.THREE.MeshPhysicalMaterial({
      color: 0xf4efe6,
      roughness: 0.46,
      metalness: 0,
      clearcoat: 0.38,
      clearcoatRoughness: 0.36,
    });

    const baseMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, BASE_DEPTH), caseMaterial);
    baseMesh.castShadow = true;
    baseMesh.receiveShadow = true;
    swivel.add(baseMesh);

    // The printed photograph stays unlit so it keeps the exact colours of the
    // supplied artwork while the white case catches the room's light.
    const backCover = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: textures.cover,
        toneMapped: false,
        side: THREE.FrontSide,
      })
    );
    backCover.rotation.y = Math.PI;
    backCover.position.z = -BASE_DEPTH / 2 - 0.0012;
    swivel.add(backCover);

    // The inside of the case: a printed tray and a very faint moulded rim.
    const trayMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.966, 0.966),
      new THREE.MeshBasicMaterial({ map: trayTexture, toneMapped: false })
    );
    trayMesh.position.z = BASE_DEPTH / 2 + 0.0008;
    swivel.add(trayMesh);

    const discGroup = new THREE.Group();
    discGroup.position.z = BASE_DEPTH / 2 + 0.0036;
    discGroup.visible = false;
    swivel.add(discGroup);

    const discMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.82, 0.82),
      new THREE.MeshBasicMaterial({
        map: discTexture,
        transparent: true,
        alphaTest: 0.02,
        toneMapped: false,
        side: THREE.FrontSide,
      })
    );
    discMesh.renderOrder = 1;
    discGroup.add(discMesh);

    // The lid is a separate thin panel hinged on the left. The cover and all
    // of its ink/veil layers move with it, revealing the disc underneath.
    const lidPivot = new THREE.Group();
    lidPivot.position.set(-0.5, 0, LID_PIVOT_Z);
    swivel.add(lidPivot);

    const lidMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, LID_DEPTH), caseMaterial);
    lidMesh.position.set(0.5, 0, 0);
    lidMesh.castShadow = true;
    lidMesh.receiveShadow = true;
    lidPivot.add(lidMesh);

    const frontCover = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: textures.cover,
        toneMapped: false,
        side: THREE.FrontSide,
      })
    );
    frontCover.position.set(0.5, 0, LID_DEPTH / 2 + 0.0012);
    lidPivot.add(frontCover);

    // A numberless print rests on top while the ink is being written. It
    // dissolves into the real cover as the photograph develops.
    const cleanCoverMaterial = new THREE.MeshBasicMaterial({
      map: textures.clean,
      transparent: true,
      opacity: 1,
      toneMapped: false,
      side: THREE.FrontSide,
      depthWrite: false,
    });
    const cleanCover = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cleanCoverMaterial);
    cleanCover.position.set(0.5, 0, LID_DEPTH / 2 + 0.002);
    cleanCover.renderOrder = 1;
    lidPivot.add(cleanCover);

    const veilTexture = createVeilTexture();
    veilTexture.anisotropy = maxAnisotropy;
    const veilMaterial = new THREE.MeshBasicMaterial({
      map: veilTexture,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    const veilMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), veilMaterial);
    veilMesh.position.set(0.5, 0, LID_DEPTH / 2 + 0.0025);
    veilMesh.renderOrder = 2;
    lidPivot.add(veilMesh);

    const inkMaterial = makeInkMaterial(textures.ink, textures.writeMap);
    const inkMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), inkMaterial);
    inkMesh.position.set(0.5, 0, LID_DEPTH / 2 + 0.0036);
    inkMesh.renderOrder = 3;
    lidPivot.add(inkMesh);

    // The booklet page on the inside of the lid. It faces the tray when the
    // case opens, and carries the same photograph in a quieter layout.
    const bookletMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.94, 0.94),
      new THREE.MeshBasicMaterial({ map: bookletTexture, toneMapped: false })
    );
    bookletMesh.rotation.y = Math.PI;
    bookletMesh.position.set(0.5, 0, -LID_DEPTH / 2 - 0.0009);
    lidPivot.add(bookletMesh);

    // A small, almost invisible spine highlight adds a tiny bit of weight
    // to the left edge when the sleeve is seen at an angle.
    const spine = new THREE.Mesh(
      new THREE.PlaneGeometry(0.012, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.15,
        depthWrite: false,
        toneMapped: false,
      })
    );
    spine.position.set(0.007, 0, LID_DEPTH / 2 + 0.0044);
    lidPivot.add(spine);

    // The paper band sealing the opening side. Its front strip is intentionally
    // readable in the normal three-quarter view, while a narrow side tab wraps
    // around the fore-edge. Both fade as the lid swings away.
    const sealMaterial = new THREE.MeshBasicMaterial({
      map: sealTexture,
      transparent: true,
      opacity: 1,
      toneMapped: false,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const sealGroup = new THREE.Group();
    lidPivot.add(sealGroup);

    const sealFront = new THREE.Mesh(new THREE.PlaneGeometry(0.062, 0.56), sealMaterial);
    sealFront.position.set(0.955, 0, LID_DEPTH / 2 + 0.0048);
    sealFront.renderOrder = 6;
    sealGroup.add(sealFront);

    const sealSide = new THREE.Mesh(new THREE.PlaneGeometry(0.034, 0.56), sealMaterial);
    sealSide.rotation.y = Math.PI / 2;
    sealSide.position.set(1.002, 0, 0);
    sealSide.renderOrder = 6;
    sealGroup.add(sealSide);

    const sealHitMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    });
    const sealHit = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.7, 0.17), sealHitMaterial);
    sealHit.position.set(0.955, 0, 0.003);
    lidPivot.add(sealHit);

    const caseState = {
      open: false,
      target: 0,
      progress: 0,
      discSpeed: 0,
    };
    const sealRaycaster = new THREE.Raycaster();
    const sealPointer = new THREE.Vector2();
    const sealWorld = new THREE.Vector3();
    const sealNormal = new THREE.Vector3();
    const sealToCamera = new THREE.Vector3();
    const sealQuaternion = new THREE.Quaternion();

    // Dust. Camera-facing, nearly transparent, and only there when the light
    // catches it. It gives the empty air a little depth.
    const dustTexture = makeDustTexture();
    const dustGeometry = new THREE.BufferGeometry();
    const dustCount = 46;
    const dustPositions = new Float32Array(dustCount * 3);
    const dustPhase = new Float32Array(dustCount);
    for (let i = 0; i < dustCount; i += 1) {
      dustPositions[i * 3] = (Math.random() - 0.5) * 3.6;
      dustPositions[i * 3 + 1] = (Math.random() - 0.5) * 2.0;
      dustPositions[i * 3 + 2] = -0.55 + Math.random() * 1.1;
      dustPhase[i] = Math.random() * Math.PI * 2;
    }
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
    dustGeometry.userData.phase = dustPhase;
    dustGeometry.userData.basePositions = dustPositions.slice();
    const dustMaterial = new THREE.PointsMaterial({
      size: 0.014,
      map: dustTexture,
      color: 0x5b5a58,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.NormalBlending,
    });
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    scene.add(dust);

    const layout = {
      mobile: mobileMedia.matches,
      scale: 1,
      offsetY: 0,
      baseX: 0,
      baseY: 0,
      stageX: 0.5,
      stageY: 0.5,
      visibleWidth: 1,
      visibleHeight: 1,
    };

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, w < 900 ? 1.4 : 1.6);
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();

      layout.mobile = mobileMedia.matches;
      const landscapeCompact = compactLandscapeMedia.matches;
      if (landscapeCompact) layout.mobile = false;
      const stageX = layout.mobile ? 0.5 : landscapeCompact ? 0.64 : 0.655;
      const stageY = layout.mobile ? 0.33 : landscapeCompact ? 0.5 : 0.49;
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      const visibleHeight = 2 * Math.tan(vFov / 2) * camera.position.z;
      const visibleWidth = visibleHeight * camera.aspect;

      layout.stageX = stageX;
      layout.stageY = stageY;
      layout.visibleWidth = visibleWidth;
      layout.visibleHeight = visibleHeight;

      // Scale the background projection against the viewport at its own
      // depth: it is wider than the sleeve and deliberately very faint.
      const ghostDistance = camera.position.z - ghostMesh.position.z;
      const ghostVisibleHeight = 2 * Math.tan(vFov / 2) * ghostDistance;
      const ghostVisibleWidth = ghostVisibleHeight * camera.aspect;
      const ghostWidth = ghostVisibleWidth * (layout.mobile ? 0.94 : 0.92);
      const ghostCenterY = layout.mobile ? 0.55 : 0.53;
      ghostMesh.scale.set(ghostWidth, ghostWidth / GHOST_ASPECT, 1);
      ghostMesh.position.x = 0;
      ghostMesh.position.y = (0.5 - ghostCenterY) * ghostVisibleHeight;
      ghostMaterial.uniforms.uOpacity.value = layout.mobile ? 0.068 : 0.075;

      // Keep the sleeve generously sized but never let it crowd the copy.
      if (layout.mobile) {
        layout.scale = Math.min(visibleHeight * 0.53, visibleWidth * 0.79);
      } else if (landscapeCompact) {
        layout.scale = Math.min(visibleHeight * 0.68, visibleWidth * 0.38);
      } else {
        layout.scale = Math.min(visibleHeight * 0.65, visibleWidth * 0.42);
      }
      layout.offsetY = (0.5 - layout.stageY) * visibleHeight;
      layout.baseX = (stageX - 0.5) * visibleWidth;
      layout.baseY = layout.offsetY;

      albumRoot.position.x = layout.baseX;
      albumRoot.position.y = layout.baseY;
      albumRoot.scale.setScalar(layout.scale);

      keyLight.position.x = albumRoot.position.x + 3.1;
      keyLight.position.y = albumRoot.position.y + 3.8;
      keyLight.target.position.set(albumRoot.position.x, albumRoot.position.y, 0);
      keyLight.target.updateMatrixWorld();

      dust.position.x = albumRoot.position.x * 0.4;
      dust.position.y = albumRoot.position.y * 0.4;

      document.documentElement.style.setProperty("--stage-x", `${stageX * 100}%`);
      document.documentElement.style.setProperty("--stage-y", `${stageY * 100}%`);
    }

    resize();

    const uniforms = inkMaterial.uniforms;

    function openCase() {
      if (caseState.open) return false;
      caseState.open = true;
      caseState.target = 1;
      return true;
    }

    function closeCase() {
      if (!caseState.open) return false;
      caseState.open = false;
      caseState.target = 0;
      return true;
    }

    function isCaseOpen() {
      return caseState.open;
    }

    function hitSeal(clientX, clientY) {
      if (caseState.open || caseState.progress > 0.02) return false;

      // Do not let a tap pass through the back of a flipped sleeve. The seal
      // only exists on the printed front of the lid.
      sealHit.getWorldPosition(sealWorld);
      lidPivot.getWorldQuaternion(sealQuaternion);
      sealNormal.set(0, 0, 1).applyQuaternion(sealQuaternion).normalize();
      sealToCamera.copy(camera.position).sub(sealWorld).normalize();
      if (sealNormal.dot(sealToCamera) < 0.08) return false;

      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      sealPointer.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      sealRaycaster.setFromCamera(sealPointer, camera);
      return sealRaycaster.intersectObject(sealHit, false).length > 0;
    }

    function updateCase(dt) {
      if (prefersReducedMotion) {
        caseState.progress = caseState.target;
      } else {
        const follow = 1 - Math.exp(-3.55 * Math.max(0, dt));
        caseState.progress += (caseState.target - caseState.progress) * follow;
        if (Math.abs(caseState.target - caseState.progress) < 0.0008) {
          caseState.progress = caseState.target;
        }
      }

      const progress = caseState.progress;
      lidPivot.rotation.y = OPEN_ANGLE * progress;

      const sealOpacity = 1 - smoothstep(clamp(progress / 0.19, 0, 1));
      sealMaterial.opacity = sealOpacity;
      sealGroup.visible = sealOpacity > 0.004;

      discGroup.visible = progress > 0.004;
      const discTarget =
        !prefersReducedMotion && lyricPlayback.playing && progress > 0.2 ? 1.55 : 0;
      caseState.discSpeed = damp(caseState.discSpeed, discTarget, 2.7, Math.max(0.0001, dt));
      if (Math.abs(caseState.discSpeed) > 0.0004) {
        discGroup.rotation.z += caseState.discSpeed * dt;
      }
    }

    return {
      renderer,
      scene,
      camera,
      albumRoot,
      swivel,
      lidPivot,
      discGroup,
      sealGroup,
      sealHit,
      caseState,
      veilMaterial,
      cleanCoverMaterial,
      cleanCover,
      inkMesh,
      veilMesh,
      inkMaterial,
      uniforms,
      ghostMaterial,
      ghostMesh,
      layout,
      resize,
      openCase,
      closeCase,
      isCaseOpen,
      hitSeal,
      updateCase,
      getCaseProgress() {
        return caseState.progress;
      },
      resetWriting() {
        uniforms.uWrite.value = 0;
        uniforms.uOpacity.value = 1;
        cleanCoverMaterial.opacity = 1;
        cleanCover.visible = true;
        veilMaterial.opacity = 0.86;
        inkMesh.visible = true;
        veilMesh.visible = true;
      },
    };
  }

  function makeDustTexture() {
    const THREE = window.THREE;
    const size = 64;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.72)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(c);
    texture.encoding = THREE.LinearEncoding;
    return texture;
  }

  /* -----------------------------------------------------------------------
     Main animation loop
     ----------------------------------------------------------------------- */

  function updateSpin(dt) {
    if (prefersReducedMotion) {
      interaction.velocityX = 0;
      interaction.velocityY = 0;
      interaction.currentY = interaction.targetY;
      interaction.currentX = interaction.targetX;
      return;
    }
    if (!interaction.dragging) {
      // Let a flick carry a little further, then let the sleeve settle.
      interaction.targetY += interaction.velocityY * dt * 0.52;
      interaction.targetX = clamp(interaction.targetX + interaction.velocityX * dt * 0.32, -0.52, 0.52);
      interaction.velocityY *= Math.exp(-dt * 3.4);
      interaction.velocityX *= Math.exp(-dt * 4.0);
      if (Math.abs(interaction.velocityY) < 0.002) interaction.velocityY = 0;
      if (Math.abs(interaction.velocityX) < 0.002) interaction.velocityX = 0;
    }

    interaction.currentY = damp(interaction.currentY, interaction.targetY, 7.5, dt);
    interaction.currentX = damp(interaction.currentX, interaction.targetX, 8.5, dt);
  }

  function updateExperience(dt, elapsed) {
    if (!viewer) return;

    const v = viewer;
    const intro = prefersReducedMotion
      ? 1
      : smoothstep(clamp(elapsed / TIMING.introDuration, 0, 1));
    const write = prefersReducedMotion
      ? 1
      : clamp((elapsed - TIMING.writeStart) / TIMING.writeDuration, 0, 1);
    const develop = prefersReducedMotion
      ? 1
      : smoothstep(clamp((elapsed - TIMING.developStart) / TIMING.developDuration, 0, 1));
    const complete = prefersReducedMotion || elapsed >= TIMING.complete;

    let phase = "intro";
    if (complete) phase = "complete";
    else if (elapsed >= TIMING.developStart) phase = "developing";
    else if (elapsed >= TIMING.writeStart) phase = "writing";
    setPhase(phase);

    // While the ink is going down, the printed photograph is still milky;
    // the numberless plate beneath the veil keeps the un-written 1989 from
    // showing through too early. The exact cover develops after the final stroke.
    const writingVeil = 0.84 - intro * 0.032 - write * 0.014;
    const veil = prefersReducedMotion ? 0 : writingVeil * (1 - develop);
    v.veilMaterial.opacity = veil;
    v.veilMesh.visible = veil > 0.002;

    const cleanFade = prefersReducedMotion ? 1 : smoothstep(clamp(develop / 0.82, 0, 1));
    v.cleanCoverMaterial.opacity = 1 - cleanFade;
    v.cleanCover.visible = cleanFade < 0.999;

    v.uniforms.uWrite.value = write;
    if (v.ghostMaterial) {
      const ghostBaseOpacity = v.layout.mobile ? 0.068 : 0.075;
      v.ghostMaterial.uniforms.uWrite.value = write;
      // The projection is strongest while the hand is writing. As the
      // Polaroid develops, it recedes into a faint watermark behind the page.
      const ghostOpacity = ghostBaseOpacity * (1 - develop * 0.68);
      v.ghostMaterial.uniforms.uOpacity.value = ghostOpacity;
      // Once it is only a few percent visible, stop paying for a full-screen
      // transparent pass on every frame.
      v.ghostMesh.visible = ghostOpacity > 0.032;
    }
    v.uniforms.uOpacity.value = 1 - smoothstep(clamp((develop - 0.58) / 0.42, 0, 1));
    v.inkMesh.visible = v.uniforms.uOpacity.value > 0.002;
    v.veilMesh.visible = veil > 0.002;

    updateSpin(dt);
    v.updateCase(dt);
    const caseProgress = v.getCaseProgress();
    interaction.smoothPointerX = damp(interaction.smoothPointerX, interaction.pointerX, 3.2, dt);
    interaction.smoothPointerY = damp(interaction.smoothPointerY, interaction.pointerY, 3.2, dt);

    const introX = lerp(0.19, 0.018, intro);
    const introY = lerp(-0.62, -0.075, intro);
    const settleX = develop * 0.018;
    const settleY = develop * -0.085;
    const motionTime = prefersReducedMotion ? 0 : elapsed;
    const idleX = prefersReducedMotion ? 0 : Math.cos(motionTime * 0.33) * 0.009;
    const idleY = prefersReducedMotion ? 0 : Math.sin(motionTime * 0.27 + 0.4) * 0.012;
    const parallaxX = prefersReducedMotion ? 0 : interaction.smoothPointerY * 0.024;
    const parallaxY = prefersReducedMotion ? 0 : interaction.smoothPointerX * 0.038;
    const targetRotX = introX + settleX + idleX + parallaxX + interaction.currentX;
    const targetRotY =
      introY + settleY + idleY + parallaxY + interaction.currentY + caseProgress * 0.045;

    if (prefersReducedMotion) {
      v.swivel.rotation.set(targetRotX, targetRotY, 0);
    } else {
      v.swivel.rotation.x = damp(v.swivel.rotation.x, targetRotX, 4.5, dt);
      v.swivel.rotation.y = damp(v.swivel.rotation.y, targetRotY, 5.0, dt);
      v.swivel.rotation.z = damp(v.swivel.rotation.z, Math.sin(elapsed * 0.24 + 1.2) * 0.006, 4.0, dt);
    }

    const introScale = 0.9 + easeOutCubic(intro) * 0.1;
    const openedScaleLoss = v.layout.mobile ? (state.compact ? 0.32 : 0.42) : 0.22;
    const openedShiftFactor = v.layout.mobile ? (state.compact ? 0.19 : 0.2) : 0.075;
    const openedScale = 1 - caseProgress * openedScaleLoss;
    const openedShift = v.layout.visibleWidth * openedShiftFactor * caseProgress;
    v.albumRoot.scale.setScalar(v.layout.scale * introScale * openedScale);
    v.albumRoot.position.x = v.layout.baseX + openedShift;
    v.albumRoot.position.y = v.layout.baseY;
    v.swivel.position.y = prefersReducedMotion
      ? 0
      : (1 - intro) * -0.055 + Math.sin(elapsed * 0.58) * 0.0055;
    v.swivel.position.z = prefersReducedMotion ? 0 : (1 - intro) * -0.2;

    // The dust barely moves, but it keeps the air from feeling frozen.
    const dust = v.scene.children.find((child) => child.isPoints);
    if (dust) {
      dust.visible = !prefersReducedMotion;
      if (!prefersReducedMotion) {
        const base = dust.geometry.userData.basePositions;
        const phase = dust.geometry.userData.phase;
        const position = dust.geometry.attributes.position.array;
        for (let i = 0; i < phase.length; i += 1) {
          position[i * 3] = base[i * 3] + Math.sin(elapsed * 0.12 + phase[i]) * 0.035;
          position[i * 3 + 1] = base[i * 3 + 1] + Math.cos(elapsed * 0.1 + phase[i]) * 0.03;
        }
        dust.geometry.attributes.position.needsUpdate = true;
        dust.rotation.z = Math.sin(elapsed * 0.035) * 0.012;
      }
    }

    // A minute bloom lifts the photograph as it develops.
    v.renderer.toneMappingExposure = 1.06 + develop * 0.035;
  }

  function animate(now) {
    const v = viewer;
    if (!v) return;

    const rawDt = state.lastFrame ? (now - state.lastFrame) / 1000 : 1 / 60;
    state.lastFrame = now;
    const dt = Math.min(Math.max(rawDt, 0.0001), 0.05);

    if (state.forcedTime !== null) {
      state.clock = state.forcedTime;
    } else if (!prefersReducedMotion) {
      state.clock += dt;
    }

    updateExperience(dt, state.clock);
    v.renderer.render(v.scene, v.camera);
    loopId = window.requestAnimationFrame(animate);
  }

  /* -----------------------------------------------------------------------
     Boot
     ----------------------------------------------------------------------- */

  function startExperience() {
    body.classList.add("is-ready");
    loader.setAttribute("aria-hidden", "true");
    state.started = true;
    state.ready = true;
    state.lastFrame = performance.now();
    state.phase = "";
    statusText.textContent = phaseLabel("intro");

    if (prefersReducedMotion) {
      state.clock = TIMING.complete + 0.1;
    } else if (state.forcedTime !== null) {
      state.clock = state.forcedTime;
    } else {
      state.clock = 0;
    }

    if (viewer && viewer.layout) {
      viewer.resize();
    }
    window.cancelAnimationFrame(loopId);
    loopId = window.requestAnimationFrame((time) => {
      state.lastFrame = time;
      animate(time);
    });
  }

  function showFallback(error) {
    console.error("[1989] Unable to start the interactive scene:", error);
    body.classList.add("is-ready", "webgl-fallback");
    loader.setAttribute("aria-hidden", "true");
    if (fallback) fallback.hidden = false;
    if (statusText) statusText.textContent = "THE CASE IS RESTING";
    if (flipButton) flipButton.disabled = true;
    if (replayButton) replayButton.style.display = "none";
  }

  async function boot() {
    try {
      if (!window.THREE) throw new Error("Three.js did not load.");
      if (!window.ALBUM_TEXTURES) throw new Error("The embedded cover textures did not load.");
      setupInput();

      const startedAt = performance.now();
      const fontReady =
        document.fonts && document.fonts.ready
          ? Promise.race([document.fonts.ready, wait(1600)])
          : Promise.resolve();
      const [textures] = await Promise.all([loadAllTextures(), fontReady]);

      viewer = createViewer(textures);
      window.__ALBUM_VIEWER__ = viewer;
      window.__ALBUM_STATE__ = { state, interaction, TIMING };

      if (debugFlip) {
        interaction.targetY = Math.PI;
        interaction.currentY = Math.PI;
      }

      // Make sure the loader has the tiniest moment to breathe before the
      // cover fades in. The pause also lets the display font settle.
      const requiredWait = prefersReducedMotion || debugTime !== null ? 80 : 250;
      const remaining = Math.max(0, requiredWait - (performance.now() - startedAt));
      if (remaining > 0) await wait(remaining);

      window.addEventListener("resize", () => {
        if (viewer && viewer.resize) viewer.resize();
      });

      startExperience();
    } catch (error) {
      showFallback(error);
    }
  }

  // Set initial no-JS-independent UI state.
  if (replayButton) replayButton.setAttribute("aria-hidden", "false");
  setupLyricsExperience();
  boot();
})();
