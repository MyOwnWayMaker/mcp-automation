# compress_videos - Mac H.265 video compression toolkit

Drop-and-forget disk-space recovery: any video that lands in `~/CompressMe/`
gets re-encoded to H.265 (HEVC) and moved to `~/CompressMe/done/`. Already-HEVC
files are skipped. Files where the new size isn't meaningfully smaller (default:
must be < 80% of original) are skipped too - no point taxing the CPU for a
1% saving.

Two pieces:

| File | Purpose |
|---|---|
| `compress_videos.sh` | One-shot: takes a folder (recursive) or a single file. Safe to re-run. |
| `compress_videos_watch.sh` | fswatch daemon - runs the one-shot on each new arrival in `~/CompressMe/`. |
| `compress_videos.plist` | macOS LaunchAgent so the watcher runs on login + restarts on crash. |
| `setup_watch.sh` | One-time installer: brews ffmpeg + fswatch, renders the plist, loads it. |

## Install

On the Mac:

```bash
cd ~/path/to/compress-videos     # wherever you put the four files
bash setup_watch.sh
```

`setup_watch.sh` will:
- check Homebrew is installed (won't auto-install it - install from <https://brew.sh> first if not present)
- `brew install ffmpeg fswatch` (skipped if already installed)
- create `~/CompressMe/` and `~/CompressMe/done/`
- render `~/Library/LaunchAgents/com.hakiel.compress-videos.plist` with absolute paths
- `launchctl load` it so the watcher is running now AND every login

## Use

**Drop a video into `~/CompressMe/`.** Watcher waits ~5s for the copy to
finish (so it doesn't try to encode a half-uploaded file from Drive sync),
then runs `compress_videos.sh` on just that file. On success, the compressed
result is moved to `~/CompressMe/done/`.

```
~/CompressMe/big_4k_clip.mov     <- drop here
   |  ~5s debounce, then encode
   v
~/CompressMe/done/big_4k_clip.mov  <- compressed result lives here
```

Live log (tail -f friendly):

```
tail -f ~/Library/Logs/compress_videos.log
```

## One-shot usage (no daemon)

Compress a whole folder by hand - useful for the first big sweep of an
existing video library:

```bash
./compress_videos.sh ~/Movies/Untouched
./compress_videos.sh --threshold 70 ~/Movies        # stricter - only keep if < 70%
./compress_videos.sh --dry-run ~/Movies             # estimate only, no encoding
./compress_videos.sh --verbose ~/Movies             # show ffmpeg progress
```

The script is **idempotent**: re-running on a folder skips files that are
already HEVC, so you can run it as often as you want.

Single-file mode:

```bash
./compress_videos.sh ~/Movies/some_clip.mp4
```

## What gets compressed

Recursively finds these extensions (case-insensitive): `.mp4`, `.mov`,
`.avi`, `.mkv`, `.m4v`, `.webm`. Anything else is silently skipped.

| Source | Output extension |
|---|---|
| `.mp4`, `.m4v`, `.mov`, `.mkv` | unchanged (HEVC fits these containers natively) |
| `.avi`, `.webm` | rewritten as `.mp4` (those containers don't support HEVC; original deleted on success) |

Encoding params: `libx265 -crf 26 -preset medium`. Audio + subtitles are
copied without re-encoding (`-c:a copy -c:s copy`). CRF 26 is a sweet spot
for 1080p consumer video - visually transparent to most eyes, files
typically 40-60% smaller than the H.264 source.

## Threshold rule

After encoding, the new size is compared to the original:

- **new < N% of original** -> original deleted, new file kept (default N = 80)
- **new >= N% of original** -> tmp file deleted, original kept untouched

Override per-run with `--threshold N`. Already-HEVC files skip this entirely.

## Disable / re-enable / uninstall

```bash
# stop the watcher (this session and across reboots)
launchctl unload ~/Library/LaunchAgents/com.hakiel.compress-videos.plist

# start it back up
launchctl load   ~/Library/LaunchAgents/com.hakiel.compress-videos.plist

# uninstall completely
launchctl unload ~/Library/LaunchAgents/com.hakiel.compress-videos.plist
rm ~/Library/LaunchAgents/com.hakiel.compress-videos.plist
# (the scripts themselves and the brew-installed ffmpeg/fswatch you can leave)
```

## Watcher options (env vars)

Set these before invoking `setup_watch.sh` if you want non-defaults baked in,
or edit the LaunchAgent plist's `EnvironmentVariables` block after install:

| Var | Default | Effect |
|---|---|---|
| `WATCH_DIR` | `~/CompressMe` | Folder the watcher polls |
| `DONE_DIR` | `$WATCH_DIR/done` | Where compressed files land |
| `THRESHOLD` | `80` | Replacement threshold (percent) |
| `IN_PLACE` | `0` | Set to `1` to skip the move-to-done step (compressed file stays in `WATCH_DIR`) |
| `DEBOUNCE_SECONDS` | `5` | Stable-size poll interval before encoding |

## How idempotency works

The one-shot script's first action per file is `ffprobe` + a codec check.
If the video stream is HEVC, it's logged `SKIP-HEVC` and never touched. So
running the watcher (or the one-shot) repeatedly over the same folder is
free - only newly-arrived non-HEVC files do work.

## Troubleshooting

**Watcher isn't picking up files.** Check the log:
```
tail -50 ~/Library/Logs/compress_videos.log
```
If the log doesn't show `[watch] starting on ...` recently, the LaunchAgent
isn't running:
```
launchctl list | grep compress-videos
```
No output -> re-run `setup_watch.sh`.

**Encoding is slow.** That's `-preset medium` doing its job. If you want
faster (less compression, more CPU per second), edit `compress_videos.sh`
and change `-preset medium` to `-preset fast` or `-preset ultrafast`.

**Specific file failed.** `grep ERROR ~/Library/Logs/compress_videos.log`
will surface the ffmpeg error message. The original file is always preserved
on encode failure.

**Want to re-encode an already-HEVC file anyway** (e.g., to drop the
bitrate further). Use ffmpeg directly - this script is designed never to
re-encode a file that's already H.265.
