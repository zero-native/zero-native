// A small XML reader for .svg files (docs/svg.md §6), build time only. It reads elements, attributes, text, comments,
// CDATA, processing instructions, a doctype and the five XML entities plus numeric ones, and keeps the line and
// column of every element and attribute, so build errors point at the exact place in the .svg file. It is not a
// general XML parser: no namespaces resolution, no DTD entities (an SVG never needs them).

export interface SvgAttr {
  value: string
  /** "file.svg:line:col" of the attribute. */
  at: string
}

export interface SvgNode {
  tag: string
  attrs: Map<string, SvgAttr>
  children: SvgNode[]
  /** Text directly inside the element (only kept to refuse `<text>` / `<style>` content clearly). */
  text: string
  /** "file.svg:line:col" of the element. */
  at: string
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

export function parseSvgXml(src: string, file: string): SvgNode {
  let i = 0
  // Line starts, for positions.
  const lineStarts = [0]
  for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) lineStarts.push(k + 1)
  const where = (pos: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= pos) lo = mid
      else hi = mid - 1
    }
    return `${file}:${lo + 1}:${pos - lineStarts[lo]! + 1}`
  }
  const fail = (pos: number, msg: string): never => {
    throw new Error(`${where(pos)}: ${msg}`)
  }
  const decode = (s: string, pos: number) =>
    s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return String.fromCodePoint(code)
      }
      if (!(name in ENTITIES)) fail(pos, `unknown XML entity ${whole}`)
      return ENTITIES[name]!
    })
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++
  }
  const nameAt = (): string => {
    const m = /[A-Za-z_:][\w:.-]*/y
    m.lastIndex = i
    const hit = m.exec(src)
    if (!hit) fail(i, "expected a name")
    i = m.lastIndex
    return hit![0]
  }
  /** Skips <?...?>, <!-- -->, <!DOCTYPE ...> and returns true, or returns false. */
  const skipSpecial = (): boolean => {
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i)
      if (end < 0) fail(i, "unclosed <?...?>")
      i = end + 2
      return true
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i)
      if (end < 0) fail(i, "unclosed comment")
      i = end + 3
      return true
    }
    if (src.startsWith("<!DOCTYPE", i) || src.startsWith("<!doctype", i)) {
      // A doctype may hold an internal subset in [...].
      let depth = 0
      for (let k = i; k < src.length; k++) {
        const ch = src[k]
        if (ch === "[") depth++
        else if (ch === "]") depth--
        else if (ch === ">" && depth === 0) {
          i = k + 1
          return true
        }
      }
      fail(i, "unclosed <!DOCTYPE")
    }
    return false
  }

  const element = (): SvgNode => {
    const start = i
    i++ // <
    const tag = nameAt()
    const node: SvgNode = { tag, attrs: new Map(), children: [], text: "", at: where(start) }
    while (true) {
      skipWs()
      if (src.startsWith("/>", i)) {
        i += 2
        return node
      }
      if (src[i] === ">") {
        i++
        break
      }
      if (i >= src.length) fail(start, `<${tag}> is not closed`)
      const attrPos = i
      const name = nameAt()
      skipWs()
      if (src[i] !== "=") fail(i, `attribute "${name}" needs a value`)
      i++
      skipWs()
      const q = src[i]
      if (q !== '"' && q !== "'") fail(i, `attribute "${name}": the value needs quotes`)
      const end = src.indexOf(q!, i + 1)
      if (end < 0) fail(i, `attribute "${name}": the value is not closed`)
      if (node.attrs.has(name)) fail(attrPos, `attribute "${name}" is written twice`)
      node.attrs.set(name, { value: decode(src.slice(i + 1, end), attrPos), at: where(attrPos) })
      i = end + 1
    }
    // Content.
    while (true) {
      if (i >= src.length) fail(start, `<${tag}> has no closing </${tag}>`)
      if (src.startsWith("</", i)) {
        const closePos = i
        i += 2
        const name = nameAt()
        skipWs()
        if (src[i] !== ">") fail(i, `expected ">" after </${name}`)
        i++
        if (name !== tag) fail(closePos, `</${name}> closes <${tag}> (opened at ${node.at})`)
        return node
      }
      if (src.startsWith("<![CDATA[", i)) {
        const end = src.indexOf("]]>", i)
        if (end < 0) fail(i, "unclosed CDATA")
        node.text += src.slice(i + 9, end)
        i = end + 3
        continue
      }
      if (src[i] === "<") {
        if (skipSpecial()) continue
        node.children.push(element())
        continue
      }
      const next = src.indexOf("<", i)
      const end = next < 0 ? src.length : next
      node.text += decode(src.slice(i, end), i)
      i = end
    }
  }

  let root: SvgNode | null = null
  while (i < src.length) {
    skipWs()
    if (i >= src.length) break
    if (src[i] !== "<") fail(i, "text outside the root element")
    if (skipSpecial()) continue
    if (root) fail(i, "a second root element")
    root = element()
  }
  if (!root) throw new Error(`${file}: no <svg> element`)
  return root
}
