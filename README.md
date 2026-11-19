# SkinScope Consult

A face and skin analysis system for **consultations in the clinic**. It runs in the browser on an iPad
(or any tablet / phone / laptop), with nothing to install. Customers, photos and results are stored **only on that device**.

## Workflow

| Step | What you do |
|---|---|
| **1 Customer** | Search or register the customer: name, sex, birthday (required, used for age-group comparison), adviser/doctor, phone, e-mail, notes. Past visits are listed here. |
| **2 Capture** | Front → Left 45° → Right 45°. A live head-angle guide auto-captures when angle, distance, level and light are right. Preview overlays: **4 / 48 sections** grid, or **Ghost** (last visit's photo, adjustable transparency) for repeat visits. You can also import photos. |
| **3 Images** | For each position, 3 side-by-side images: **Normal** (pores & wrinkles), **Polarized-style** (surface spots), **UV-style** (deep spots & sebum). Each has **M** (marked) and **B** (black & white) modes. *All angles* shows the 3-photo collage in any mode. Hold 💡 to see the original. |
| **4 Analysis** | Pores, Wrinkles, Spots (surface), Deep / diffuse pigment, Sebum (with skin-type questions), Redness, Texture & scars, Skin tone, Face structure. Each shows a 0–100 score, zones **A–G** with a bar chart, the clinic reference for the same sex and age group, and counselling text. |
| **5 Total** | One-page summary: state bars vs reference, key images, skin type, tone, structure, **Advice** and **Recommended treatments / products**. **Print / PDF**. |
| **6 History** | Line graphs of every category over the last 10 visits, a score table, and the advice history. |
| **7 Compare** | Pick 2 dates: side-by-side images in any mode, plus the score change per category (green = improved). |

**Tap any image** to open the viewer. You can pinch-zoom (with a navigator), hold for the original, and use the
**Length** (mm), **Area** (mm² + brightness), **Angle**, **Line profile** (RGB/gray roughness), **Arrow**, **Text** (e.g. "Botox")
and **Pen** tools. Drawings are saved with the visit, and **Save image** exports them.

**Clinic reference:** age-group averages are built from *your own* saved patients (same sex, same 10-year age group,
at least 3 patients). No made-up norms are used.

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
- For repeat visits, switch the preview to **Ghost** and line the face up with last time.
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
- "Polarized-style" and "UV-style" images are **computed from a normal photo**. They are not real cross-polarised or
  UV photographs, so they cannot show porphyrins (acne bacteria) or measure true dermal pigment. "Deep / diffuse pigment"
  means broad, soft-edged pigment patterns (e.g. melasma-like), estimated from colour.
- Data lives in this browser on this device. Clearing Safari website data deletes it, and it does not sync between devices.
- Scores depend on light and camera. Tune the thresholds in `CALIBRATION` at the top of
  `js/analysis.js` after trying it on a few patients in your own room.

## Files

```
index.html          page layout
css/styles.css      layout (iPad-first, print layout for the report)
js/app.js           screens: customer, capture, images, analysis, total, history, compare
js/db.js            on-device customer & visit storage (IndexedDB)
js/viewer.js        zoom viewer + measurement / drawing tools
js/charts.js        SVG charts
js/face.js          MediaPipe loading, head pose, mm scale
js/regions.js       skin mask and face zones
js/analysis.js      skin analysis + CALIBRATION
js/views.js         Normal / Polarized-style / UV-style images, M & B modes
js/structure.js     facial proportions & overlay
js/collage.js       3-photo collage
```
