// The web `FormData` class for fetch (multipart/form-data uploads). Hermes has no Blob or File, so a file is given
// the React Native way, as `{ uri, name, type }`: native streams it from the `content://` or `file://` URI straight
// to the network; its bytes never enter JS.
//
//   const form = new FormData()
//   form.append("storeId", "42")
//   form.append("receipt", { uri: photo.uri, name: "receipt.jpg", type: "image/jpeg" })
//   await fetch(url, { method: "POST", body: form })   // Content-Type with the boundary is set for you

export interface FormFile {
  /** `content://...` or `file://...`. */
  uri: string
  /** File name sent to the server. Default: the last part of the URI. */
  name?: string
  /** MIME type. Default: application/octet-stream. */
  type?: string
}

export type FormValue = string | FormFile

function isFile(v: unknown): v is FormFile {
  return typeof v === "object" && v !== null && typeof (v as FormFile).uri === "string"
}

function entry(name: string, value: FormValue | number | boolean, filename?: string): [string, FormValue] {
  if (isFile(value)) {
    if (!/^(content|file):\/\//i.test(value.uri)) {
      throw new TypeError(`FormData: file "${name}" needs a content:// or file:// uri, got "${value.uri}"`)
    }
    const fallback = decodeURIComponent(value.uri.split(/[/?#]/).filter(Boolean).pop() ?? "file")
    return [String(name), { uri: value.uri, name: filename ?? value.name ?? fallback, type: value.type }]
  }
  if (typeof value === "object" && value !== null) {
    throw new TypeError(`FormData: "${name}" must be a string or a file ({ uri, name, type }); use JSON.stringify for objects`)
  }
  return [String(name), String(value)]
}

export class FormData {
  private list: Array<[string, FormValue]> = []

  append(name: string, value: FormValue | number | boolean, filename?: string): void {
    this.list.push(entry(name, value, filename))
  }

  set(name: string, value: FormValue | number | boolean, filename?: string): void {
    const e = entry(name, value, filename)
    const at = this.list.findIndex(([k]) => k === e[0])
    if (at === -1) {
      this.list.push(e)
      return
    }
    this.list[at] = e
    this.list = this.list.filter(([k], i) => k !== e[0] || i === at)
  }

  get(name: string): FormValue | null {
    return this.list.find(([k]) => k === name)?.[1] ?? null
  }

  getAll(name: string): FormValue[] {
    return this.list.filter(([k]) => k === name).map(([, v]) => v)
  }

  has(name: string): boolean {
    return this.list.some(([k]) => k === name)
  }

  delete(name: string): void {
    this.list = this.list.filter(([k]) => k !== name)
  }

  *entries(): IterableIterator<[string, FormValue]> {
    yield* this.list.map(([k, v]) => [k, v] as [string, FormValue])
  }

  *keys(): IterableIterator<string> {
    for (const [k] of this.list) yield k
  }

  *values(): IterableIterator<FormValue> {
    for (const [, v] of this.list) yield v
  }

  forEach(fn: (value: FormValue, name: string, form: FormData) => void): void {
    for (const [k, v] of this.list) fn(v, k, this)
  }

  [Symbol.iterator](): IterableIterator<[string, FormValue]> {
    return this.entries()
  }

  /** Internal: the parts for native: [name, value] for text, [name, uri, filename, type] for files. */
  _parts(): Array<[string, string] | [string, string, string, string]> {
    return this.list.map(([k, v]) =>
      typeof v === "string" ? [k, v] : [k, v.uri, v.name ?? "file", v.type ?? "application/octet-stream"],
    )
  }
}
