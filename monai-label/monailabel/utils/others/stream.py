# fastapi_streaming_multipart.py
from fastapi import Response
from fastapi.responses import StreamingResponse
import json, secrets, zlib
from typing import Iterable, Union

try:
    import numpy as np  # optional
except ImportError:
    np = None

BytesLike = Union[bytes, bytearray, memoryview]

def _as_read_chunks(obj, chunk_size: int = 1 << 20) -> Iterable[memoryview]:
    """
    Return an iterator of memoryview chunks over the payload without
    making unnecessary copies. Supports bytes/bytearray/memoryview
    and numpy arrays (contiguous or not).
    """
    # NumPy path
    if np is not None and isinstance(obj, np.ndarray):
        # Ensure uint8 view on C-order bytes without data copy if possible
        # Use tobytes(order="C") only as a last resort (it will copy if needed).
        if obj.dtype != np.uint8 or not obj.flags["C_CONTIGUOUS"]:
            # Make a C-contiguous uint8 view/copy minimally
            obj = obj.astype(np.uint8, copy=False)
            if not obj.flags["C_CONTIGUOUS"]:
                obj = np.ascontiguousarray(obj)
        mv = memoryview(obj)  # zero-copy over ndarray buffer
    else:
        # Generic bytes-like
        if not isinstance(obj, (bytes, bytearray, memoryview)):
            raise TypeError(f"Unsupported type for streaming: {type(obj)}")
        mv = memoryview(obj)

    n = len(mv)
    off = 0
    while off < n:
        end = min(off + chunk_size, n)
        yield mv[off:end]
        off = end

def _gzip_stream(chunks: Iterable[memoryview], level: int = 6) -> Iterable[bytes]:
    """
    Stream gzip bytes from an iterable of (memoryview) chunks.
    wbits=16+MAX_WBITS = gzip container (not raw deflate).
    """
    comp = zlib.compressobj(level=level, method=zlib.DEFLATED, wbits=16 + zlib.MAX_WBITS)
    for ch in chunks:
        # ch is memoryview -> no copy when feeding zlib
        out = comp.compress(ch)
        if out:
            yield out
    tail = comp.flush()
    if tail:
        yield tail

def stream_multipart(meta: dict, seg_payload: Union[BytesLike, "np.ndarray"]) -> StreamingResponse:
    """
    Sends a multipart/form-data with:
      - part "meta": application/json, Content-Encoding: gzip
      - part "seg" : application/octet-stream, Content-Encoding: gzip (level 1)
    The seg is a 0/1 mask crop, which gzips ~150x (1.5MB -> ~20KB): on anything slower
    than a wired LAN the transfer saving (~400ms measured at ~27Mbps effective) dwarfs
    the client's ~30ms DecompressionStream cost, and on a gigabit link the delta is
    within noise. Level 1 keeps the server-side compress at a few ms; on a binary mask
    its ratio is nearly identical to level 6. (An earlier revision sent the seg RAW
    because client gunzip measured 180-450ms — that number came from a heap suffering
    since-fixed GC pressure from full-volume labelmap blocks, and raw only won on the
    gigabit link it was measured over.) The client's per-part gunzipIfNeeded keys off
    Content-Encoding, so clients parse either encoding.
    """
    boundary = f"monai-{secrets.token_hex(12)}"
    CRLF = b"\r\n"
    dash_boundary = b"--" + boundary.encode("utf-8")

    # Pre-render headers (bytes) — small and static
    meta_headers = CRLF.join([
        dash_boundary,
        b'Content-Disposition: form-data; name="meta"; filename="meta.json"',
        b"Content-Type: application/json",
        b"Content-Encoding: gzip",
        b"",  # blank line ends headers
    ]) + CRLF

    seg_headers = CRLF.join([
        dash_boundary,
        b'Content-Disposition: form-data; name="seg"; filename="seg.bin"',
        b"Content-Type: application/octet-stream",
        b"Content-Encoding: gzip",
        b"",
    ]) + CRLF

    closing = dash_boundary + b"--" + CRLF

    # Prepare meta JSON bytes as an iterator
    meta_bytes = json.dumps(meta, separators=(",", ":")).encode("utf-8")
    meta_iter = _as_read_chunks(meta_bytes, chunk_size=64 * 1024)  # small chunks are fine for JSON

    # Prepare seg bytes iterator (large, so use bigger chunks)
    seg_iter = _as_read_chunks(seg_payload, chunk_size=2 << 20)  # 2 MiB

    def gen():
        # meta part
        yield meta_headers
        for gz in _gzip_stream(meta_iter, level=6):
            yield gz
        yield CRLF  # end of meta body

        # seg part — gzip level 1 (see docstring for the raw-vs-gzip history).
        yield seg_headers
        for gz in _gzip_stream(seg_iter, level=1):
            yield gz
        yield CRLF  # end of seg body

        # closing boundary
        yield closing

    return StreamingResponse(gen(), media_type=f"multipart/form-data; boundary={boundary}")
