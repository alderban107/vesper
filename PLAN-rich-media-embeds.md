# Rich Media Embeds: Audio & Video

> **Status:** Planning — not yet implemented
> **Branch:** `monika/rich-media-embeds-audio-video`
> **Remove this file before merging the final PR.**

---

## Problem

Uploaded images embed inline with a preview and lightbox. Audio files also embed with a
custom player. Video files fall through to a generic download card. Users expect inline
playback for video and audio — and several related UX problems need solving at the same
time:

1. **No video embeds at all.** Video files render as a download button.
2. **Eager loading of all media.** Every image and audio file in scroll history is fetched
   and decrypted the moment its message enters the DOM, regardless of viewport position.
   In a busy channel this wastes bandwidth and memory.
3. **No click-to-load for audio.** Audio files download immediately. This should be
   user-initiated, same as video.
4. **No audio metadata.** Music files (MP3, FLAC, etc.) contain title, artist, album, and
   cover art that we could extract and display. Discord doesn't do this — we'd be ahead.
5. **Upload size ceiling.** The current 25 MiB limit is too low for most video files.
6. **Upload size not configurable.** Server administrators can't tune the limit without
   changing source code.

## Architecture Context

Understanding the constraints before reading the plan:

- **End-to-end encryption.** Files are AES-256-GCM encrypted client-side before upload.
  The server stores opaque ciphertext. This means the server cannot transcode, generate
  thumbnails, extract metadata, or serve range requests against plaintext. All media
  processing must happen on the client.
- **AES-GCM is all-or-nothing.** The authentication tag is computed over the full
  ciphertext. You cannot decrypt a byte range without the complete blob. This rules out
  HTTP range-request seeking and streaming decryption.
- **File metadata lives inside MLS ciphertext.** The encrypted message payload contains a
  `file` object with the attachment ID, filename, content type, size, and AES key/IV.
  Receiving clients use this to fetch, decrypt, and render. Any new metadata fields
  (thumbnails, duration, audio tags) extend this object.
- **Attachments are cascade-deleted.** The `attachments` table has
  `on_delete: :delete_all` on `message_id`. When a message is deleted,
  `delete_message/1` also collects storage keys and removes blobs from disk when their
  reference count reaches zero. Multiple attachments per message (e.g., video + thumbnail)
  are handled by this existing model with no changes.
- **No virtualization.** `MessageFeed` renders all loaded messages as a flat list. There
  is no IntersectionObserver or visibility gating. Every `FilePreview` in the DOM
  immediately fetches its file.

## Payload Schema

The existing `FilePayload` type (v1) has an open `file` object. All new fields are
optional and backward-compatible — old clients ignore fields they don't recognize. No
version bump is needed.

```typescript
interface FilePayload {
  v: 1
  type: 'file'
  text: string | null
  file: {
    // Existing fields
    id: string                   // server-side attachment ID
    name: string                 // original filename
    content_type: string         // MIME type
    size: number                 // bytes
    key: string                  // base64 AES-256-GCM key
    iv: string                   // base64 IV

    // Stage 2: video thumbnails
    duration?: number            // seconds (video or audio)
    thumbnail?: {
      id: string                 // thumbnail attachment ID
      key: string                // thumbnail AES key
      iv: string                 // thumbnail IV
    }

    // Stage 3: audio metadata
    audio_metadata?: {
      title?: string
      artist?: string
      album?: string
      cover?: {                  // same shape as thumbnail
        id: string
        key: string
        iv: string
      }
    }
  }
}
```

## Supported Media Types

### Video

Files matching `video/*` render the video embed card. Playback support varies by browser;
unsupported formats attempt playback and fall back to a download card on error.

| MIME type          | Extensions  | Browser support                         | Notes                        |
|--------------------|-------------|-----------------------------------------|------------------------------|
| `video/mp4`        | .mp4, .m4v  | Universal                               | H.264/H.265 — the safe bet   |
| `video/webm`       | .webm       | Chrome, Firefox, Edge; not Safari <16.4 | VP8/VP9/AV1                  |
| `video/ogg`        | .ogv        | Chrome, Firefox; not Safari             | Theora — rare in practice    |
| `video/quicktime`  | .mov        | Safari, some Chrome; not Firefox        | Common from iPhones          |

**Excluded:** `video/x-matroska` (.mkv). No browser supports the MKV container natively.
The codecs inside (usually H.264/VP9) are playable, but the container isn't. Client-side
remuxing via ffmpeg.wasm would add ~25 MB of wasm binary and significant CPU overhead —
not justified for a chat app. MKV files render as the normal download card.

### Audio

Files matching `audio/*` render the audio embed card. Same attempt-and-fallback strategy.

| MIME type      | Extensions  | Browser support           | Notes                     |
|----------------|-------------|---------------------------|---------------------------|
| `audio/mpeg`   | .mp3        | Universal                 |                           |
| `audio/ogg`    | .ogg, .oga  | Chrome, Firefox; no Safari| Vorbis/Opus               |
| `audio/wav`    | .wav        | Universal                 | Can be very large         |
| `audio/webm`   | .weba       | Chrome, Firefox, Edge     | Opus codec                |
| `audio/aac`    | .aac        | Universal                 |                           |
| `audio/flac`   | .flac       | Chrome, Firefox, Safari 11+, Edge |                  |
| `audio/mp4`    | .m4a        | Universal                 | AAC in MP4 container      |
| `audio/x-m4a`  | .m4a        | Universal                 | Alternative MIME for M4A  |

### Images

No changes to image handling. `image/*` types (including animated GIF and animated WebP)
continue to render as `<img>` elements that loop natively. They gain viewport-based lazy
loading from Stage 1 but otherwise behave as they do today.

### Content-Type Fallback

`File.type` in browsers is occasionally empty or `application/octet-stream` for valid
media files. Stage 4 adds extension-based sniffing as a fallback before deciding which
render branch to use.

---

## Stage 1: Visibility-gated media loading, video embeds, audio click-to-load

The foundational stage. Three things ship together because they're interdependent.

### 1a. `useVisibility` hook

A React hook wrapping IntersectionObserver. Takes a ref, returns `{ isVisible, hasBeenVisible }`.

- `isVisible`: currently in or near the viewport.
- `hasBeenVisible`: latches `true` once the element first enters. Used to trigger initial
  fetch — once started, we don't cancel mid-download just because the user scrolled past.
- Root margin: `600px` — pre-loads slightly before entering view to reduce visible jank.
- Disconnects on unmount.

`FilePreview` wraps its content in this hook. The `useEffect` that fetches and decrypts
media only fires when `hasBeenVisible` becomes `true`.

**Memory eviction:** When a loaded media element scrolls far out of view (>2000px from
viewport edge), revoke the blob URL and reset to the unloaded state. If the user scrolls
back, re-fetch. This prevents unbounded memory growth in long sessions. Eviction uses a
second IntersectionObserver with a larger negative root margin, or a periodic check
against `isVisible`.

**Applies to all media types:** images, audio, and video.

### 1b. Video embed in `FilePreview.tsx`

Add a `video/*` branch alongside the existing `image/*` and `audio/*` branches.

**New `VideoPlayer.tsx` component** with three states:

1. **Unloaded** — card showing: film/play icon, filename, formatted file size, prominent
   play button overlay. Minimal height placeholder so layout doesn't jump on load.
2. **Loading** — spinner replaces play button. Fetch + decrypt in progress.
3. **Loaded** — native `<video controls>` element with blob URL as `src`. Download button
   alongside native controls.
4. **Error** — falls back to generic file card with "Format not supported in this browser
   — download to play" text and download button.

Video **always** requires explicit click to start downloading, regardless of visibility.
The visibility hook gates whether the *card itself* renders (for consistency) but the
actual fetch is user-initiated.

**Playback error handling:** Attach an `onerror` handler to the `<video>` element. If the
browser can't decode the format, transition to the error state with a download fallback.
No format-sniffing or capability detection upfront — just try and handle failure.

### 1c. Audio click-to-load

Change audio from eager-loading to click-to-load, matching the video pattern.

The existing `AudioPlayer.tsx` handles the loaded state well. The change is in
`FilePreview.tsx`: the audio branch renders an unloaded card (volume icon, filename, size,
play button) instead of immediately fetching. On click, fetch/decrypt, then hand off to
`AudioPlayer`.

### 1d. Configurable upload size limit

**Server changes:**

- `server/config/runtime.exs` — read `MAX_UPLOAD_SIZE` env var, parse as integer bytes,
  pass to app config.
- `server/lib/vesper/chat/file_storage.ex` — change default from `26_214_400` (25 MiB)
  to `52_428_800` (50 MiB).
- `.env.example` — add `MAX_UPLOAD_SIZE` with documentation comment.

The `AttachmentController.create/2` already calls `FileStorage.max_upload_size()` — no
controller changes needed.

### Stage 1 file changes

| File | Change |
|------|--------|
| `client/src/renderer/src/hooks/useVisibility.ts` | **New.** IntersectionObserver hook. |
| `client/src/renderer/src/components/chat/VideoPlayer.tsx` | **New.** Video embed component. |
| `client/src/renderer/src/components/chat/FilePreview.tsx` | Add video branch, wrap all media in visibility hook, make audio click-to-load. |
| `server/lib/vesper/chat/file_storage.ex` | Default 25→50 MiB. |
| `server/config/runtime.exs` | Read `MAX_UPLOAD_SIZE` env var. |
| `.env.example` | Document `MAX_UPLOAD_SIZE`. |

---

## Stage 2: Video thumbnails

### Thumbnail extraction at upload time

**New `videoThumbnail.ts` utility:**

`extractVideoThumbnail(file: File): Promise<{ blob: Blob; duration: number } | null>`

1. Create a temporary `<video>` element, set `src` to a blob URL of the raw
   (pre-encryption) file.
2. Wait for `loadedmetadata` — extract `duration`.
3. Seek to `min(1.0, duration * 0.1)` seconds.
4. On `seeked`, draw the frame to an offscreen `<canvas>`.
5. Export as JPEG at 0.7 quality, cap dimensions at 320px on the long edge.
6. Return the blob (typically 10–30 KB) and duration.
7. If any step fails (e.g., browser can't decode the codec for thumbnail extraction),
   return `null`. The video still uploads — it just won't have a thumbnail.

### Upload flow changes

When the staged file is `video/*`, before encrypting the main file:

1. Run `extractVideoThumbnail`.
2. If thumbnail exists: encrypt thumbnail → upload as a second attachment (fast, tiny).
3. Build the payload with extended fields:
   - `file.duration` — seconds
   - `file.thumbnail` — `{ id, key, iv }` referencing the thumbnail attachment

Both `MessageInput.tsx` and `DmMessageInput.tsx` get this logic. (Duplicate for now;
shared hook refactor is a later cleanup.)

### VideoPlayer enhancement

- If `thumbnail` exists: eagerly fetch/decrypt the thumbnail (respecting visibility hook)
  and display as poster image behind the play button overlay.
- If `duration` exists: show formatted duration (e.g., "2:34") in the bottom-right corner
  of the card.
- Thumbnail fetch is tiny (~20 KB) so the visibility-gated eager load is fine here.

### Deletion model

Both the video blob and thumbnail blob are separate attachment rows, both with
`message_id` pointing to the same message. The existing `on_delete: :delete_all` cascade
and `delete_message/1` blob cleanup handle this with no changes. Verified: the function
iterates all attachments for the message, collects storage keys, and removes blobs whose
reference count reaches zero.

### Stage 2 file changes

| File | Change |
|------|--------|
| `client/src/renderer/src/utils/videoThumbnail.ts` | **New.** Thumbnail + duration extraction. |
| `client/src/renderer/src/stores/messageStore.ts` | Extend `FileMessageContent` type with optional `thumbnail` and `duration`. |
| `client/src/renderer/src/crypto/payload.ts` | Extend `FilePayload` type. |
| `client/src/renderer/src/components/chat/MessageInput.tsx` | Thumbnail generation + upload for video files. |
| `client/src/renderer/src/components/dm/DmMessageInput.tsx` | Same. |
| `client/src/renderer/src/components/chat/VideoPlayer.tsx` | Poster image + duration display. |

---

## Stage 3: Audio metadata extraction

### Dependency

Add `music-metadata-browser` (~100 KB minified). Handles MP3 (ID3v2.2/2.3/2.4), FLAC
(Vorbis comments + PICTURE blocks), OGG, M4A, WAV. Pure JS, no wasm.

### Metadata extraction at upload time

**New `audioMetadata.ts` utility:**

`extractAudioMetadata(file: File): Promise<AudioMetadata | null>`

1. Parse the file with `music-metadata-browser`.
2. Extract: `title`, `artist`, `album`, `duration`, and the first embedded picture.
3. If cover art exists: resize/compress to JPEG, cap at 200px on the long edge, target
   ~15 KB. Encrypt and upload as a side attachment (same pattern as video thumbnails).
4. Return the metadata object. If parsing fails or no metadata exists, return `null`.

**Format caveats:**
- MP3 ID3 tags have three major versions with different text encodings. The library
  normalizes this, but user-tagged files can contain garbage. Truncate display strings to
  reasonable lengths (128 chars for title/artist, 256 for album).
- FLAC cover art is stored as PICTURE metadata blocks, MP3 as APIC frames. The library
  abstracts the difference.
- WAV files almost never have metadata. They'll display as the basic audio player.
- Some files have no metadata at all. The UI must degrade cleanly.

### Upload flow changes

When the staged file is `audio/*`, before encrypting the main file:

1. Run `extractAudioMetadata`.
2. If cover art exists: encrypt → upload as side attachment.
3. Build the payload with `file.audio_metadata` and optionally `file.duration`.

Both `MessageInput.tsx` and `DmMessageInput.tsx`.

### AudioPlayer enhancement

When `audio_metadata` is present:

- Show cover art (if available) as a small album thumbnail to the left of the player.
- Show title and artist below (or instead of) the filename. Fallback: no title → show
  filename; no artist → omit; no cover → no cover.
- Duration from metadata can pre-populate the time display before the audio element loads.

When `audio_metadata` is absent, the player looks and behaves exactly as it does today
(post-Stage 1 click-to-load).

### Stage 3 file changes

| File | Change |
|------|--------|
| `client/package.json` | Add `music-metadata-browser`. |
| `client/src/renderer/src/utils/audioMetadata.ts` | **New.** Metadata + cover art extraction. |
| `client/src/renderer/src/crypto/payload.ts` | Extend `FilePayload` with `audio_metadata`. |
| `client/src/renderer/src/stores/messageStore.ts` | Extend `FileMessageContent` type. |
| `client/src/renderer/src/components/chat/MessageInput.tsx` | Metadata extraction + cover upload for audio files. |
| `client/src/renderer/src/components/dm/DmMessageInput.tsx` | Same. |
| `client/src/renderer/src/components/chat/AudioPlayer.tsx` | Cover art, title/artist display, graceful degradation. |
| `client/src/renderer/src/components/chat/FilePreview.tsx` | Pass metadata through to AudioPlayer. |

---

## Stage 4: Polish and edge cases

- **Content-type sniffing fallback.** If `file.content_type` is empty or
  `application/octet-stream`, sniff by file extension before choosing the render branch.
  Map: `.mp4`→`video/mp4`, `.webm`→`video/webm`, `.mp3`→`audio/mpeg`,
  `.flac`→`audio/flac`, etc.
- **Mobile browser verification.** Verify that blob URL `<video>` and `<audio>` elements
  work in mobile Safari (WKWebView) for the web client. The click-to-load pattern already
  respects autoplay restrictions.
- **Memory budget logging.** Dev-mode logging of total bytes held in active blob URLs,
  for tuning IntersectionObserver margins and eviction thresholds.
- **Upload progress indicator.** For large files (approaching 50 MiB), the upload can
  take noticeable time. The current flow shows a spinner but no progress percentage. A
  progress bar would be a UX improvement but is not blocking.

---

## What this plan explicitly does not do

- **Server-side transcoding.** Files are E2EE. The server cannot see plaintext.
- **HLS/DASH streaming.** Would require segmenting and re-encrypting, which requires
  plaintext access on the server.
- **Range request support.** AES-GCM requires the full ciphertext for decryption. Range
  requests against encrypted blobs are meaningless.
- **MKV playback.** No browser supports the container. Client-side remuxing via
  ffmpeg.wasm is too heavy.
- **Chunked/streaming encryption.** Switching from AES-GCM to AES-CTR with known offsets
  would enable partial decryption and seeking, but is a major rearchitecture of the
  encryption layer — out of scope for this feature.
