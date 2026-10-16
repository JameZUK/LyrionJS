# LyrionJS

A plugin for [Lyrion Music Server](https://lyrion.org) (LMS) that turns any web browser into a
player. Open the LyrionJS page on a phone, tablet or computer and that browser shows up in LMS
as a player, like a Squeezebox or squeezelite. It plays in sync with your other players and can
control all of them.

It adds a new way to play and changes nothing else about LMS.

![Now playing on a desktop browser](docs/screenshots/now-playing.png)

<p>
  <img src="docs/screenshots/albums-phone.png" width="260" alt="Albums on a phone">
  &nbsp;
  <img src="docs/screenshots/queue-phone.png" width="260" alt="The queue on a phone, dark theme">
</p>

## Features

- **A real LMS player in the browser.** It's gapless, syncs with your other players, and handles
  volume, power and renaming.
- **Lossless.** FLAC up to 24-bit/192 kHz, WAV/AIFF and MP3 are decoded in the page. LMS converts
  everything else (AAC, Ogg, radio, streaming services) as usual.
- **Phones and tablets.** It keeps playing with the screen locked, and the lock-screen controls work.
- **The whole of LMS.** Library, search, queue, playlists, favourites, radio, apps and plugins,
  players and sync, alarms and sleep timer.

## Install

1. In LMS, go to *Settings › Plugins*. At the bottom, under *Additional Repositories*, add:

   ```
   https://raw.githubusercontent.com/JameZUK/LyrionJS/main/repo.xml
   ```

2. Click *Apply*. Then tick **LyrionJS** in the list, click *Apply* again, and restart LMS when asked.
3. Open `http://<your-lms>:9000/plugins/LyrionJS/` in any browser. You can also open it from
   *Apps › LyrionJS*, Material Skin's home screen, or *Settings › Plugins › LyrionJS*.
   Tap once so the browser allows sound.

LMS offers updates through the same repository. To install by hand instead, unzip the release zip
into a `LyrionJS` folder in LMS's plugin folder and restart LMS.

**Requirements:** LMS 8 or later and a current browser. iPhone and iPad need iOS 17.1 or later to
keep playing with the screen locked.

## Settings

*Settings › Plugins › LyrionJS* has these options:

- Whether browsers may connect as players.
- Whether radio is fetched through LMS.
- The default audio output.
- Diagnostics to the LMS log.
- The address LMS links to, for example behind a reverse proxy.

Each browser also has its own settings page inside LyrionJS.

## Limitations

- On iPhone and iPad the device's volume buttons set the volume. LMS's volume for that player
  stays at 100 %.
- Crossfades set in LMS aren't applied. The browser player is always gapless.
- It has no login of its own beyond LMS's optional password. Like LMS, it's meant for your home
  network.

## Licence

GPL-2.0-or-later (see [`LICENSE`](LICENSE)). The project's own code also carries an additional
permission for distribution through app stores, as long as the full source stays available
under the GPL: see [`LICENSE-EXCEPTION`](LICENSE-EXCEPTION).

LyrionJS is an independent project, not an official Lyrion one.

## More

- [How it works, and the protocol](docs/ARCHITECTURE.md)
- [Building, testing and releasing](docs/DEVELOPMENT.md)
