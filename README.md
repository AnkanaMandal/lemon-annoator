# Lemon

Lemon is a self-hosted web app for annotating videos stored in AWS S3 (or any S3-compatible store). Each project
points at one bucket folder and has its own label schema. Videos stream directly from S3 through short-lived
presigned URLs, so nothing large is copied to your machine. Projects, labels and exports are plain JSON files in
`./app_data`.

## Features

- A single queue of every `.mp4` and `.mov` file under a folder, with per-video status and overall progress.
- A frame-accurate player with keyboard controls and event markers on the scrubber.
- Two kinds of labels: whole-video labels (one answer per clip) and timestamp events (recorded at a moment in the
  video).
- A label schema per project, built visually or pasted as a Label Studio config.
- Changes save automatically and stay saved until you clear them.
- One-click export of the whole project to a single JSON file.

## Requirements

- Node.js 20.9 or later
- Python 3.10 or later
- An S3 bucket with `.mp4` or `.mov` videos encoded as H.264 (other files are ignored)

## Install and run

### One command

```bash
npm run setup     # first time: Python virtual env, Python and Node dependencies, .env files
npm run dev       # starts the API and the web app; Ctrl+C stops both
```

Open the URL that is printed (normally http://localhost:3000).

- Ports default to 8000 (API) and 3000 (web app). If one is taken, the next free port is used and the web app is
  connected to it automatically. To choose ports yourself: `API_PORT=8100 WEB_PORT=3100 npm run dev`
  (PowerShell: `$env:API_PORT=8100; $env:WEB_PORT=3100; npm run dev`).
- If Lemon is already running, the command prints its address instead of starting a second copy.
- Both servers listen on `127.0.0.1` only. The app holds your AWS keys, so it is not reachable from your network.
- On Windows this runner starts the backend without auto-reload. Use the two-terminal setup below if you are
  editing backend code.

Production mode: `npm run build` then `npm run start`. The build records the backend address it proxies to
(`BACKEND_URL` at build time, default `http://127.0.0.1:8000`), so rebuild if you change the API port.

### Two terminals

Backend (http://127.0.0.1:8000):

```powershell
# Windows (PowerShell)
cd backend
python -m venv .venv                                        # first time only
.venv\Scripts\python -m pip install -r requirements.txt     # first time only
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

```bash
# macOS / Linux
cd backend
python3 -m venv .venv                         # first time only
.venv/bin/pip install -r requirements.txt     # first time only
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Frontend (http://localhost:3000):

```bash
cd frontend
npm install       # first time, and after pulling dependency changes
npm run dev
```

If port 8000 is taken, start the backend with another `--port` and set `BACKEND_URL` in `frontend/.env.local` to
match, then restart the frontend.

## Configuration

No environment variables are required. AWS credentials are entered per project in the app.

| File | Variable | Default | Purpose |
| --- | --- | --- | --- |
| `backend/.env` | `LEMON_DATA_DIR` | `./app_data` | Where projects, labels and exports are stored |
| `backend/.env` | `LEMON_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1` | Host names the API accepts (protects against DNS rebinding) |
| `backend/.env` | `LEMON_MAX_LIST_KEYS` | `50000` | Maximum number of S3 objects scanned per listing |
| `backend/.env` | `LEMON_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Only needed if you call the API directly from a browser |
| `frontend/.env.local` | `BACKEND_URL` | `http://127.0.0.1:8000` | Where the web app sends `/api` requests |

If a project's access key fields are left empty, the backend uses the standard AWS credential chain
(`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, `AWS_PROFILE`, `~/.aws/credentials`, SSO or an instance role).

## AWS setup

1. Create an IAM user (or role) with read-only access to the folder:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "s3:ListBucket",
         "Resource": "arn:aws:s3:::YOUR_BUCKET",
         "Condition": { "StringLike": { "s3:prefix": ["videos/*"] } }
       },
       {
         "Effect": "Allow",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::YOUR_BUCKET/videos/*"
       }
     ]
   }
   ```

2. Create an access key for that user and enter it, with the region, bucket and folder prefix (for example
   `videos/`), under Settings > Cloud storage. Pasting `s3://bucket/folder/` into the bucket field fills both fields.
3. The bucket needs no CORS configuration.

S3-compatible stores (MinIO, Cloudflare R2, Wasabi) are supported: open Advanced and set the custom endpoint URL.

Credentials are stored in plain text in `app_data/projects/<id>/project.json`. They are never sent back to the
browser, and `app_data/` is excluded from git. Use a read-only IAM user.

## Using Lemon

### Projects

Create a project from the dashboard. Each project card shows its progress and creation date. A project's settings
have three sections:

- **Cloud storage**: bucket, folder prefix, region and credentials, with Test connection. The panel at the top shows
  how many videos the folder holds, how many are new since the previous sync (by upload time), the total size and
  when it last synced. Sync storage re-reads the bucket. Opening or refreshing the queue also counts as a sync.
- **Label schema**: what you record for each video (see below).
- **General**: name, description, frame rate, skip interval, presigned URL lifetime, and deleting the project
  (type `delete` to confirm).

Once a project has saved annotations, its bucket cannot be changed. Create a new project for a different bucket.

### Label schema

Every field has a scope:

- **Whole video**: answered once per clip and saved with the video. No capture is needed. Use this for
  classification such as shot type, verdict or camera angle.
- **Each timestamp**: recorded with every captured event, together with the event type and an optional note.

Field types are checkbox, choices (single or multiple), dropdown and text. Any field can be marked required:
required whole-video fields must be answered before Save & Next, and required timestamp fields before Capture.

The schema can be built in the Visual editor, or pasted as a [Label Studio](https://labelstud.io/tags/) config in
the Code editor. The config is checked as you type, and switching between the two editors converts in both
directions.

| Label Studio tag | Becomes |
| --- | --- |
| `<Header value="..."/>` | The label of the control that follows it |
| `<Choices name choice="single">` with `<Choice value/>` | A choices field with one answer |
| `<Choices name choice="multiple">` | A choices field with several answers (saved as a list) |
| `<Choices ... layout="select">` | A dropdown |
| `<Choice ... selected="true"/>` | The default answer |
| `<TextArea name placeholder/>` | A text field |
| `<TimelineLabels>` or `<Labels>` with `<Label value/>` | Event types for timestamp events |
| `<Checkbox name value checked/>` | A single true/false field (Lemon extension) |
| `required="true"` | The field must be answered |
| `perRegion="true"` | The field is recorded per timestamp. Without it, the field labels the whole video. |

Layout and object tags such as `<View>` and `<Video>` are accepted and ignored. Other control tags are skipped with
a warning.

### Annotating

- The queue on the left lists the videos with their status: not started, in progress or completed. It can be
  filtered and searched.
- Right-click a video for its details (S3 URI, size, content type, last modified, ETag, storage class, S3 metadata,
  duration, resolution), to copy its S3 URI or key, to open it in a new tab, or to clear its annotations.
- The panel on the right holds the whole-video labels and, if the schema has any, the timestamp event fields with
  the Capture button. Saved whole-video labels are also listed under the player when you reopen a video.
- Click an event in the timeline, or its marker on the scrubber, to edit it. Retime moves it to the playhead.
- Hide the queue or the label panel with the icon in its header, or with `Q` and `T`.
- Save & Next marks the video completed and opens the next unfinished one.

| Key | Action |
| --- | --- |
| `Space` or `K` | Play / pause |
| `Left` / `Right` | Previous / next frame |
| `Shift` + `Left` / `Right` | Back / forward 1 second |
| `J` / `L` | Back / forward by the skip interval (default 5 seconds) |
| `[` / `]` | Slower / faster playback |
| `Enter` or `M` | Capture the current timestamp, or update the event being edited |
| `1` to `9` | Toggle the first nine checkboxes and choice options, in the order shown |
| `Shift` + `1` to `9` | Set the event type (`Shift` + `0` clears it) |
| `Esc` | Cancel editing |
| `Delete` | Delete the event being edited |
| `Ctrl` + `S` | Save now |
| `Ctrl` + `Enter` | Save & Next |
| `Alt` + `Up` / `Down` | Previous / next video |
| `Q` / `T` | Show / hide the queue / the label panel |
| `?` | Show all shortcuts |

On macOS, use `Cmd` instead of `Ctrl`.

### Saving and persistence

Annotations stay on disk until you clear them.

- Changes are saved automatically about a second after you make them, when you switch videos, and when you leave
  the annotation view. Export saves any pending change before exporting. Closing the browser tab with a change that
  has not been written yet asks for confirmation.
- A video becomes "in progress" when something is saved for it, and "completed" when you use Save & Next. A
  completed video stays completed when you edit it later.
- To remove a video's annotations, right-click it and choose Clear annotations. Deleting a project moves the whole
  project folder. In both cases the files go to `app_data/.trash/`, from where they can be restored. Lemon never
  empties the trash; delete those folders yourself when you no longer need them.
- Each export writes a new timestamped file and keeps the earlier ones.

The browser also remembers, per browser: the theme, the panel layout, the capture options, the last video opened
in each project, and each project's queue filter and search. Clearing the site data in the browser resets these.

### Export

Export Project JSON writes `app_data/projects/<id>/exports/<project>_<timestamp>.json` and downloads a copy. It
contains every video in the current bucket folder, annotated or not:

```json
{
  "format": "lemon/v1",
  "exported_at": "2026-10-24T10:12:09Z",
  "project": { "id": "mid-court-e93f91", "name": "mid court", "bucket": "my-bucket", "prefix": "clips/", "fps": 30 },
  "label_schema": { "event_types": [], "fields": [], "field_labels": { "shot_type": "Shot Type" } },
  "summary": { "total_videos": 6, "completed": 6, "in_progress": 0, "not_started": 0, "total_events": 0 },
  "videos": [
    {
      "video_filename": "HANNA.mp4",
      "s3_key": "clips/HANNA.mp4",
      "s3_uri": "s3://my-bucket/clips/HANNA.mp4",
      "streaming_url": "https://my-bucket.s3.ap-south-1.amazonaws.com/clips/HANNA.mp4?X-Amz-...",
      "streaming_url_expires_at": "2026-10-24T11:10:41Z",
      "status": "completed",
      "duration_seconds": 2.26,
      "fps": 30,
      "event_count": 0,
      "annotated_at": "2026-10-24T10:05:02Z",
      "labels": {
        "shot_type": "backhand_straight_lift",
        "verdict": "pass",
        "error_pattern": ["poor_timing", "incorrect_grip"],
        "notes": null
      },
      "events": []
    }
  ]
}
```

Timestamp events, when the schema has them, look like this:

```json
{
  "id": "4f0c9e1a2b3c",
  "timestamp": 1.25,
  "time": "00:00:01.250",
  "frame": 37,
  "event_name": "Smash",
  "checkboxes": { "forehand": true, "winning_shot": false },
  "attributes": { "court_side": "Left" },
  "note": ""
}
```

Checkbox fields are always written as `true` or `false`. `streaming_url` is the presigned URL in use when the video
was last saved and expires by design; use `s3_uri` as the permanent reference.

## Data on disk

```
app_data/
  projects/<project-id>/
    project.json              project settings, storage credentials, label schema
    annotations/<video>.json  one file per annotated video
    annotations/_index.json   status index, rebuilt automatically from the files if needed
    exports/                  one file per export
  .trash/                     deleted projects, cleared and unreadable annotation files
```

All files are written atomically (to a temporary file, then renamed), so an interrupted write never leaves a
partial file.

## How it works

- The frontend is Next.js 16 (App Router) with React 19, Tailwind CSS and shadcn/ui. It forwards `/api` requests to
  the backend, so the browser talks to a single origin.
- The backend is FastAPI with boto3. It lists the bucket, checks objects, creates presigned URLs and reads and
  writes the JSON files.
- The video element streams from S3 with HTTP range requests, so seeking does not download the whole file. When a
  presigned URL expires during playback, a new one is fetched and playback resumes at the same position.

## Project structure

```
backend/
  app/
    main.py          FastAPI app, error handling, host check
    config.py        LEMON_* settings
    models.py        data models
    storage.py       JSON storage under app_data
    s3_service.py    S3 access and error messages
    routers/         projects, videos and annotations, export
  tests/             API tests against a simulated S3
frontend/
  src/
    app/             pages: dashboard, annotate, settings
    components/      annotate, settings, dashboard, project, ui
    hooks/           data fetching, keyboard shortcuts
    lib/             API client, types, schema and Label Studio config handling
scripts/
  setup.mjs          first-time setup
  dev.mjs            runs backend and frontend together
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "The AWS Access Key ID is not recognized" or "Secret Access Key is incorrect" | Re-enter the keys. |
| "Bucket is in region X" | Use the suggested region (the connection test offers a button for it). |
| "Access denied" | Attach the IAM policy above. The message names the permissions that are missing. |
| "Your computer clock is out of sync" | Turn on automatic time sync. AWS signatures depend on the clock. |
| A video does not play but the connection works | The file is probably HEVC (H.265) or ProRes, which browsers cannot decode. Re-encode it to H.264, for example `ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4`. |
| A video is missing from the queue | Only `.mp4` and `.mov` files under the folder prefix are listed. Use Sync storage or the refresh button in the queue. |
| "The Lemon API did not respond" | The backend is not running, or the frontend points at the wrong port (`BACKEND_URL`). |
| "Another next dev server is already running" | The frontend is already running from this folder. Use that one, or stop it first. |

## Development

Backend tests run against a simulated S3 and need no AWS account:

```bash
cd backend
.venv\Scripts\python -m pip install -r requirements-dev.txt     # macOS/Linux: .venv/bin/pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest                                  # macOS/Linux: .venv/bin/pytest
```

Frontend checks, from `frontend/`: `npx tsc --noEmit`, `npm run lint`, `npm run build`. Format with
`npm run format`.

## License

MIT
