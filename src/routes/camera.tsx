import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Sheet Camera — keeps the webcam on and, whenever someone edits the order
 * sheet, takes a photo and sends it to the sheet's Apps Script, which saves it
 * to Drive and puts the link in column N of the edited row.
 *
 * The camera cannot live inside Google Sheets (Google blocks camera access in
 * sheet popups/sidebars), so this page runs in its own tab/window next to the
 * sheet. It only takes photos while this page is open and the camera is on.
 */

export const Route = createFileRoute("/camera")({
  head: () => ({ meta: [{ title: "Sheet Camera" }] }),
  component: CameraPage,
});

const CFG_KEY = "bakery_sheet_camera_cfg_v1";
const POLL_MS = 2000;

type Cfg = { monWedUrl: string; thuSatUrl: string; token: string; email: string };
const EMPTY_CFG: Cfg = { monWedUrl: "", thuSatUrl: "", token: "", email: "" };

type LogLine = { t: string; msg: string; ok: boolean };

function loadCfg(): Cfg {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return { ...EMPTY_CFG, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return EMPTY_CFG;
}

function nowLabel() {
  return new Date().toLocaleTimeString("en-ZA", { hour12: false });
}

function CameraPage() {
  const [cfg, setCfg] = useState<Cfg>(EMPTY_CFG);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [camError, setCamError] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [photoCount, setPhotoCount] = useState(0);
  const [lastPhotoAt, setLastPhotoAt] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cfgRef = useRef<Cfg>(EMPTY_CFG);
  const busyRef = useRef(false);
  const camOnRef = useRef(false);

  const addLog = useCallback((msg: string, ok = true) => {
    setLog((prev) => [{ t: nowLabel(), msg, ok }, ...prev].slice(0, 12));
  }, []);

  // Load saved settings once (client only).
  useEffect(() => {
    const c = loadCfg();
    setCfg(c);
    cfgRef.current = c;
    setShowSettings(!(c.token && (c.monWedUrl || c.thuSatUrl)));
    setCfgLoaded(true);
  }, []);

  const saveCfg = (next: Cfg) => {
    const clean: Cfg = {
      monWedUrl: next.monWedUrl.trim(),
      thuSatUrl: next.thuSatUrl.trim(),
      token: next.token.trim(),
      email: next.email.trim(),
    };
    setCfg(clean);
    cfgRef.current = clean;
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(clean));
    } catch {
      /* ignore */
    }
  };

  const startCamera = useCallback(async () => {
    setCamError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser can't use the camera on this page (needs https).");
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        camOnRef.current = false;
        setCamOn(false);
        setCamError("The camera was switched off. Click “Turn camera on”.");
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      camOnRef.current = true;
      setCamOn(true);
      addLog("Camera is ON and watching the sheet.");
    } catch (e: any) {
      camOnRef.current = false;
      setCamOn(false);
      const name = e?.name || "";
      setCamError(
        name === "NotAllowedError"
          ? "Camera permission was blocked. Click the camera/lock icon in the address bar, choose Allow, then click “Turn camera on” again."
          : name === "NotFoundError"
            ? "No camera was found on this computer."
            : e?.message || "Could not start the camera.",
      );
    }
  }, [addLog]);

  // Auto-start the camera if permission was already granted before.
  useEffect(() => {
    if (!cfgLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const perm = await (navigator as any).permissions?.query({ name: "camera" });
        if (!cancelled && perm?.state === "granted") startCamera();
      } catch {
        /* permission query unsupported — user clicks the button */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfgLoaded, startCamera]);

  // Turn the camera off when leaving the page.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const grabJpeg = useCallback(async (): Promise<string | null> => {
    const stream = streamRef.current;
    const track = stream?.getVideoTracks()[0];
    if (!track || track.readyState !== "live") return null;

    let source: CanvasImageSource | null = null;
    let w = 0;
    let h = 0;
    try {
      const IC = (window as any).ImageCapture;
      if (IC) {
        const bmp: ImageBitmap = await new IC(track).grabFrame();
        source = bmp;
        w = bmp.width;
        h = bmp.height;
      }
    } catch {
      source = null;
    }
    if (!source) {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !v.videoWidth) return null;
      source = v;
      w = v.videoWidth;
      h = v.videoHeight;
    }
    const scale = Math.min(1, 640 / w);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  }, []);

  const callScript = useCallback(async (url: string, params: Record<string, string>) => {
    const u = new URL(url);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u.toString(), { method: "GET", redirect: "follow" });
    return res.json();
  }, []);

  const postScript = useCallback(async (url: string, body: Record<string, unknown>) => {
    // text/plain keeps this a "simple" request (no CORS preflight) — Apps Script needs that.
    const res = await fetch(url, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    return res.json();
  }, []);

  const pollOnce = useCallback(async () => {
    if (busyRef.current || !camOnRef.current) return;
    const c = cfgRef.current;
    if (!c.token) return;
    const urls = [c.monWedUrl, c.thuSatUrl].filter(Boolean);
    if (urls.length === 0) return;
    busyRef.current = true;
    try {
      for (const url of urls) {
        let took: any;
        try {
          took = await callScript(url, { action: "take", token: c.token, email: c.email });
        } catch (e: any) {
          addLog("Could not reach the sheet script (" + (e?.message || "network") + ")", false);
          continue;
        }
        if (!took?.ok) {
          addLog("Sheet script said: " + (took?.error || "unknown error"), false);
          continue;
        }
        if (!took.item) continue; // nothing to photograph

        const image = await grabJpeg();
        if (!image) {
          addLog("Change seen but the camera frame wasn't ready — no photo taken.", false);
          continue;
        }
        try {
          const up = await postScript(url, {
            action: "upload",
            token: c.token,
            id: took.item.id,
            image,
            email: c.email,
          });
          if (up?.ok) {
            setPhotoCount((n) => n + 1);
            setLastPhotoAt(nowLabel());
            addLog(
              "📷 Photo taken for " +
                (took.item.rows?.length || 1) +
                " changed row(s) — link added in column N.",
            );
          } else {
            addLog("Photo upload failed: " + (up?.error || "unknown"), false);
          }
        } catch (e: any) {
          addLog("Photo upload failed (" + (e?.message || "network") + ")", false);
        }
      }
    } finally {
      busyRef.current = false;
    }
  }, [addLog, callScript, grabJpeg, postScript]);

  // Poll on a Web Worker timer — unlike setInterval on the page, it isn't
  // slowed down to once-a-minute when this window is behind the sheet.
  useEffect(() => {
    let worker: Worker | null = null;
    let fallback: ReturnType<typeof setInterval> | null = null;
    try {
      const code = `setInterval(function(){ postMessage(1); }, ${POLL_MS});`;
      const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
      worker = new Worker(url);
      worker.onmessage = () => {
        void pollOnce();
      };
    } catch {
      fallback = setInterval(() => void pollOnce(), POLL_MS);
    }
    return () => {
      worker?.terminate();
      if (fallback) clearInterval(fallback);
    };
  }, [pollOnce]);

  // Ask the browser to keep the screen/tab awake while watching.
  useEffect(() => {
    if (!camOn) return;
    let lock: any = null;
    const get = async () => {
      try {
        lock = await (navigator as any).wakeLock?.request("screen");
      } catch {
        /* ignore */
      }
    };
    void get();
    const onVis = () => {
      if (document.visibilityState === "visible") void get();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try {
        lock?.release();
      } catch {
        /* ignore */
      }
    };
  }, [camOn]);

  const testConnection = async () => {
    const c = cfgRef.current;
    const urls = [
      ["MON-WED", c.monWedUrl],
      ["THU-SAT", c.thuSatUrl],
    ].filter(([, u]) => u);
    if (!c.token || urls.length === 0) {
      addLog("Fill in the token and at least one sheet link first.", false);
      return;
    }
    for (const [label, url] of urls) {
      try {
        const r = await callScript(url, { action: "ping", token: c.token });
        addLog(
          r?.ok ? `✓ ${label} sheet connected.` : `✗ ${label}: ${r?.error || "not accepted"}`,
          !!r?.ok,
        );
      } catch (e: any) {
        addLog(`✗ ${label}: could not reach it (${e?.message || "network"})`, false);
      }
    }
  };

  const inputCls = "w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900";

  return (
    <div style={{ minHeight: "100vh", background: "#f6f3ee", color: "#1f1a14", padding: 16 }}>
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>📷 Sheet Camera</h1>
        <p style={{ fontSize: 13, color: "#6b6258", marginBottom: 12 }}>
          Keep this page open in its own window next to the order sheet. Every time the sheet is
          edited, a photo is taken and linked in column N. No photos are taken while this page is
          closed or the camera is off.
        </p>

        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            background: "#fff",
            border: "1px solid #e5ded3",
            borderRadius: 10,
            padding: 10,
            marginBottom: 12,
          }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            style={{
              width: 140,
              height: 105,
              background: "#111",
              borderRadius: 8,
              objectFit: "cover",
              transform: "scaleX(-1)",
            }}
          />
          <div style={{ flex: 1, fontSize: 13 }}>
            <div style={{ fontWeight: 700, color: camOn ? "#b91c1c" : "#6b6258" }}>
              {camOn ? "● CAMERA ON — watching the sheet" : "○ Camera is off"}
            </div>
            <div style={{ color: "#6b6258", marginTop: 2 }}>
              Photos taken: {photoCount}
              {lastPhotoAt ? ` (last at ${lastPhotoAt})` : ""}
            </div>
            {!camOn && (
              <button
                onClick={startCamera}
                style={{
                  marginTop: 8,
                  padding: "6px 12px",
                  borderRadius: 8,
                  background: "#1f1a14",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Turn camera on
              </button>
            )}
          </div>
        </div>

        {camError && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              borderRadius: 8,
              padding: 10,
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {camError}
          </div>
        )}

        <button
          onClick={() => setShowSettings((s) => !s)}
          style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, textDecoration: "underline" }}
        >
          {showSettings ? "Hide settings" : "Show settings"}
        </button>

        {showSettings && (
          <div
            style={{
              background: "#fff",
              border: "1px solid #e5ded3",
              borderRadius: 10,
              padding: 12,
              marginBottom: 12,
              display: "grid",
              gap: 10,
            }}
          >
            <label style={{ fontSize: 12, fontWeight: 600 }}>
              MON-WED sheet link (web app URL)
              <input
                className={inputCls}
                value={cfg.monWedUrl}
                onChange={(e) => saveCfg({ ...cfg, monWedUrl: e.target.value })}
                placeholder="https://script.google.com/macros/s/.../exec"
              />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600 }}>
              THU-SAT sheet link (web app URL)
              <input
                className={inputCls}
                value={cfg.thuSatUrl}
                onChange={(e) => saveCfg({ ...cfg, thuSatUrl: e.target.value })}
                placeholder="https://script.google.com/macros/s/.../exec"
              />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600 }}>
              Secret token (from the sheet script)
              <input
                className={inputCls}
                type="password"
                value={cfg.token}
                onChange={(e) => saveCfg({ ...cfg, token: e.target.value })}
                placeholder="paste the token"
              />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600 }}>
              Your Google email (optional — use it if several people edit the sheet, so each
              person's photo is only taken on their own computer)
              <input
                className={inputCls}
                value={cfg.email}
                onChange={(e) => saveCfg({ ...cfg, email: e.target.value })}
                placeholder="you@gmail.com"
              />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={testConnection}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid #1f1a14",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Test connection
              </button>
              <span style={{ fontSize: 12, color: "#6b6258", alignSelf: "center" }}>
                Settings save automatically on this computer.
              </span>
            </div>
          </div>
        )}

        <div style={{ fontSize: 12, fontWeight: 700, margin: "6px 0" }}>Activity</div>
        <div
          style={{
            background: "#fff",
            border: "1px solid #e5ded3",
            borderRadius: 10,
            padding: 8,
            fontSize: 12,
            minHeight: 60,
          }}
        >
          {log.length === 0 && <div style={{ color: "#9a9084" }}>Nothing yet.</div>}
          {log.map((l, i) => (
            <div key={i} style={{ color: l.ok ? "#1f1a14" : "#b91c1c", padding: "2px 0" }}>
              <span style={{ color: "#9a9084" }}>{l.t}</span> {l.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
