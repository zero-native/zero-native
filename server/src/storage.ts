// Where bundle zips live: a local folder (`file:<folder>`) or a GCS bucket (`gs://<bucket>/<prefix>`). Files are
// written once and never changed (their path has their SHA-256 in it), so the server keeps a local copy of every
// file it serves and answers Range requests from that copy (RN learned: streaming each request from GCS is slow).
import { mkdirSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"

export interface FileStore {
  readonly where: string
  /** Writes the file (a retry of the same path writes the same bytes). */
  put(path: string, data: Uint8Array): Promise<void>
  /** A local file with the bytes (downloaded once into the cache for GCS), or null if the store doesn't have it. */
  local(path: string): Promise<string | null>
}

const SAFE_PATH = /^[a-z][a-z0-9_.-]*(\/[A-Za-z0-9_.-]+)+$/

function checkPath(path: string) {
  if (!SAFE_PATH.test(path) || path.includes("..")) throw new Error(`refusing file path ${path}`)
}

export function openStore(url: string, cacheDir: string): FileStore {
  if (url.startsWith("file:")) return new FolderStore(url.slice("file:".length))
  if (url.startsWith("gs://")) {
    const [bucket, ...rest] = url.slice("gs://".length).split("/")
    return new GcsStore(bucket!, rest.filter(Boolean).join("/"), cacheDir)
  }
  throw new Error(`STORAGE must be file:<folder> or gs://<bucket>/<prefix>`)
}

class FolderStore implements FileStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true })
  }
  get where() {
    return `folder ${this.root}`
  }
  async put(path: string, data: Uint8Array) {
    checkPath(path)
    const full = join(this.root, ...path.split("/"))
    mkdirSync(dirname(full), { recursive: true })
    const tmp = `${full}.${crypto.randomUUID()}.tmp`
    await Bun.write(tmp, data)
    renameSync(tmp, full)
  }
  async local(path: string) {
    checkPath(path)
    const full = join(this.root, ...path.split("/"))
    return (await Bun.file(full).exists()) ? full : null
  }
}

class GcsStore implements FileStore {
  private bucket: import("@google-cloud/storage").Bucket | null = null
  private inflight = new Map<string, Promise<string | null>>()
  constructor(
    private bucketName: string,
    private prefix: string,
    private cacheDir: string,
  ) {}
  get where() {
    return `gs://${this.bucketName}/${this.prefix}`
  }
  private async b() {
    if (!this.bucket) {
      // Application Default Credentials: the GKE workload identity, or GOOGLE_APPLICATION_CREDENTIALS locally.
      const { Storage } = await import("@google-cloud/storage")
      this.bucket = new Storage().bucket(this.bucketName)
    }
    return this.bucket
  }
  private key(path: string) {
    return this.prefix ? `${this.prefix}/${path}` : path
  }
  async put(path: string, data: Uint8Array) {
    checkPath(path)
    await (await this.b()).file(this.key(path)).save(Buffer.from(data), { resumable: false, contentType: "application/zip" })
    const full = join(this.cacheDir, ...path.split("/"))
    mkdirSync(dirname(full), { recursive: true })
    await Bun.write(full, data)
  }
  local(path: string): Promise<string | null> {
    checkPath(path)
    const running = this.inflight.get(path)
    if (running) return running
    const task = (async () => {
      const full = join(this.cacheDir, ...path.split("/"))
      if (await Bun.file(full).exists()) return full
      const file = (await this.b()).file(this.key(path))
      const [exists] = await file.exists()
      if (!exists) return null
      mkdirSync(dirname(full), { recursive: true })
      const tmp = `${full}.${crypto.randomUUID()}.tmp`
      await file.download({ destination: tmp })
      renameSync(tmp, full)
      return full
    })().finally(() => this.inflight.delete(path))
    this.inflight.set(path, task)
    return task
  }
}
