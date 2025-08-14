// multipart.ts
function uint8ToString(u8: Uint8Array): string {
    return new TextDecoder("utf-8").decode(u8);
  }
  
function findCRLFCRLF(u8: Uint8Array): number {
// find first occurrence of \r\n\r\n separating headers/body
for (let i = 0; i + 3 < u8.length; i++) {
    if (u8[i] === 13 && u8[i+1] === 10 && u8[i+2] === 13 && u8[i+3] === 10) return i;
}
return -1;
}

function parseHeaders(headerStr: string): Record<string,string> {
const out: Record<string,string> = {};
headerStr.split(/\r?\n/).forEach(line => {
    const idx = line.indexOf(":");
    if (idx > -1) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx+1).trim();
});
return out;
}

function getBoundary(ct: string | null): string {
if (!ct) throw new Error("Missing Content-Type");
const m = /boundary=([^;]+)/i.exec(ct);
if (!m) throw new Error("No boundary in Content-Type");
return m[1];
}
  
export function parseMultipart(bodyBuf: ArrayBuffer, contentType: string) {
const boundary = getBoundary(contentType);
const boundaryBytes = new TextEncoder().encode(`--${boundary}`);
const dashdash = new TextEncoder().encode(`--${boundary}--`);
const u8 = new Uint8Array(bodyBuf);

// Split by boundaries
const parts: Uint8Array[] = [];
let i = 0;
while (i < u8.length) {
    // look for next boundary
    let j = i;
    // skip leading CRLF
    if (u8[j] === 13 && u8[j+1] === 10) j += 2;
    // final boundary?
    if (u8.slice(j, j + dashdash.length).every((b, k) => b === dashdash[k])) break;
    if (!u8.slice(j, j + boundaryBytes.length).every((b, k) => b === boundaryBytes[k])) {
    // not a boundary, advance 1 byte
    i++;
    continue;
    }
    // move past boundary + CRLF
    j += boundaryBytes.length;
    if (u8[j] === 13 && u8[j+1] === 10) j += 2;

    // find header/body split
    const rest = u8.slice(j);
    const split = findCRLFCRLF(rest);
    if (split < 0) break;

    const headerBytes = rest.slice(0, split);
    const bodyStart = j + split + 4;

    // find next boundary start to get body end
    let k = bodyStart;
    // scan forward for "\r\n--boundary" sequence
    const marker = new TextEncoder().encode(`\r\n--${boundary}`);
    let end = -1;
    for (; k + marker.length <= u8.length; k++) {
    let match = true;
    for (let t = 0; t < marker.length; t++) {
        if (u8[k + t] !== marker[t]) { match = false; break; }
    }
    if (match) { end = k; break; }
    }
    if (end === -1) end = u8.length;

    parts.push(u8.slice(j, end)); // includes headers+CRLFCRLF+body
    i = end + 2; // move past \r\n before next boundary
}

let meta: any = null;
let seg: Uint8Array | null = null;

for (const p of parts) {
    const split = findCRLFCRLF(p);
    if (split < 0) continue;
    const headers = parseHeaders(uint8ToString(p.slice(0, split)));
    const body = p.slice(split + 4);

    const cd = headers["content-disposition"] || "";
    const nameMatch = /name="([^"]+)"/i.exec(cd);
    const name = nameMatch ? nameMatch[1] : "";

    const ctype = headers["content-type"] || "";

    if (name === "meta" && /application\/json/i.test(ctype)) {
    meta = JSON.parse(uint8ToString(body));
    } else if (name === "seg" && /application\/octet-stream/i.test(ctype)) {
    seg = body; // Uint8Array (binary)
    }
}

if (!meta) throw new Error("meta part not found");
if (!seg) throw new Error("seg part not found");
return { meta, seg };
}
