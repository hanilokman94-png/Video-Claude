# SkinScope Consult

A fast face and skin analyser for **first consultations in the clinic**. It runs in the browser on an
iPad, iPhone, Android tablet or laptop, with nothing to install and no account.

1. Take **3 photos**: front, then the patient's right side at 45°, then the left side at 45°.
   The camera shows the head angle live and **auto-captures** when the angle, distance, level and light are right.
2. Straight away it shows a **collage of the 3 photos**, ready to show the patient, save or print.
3. Switch the collage between **light modes**:

| Mode | What it shows |
|---|---|
| Original | The photos as taken |
| **Red light** | Redness / blood vessels / inflammation; possible active spots circled |
| **Blue light** | Blue-channel contrast. Surface pigment (melasma, sun spots) stands out dark |
| Brown spots | Melanin map: melasma patches and pigment spots |
| Pores & texture | Relief map: pores (cyan dots), possible acne scars / depressions (orange circles) |
| Oil / shine | Shiny (oily) areas in yellow |
| Face structure | Midline, facial thirds, fifths, widths, eye tilt; jawline on the 45° views |

4. A short report: **skin type** (oily / combination / normal / dry), **pores**, **texture & acne scars**,
   **pigmentation & melasma pattern**, **redness**, **face structure** (shape, proportions, symmetry, head angles),
   a per-zone table and a notes box. Use **Print / PDF** to save it to the patient file.

> Photos are processed **only on the device**. Nothing is uploaded or stored. Closing the page clears them.

## Putting it on your iPad

The camera only works over `https`, so host the folder on any static host. The easiest option is GitHub Pages:

1. On GitHub, open this repository → **Settings → Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**. Pick the branch and the `/ (root)` folder, then **Save**.
3. After about a minute you get a link like `https://<your-username>.github.io/<repo>/`.
4. Open it in **Safari** on the iPad. Tap **Share → Add to Home Screen** so it opens like an app.
5. The first time, allow camera access.

Other hosts work too, for example Netlify Drop (drag the folder in) or Cloudflare Pages.
An internet connection is needed the first time, to load the face AI (~4 MB). After that it is cached.

## How to take good photos

- Bare skin: no makeup or sunscreen. Hair clipped back, glasses off.
- Soft, even light from the front (window light or a ring light). Avoid flash and overhead spotlights.
- **Use the back camera**, held by staff, about 30–40 cm from the face. It has much more detail for pores.
- For the oil reading, the patient should not have cleansed or blotted in the last 1–2 hours.
- Same room, same light, same distance at every visit, so before/after photos are comparable.
- You can also take photos with the normal iPad Camera app and use **Import 1–3 photos**.
  The app sorts them into front / right / left by head angle.

## How it works (in short)

- **Face landmarks and head angle**: Google MediaPipe Face Landmarker (478 points) runs on-device.
- **Skin maps**: each pixel's colour is converted to optical density and split into
  **melanin** (brown pigment), **haemoglobin** (redness) and **shading** (3-D relief) using their light-absorption signatures.
  That is why a shadow is not counted as pigment, and a brown spot is not counted as a scar.
- **Pores / scars**: small and medium dark pits in the shading map, sized in millimetres (scale from the iris size).
- **Oil**: specular shine on the T-zone vs the cheeks. The 3 quick questions in the report confirm dryness, which a photo can't see.
- **Structure**: ratios measured from the landmarks on the front photo.

## Important limits

- This is an **indicative, image-based** tool to support the consultation and show the patient. It is **not a diagnosis**.
  For example, the melasma pattern should be confirmed with Wood's lamp or dermoscopy.
- "Red light" and "Blue light" are **computed from a normal photo**. They are not real UV / cross-polarised
  imaging (like VISIA), so they cannot show porphyrins or deep pigment.
- Scores depend on light and camera. Tune the thresholds in `CALIBRATION` at the top of
  `js/analysis.js` after trying it on a few patients in your own room.

## Files

```
index.html          screens: home, camera capture, results
css/styles.css      layout (iPad-first, print layout for the report)
js/app.js           app flow, capture guidance, report
js/face.js          MediaPipe loading, head pose, mm scale
js/regions.js       skin mask and face zones
js/analysis.js      skin analysis + CALIBRATION
js/views.js         red / blue / brown / texture / shine renderings
js/structure.js     facial proportions & overlay
js/collage.js       3-photo collage
```
