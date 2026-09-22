# Arduino Web IDE

Type Arduino Uno code in a browser, compile it in the cloud, and upload it straight to
the board over USB — nobody using the site needs to install the Arduino IDE, drivers,
or anything else. Just Chrome or Edge.

## How it works

- **Frontend** (`public/`): a code editor plus an "Upload" button. Uploading uses the
  browser's built-in **Web Serial API** to talk to the board directly — no plugin.
- **Backend** (`server.js`): a tiny Express server that runs `arduino-cli` to compile
  whatever code is submitted, and hands the resulting `.hex` file back to the browser.
- The browser then flashes that `.hex` file onto the Uno itself, by speaking the
  STK500v1 protocol that the Uno's Optiboot bootloader understands (this is the same
  protocol `avrdude`/the Arduino IDE use under the hood) — implemented in plain
  JavaScript in `public/app.js`.

Only the **backend** needs a real install of `arduino-cli` — and that happens once,
on the server, via the included `Dockerfile`. End users only ever open a webpage.

## Deploy it (free, ~5 minutes)

Using [Render](https://render.com) (has a free web-service tier):

1. Push this folder to a new GitHub repo.
2. On Render: **New +** → **Blueprint** → connect the repo. Render will read
   `render.yaml` and set everything up automatically (Docker build, free plan).
   - Or manually: **New +** → **Web Service** → connect the repo → Environment:
     **Docker** → Plan: **Free**.
3. Wait for the first build (it installs `arduino-cli` + the AVR core, so the first
   build takes a few minutes; later ones are cached and much faster).
4. Once deployed, Render gives you a URL like `https://arduino-web-ide.onrender.com`.
   That's the whole app — share that link.

Any other Docker-friendly free host (Railway, Fly.io, etc.) works the same way — they
all just need to build the `Dockerfile` and run `npm start`.

**Free-tier note:** Render's free web services spin down after periods of inactivity
and take ~30–60 seconds to wake back up on the next request. That's normal — it's just
the compile server waking up, not a bug.

## Using the site

1. Open the deployed URL in **Chrome or Edge** (desktop — Web Serial isn't available
   on iOS/Android yet, and Firefox/Safari don't support it).
2. Plug the Arduino Uno into the computer via USB.
3. Click **Connect Board** and pick the Uno from the browser's port picker.
4. Write or paste your sketch in the editor.
5. Click **Compile & Upload**.
6. Watch progress in the Output panel; the built-in Serial Monitor at the bottom lets
   you watch `Serial.println()` output afterward.

## Limitations / notes

- Currently targets the **Arduino Uno** (`arduino:avr:uno`) specifically. Nano, Mega,
  etc. use slightly different bootloader/protocol details — ask if you'd like those
  added.
- Cheap Uno clones with a **CH340 USB chip** may still need a one-time driver install
  on Windows for the OS to expose a serial port at all (genuine Unos and most modern
  clones with an ATmega16U2/FTDI chip don't need this). That's an OS-level limitation,
  not something a webpage can work around.
- No code-upload verification (read-back check) is performed after flashing, to keep
  things simple — the upload log will tell you if any step failed.
- The `/compile` endpoint is rate-limited (12 requests/minute per IP) since it's a
  publicly reachable compiler; adjust in `server.js` if you deploy this for a bigger
  group.
