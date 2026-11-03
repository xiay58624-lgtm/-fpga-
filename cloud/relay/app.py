import base64
import binascii
import os
import threading
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


DEVICE_TOKEN = os.environ.get("RELAY_DEVICE_TOKEN", "")
VIEWER_TOKEN = os.environ.get("RELAY_VIEWER_TOKEN", "")
MAX_IMAGE_BYTES = 3 * 1024 * 1024
_lock = threading.Lock()
_snapshots: dict[int, dict[str, Any]] = {}

app = FastAPI(title="ADAS Snapshot Relay", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class Snapshot(BaseModel):
    ok: bool = True
    width: int
    height: int
    frame_sequence: int | float | None = None
    detection_frame_sequence: int | float | None = None
    detections_stale: bool | None = None
    detection_age_frames: int | float | None = None
    coordinate_space: str | None = None
    content_type: str = "image/jpeg"
    image_base64: str
    detections: list[dict[str, Any]] = []


def require_token(actual: str | None, expected: str, detail: str) -> None:
    if not expected or actual is None or actual != expected:
        raise HTTPException(status_code=401, detail=detail)


@app.get("/api/ping")
def ping():
    with _lock:
        sources = sorted(_snapshots)
    return {
        "ok": True,
        "device": "adas-cloud-relay",
        "role": "snapshot_relay",
        "sources_online": sources,
    }


@app.post("/api/device/snapshot")
def publish_snapshot(
    payload: Snapshot,
    source: int = Query(default=0, ge=0, le=4),
    x_device_token: str | None = Header(default=None),
):
    require_token(x_device_token, DEVICE_TOKEN, "invalid_device_token")
    if payload.width < 1 or payload.height < 1 or payload.width > 4096 or payload.height > 2160:
        raise HTTPException(status_code=400, detail="invalid_dimensions")
    try:
        image = base64.b64decode(payload.image_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="invalid_image_base64")
    if len(image) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image_too_large")
    if not image.startswith(b"\xff\xd8\xff"):
        raise HTTPException(status_code=400, detail="image_must_be_jpeg")
    snapshot = payload.model_dump()
    snapshot["received_at"] = time.time()
    with _lock:
        _snapshots[source] = snapshot
    return {"ok": True, "source": source, "frame_sequence": payload.frame_sequence}


@app.get("/api/adas/snapshot")
def get_snapshot(
    source: int = Query(default=0, ge=0, le=4),
    x_viewer_token: str | None = Header(default=None),
):
    require_token(x_viewer_token, VIEWER_TOKEN, "invalid_viewer_token")
    with _lock:
        snapshot = _snapshots.get(source)
        if snapshot is not None:
            snapshot = dict(snapshot)
    if snapshot is None:
        raise HTTPException(status_code=503, detail="frame_not_ready")
    age = time.time() - snapshot.pop("received_at", time.time())
    snapshot["relay_age_seconds"] = round(age, 3)
    snapshot["relay_stale"] = age > 2.0
    return snapshot
