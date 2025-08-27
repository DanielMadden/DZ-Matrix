import * as React from "react";
import { addPropertyControls, ControlType } from "framer";

type Props = {
  background: string;
};

export default function MatrixCanvas({ background }: Props) {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const rafRef = React.useRef<number | null>(null);

  // --- tunables ---
  const CELL = 20; // grid cell size in CSS px
  const DECAY = 0.9; // 0.88..0.97 (higher = longer trails)
  const THRESH = 0.02;
  const SPEED_MS = 50; // ~20 FPS feel; you can also go full rAF if you want
  const SVG_PROB = 0.01;
  const INTENSITY_TEXT = 0.5;
  const INTENSITY_SVG = 5;
  const FLICKER_CHANCE = 0.0; // e.g., 0.003 for subtle shimmer

  // character pool (weighted)
  const POOL =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@#$%^&*()_+-=[]{}|;:',.<>/?~`";
  const WEIGHTED_POOL = React.useMemo(
    () => POOL + "000111ZZZZZZZZZZZZZZZZZZzzzzzzzzzzzzzzzzzz",
    []
  );
  const randCharCode = React.useCallback(
    () => WEIGHTED_POOL.charCodeAt((Math.random() * WEIGHTED_POOL.length) | 0),
    [WEIGHTED_POOL]
  );

  // state that rebuilds with size
  const stateRef = React.useRef<{
    COLS: number;
    ROWS: number;
    N: number;
    ypos: number[];
    intensity: Float32Array;
    glyphCode: Uint16Array;
    cellType: Uint8Array; // 0=empty 1=text 2=svg
    headNow: Uint8Array;
    DPR: number;
    lastTick: number;
  } | null>(null);

  // --- optional SVG: paste your SVG string below (leave empty to skip) ---
  const RAW_SVG = `<svg width="625" height="660" viewBox="0 0 625 660" xmlns="http://www.w3.org/2000/svg">
          <path d="M611.209 102.718C566.558 103.637 521.844 104.368 478.259 104.89H475.164L503.419 0H428.4L400.02 105.412H378.751C373.794 105.412 367.102 105.412 358.527 105.308L355.432 105.203L383.812 0H308.794L280.686 104.284L179.901 102.634L165.22 109.84L157.544 140.856C149.409 171.057 138.91 203.911 126.529 238.54L121.719 251.928H187.953L204.935 212.265C216.647 186.701 221.374 181.249 222.168 180.435C223.821 179.098 227.501 176.822 236.139 175.589C239.485 175.067 246.136 174.461 258.642 173.939L261.947 173.835L220.579 327.264L178.166 364.775C116.344 419.079 61.9261 465.237 16.271 502.018L13.3012 504.482L0 554.149L160.64 550.035L130.984 659.979H206.002L235.512 550.661H237.687C249.336 550.87 262.302 551.184 276.733 551.392L279.828 551.497L250.59 660H325.609L354.428 552.833L415.225 553.857H493.129L505.761 542.223L506.702 539.237C522.743 484.62 539.161 437.333 555.453 398.799L561.35 384.784H492.627L479.347 416.886C459.541 463.775 448.75 471.712 445.864 473.049C442.977 474.281 430.576 477.372 377.642 478.709L374.443 478.813L417.4 319.097L418.069 318.471C477.736 265.504 541.858 209.55 608.741 152.259L611.502 149.899L624.322 102.404L611.209 102.718ZM299.278 479.44H241.096L256.844 464.799C275.018 447.902 293.527 430.901 312.14 413.795L318.456 408.03L299.278 479.44ZM380.905 183.087C363.191 199.378 344.703 216.171 325.776 233.381L319.481 239.041L337.195 172.999H391.885L380.905 183.087Z" fill="white"/>
        </svg>`; // <-- paste your <svg>...</svg> here (string). Leave empty to disable SVGs.

  const svgImgRef = React.useRef<HTMLImageElement | null>(null);
  React.useEffect(() => {
    if (!RAW_SVG) {
      svgImgRef.current = null;
      return;
    }
    const blob = new Blob([RAW_SVG], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      svgImgRef.current = img;
    };
    img.src = url;
    return () => {
      svgImgRef.current = null;
    };
  }, [RAW_SVG]);

  // rebuild grid (size, DPR, buffers)
  const rebuild = React.useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    // figure CSS size
    const w = Math.max(1, wrap.clientWidth);
    const h = Math.max(1, wrap.clientHeight);

    // DPR policy: real DPR but capped for perf
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    // lock CSS size and set backing buffer
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);

    // draw in CSS px
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = true;

    // grid
    const COLS = Math.ceil(w / CELL);
    const ROWS = Math.ceil(h / CELL);
    const N = COLS * ROWS;

    // (re)alloc state
    const intensity = new Float32Array(N);
    const glyphCode = new Uint16Array(N);
    const cellType = new Uint8Array(N);
    const headNow = new Uint8Array(N);
    const ypos = new Array(COLS).fill(0);

    // init background
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);

    stateRef.current = {
      COLS,
      ROWS,
      N,
      ypos,
      intensity,
      glyphCode,
      cellType,
      headNow,
      DPR,
      lastTick: performance.now(),
    };
  }, [CELL, background]);

  // main draw loop
  const loop = React.useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const s = stateRef.current;
    if (!canvas || !wrap || !s) return;
    const ctx = canvas.getContext("2d")!;
    const { COLS, ROWS, N, ypos, intensity, glyphCode, cellType, headNow } = s;

    // tick pacing using SPEED_MS (on top of rAF)
    const now = performance.now();
    if (now - s.lastTick < SPEED_MS) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }
    s.lastTick = now;

    const idx = (c: number, r: number) => r * COLS + c;

    // 1) advance heads + stamp cells
    headNow.fill(0);
    for (let c = 0; c < COLS; c++) {
      const y = ypos[c];
      const r = (y / CELL) | 0;
      if (r >= 0 && r < ROWS) {
        const k = idx(c, r);
        headNow[k] = 1;
        if (svgImgRef.current && Math.random() < SVG_PROB) {
          cellType[k] = 2;
          intensity[k] = INTENSITY_SVG;
        } else {
          cellType[k] = 1;
          intensity[k] = INTENSITY_TEXT;
          glyphCode[k] = randCharCode();
        }
      }
      // move stream; compare to CSS height (wrap.clientHeight)
      if (y >= wrap.clientHeight && Math.random() > 0.975) ypos[c] = 0;
      else ypos[c] = y + CELL;
    }

    // 2) decay + cull
    for (let k = 0; k < N; k++) {
      const a = intensity[k];
      if (a > 0) {
        intensity[k] = a * DECAY;
        if (
          FLICKER_CHANCE &&
          intensity[k] > 0.1 &&
          cellType[k] === 1 &&
          Math.random() < FLICKER_CHANCE
        ) {
          intensity[k] = INTENSITY_TEXT;
        }
        if (intensity[k] < THRESH) {
          intensity[k] = 0;
          cellType[k] = 0;
        }
      }
    }

    // 3) redraw frame from state
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, wrap.clientWidth, wrap.clientHeight);

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // NOTE: font size based on CELL (roomy look). Poppins 300 matches your style.
    ctx.font = `${Math.round(CELL * 0.5)}px 'Poppins', sans-serif`;

    for (let r = 0; r < ROWS; r++) {
      const y = r * CELL;
      for (let c = 0; c < COLS; c++) {
        const k = idx(c, r);
        const a = intensity[k];
        if (a < THRESH) continue;
        const cx = c * CELL + CELL / 2;
        const alpha = headNow[k] ? 0.9 : a;

        if (cellType[k] === 2 && svgImgRef.current) {
          // SVG hero glyph (scaled to ~2/3 cell width)
          const w = CELL * (2 / 3);
          const h = (svgImgRef.current.height / svgImgRef.current.width) * w;
          ctx.globalAlpha = Math.min(1, alpha);
          ctx.drawImage(svgImgRef.current, cx - w / 2, y, w, h);
        } else if (cellType[k] === 1) {
          // text glyph
          ctx.globalAlpha = alpha;
          ctx.fillStyle = "#e9e9e9";
          ctx.fillText(String.fromCharCode(glyphCode[k]), cx, y);
        }
      }
    }

    ctx.globalAlpha = 1;
    rafRef.current = requestAnimationFrame(loop);
  }, [
    DECAY,
    THRESH,
    SPEED_MS,
    CELL,
    INTENSITY_TEXT,
    INTENSITY_SVG,
    SVG_PROB,
    FLICKER_CHANCE,
    background,
    randCharCode,
  ]);

  // setup & teardown
  React.useEffect(() => {
    rebuild();
    const ro = new ResizeObserver(() => rebuild());
    if (wrapRef.current) ro.observe(wrapRef.current);

    // start loop
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [rebuild, loop]);

  return (
    <div
      ref={wrapRef}
      style={{
        width: "100%",
        height: "100%",
        background, // also paint behind canvas so transparent holes match
        position: "relative",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
    </div>
  );
}

// Framer control: Background color (hex or rgba string both work)
addPropertyControls(MatrixCanvas, {
  background: {
    title: "Background",
    type: ControlType.Color,
    defaultValue: "#0b0b0b",
  },
});
