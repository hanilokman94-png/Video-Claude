// Face detection with Google MediaPipe Face Landmarker (runs fully on-device).
// 478 landmarks per face + a 4x4 head-pose matrix.

export const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
export const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let videoLandmarker = null;
let imageLandmarker = null;
let loading = null;

async function create(FaceLandmarker, fileset, runningMode) {
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode,
    numFaces: 1,
    outputFacialTransformationMatrixes: true,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch (e) {
    console.warn('GPU delegate failed, falling back to CPU', e);
    return await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

export function loadFaceModels() {
  if (!loading) {
    loading = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import(`${VISION_URL}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
      imageLandmarker = await create(FaceLandmarker, fileset, 'IMAGE');
      videoLandmarker = await create(FaceLandmarker, fileset, 'VIDEO');
    })();
  }
  return loading;
}

export function detectVideo(video, ts) {
  if (!videoLandmarker) return null;
  const w = video.videoWidth || video.width;
  const h = video.videoHeight || video.height;
  return toFace(videoLandmarker.detectForVideo(video, ts), w, h);
}

export function detectImage(source) {
  if (!imageLandmarker) throw new Error('Face model not loaded');
  const w = source.naturalWidth || source.videoWidth || source.width;
  const h = source.naturalHeight || source.videoHeight || source.height;
  return toFace(imageLandmarker.detect(source), w, h);
}

function toFace(result, width, height) {
  if (!result || !result.faceLandmarks || !result.faceLandmarks.length) return null;
  // Landmarks in pixel units (z uses the same scale as x).
  const pts = result.faceLandmarks[0].map((p) => ({ x: p.x * width, y: p.y * height, z: p.z * width }));
  const m = result.facialTransformationMatrixes?.[0]?.data;
  return { pts, width, height, pose: headPose(pts, m) };
}

const DEG = 180 / Math.PI;

/**
 * Head pose in degrees.
 * yaw  > 0 : patient turned to THEIR LEFT  -> camera sees the patient's RIGHT side of the face
 * yaw  < 0 : patient turned to THEIR RIGHT -> camera sees the patient's LEFT side of the face
 * roll     : head tilt toward a shoulder (eye line vs horizontal)
 * pitch    : nodding up/down (magnitude is what matters for capture)
 */
export function headPose(pts, m) {
  let yaw, pitch;
  if (m && m.length === 16) {
    // column-major 4x4; R[r][c] = m[c*4 + r]
    const r02 = m[8], r12 = m[9], r22 = m[10];
    yaw = -Math.asin(Math.max(-1, Math.min(1, r02))) * DEG;
    pitch = Math.atan2(-r12, r22) * DEG;
  } else {
    const a = pts[234], b = pts[454];
    yaw = Math.atan2(b.z - a.z, b.x - a.x) * DEG;
    const t = pts[10], c = pts[152];
    pitch = Math.atan2(t.z - c.z, c.y - t.y) * DEG;
  }
  const e1 = pts[33], e2 = pts[263];
  const roll = Math.atan2(e2.y - e1.y, e2.x - e1.x) * DEG;
  return { yaw, pitch, roll };
}

export function faceBox(pts, pad = 0.12) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const w = x1 - x0, h = y1 - y0;
  return { x: x0 - w * pad, y: y0 - h * pad * 1.4, w: w * (1 + 2 * pad), h: h * (1 + pad * 2.4) };
}

/** Approximate pixels per millimetre, from the iris diameter (~11.7 mm), fallback eye width. */
export function pxPerMm(pts) {
  if (pts.length >= 478) {
    // iris ring points: 469-472 (one eye) and 474-477 (other eye)
    const d = (a, b) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
    const iris = Math.max((d(469, 471) + d(474, 476)) / 2, (d(470, 472) + d(475, 477)) / 2);
    if (iris > 4) return iris / 11.7;
  }
  const ew = Math.hypot(pts[33].x - pts[133].x, pts[33].y - pts[133].y);
  return ew / 30;
}
