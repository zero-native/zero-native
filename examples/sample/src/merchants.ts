// Sample merchants. Plain data, no side effects (startup rule: nothing runs at module load; the long list is built
// on demand by the screen that shows it).

export interface Merchant {
  id: string
  name: string
  area: string
  photo: string
}

export const MERCHANTS: Merchant[] = [
  { id: "m1", name: "Kalyan Jewellers", area: "Bannerghatta Road", photo: "https://picsum.photos/id/1062/112/112" },
  { id: "m2", name: "Sri Sai Medicals", area: "JP Nagar 7th Phase", photo: "https://picsum.photos/id/1080/112/112" },
  { id: "m3", name: "Annapoorna Tiffins", area: "Arekere", photo: "https://picsum.photos/id/292/112/112" },
  { id: "m4", name: "Green Leaf Supermart", area: "Hulimavu", photo: "https://picsum.photos/id/1059/112/112" },
  { id: "m5", name: "Ganesh Hardware", area: "Gottigere", photo: "https://picsum.photos/id/1067/112/112" },
]

const AREAS = ["Arekere", "Hulimavu", "Gottigere", "JP Nagar", "BTM Layout", "Jayanagar", "Banashankari", "Bilekahalli"]
const KINDS = ["Medicals", "Supermart", "Bakery", "Tiffins", "Hardware", "Fashions", "Mobiles", "Sweets", "Kirana"]
const FIRST = ["Sri", "New", "Lakshmi", "Royal", "Fresh", "Om", "Balaji", "Sai", "Star", "Annapoorna", "Green"]

/** A generated merchant for index i (same every time), for long lists. Id "g<i>". */
export function generatedMerchant(i: number): Merchant {
  return {
    id: `g${i}`,
    name: `${FIRST[i % FIRST.length]} ${KINDS[(i * 7) % KINDS.length]} ${i}`,
    area: AREAS[Math.floor(i / 100) % AREAS.length],
    photo: "",
  }
}

/** The merchant for a route param. Unknown ids (an old link) get a neutral placeholder, never a crash. */
export function merchantById(id: string): Merchant {
  const known = MERCHANTS.find((m) => m.id === id)
  if (known) return known
  const n = /^g(\d+)$/.exec(id)
  if (n) return generatedMerchant(Number(n[1]))
  return { id, name: "Unknown merchant", area: "", photo: "" }
}
