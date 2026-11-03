// A local server for the pdf phone test. tools/plugin-phone/pdf.ts starts it by itself. To use the lab by hand:
//
//   bun run tools/plugin-phone/pdf-server.ts
//   adb reverse tcp:8793 tcp:8793
//
// The PDFs are made here, with no library: a PDF is text objects plus a table of where each starts. The password one uses
// PDF's oldest lock (RC4, 40 bit), which every reader knows.
import { createHash } from "node:crypto"

const PORT = 8793
export const SERVER = `http://localhost:${PORT}`
/** The same server by a second name: another origin, so a redirect there must lose the app's headers. */
export const OTHER = `http://127.0.0.1:${PORT}`

/** What reached the server: hits per path, and the last lab header seen on each. */
export const received: { hits: Record<string, number>; header: Record<string, string | null> } = { hits: {}, header: {} }

interface Page {
  width: number
  height: number
  content: string
}

/** Page text in Helvetica, a grey band and a frame, so a test can see it is drawn. */
function page(width: number, height: number, title: string, lines = 6): Page {
  const rows = Array.from({ length: lines }, (_, i) => `BT /F1 14 Tf 40 ${height - 120 - i * 24} Td (Item ${i + 1} ........ Rs ${(i + 1) * 10}.00) Tj ET`)
  return {
    width,
    height,
    content: [`0.85 g 20 ${height - 90} ${width - 40} 60 re f 0 g`, `BT /F1 28 Tf 40 ${height - 70} Td (${title}) Tj ET`, ...rows, `1 w 10 10 ${width - 20} ${height - 20} re S`].join("\n"),
  }
}

const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex")
const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest()
const padded = (password: string) => Buffer.concat([Buffer.from(password, "latin1"), PAD]).subarray(0, 32)

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255
    ;[s[i], s[j]] = [s[j]!, s[i]!]
  }
  const out = Buffer.alloc(data.length)
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255
    j = (j + s[i]!) & 255
    ;[s[i], s[j]] = [s[j]!, s[i]!]
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!
  }
  return out
}

/** A whole PDF. With [password], the user needs it to open the file (Standard security handler, revision 2). */
export function makePdf(pages: Page[], password?: string): Buffer {
  const id = createHash("md5").update(`zn-lab-${pages.length}-${password ?? ""}`).digest()
  const perms = -44
  let key: Buffer | null = null
  let owner: Buffer | null = null
  let user: Buffer | null = null
  if (password !== undefined) {
    owner = rc4(md5(padded(password)).subarray(0, 5), padded(password))
    const p = Buffer.alloc(4)
    p.writeInt32LE(perms)
    key = md5(padded(password), owner, p, id).subarray(0, 5)
    user = rc4(key, PAD)
  }
  const objects: (string | { dict: string; stream: Buffer })[] = []
  const add = (o: (typeof objects)[number]) => objects.push(o)
  add("<< /Type /Catalog /Pages 2 0 R >>")
  add("") // the page list, below, once the pages have numbers
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const kids: number[] = []
  for (const pg of pages) {
    const contentNo = objects.length + 2
    kids.push(objects.length + 1)
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pg.width} ${pg.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNo} 0 R >>`)
    add({ dict: "", stream: Buffer.from(pg.content, "latin1") })
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`
  let encryptNo = 0
  if (owner && user) {
    encryptNo = objects.length + 1
    add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P ${perms} >>`)
  }

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")]
  let size = parts[0]!.length
  const offsets: number[] = []
  objects.forEach((o, i) => {
    const no = i + 1
    offsets.push(size)
    let body: Buffer
    if (typeof o === "string") {
      body = Buffer.from(`${no} 0 obj\n${o}\nendobj\n`, "latin1")
    } else {
      // Each object's own key: the file key + its number, as the spec says. Only streams carry text here.
      const data = key ? rc4(md5(key, Buffer.from([no & 255, (no >> 8) & 255, (no >> 16) & 255, 0, 0])).subarray(0, 10), o.stream) : o.stream
      body = Buffer.concat([Buffer.from(`${no} 0 obj\n<< /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")])
    }
    parts.push(body)
    size += body.length
  })
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("")
  const encrypt = encryptNo ? ` /Encrypt ${encryptNo} 0 R` : ""
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypt} /ID [<${id.toString("hex")}> <${id.toString("hex")}>] >>\nstartxref\n${size}\n%%EOF\n`
  parts.push(Buffer.from(xref + trailer, "latin1"))
  return Buffer.concat(parts)
}

const A4 = [595, 842] as const
export const files = {
  one: makePdf([page(A4[0], A4[1], "ZeroBill receipt")]),
  pages50: makePdf(Array.from({ length: 50 }, (_, i) => page(A4[0], A4[1], `Page ${i + 1}`, 28))),
  // A thermal receipt: 80 mm wide, 70 cm long.
  roll: makePdf([page(226, 2000, "Roll", 70)]),
  password: makePdf([page(A4[0], A4[1], "Locked")], "1234"),
  // A start that looks right, then nothing a reader can use.
  broken: Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog", "latin1"), Buffer.alloc(2000, 0x41)]),
}

const pdfAnswer = (body: Buffer) => new Response(body, { headers: { "content-type": "application/pdf", "content-length": String(body.length) } })

export function startPdfServer() {
  return Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      received.hits[path] = (received.hits[path] ?? 0) + 1
      received.header[path] = req.headers.get("x-zn-lab")
      switch (path) {
        case "/one.pdf":
          return pdfAnswer(files.one)
        case "/pages50.pdf":
          return pdfAnswer(files.pages50)
        case "/roll.pdf":
          return pdfAnswer(files.roll)
        case "/password.pdf":
          return pdfAnswer(files.password)
        case "/broken.pdf":
          return pdfAnswer(files.broken)
        case "/html.pdf": // an error page sent with 200, as some servers do
          return new Response("<!doctype html><title>Login</title><p>Please log in</p>".padEnd(1500, " "), { headers: { "content-type": "application/pdf" } })
        case "/redirect":
          return new Response(null, { status: 302, headers: { location: "/one.pdf?via=redirect" } })
        case "/redirect-other":
          return new Response(null, { status: 302, headers: { location: `${OTHER}/one.pdf?via=other` } })
        case "/slow.pdf": {
          // The first bytes at once, the rest over 20 s: long enough to kill the app in the middle.
          const body = files.pages50
          const stream = new ReadableStream({
            async start(c) {
              for (let i = 0; i < body.length; i += 4096) {
                c.enqueue(body.subarray(i, i + 4096))
                await Bun.sleep(Math.ceil(20000 / (body.length / 4096)))
              }
              c.close()
            },
          })
          return new Response(stream, { headers: { "content-type": "application/pdf", "content-length": String(body.length) } })
        }
        default:
          return new Response("not found", { status: 404 })
      }
    },
  })
}

if (import.meta.main) {
  startPdfServer()
  console.log(`pdf lab server on ${SERVER}`)
  console.log(`on the phone: adb reverse tcp:${PORT} tcp:${PORT}`)
}
