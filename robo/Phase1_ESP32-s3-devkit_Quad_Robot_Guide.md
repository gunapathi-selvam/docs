# 🤖 ESP32-S3 Quad Robot — Phase 1 Build Guide
### Preset Movements + Offline Web Control

> **Goal of Phase 1:** Get 4 servos moving in named poses (stand, sit, wave, dance), controlled from your phone over the ESP32's own WiFi hotspot — **completely offline, no internet required.**
>
> **Skill level:** Absolute beginner (no prior circuit knowledge needed). Every step is explained.

---

## 1. Components Checklist

### What you already have
| Component | Spec | Role in Phase 1 |
|---|---|---|
| ESP32-S3 DevKitC | N16R8 (16MB Flash, 8MB PSRAM), dual USB-C | The "brain" |
| Servo motors | 4 × SG90 / MG90S | The 4 legs |
| OV3660 camera | — | **Not used in Phase 1** (saved for Phase 3) |
| Bambu Lab A1 | rPLA filament | Print the body/legs |

### What you need to add (cheap, easily sourced)
| Component | Why | Approx. cost (India) |
|---|---|---|
| External 5V power supply (5V / 2A min) | Servos brown-out the ESP32 if powered from its pin | ₹150–300 |
| Breadboard (half-size) | Distribute power cleanly without soldering | ₹70–120 |
| Jumper wires (male-male, male-female) | Connections | ₹80–150 |
| Optional: 1000µF capacitor | Smooths servo power spikes (prevents resets) | ₹10 |

> 💡 **Customs-auction tip:** A 5V/2A phone charger + a USB breakout board works perfectly as the servo supply if you want to save money.

---

## 2. Understanding the Parts (1-minute primer)

**ESP32-S3** — a tiny computer with WiFi built in. It runs your code and can host a web page that your phone connects to.

**Servo motor (SG90)** — a motor that rotates to a *specific angle* (0°–180°) instead of spinning freely. Perfect for legs/joints. Each servo has **3 wires**:
- 🟤 Brown/Black = **GND** (ground)
- 🔴 Red = **5V power**
- 🟠 Orange/Yellow = **Signal** (this is what the ESP32 controls)

**Why external power?** Each SG90 can pull ~250mA, and 4 moving at once = ~1A spike. The ESP32's onboard 3.3V pin can't supply that — it would reset or behave erratically. So servos get their **own 5V supply**, and we just share the **ground** with the ESP32.

---

## 3. Wiring / Connections

### The golden rule
> **Servos powered by external 5V. Signal wires go to ESP32. GROUND IS SHARED between ESP32 and the external supply.**

### Pin assignments
| Servo | Signal wire → ESP32 GPIO |
|---|---|
| Leg 1 (Front-Left) | GPIO 4 |
| Leg 2 (Front-Right) | GPIO 5 |
| Leg 3 (Back-Left) | GPIO 6 |
| Leg 4 (Back-Right) | GPIO 7 |

### Step-by-step wiring
1. Plug the **external 5V supply** into the breadboard's **+ (red) rail** and **– (blue) rail**.
2. Connect **all 4 servo RED wires** to the breadboard **+ rail**.
3. Connect **all 4 servo BROWN/BLACK wires** to the breadboard **– rail**.
4. Connect **one jumper from the breadboard – rail to an ESP32 GND pin** ← **this shared ground is critical.**
5. Connect each servo's **ORANGE/SIGNAL wire** to its GPIO pin (4, 5, 6, 7).
6. (Optional but recommended) Place the **1000µF capacitor** across the + and – rails. Long leg → +, short leg → –.

### Connection diagram (text form)
```
   External 5V/2A Supply
        |        |
       (+)      (-)
        |        |
   ┌────┴────────┴────┐  Breadboard power rails
   │  + + + +    - - -│
   └──┬─┬─┬─┬────┬────┘
      │ │ │ │    │
   Servo RED×4   │
                 │
   Servo BROWN×4 ┘  (to - rail)
                 │
                 └──── jumper ──── ESP32 GND  ← SHARED GROUND

   Servo SIGNAL (orange):
      Leg1 ──────► GPIO 4
      Leg2 ──────► GPIO 5
      Leg3 ──────► GPIO 6
      Leg4 ──────► GPIO 7

   ESP32-S3 ──► USB-C ──► your laptop (for programming & ESP power)
```

> ⚠️ **Do NOT connect servo RED (5V) wires to the ESP32's 5V or 3.3V pin.** Only the signal and ground touch the ESP32.

---

## 4. Software Setup (One-time)

### A. Install Arduino IDE
1. Download **Arduino IDE 2.x** from arduino.cc
2. Install and open it.

### B. Add ESP32 board support
1. Go to **File → Preferences**.
2. In *Additional Boards Manager URLs*, paste:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Go to **Tools → Board → Boards Manager**, search **esp32**, install **"esp32 by Espressif Systems"** (use v3.x).

### C. Install the servo library
1. Go to **Tools → Manage Libraries**.
2. Search **ESP32Servo**, install it.

### D. Select your board
1. **Tools → Board → ESP32 Arduino → "ESP32S3 Dev Module"**
2. **Tools → USB CDC On Boot → "Enabled"** (so the serial monitor works on the S3)
3. **Tools → PSRAM → "OPI PSRAM"** (because it's the N16**R8** = 8MB PSRAM)
4. **Tools → Flash Size → "16MB"**
5. Pick the right **Port** (plug in via USB-C — use the port labeled **UART**, not the OTG one, for programming).

---

## 5. First Test (Before the Full Code)

**Always confirm the board works before adding servos.** Upload the built-in Blink example:

`File → Examples → 01.Basics → Blink`

If the onboard LED blinks → your setup is correct. Move on.

---

## 6. Phase 1 Full Code

Paste this into a new sketch and upload. It creates a WiFi hotspot called **`RoboPup`** and serves a button page.

```cpp
#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>

// ---- WiFi hotspot settings (offline Access Point) ----
const char* AP_SSID = "RoboPup";
const char* AP_PASS = "12345678";   // min 8 chars

WebServer server(80);

// ---- Servo objects ----
Servo legFL, legFR, legBL, legBR;

const int PIN_FL = 4;
const int PIN_FR = 5;
const int PIN_BL = 6;
const int PIN_BR = 7;

// Helper: move all four legs to given angles, then small pause
void setLegs(int fl, int fr, int bl, int br, int wait = 400) {
  legFL.write(fl);
  legFR.write(fr);
  legBL.write(bl);
  legBR.write(br);
  delay(wait);
}

// ---- Named poses ----
void poseStand() { setLegs(90, 90, 90, 90); }
void poseSit()   { setLegs(150, 150, 30, 30); }

void poseWave() {
  poseStand();
  for (int i = 0; i < 3; i++) {       // wave front-right leg
    legFR.write(40); delay(300);
    legFR.write(140); delay(300);
  }
  poseStand();
}

void poseDance() {
  for (int i = 0; i < 4; i++) {
    setLegs(60, 120, 60, 120, 250);
    setLegs(120, 60, 120, 60, 250);
  }
  poseStand();
}

// ---- Web page ----
String htmlPage() {
  return R"rawliteral(
  <!DOCTYPE html><html><head>
  <meta name='viewport' content='width=device-width,initial-scale=1'>
  <title>RoboPup</title>
  <style>
    body{font-family:sans-serif;text-align:center;background:#111;color:#eee;margin:0;padding:30px;}
    h1{font-size:1.6rem;}
    button{font-size:1.3rem;margin:10px;padding:18px 30px;border:none;border-radius:14px;
           background:#2d7dff;color:#fff;width:80%;max-width:300px;}
    button:active{background:#1a5fd0;}
  </style></head><body>
  <h1>🤖 RoboPup Control</h1>
  <button onclick="go('stand')">Stand</button>
  <button onclick="go('sit')">Sit</button>
  <button onclick="go('wave')">Wave</button>
  <button onclick="go('dance')">Dance</button>
  <script>
    function go(p){ fetch('/'+p); }
  </script>
  </body></html>
  )rawliteral";
}

void setup() {
  Serial.begin(115200);

  // Attach servos (ESP32Servo: standard 500-2400us range)
  legFL.attach(PIN_FL, 500, 2400);
  legFR.attach(PIN_FR, 500, 2400);
  legBL.attach(PIN_BL, 500, 2400);
  legBR.attach(PIN_BR, 500, 2400);

  poseStand();   // start standing

  // Start WiFi Access Point (offline)
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.print("AP IP: ");
  Serial.println(WiFi.softAPIP());   // usually 192.168.4.1

  // Routes
  server.on("/",      []() { server.send(200, "text/html", htmlPage()); });
  server.on("/stand", []() { poseStand(); server.send(200, "text/plain", "ok"); });
  server.on("/sit",   []() { poseSit();   server.send(200, "text/plain", "ok"); });
  server.on("/wave",  []() { poseWave();  server.send(200, "text/plain", "ok"); });
  server.on("/dance", []() { poseDance(); server.send(200, "text/plain", "ok"); });

  server.begin();
}

void loop() {
  server.handleClient();
}
```

---

## 7. How to Use It

1. Upload the code. Open **Serial Monitor** (115200 baud) — you should see `AP IP: 192.168.4.1`.
2. On your phone, open **WiFi settings** → connect to **`RoboPup`** (password `12345678`).
3. Open a browser → go to **`192.168.4.1`**.
4. Tap **Stand / Sit / Wave / Dance** → the robot moves. 🎉

All offline. No internet anywhere in the loop.

---

## 8. Tuning the Poses (The Fun Part for Learning)

Servos vary, and how you mount the legs changes which angle = "straight." After assembly:

- Watch which direction each leg moves.
- Adjust the numbers inside `poseStand()`, `poseSit()`, etc.
- `90` is the servo's middle. `0` and `180` are the extremes.
- If a leg moves the *wrong* way, replace `angle` with `180 - angle` for that servo.

This trial-and-error is exactly the right beginner exercise — change a number, upload, watch, repeat.

---

## 9. 3D Printing the Body (Bambu A1)

- Search **Printables / Thingiverse** for: `ESP32 quadruped SG90` or `4 servo robot dog STL`
- Print in **rPLA** (your budget pick) — robot frames don't need PETG's heat resistance.
- Suggested settings: 0.2mm layer height, 15% infill, 2 walls. Plenty strong for a light bot.
- Print the servo horns/brackets that match **SG90 / MG90S** mounting.

---

## 10. Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| ESP32 keeps resetting when servos move | Servos drawing from ESP32 power | Use external 5V supply + shared GND |
| Servos jitter constantly | No shared ground, or weak supply | Confirm GND jumper; add 1000µF cap |
| Can't see `RoboPup` WiFi | Code didn't upload / wrong board settings | Re-check board = ESP32S3, PSRAM = OPI |
| Upload fails | Wrong USB port | Use the **UART** USB-C port, hold BOOT while connecting if needed |
| Page won't load at 192.168.4.1 | Phone used mobile data | Disable mobile data; stay on RoboPup WiFi |
| Servo moves wrong direction | Mounting orientation | Use `180 - angle` for that servo |

---

## 11. What's Next

- **Phase 2 — Manual control:** Add joystick/buttons or directional web controls for live driving.
- **Phase 3 — Camera reactions:** Bring in the OV3660 + **ESP-WHO** for offline face/motion detection that triggers poses.

> Phase 1 teaches: Arduino C++ basics, servo angles, WiFi AP mode, and hosting a web UI. Master this and the rest builds naturally on top.

---

*Build guide — Phase 1 of 3. Offline-first. Beginner-friendly.*
