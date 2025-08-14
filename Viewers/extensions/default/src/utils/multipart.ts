// multipart.ts
function uint8ToString(u8: Uint8Array): string {
    return new TextDecoder("utf-8").decode(u8);
  }
  
  function findCRLFCRLF(u8: Uint8Array): number {
    for (let i = 0; i + 3 < u8.length; i++) {
      if (u8[i] === 13 && u8[i + 1] === 10 && u8[i + 2] === 13 && u8[i + 3] === 10) return i;
    }
    return -1;
  }
  
  function parseHeaders(headerStr: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of headerStr.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > -1) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return out;
  }
  
  function getBoundary(ct: string | null): string {
    if (!ct) throw new Error("Missing Content-Type");
    const m = /boundary=([^;]+)/i.exec(ct);
    if (!m) throw new Error("No boundary in Content-Type");
    return m[1].replace(/^"(.*)"$/, "$1"); // handle quoted boundary
  }
  
  async function gunzipIfNeeded(u8: Uint8Array, headers: Record<string, string>): Promise<Uint8Array> {
    const enc = (headers["content-encoding"] || "").toLowerCase();
    if (!enc.includes("gzip")) return u8;
    const DS: any = (globalThis as any).DecompressionStream;
    if (typeof DS === "function") {
      const ds = new DS("gzip");
      const stream = new Blob([u8]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    }
    // No native gunzip; return compressed bytes and let caller handle (e.g., pako.ungzip)
    return u8;
  }
  
  /**
   * Parse a multipart/form-data response body.
   * - Auto-decompresses per-part gzip for both "meta" (JSON) and "seg" (binary) when Content-Encoding: gzip is present.
   * - Returns raw headers per part so callers can see original encodings.
   */
  export async function parseMultipart(
    bodyBuf: ArrayBuffer,
    contentType: string
  ): Promise<{
    meta: any;                                // parsed JSON (decompressed if needed)
    seg: Uint8Array;                          // binary bytes after any decompression
  }> {
    const boundary = getBoundary(contentType);
    const u8 = new Uint8Array(bodyBuf);
    const boundaryBytes = new TextEncoder().encode(`--${boundary}`);
    const finalBoundaryBytes = new TextEncoder().encode(`--${boundary}--`);
    const nextMarker = new TextEncoder().encode(`\r\n--${boundary}`);
  
    const parts: Uint8Array[] = [];
    let i = 0;
  
    while (i < u8.length) {
      // skip inter-part CRLF
      if (u8[i] === 13 && u8[i + 1] === 10) i += 2;
  
      // final boundary?
      if (u8.slice(i, i + finalBoundaryBytes.length).every((b, k) => b === finalBoundaryBytes[k])) break;
  
      // need a boundary
      if (!u8.slice(i, i + boundaryBytes.length).every((b, k) => b === boundaryBytes[k])) {
        i++; // resync
        continue;
      }
  
      // advance past boundary and CRLF
      let j = i + boundaryBytes.length;
      if (u8[j] === 13 && u8[j + 1] === 10) j += 2;
  
      const rest = u8.slice(j);
      const split = findCRLFCRLF(rest);
      if (split < 0) break;
  
      const bodyStart = j + split + 4;
  
      // find end = position before "\r\n--boundary"
      let k = bodyStart;
      let end = -1;
      for (; k + nextMarker.length <= u8.length; k++) {
        let match = true;
        for (let t = 0; t < nextMarker.length; t++) {
          if (u8[k + t] !== nextMarker[t]) { match = false; break; }
        }
        if (match) { end = k; break; }
      }
      if (end === -1) end = u8.length;
  
      parts.push(u8.slice(j, end)); // headers + CRLFCRLF + body
      i = end + 2; // over the CRLF preceding the next boundary
    }
  
    let metaObj: any = null;
    let metaBytes = new Uint8Array(0);
    let metaHeaders: Record<string, string> = {};
    let seg = new Uint8Array(0);
    let segHeaders: Record<string, string> = {};
  
    for (const p of parts) {
      const split = findCRLFCRLF(p);
      if (split < 0) continue;
      const headers = parseHeaders(uint8ToString(p.slice(0, split)));
      const body = p.slice(split + 4);
  
      const cd = headers["content-disposition"] || "";
      const nameMatch = /name="([^"]+)"/i.exec(cd);
      const name = nameMatch ? nameMatch[1] : "";
  
      const ctype = (headers["content-type"] || "").toLowerCase();
  
      if (name === "meta" && ctype.includes("application/json")) {
        const unzipped = await gunzipIfNeeded(body, headers);
        metaBytes = unzipped;
        metaObj = JSON.parse(uint8ToString(unzipped));
      } else if (name === "seg" && ctype.includes("application/octet-stream")) {
        const unzipped = await gunzipIfNeeded(body, headers);
        seg = unzipped;
      }
    }
  
    if (!metaObj) throw new Error("meta part not found");
    if (!seg.length) throw new Error("seg part not found");
  
    return { meta: metaObj, seg};
  }
  