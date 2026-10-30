// Where released bundles and channel pointers live (docs/ota.md §3.1). The release CLI writes it; the update server
// (step 4.4) reads it. Every record is a file that is created once and never changed: two people releasing at the
// same moment can't take the same serial or seq, because the second "create" fails (no compare-and-swap, no
// database; ZeroBill's RN OTA moved off compare-and-swap JSON on GCS because it was slow and easy to break).
//
// Layout, under one folder per app:
//   <app>/bundles/<id>/bundle.zip          the bundle's files (written before the manifest; replaced only while the
//                                           manifest doesn't exist yet, i.e. by a retry of a failed upload)
//   <app>/bundles/<id>/manifest.json       the signed record; its creation is the moment the bundle exists
//   <app>/bundles/<id>/stable.json         the owner's "stable on staging" mark (created once)
//   <app>/channels/<channel>/<seq>.json    one file per pointer change, seq zero-padded; the highest is current
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"

export interface Store {
  /** For messages: where this store is. */
  readonly where: string
  /** The file's bytes, or null if it doesn't exist. */
  read(path: string): Promise<Uint8Array | null>
  /** Writes the file, replacing it if it exists. */
  write(path: string, data: Uint8Array): Promise<void>
  /** Writes the file only if it doesn't exist yet. False if it did (someone else created it first). */
  createOnly(path: string, data: Uint8Array): Promise<boolean>
  /** Paths of all files under [prefix] (relative to the store, "/" separators). */
  list(prefix: string): Promise<string[]>
}

/** A store in a local folder: for development, tests, and copying to a web server as it is. */
export class LocalStore implements Store {
  constructor(readonly root: string) {}

  get where() {
    return this.root
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(readFileSync(this.full(path)))
    } catch {
      return null
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const f = this.full(path)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, data)
  }

  async createOnly(path: string, data: Uint8Array): Promise<boolean> {
    const f = this.full(path)
    mkdirSync(dirname(f), { recursive: true })
    try {
      writeFileSync(f, data, { flag: "wx" }) // O_CREAT | O_EXCL: fails if the file exists, atomically
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false
      throw e
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    const walk = (dir: string) => {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const n of names) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else out.push(relative(this.root, p).split(sep).join("/"))
      }
    }
    walk(prefix === "" ? this.root : this.full(prefix))
    return out.sort()
  }

  private full(path: string): string {
    if (path.split("/").some((part) => part === ".." || part === "")) throw new Error(`bad store path "${path}"`)
    return join(this.root, ...path.split("/"))
  }
}
